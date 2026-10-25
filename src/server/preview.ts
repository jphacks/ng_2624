import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request } from 'node:https';
import type { ProductCandidate } from '../shared/types.ts';
import { isRetailProductUrl } from '../shared/product-source.ts';

export type PreviewImage = { body: Buffer; contentType: string };
type Address = { address: string; family: number };
type Response = { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer };
type Dependencies = {
  resolve: (hostname: string) => Promise<Address[]>;
  read: (url: URL, address: Address, maxBytes: number, signal: AbortSignal) => Promise<Response>;
};
const HTML_LIMIT = 512 * 1024, IMAGE_LIMIT = 2 * 1024 * 1024;
const AMAZON_HTML_LIMIT = 4 * 1024 * 1024;
const amazonHost = (url: URL) => ['amazon.co.jp', 'www.amazon.co.jp'].includes(url.hostname);
function amazonImage(value: string | null | undefined): URL | null {
  if (!value) return null;
  try {
    const url = httpsUrl(value);
    return ['m.media-amazon.com', 'images-na.ssl-images-amazon.com', 'images-fe.ssl-images-amazon.com'].includes(url.hostname) && url.pathname.startsWith('/images/I/') ? url : null;
  } catch { return null; }
}

function trustedProductImage(value: string | null | undefined, productUrl: string): URL | null {
  const amazon = amazonImage(value);
  try {
    const product = httpsUrl(productUrl);
    if (amazonHost(product)) return amazon;
    const image = value ? httpsUrl(value) : null;
    if (image && /^(?:www\.)?yodobashi\.com$/.test(product.hostname)
        && image.hostname === 'image.yodobashi.com' && image.pathname.startsWith('/product/')) return image;
    const shop = product.pathname.split('/')[1];
    if (image && product.hostname === 'item.rakuten.co.jp' && shop
        && image.hostname === 'image.rakuten.co.jp' && image.pathname.startsWith('/' + shop + '/')) return image;
  } catch { /* Unsupported hint. */ }
  return null;
}

