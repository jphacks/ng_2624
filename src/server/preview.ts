import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request } from 'node:https';
import type { ProductCandidate } from '../shared/types.ts';

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
  if (amazonHost(base)) for (const tag of html.match(/<img\b[^>]*>/gi) ?? []) {
    if (!/\sid=["'](?:landingImage|imgBlkFront|main-image)["']/i.test(tag)) continue;
    const attributes: Record<string, string> = {};
    for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attributes[match[1].toLowerCase()] = decodeHtml(match[2] ?? match[3]);
    const image = amazonImage(attributes['data-old-hires']) ?? amazonImage(attributes.src);
    if (image) return image;
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
  async function retrieve(productUrl: string, signal: AbortSignal, imageHint?: string | null): Promise<PreviewImage | null> {
    try {
      const product = httpsUrl(productUrl);
      let imageUrl = amazonHost(product) ? amazonImage(imageHint) : null;
      if (!imageUrl) {
        const page = await read(product, amazonHost(product) ? AMAZON_HTML_LIMIT : HTML_LIMIT, signal);
        if (!/^text\/html(?:;|$)/i.test(String(page.response.headers['content-type']))) return null;
        imageUrl = imageMetadata(page.response.body.toString('utf8'), page.url);
      }
      if (!imageUrl) return null;
      const image = await read(imageUrl, IMAGE_LIMIT, signal);
      const contentType = String(image.response.headers['content-type']).split(';')[0].trim().toLowerCase();
      return validImage(image.response.body, contentType) ? { body: image.response.body, contentType } : null;
    } catch { return null; }
  }
  async function fetchProductImage(productUrl: string, imageHint?: string | null): Promise<PreviewImage | null> {
    const cached = cache.get(productUrl);
    if (cached && cached.expires > Date.now() && (cached.image || !imageHint)) return cached.image;
    const existing = pending.get(productUrl); if (existing) return existing;
    if (pending.size >= 4) return null;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<null>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, 8000); });
    const work = Promise.race([retrieve(productUrl, controller.signal, imageHint), deadline]).then(image => {
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
        if ((host === 'amazon.co.jp' || host === 'www.amazon.co.jp') && /\/(?:dp|gp\/product)\/[A-Z0-9]{10}(?:[/?]|$)/i.test(url.pathname)) return url.href;
        // Only resolve the search engine's source redirect or Amazon's own short links.
        if (!['vertexaisearch.cloud.google.com', 'www.google.com', 'google.com', 'amzn.to', 'amazon.co.jp', 'www.amazon.co.jp'].includes(host)) return null;
        const addresses = await deps.resolve(host);
        controller.signal.throwIfAborted();
        if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) return null;
        const response = await deps.read(url, addresses[0], HTML_LIMIT, controller.signal);
        if (![301,302,303,307,308].includes(response.status) || typeof response.headers.location !== 'string') return null;
        url = httpsUrl(response.headers.location, url);
      }
      return null;
    })().catch(() => null);
    const timeout = new Promise<null>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, 5000); });
    try { return await Promise.race([work, timeout]); } finally { clearTimeout(timer!); }
  }
  async function enrichProduct(product: ProductCandidate): Promise<ProductCandidate> {
    const image = await fetchProductImage(product.productUrl, product.imageUrl);
    return { ...product, imageUrl: image ? `/api/products/${encodeURIComponent(product.id)}/image` : null };
  }
  async function prepareProduct(product: ProductCandidate): Promise<ProductCandidate | null> {
    const productUrl = await resolveAmazonProductUrl(product.productUrl);
    if (productUrl) return enrichProduct({ ...product, productUrl });
    // 検索サービスの引用URLを解決できなくても、検索済み候補は残す。
    // 未確認のAmazon URLは生成せず、引用された出典リンクをそのまま保持する。
    try {
      const source = httpsUrl(product.productUrl);
      if (source.hostname !== 'vertexaisearch.cloud.google.com' || !source.pathname.startsWith('/grounding-api-redirect/')
          || !product.sourceUrls.includes(product.productUrl)) return null;
      return { ...product, imageUrl: null, recommendationReason: product.recommendationReason + ' 商品ページへの接続は未確認です。出典で確認してください。' };
    } catch { return null; }
  }
  return { enrichProduct, fetchProductImage, resolveAmazonProductUrl, prepareProduct };
}
export const { enrichProduct, fetchProductImage, resolveAmazonProductUrl, prepareProduct } = createProductPreview();