/** Conservative public-unicast allowlist, excluding mapped and transition IPv6. */
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) !== 6) return false;
  const [first, second = '0'] = address.toLowerCase().split(':');
  const prefix = parseInt(first, 16), next = parseInt(second || '0', 16);
  return prefix >= 0x2000 && prefix <= 0x3fff && prefix !== 0x2002 && prefix !== 0x3fff &&
    !(prefix === 0x2001 && (next <= 0x1ff || next === 0xdb8));
}
function httpsUrl(value: string, base?: URL): URL {
  const url = new URL(value, base);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || value.length > 4096) throw new Error('Unsupported preview URL');
  url.hash = '';
  return url;
}
const dependencies: Dependencies = {
  resolve: hostname => lookup(hostname, { all: true, verbatim: true }),
  read: (url, address, maxBytes, signal) => new Promise((resolve, reject) => {
    const req = request(url, {
      agent: false, signal, family: address.family,
      lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
      headers: { Accept: 'text/html,image/png,image/jpeg,image/gif,image/webp', 'Accept-Encoding': 'identity', 'User-Agent': 'Wishbridge-Preview/1.0' },
    }, response => {
      response.on('error', reject);
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        resolve({ status, headers: response.headers, body: Buffer.alloc(0) }); response.destroy(); return;
      }
      if (Number(response.headers['content-length']) > maxBytes) { response.destroy(new Error('Preview too large')); return; }
      const chunks: Buffer[] = []; let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) response.destroy(new Error('Preview too large')); else chunks.push(chunk);
      });
      response.on('end', () => resolve({ status, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end();
  }),
};
function decodeHtml(value: string): string {
  return value.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/gi, entity => {
    const named: Record<string, string> = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
    const code = entity[2].toLowerCase() === 'x' ? parseInt(entity.slice(3, -1), 16) : parseInt(entity.slice(2, -1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}
function imageMetadata(html: string, base: URL): URL | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attributes: Record<string, string> = {};
    for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) attributes[match[1].toLowerCase()] = decodeHtml(match[2] ?? match[3] ?? match[4]);
    const property = (attributes.property ?? attributes.name ?? '').toLowerCase();
    if (['og:image', 'og:image:secure_url', 'twitter:image', 'twitter:image:src'].includes(property) && attributes.content) {
      try { return httpsUrl(attributes.content, base); } catch { /* Try other metadata. */ }
    }
  }
  for (const script of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(script[1]);
      const nodes = Array.isArray(parsed) ? parsed : [parsed, ...(Array.isArray(parsed?.['@graph']) ? parsed['@graph'] : [])];
      for (const node of nodes) {
        if (!node || !(Array.isArray(node['@type']) ? node['@type'] : [node['@type']]).includes('Product')) continue;
        for (const image of Array.isArray(node.image) ? node.image : [node.image]) {
          const value = typeof image === 'string' ? image : image?.url ?? image?.contentUrl;
          if (typeof value === 'string') { try { return httpsUrl(value, base); } catch { /* Try another image. */ } }
        }
      }
    } catch { /* Ignore malformed structured data. */ }
  }
  if (amazonHost(base)) for (const tag of html.match(/<img\b[^>]*>/gi) ?? []) {
    if (!/\sid=["'](?:landingImage|imgBlkFront|main-image)["']/i.test(tag)) continue;
    const attributes: Record<string, string> = {};
    for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attributes[match[1].toLowerCase()] = decodeHtml(match[2] ?? match[3]);
    const image = amazonImage(attributes['data-old-hires']) ?? amazonImage(attributes.src);
    if (image) return image;
    try {
      const dynamic: unknown = JSON.parse(attributes['data-a-dynamic-image'] ?? '{}');
      if (dynamic && typeof dynamic === 'object' && !Array.isArray(dynamic)) {
        for (const value of Object.keys(dynamic)) {
          const image = amazonImage(value);
          if (image) return image;
        }
      }
    } catch { /* Ignore malformed optional image metadata. */ }
  }
  return null;
}
function yenPrice(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim().replace(/,/g, '');
  if (!/^\d+(?:\.0+)?$/.test(text)) return null;
  const price = Number(text);
  return Number.isSafeInteger(price) && price > 0 ? price : null;
}
function priceMetadata(html: string, base: URL): number | null {
  for (const script of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const root: unknown = JSON.parse(script[1]);
      const nodes: unknown[] = Array.isArray(root) ? [...root] : [root];
      for (let i = 0; i < nodes.length && i < 100; i++) {
        const node = nodes[i];
        if (!node || typeof node !== 'object') continue;
        const record = node as Record<string, unknown>;
        if (Array.isArray(record['@graph'])) nodes.push(...record['@graph']);
        const types = Array.isArray(record['@type']) ? record['@type'] : [record['@type']];
        if (!types.includes('Product')) continue;
        const offers = Array.isArray(record.offers) ? record.offers : [record.offers];
        for (const offer of offers) {
          if (!offer || typeof offer !== 'object') continue;
          const data = offer as Record<string, unknown>;
          const price = data.priceCurrency === 'JPY' ? yenPrice(data.price) : null;
          if (price !== null) return price;
        }
      }
    } catch { /* Ignore malformed structured data. */ }
  }
  const meta: Record<string, string> = {};
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attributes: Record<string, string> = {};
    for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) attributes[match[1].toLowerCase()] = decodeHtml(match[2] ?? match[3] ?? match[4]);
    meta[(attributes.property ?? attributes.name ?? '').toLowerCase()] = attributes.content;
  }
  for (const prefix of ['product:price', 'og:price']) {
    const price = meta[prefix + ':currency'] === 'JPY' ? yenPrice(meta[prefix + ':amount']) : null;
    if (price !== null) return price;
  }
  if (amazonHost(base)) {
    // Only current product price widgets; never arbitrary yen amounts in recommendations.
    for (const match of html.matchAll(/<span\b[^>]*id=["'](?:priceblock_ourprice|priceblock_dealprice|priceblock_saleprice|price_inside_buybox)["'][^>]*>([^<]*)<\/span>/gi)) {
      const amount = decodeHtml(match[1]).trim().match(/^[￥¥]\s*([\d,]+)(?:\.00)?$/)?.[1];
      const price = yenPrice(amount);
      if (price !== null) return price;
    }
    const container = html.match(/<(div|span)\b[^>]*id=["'](?:corePrice_feature_div|corePriceDisplay_desktop_feature_div|apex_desktop)["'][^>]*>/i);
    if (container) {
      const rest = html.slice(container.index! + container[0].length, container.index! + container[0].length + 12000);
      const tags = new RegExp('<(/?)' + container[1] + '\\b[^>]*>', 'gi');
      let depth = 1, currentPrice = '';
      for (const tag of rest.matchAll(tags)) {
        depth += tag[1] ? -1 : 1;
        if (!depth) { currentPrice = rest.slice(0, tag.index); break; }
      }
      for (const widget of currentPrice.matchAll(/<span\b[^>]*class=["']([^"']*\ba-price\b[^"']*)["'][^>]*>[\s\S]{0,1200}?<span\b[^>]*class=["']a-offscreen["'][^>]*>([^<]*)<\/span>/gi)) {
        if (widget[1].split(/\s+/).includes('a-text-price')) continue;
        const price = yenPrice(decodeHtml(widget[2]).trim().match(/^[￥¥]\s*([\d,]+)$/)?.[1]);
        if (price !== null) return price;
      }
    }
  }
  return null;
}
function validImage(body: Buffer, type: string): boolean {
  return (type === 'image/png' && body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
    (type === 'image/jpeg' && body[0] === 255 && body[1] === 216 && body[2] === 255) ||
    (type === 'image/gif' && /GIF8[79]a/.test(body.subarray(0, 6).toString('ascii'))) ||
    (type === 'image/webp' && body.subarray(0, 4).toString() === 'RIFF' && body.subarray(8, 12).toString() === 'WEBP');
}
export function createProductPreview(deps: Dependencies = dependencies) {
  const cache = new Map<string, { expires: number; image: PreviewImage | null }>();
  const metadata = new Map<string, { priceJpy: number | null; checkedAt: string }>();
  const imageHints = new Map<string, string>();
  const pending = new Map<string, Promise<PreviewImage | null>>();
  async function read(url: URL, limit: number, signal: AbortSignal): Promise<{ response: Response; url: URL }> {
    for (let redirects = 0; redirects <= 3; redirects++) {
      signal.throwIfAborted();
      const hostname = url.hostname.replace(/^\[|\]$/g, '');
      const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await deps.resolve(hostname);
      signal.throwIfAborted();
      if (!addresses.length || addresses.some(address => !isPublicAddress(address.address))) throw new Error('Non-public preview host');
      const response = await deps.read(url, addresses[0], limit, signal);
      if (response.body.length > limit) throw new Error('Preview too large');
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.location;
        if (typeof location !== 'string') throw new Error('Invalid redirect');
        url = httpsUrl(location, url); continue;
      }
      if (response.status !== 200) throw new Error('Preview unavailable');
      return { response, url };
    }
    throw new Error('Too many redirects');
  }
  async function retrieve(productUrl: string, signal: AbortSignal, imageHint?: string | null, needPrice = false): Promise<PreviewImage | null> {
    try {
      const product = httpsUrl(productUrl);
      let imageUrl = trustedProductImage(imageHint, productUrl);
      if (!imageUrl || needPrice) {
        try {
          const page = await read(product, amazonHost(product) ? AMAZON_HTML_LIMIT : HTML_LIMIT, signal);
          if (!/^text\/html(?:;|$)/i.test(String(page.response.headers['content-type']))) throw new Error('Not a product page');
          const html = page.response.body.toString('utf8');
          if (metadata.size >= 32) metadata.delete(metadata.keys().next().value!);
          metadata.set(productUrl, { priceJpy: priceMetadata(html, page.url), checkedAt: new Date().toISOString() });
          imageUrl ??= imageMetadata(html, page.url);
        } catch { if (!imageUrl) return null; }
      }
      if (!imageUrl) return null;
      const image = await read(imageUrl, IMAGE_LIMIT, signal);
      const trusted = trustedProductImage(imageUrl.href, productUrl);
      if (trusted) { if (imageHints.size >= 64) imageHints.delete(imageHints.keys().next().value!); imageHints.set(productUrl, trusted.href); }
      const contentType = String(image.response.headers['content-type']).split(';')[0].trim().toLowerCase();
      return validImage(image.response.body, contentType) ? { body: image.response.body, contentType } : null;
    } catch { return null; }
  }
  async function fetchProductImage(productUrl: string, imageHint?: string | null, needPrice = false): Promise<PreviewImage | null> {
    const hint = trustedProductImage(imageHint, productUrl);
    if (hint) {
      if (imageHints.size >= 64) imageHints.delete(imageHints.keys().next().value!);
      imageHints.set(productUrl, hint.href);
    }
    imageHint = hint?.href ?? imageHints.get(productUrl);
    const cached = cache.get(productUrl);
    if (cached && cached.expires > Date.now() && (cached.image || !imageHint) && (!needPrice || metadata.has(productUrl))) return cached.image;
    const existing = pending.get(productUrl); if (existing) return existing;
    if (pending.size >= 4) return null;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<null>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, 8000); });
    const work = Promise.race([retrieve(productUrl, controller.signal, imageHint, needPrice), deadline]).then(image => {
      cache.delete(productUrl);
      if (cache.size >= 32) cache.delete(cache.keys().next().value!);
      cache.set(productUrl, { expires: Date.now() + 5 * 60_000, image }); return image;
    }).finally(() => { clearTimeout(timer); pending.delete(productUrl); });
    pending.set(productUrl, work); return work;
  }
  async function resolveAmazonProductUrl(value: string): Promise<string | null> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const work = (async () => {
      let url = httpsUrl(value);
      for (let i = 0; i <= 3; i++) {
        controller.signal.throwIfAborted();
        const host = url.hostname;
        if (isRetailProductUrl(url.href)) return url.href;
        // Only resolve the search engine's source redirect or Amazon's own short links.
        if (!['vertexaisearch.cloud.google.com', 'www.google.com', 'google.com', 'amzn.to', 'amazon.co.jp', 'www.amazon.co.jp'].includes(host)) return null;
        const addresses = await deps.resolve(host);
        controller.signal.throwIfAborted();
        if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) return null;
        const response = await deps.read(url, addresses[0], HTML_LIMIT, controller.signal);
        if (response.body.length > HTML_LIMIT) return null;
        if ([301,302,303,307,308].includes(response.status) && typeof response.headers.location === 'string') {
          url = httpsUrl(response.headers.location, url);
          continue;
        }
        // Some source redirects return a small HTML interstitial rather than HTTP Location.
        if (response.status !== 200 || !['vertexaisearch.cloud.google.com', 'www.google.com', 'google.com'].includes(host)
            || !/^text\/html(?:;|$)/i.test(String(response.headers['content-type']))) return null;
        const destinations = new Set<string>();
        for (const tag of response.body.toString('utf8').match(/<(?:a|meta)\b[^>]*>/gi) ?? []) {
          const attributes: Record<string, string> = {};
          for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) attributes[match[1].toLowerCase()] = decodeHtml(match[2] ?? match[3] ?? match[4]);
          const target = /^<a\b/i.test(tag) ? attributes.href
            : attributes['http-equiv']?.toLowerCase() === 'refresh' ? attributes.content?.match(/^\s*\d+(?:\.\d+)?\s*;\s*url\s*=\s*["']?(.*?)["']?\s*$/i)?.[1] : undefined;
          if (!target) continue;
          try {
            const destination = httpsUrl(target, url);
            if (isRetailProductUrl(destination.href)) destinations.add(destination.href);
          } catch { /* Ignore unsupported destinations. */ }
        }
        return destinations.size === 1 ? destinations.values().next().value! : null;
      }
      return null;
    })().catch(() => null);
    const timeout = new Promise<null>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, 5000); });
    try { return await Promise.race([work, timeout]); } finally { clearTimeout(timer!); }
  }
  async function enrichProduct(product: ProductCandidate): Promise<ProductCandidate> {
    const image = await fetchProductImage(product.productUrl, product.imageUrl, product.priceJpy === null);
    const found = metadata.get(product.productUrl);
    const price = product.priceJpy === null && found?.priceJpy != null
      ? { priceJpy: found.priceJpy, priceCheckedAt: found.checkedAt } : {};
    return { ...product, ...price, imageUrl: image ? trustedProductImage(product.imageUrl || imageHints.get(product.productUrl), product.productUrl)?.href ?? `/api/products/${encodeURIComponent(product.id)}/image` : null };
  }
  async function prepareProduct(product: ProductCandidate): Promise<ProductCandidate | null> {
    const productUrl = await resolveAmazonProductUrl(product.productUrl);
    if (productUrl) return enrichProduct({ ...product, productUrl, sourceUrls: [...new Set([...product.sourceUrls, productUrl])] });
    // 不透明な検索出典を商品扱いしない。記事やQ&Aへの転送は候補から除く。
    return null;
  }
  async function fetchResolvedProductImage(value: string, imageHint?: string | null): Promise<PreviewImage | null> {
    const resolved = await resolveAmazonProductUrl(value);
    return resolved ? fetchProductImage(resolved, imageHint) : null;
  }
  return { enrichProduct, fetchProductImage, resolveAmazonProductUrl, prepareProduct, fetchResolvedProductImage };
}
export const { enrichProduct, fetchProductImage, resolveAmazonProductUrl, prepareProduct, fetchResolvedProductImage } = createProductPreview();
