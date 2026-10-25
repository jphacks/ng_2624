import test from 'node:test';
import assert from 'node:assert/strict';
import { createProductPreview, isPublicAddress } from './preview.ts';
import type { ProductCandidate } from '../shared/types.ts';
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const product: ProductCandidate = { id: 'product-1', name: '商品', priceJpy: 3000, productUrl: 'https://shop.test/product', size: 'small', description: '', recommendationReason: '', sourceUrls: [], imageUrl: 'https://127.0.0.1/secret' };
const publicAddress = { address: '93.184.216.34', family: 4 };
const html = (body: string) => ({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: Buffer.from(body) });
const pngResponse = () => ({ status: 200, headers: { 'content-type': 'image/png' }, body: png });

test('rejects reserved, private, loopback, mapped, transition and documentation addresses', () => {
  for (const address of ['0.0.0.0', '127.0.0.1', '10.2.3.4', '172.16.0.1', '192.168.0.1', '169.254.169.254', '100.64.0.1', '198.18.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '::1', '::ffff:8.8.8.8', 'fc00::1', 'fe80::1', '2002:0808:0808::1', '2001:db8::1', '2001::1']) assert.equal(isPublicAddress(address), false, address);
  for (const address of ['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111']) assert.equal(isPublicAddress(address), true, address);
});
test('OG image becomes same-origin proxy, preserving product data; caches and coalesces requests', async () => {
  let calls = 0;
  const preview = createProductPreview({ resolve: async () => [publicAddress], read: async (url, address) => {
    calls++; assert.deepEqual(address, publicAddress);
    return url.pathname === '/product' ? html('<meta content="/photo?a=1&amp;b=2" property="og:image">') : (assert.equal(url.search, '?a=1&b=2'), pngResponse());
  } });
  const [a, b] = await Promise.all([preview.enrichProduct(product), preview.enrichProduct(product)]);
  assert.deepEqual(a, { ...product, imageUrl: '/api/products/product-1/image' }); assert.deepEqual(a, b);
  assert.deepEqual(await preview.fetchProductImage(product.productUrl), { body: png, contentType: 'image/png' }); assert.equal(calls, 2);
});
test('rejects unsafe URLs before making a request', async () => {
  let calls = 0;
  const preview = createProductPreview({ resolve: async () => [publicAddress], read: async () => { calls++; return pngResponse(); } });
  for (const url of ['http://shop.test/a', 'https://user:pass@shop.test/a', 'https://shop.test:8443/a', 'https://127.1/a', 'https://0x7f000001/a', 'https://[::1]/a']) assert.equal(await preview.fetchProductImage(url), null);
  assert.equal(calls, 0);
});
test('rejects mixed public/private DNS answers and private image DNS', async () => {
  let calls = 0;
  const mixed = createProductPreview({ resolve: async () => [publicAddress, { address: '10.0.0.1', family: 4 }], read: async () => { calls++; return pngResponse(); } });
  assert.equal(await mixed.fetchProductImage(product.productUrl), null); assert.equal(calls, 0);
  const image = createProductPreview({ resolve: async host => host === 'shop.test' ? [publicAddress] : [{ address: '169.254.169.254', family: 4 }], read: async () => { calls++; return html('<meta property="og:image" content="https://metadata.test/secret">'); } });
  assert.equal(await image.fetchProductImage(product.productUrl), null); assert.equal(calls, 1);
});
test('revalidates redirects and bounds redirect loops', async () => {
  let calls = 0;
  const preview = createProductPreview({ resolve: async () => [publicAddress], read: async () => { calls++; return { status: 302, headers: { location: 'https://127.0.0.1/private' }, body: Buffer.alloc(0) }; } });
  assert.equal(await preview.fetchProductImage(product.productUrl), null); assert.equal(calls, 1);
  calls = 0;
  const loop = createProductPreview({ resolve: async () => [publicAddress], read: async () => { calls++; return { status: 302, headers: { location: '/loop' }, body: Buffer.alloc(0) }; } });
  assert.equal(await loop.fetchProductImage(product.productUrl), null); assert.equal(calls, 4);
});
test('rejects oversized pages/images, SVG and content-type spoofing', async () => {
  for (const response of [
    { status: 200, headers: { 'content-type': 'image/png' }, body: Buffer.alloc(2 * 1024 * 1024 + 1) },
    { status: 200, headers: { 'content-type': 'image/svg+xml' }, body: Buffer.from('<svg/>') },
    { status: 200, headers: { 'content-type': 'image/png' }, body: Buffer.from('<html>bad</html>') },
  ]) {
    const preview = createProductPreview({ resolve: async () => [publicAddress], read: async url => url.pathname === '/product' ? html('<meta name="twitter:image" content="/photo">') : response });
    assert.equal(await preview.fetchProductImage(product.productUrl), null);
  }
  const preview = createProductPreview({ resolve: async () => [publicAddress], read: async () => html(' '.repeat(512 * 1024 + 1)) });
  assert.equal(await preview.fetchProductImage(product.productUrl), null);
});
test('missing metadata removes unverified AI image and preserves other fields', async () => {
  const preview = createProductPreview({ resolve: async () => [publicAddress], read: async () => html('<title>Product</title>') });
  assert.deepEqual(await preview.enrichProduct(product), { ...product, imageUrl: null });
});

test('Amazon search image goes straight to the verified CDN without fetching the product HTML', async () => {
  const calls: string[] = [];
  const preview = createProductPreview({ resolve: async () => [publicAddress], read: async url => { calls.push(url.href); return pngResponse(); } });
  const candidate = { ...product, productUrl: 'https://www.amazon.co.jp/dp/B000000001', imageUrl: 'https://m.media-amazon.com/images/I/actual-product.png' };
  assert.equal((await preview.enrichProduct(candidate)).imageUrl, candidate.imageUrl);
  assert.deepEqual(calls, [candidate.imageUrl]);
  assert.deepEqual(await preview.fetchProductImage(candidate.productUrl), { body: png, contentType: 'image/png' });
  assert.equal(calls.length, 1);
});

test('Amazon product pages over 512KB can use their main image without OG metadata', async () => {
  const page = ' '.repeat(512 * 1024) + '<img id="landingImage" src="https://m.media-amazon.com/images/I/actual-product.png">';
  const preview = createProductPreview({ resolve: async () => [publicAddress], read: async (url, _address, limit) => {
    if (url.hostname === 'www.amazon.co.jp') { assert.equal(limit, 4 * 1024 * 1024); return html(page); }
    return pngResponse();
  } });
  assert.deepEqual(await preview.fetchProductImage('https://www.amazon.co.jp/dp/B000000001'), { body: png, contentType: 'image/png' });
});
test('Amazon dynamic main image metadata supplies a real CDN image', async () => {
  const preview = createProductPreview({ resolve: async () => [publicAddress], read: async url =>
    url.hostname === 'www.amazon.co.jp' ? html('<img id="landingImage" data-a-dynamic-image="{&quot;https://m.media-amazon.com/images/I/actual.png&quot;:[600,600]}">') : pngResponse() });
  assert.deepEqual(await preview.fetchProductImage('https://www.amazon.co.jp/dp/B000000001'), { body: png, contentType: 'image/png' });
});
test('Google HTML source redirects resolve a unique real Amazon destination and its image', async () => {
  const source = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/source';
  const direct = 'https://www.amazon.co.jp/dp/B000000001';
  for (const redirect of [`<a href="${direct}">Continue</a>`, `<meta http-equiv="refresh" content="0;url=${direct}">`]) {
    const preview = createProductPreview({ resolve: async () => [publicAddress], read: async url =>
      url.hostname === 'vertexaisearch.cloud.google.com' ? html(redirect) : url.hostname === 'www.amazon.co.jp'
        ? html('<img id="landingImage" src="https://m.media-amazon.com/images/I/actual.png">') : pngResponse() });
    const result = await preview.prepareProduct({ ...product, productUrl: source, sourceUrls: [source] });
    assert.equal(result?.productUrl, direct);
    assert.equal(result?.imageUrl, '/api/products/product-1/image');
  }
});
test('HTML source resolution rejects ambiguous, oversized, unsafe and unrelated destinations', async () => {
  for (const body of [
    '<a href="https://www.amazon.co.jp/dp/B000000001">A</a><a href="https://www.amazon.co.jp/dp/B000000002">B</a>',
    '<meta http-equiv="refresh" content="0;url=https://127.0.0.1/dp/B000000001">',
    '<a href="https://amazon.co.jp.evil.test/dp/B000000001">A</a>',
    ' '.repeat(512 * 1024 + 1),
  ]) {
    let calls = 0;
    const preview = createProductPreview({ resolve: async () => [publicAddress], read: async () => { calls++; return html(body); } });
    assert.equal(await preview.resolveAmazonProductUrl('https://vertexaisearch.cloud.google.com/grounding-api-redirect/source'), null);
    assert.equal(calls, 1);
  }
});
test('Amazon source resolution accepts product paths and rejects other destinations or unsafe DNS', async () => {
  const direct='https://www.amazon.co.jp/dp/B000000000';let calls=0;
  const preview=createProductPreview({resolve:async()=>[publicAddress],read:async()=>{calls++;return {status:302,headers:{location:direct},body:Buffer.alloc(0)};}});
  assert.equal(await preview.resolveAmazonProductUrl(direct),direct);assert.equal(calls,0);
  assert.equal(await preview.resolveAmazonProductUrl('https://amzn.to/test'),direct);assert.equal(calls,1);
  for(const value of ['https://amazon.co.jp.evil.test/dp/B000000000','https://evil.test/dp/B000000000','http://www.amazon.co.jp/dp/B000000000','https://user@www.amazon.co.jp/dp/B000000000'])assert.equal(await preview.resolveAmazonProductUrl(value),null);
  const blocked=createProductPreview({resolve:async()=>[{address:'127.0.0.1',family:4}],read:async()=>{throw Error('must not fetch');}});
  assert.equal(await blocked.resolveAmazonProductUrl('https://amzn.to/test'),null);
});

test('ゲーム3件は画像取得が拒否されても全件表示用に残る',async()=>{
  const preview=createProductPreview({resolve:async()=>[publicAddress],read:async()=>({status:503,headers:{},body:Buffer.alloc(0)})});
  const candidates=Array.from({length:3},(_,i)=>({...product,id:`game-${i}`,name:`ゲーム${i}`,productUrl:`https://www.amazon.co.jp/dp/B00000000${i}`,sourceUrls:[`https://www.amazon.co.jp/dp/B00000000${i}`]}));
  const result=await Promise.all(candidates.map(p=>preview.prepareProduct(p)));
  assert.equal(result.filter(Boolean).length,3);assert.ok(result.every(p=>p?.imageUrl===null));
});
test('記事やQ&Aを商品の出典として残さない',async()=>{
  for(const destination of ['https://detail.chiebukuro.yahoo.co.jp/qa/question_detail/q13238828848','https://www.inside-games.jp/article/2021/04/29/132124.html']){
    const preview=createProductPreview({resolve:async()=>[publicAddress],read:async()=>({status:302,headers:{location:destination},body:Buffer.alloc(0)})});
    const source='https://vertexaisearch.cloud.google.com/grounding-api-redirect/source-1';
    assert.equal(await preview.prepareProduct({...product,productUrl:source,sourceUrls:[source]}),null);
  }
});

test('保存済みの引用URLからも実際の商品画像を再取得できる',async()=>{
 const preview=createProductPreview({resolve:async()=>[publicAddress],read:async url=>{
  if(url.hostname==='vertexaisearch.cloud.google.com')return html('<a href="https://www.amazon.co.jp/dp/B000000001">Amazon商品</a>');
  if(url.hostname==='www.amazon.co.jp')return html('<meta property="og:image" content="https://m.media-amazon.com/images/I/game.jpg">');
  return pngResponse();
 }});
 assert.deepEqual(await preview.fetchResolvedProductImage('https://vertexaisearch.cloud.google.com/grounding-api-redirect/game'),{body:png,contentType:'image/png'});
 assert.equal(await preview.fetchResolvedProductImage('https://evil.test/product'),null);
});

test('one product HTML read restores actual JPY offer and image together', async () => {
  let pageReads = 0;
  const preview = createProductPreview({ resolve: async () => [publicAddress], read: async url => {
    if (url.hostname !== 'www.amazon.co.jp') return pngResponse();
    pageReads++;
    return html('<script type="application/ld+json">{"@type":"Product","offers":{"priceCurrency":"JPY","price":"6,980"}}</script><meta property="og:image" content="https://m.media-amazon.com/images/I/game.png">');
  } });
  const candidate = { ...product, priceJpy: null, productUrl: 'https://www.amazon.co.jp/dp/B000000001', imageUrl: null };
  const result = await preview.enrichProduct(candidate);
  assert.equal(result.priceJpy, 6980);
  assert.ok(result.priceCheckedAt && !Number.isNaN(Date.parse(result.priceCheckedAt)));
  assert.equal(result.imageUrl, 'https://m.media-amazon.com/images/I/game.png');
  await preview.enrichProduct(candidate);
  assert.equal(pageReads, 1);
});

test('JPY metadata and current Amazon price widgets restore prices without inventing numbers', async () => {
  for (const [body, expected] of [
    ['<meta property="product:price:currency" content="JPY"><meta property="product:price:amount" content="4990">', 4990],
    ['<span id="priceblock_ourprice">￥3,980</span>', 3980],
    ['<div id="corePrice_feature_div"><span class="a-price"><span class="a-offscreen">￥7,980</span></span></div>', 7980],
    ['<script type="application/ld+json">{"@type":"Product","offers":{"priceCurrency":"USD","price":39}}</script>', null],
    ['<script type="application/ld+json">{"@type":"Product","offers":{"price":3999}}</script><p>ポイント 100 円</p>', null],
    ['<div id="recommendations"><span class="a-price"><span class="a-offscreen">￥1,000</span></span></div>', null],
    ['<div id="corePrice_feature_div"></div><div id="recommendations"><span class="a-price"><span class="a-offscreen">￥1,000</span></span></div>', null],
    ['<div id="corePrice_feature_div"><span class="a-price a-text-price"><span class="a-offscreen">￥9,980</span></span><span class="a-price"><span class="a-offscreen">￥7,980</span></span></div>', 7980],
  ] as const) {
    const preview = createProductPreview({ resolve: async () => [publicAddress], read: async () => html(body) });
    const result = await preview.enrichProduct({ ...product, priceJpy: null, imageUrl: null, productUrl: 'https://www.amazon.co.jp/dp/B000000001' });
    assert.equal(result.priceJpy, expected, body);
  }
});

test('failed price lookup preserves a trusted native image hint', async () => {
  const preview = createProductPreview({ resolve: async () => [publicAddress], read: async url => {
    if (url.hostname === 'www.amazon.co.jp') throw new Error('Amazon denied HTML');
    return pngResponse();
  } });
  const result = await preview.enrichProduct({ ...product, priceJpy: null, productUrl: 'https://www.amazon.co.jp/dp/B000000001', imageUrl: 'https://m.media-amazon.com/images/I/game.png' });
  assert.equal(result.priceJpy, null);
  assert.equal(result.imageUrl, 'https://m.media-amazon.com/images/I/game.png');
});

test('JSON-LD Product image objects support link previews without OG tags', async () => {
  const preview = createProductPreview({ resolve: async () => [publicAddress], read: async url => url.hostname === 'www.amazon.co.jp'
    ? html('<script type="application/ld+json">{"@graph":[{"@type":"Product","image":{"url":"https://m.media-amazon.com/images/I/real.png"},"offers":{"priceCurrency":"JPY","price":7980}}]}</script>') : pngResponse() });
  const result = await preview.enrichProduct({ ...product, priceJpy: null, imageUrl: null, productUrl: 'https://www.amazon.co.jp/dp/B000000001' });
  assert.equal(result.imageUrl, 'https://m.media-amazon.com/images/I/real.png');
  assert.equal(result.priceJpy, 7980);
});

test('販売店の検索カードから得た実画像を、商品HTMLの取得失敗でも配信する',async()=>{
 const imageUrl='https://image.yodobashi.com/product/100/000/001/009/063/421/100000001009063421_10205.jpg';
 let pages=0;
 const preview=createProductPreview({resolve:async()=>[publicAddress],read:async url=>{
  if(url.hostname==='image.yodobashi.com')return pngResponse();
  pages++;throw Error('product HTML unavailable');
 }});
 const candidate={...product,priceJpy:59980,productUrl:'https://www.yodobashi.com/product/100000001009063421/',imageUrl};
 const enriched=await preview.prepareProduct(candidate);
 assert.equal(enriched?.imageUrl,imageUrl);assert.equal(enriched?.priceJpy,59980);assert.equal(pages,0);
 assert.deepEqual(await preview.fetchResolvedProductImage(candidate.productUrl),{body:png,contentType:'image/png'});
});

 test('stored native image hint survives a fresh preview instance with product HTML unavailable',async()=>{
 const candidate={...product,productUrl:'https://www.amazon.co.jp/dp/B000000001',imageUrl:'https://m.media-amazon.com/images/I/persisted.png'};
 let pages=0;
 const deps={resolve:async()=>[publicAddress],read:async(url:URL)=>{if(url.hostname==='www.amazon.co.jp'){pages++;throw Error('unavailable');}return pngResponse();}};
 const saved=await createProductPreview(deps).enrichProduct(candidate);
 assert.deepEqual(await createProductPreview(deps).fetchResolvedProductImage(saved.productUrl,saved.imageUrl),{body:png,contentType:'image/png'});
 assert.equal(pages,0);
});

test('楽天の商品メタデータ画像も保存して、再起動後に商品ページを再取得せず表示する',async()=>{
 const imageUrl='https://image.rakuten.co.jp/toyshop/cabinet/phone.png';
 const candidate={...product,productUrl:'https://item.rakuten.co.jp/toyshop/phone/',imageUrl:null};
 const saved=await createProductPreview({resolve:async()=>[publicAddress],read:async url=>url.hostname==='item.rakuten.co.jp'?html(`<meta property="og:image" content="${imageUrl}">`):pngResponse()}).enrichProduct(candidate);
 assert.equal(saved.imageUrl,imageUrl);
 let reads=0;
 const fresh=createProductPreview({resolve:async()=>[publicAddress],read:async url=>{reads++;assert.equal(url.href,imageUrl);return pngResponse();}});
 assert.deepEqual(await fresh.fetchResolvedProductImage(saved.productUrl,saved.imageUrl),{body:png,contentType:'image/png'});assert.equal(reads,1);
});

test('Yahoo! APIの画像を既存のプロキシで取得し、商品選択用の価格とURLを維持する',async()=>{
 const urls:string[]=[];
 const preview=createProductPreview({resolve:async()=>[publicAddress],read:async value=>{urls.push(value.href);return pngResponse();}});
 const candidate={...product,productUrl:'https://store.shopping.yahoo.co.jp/shop/item.html',imageUrl:'https://item-shopping.c.yimg.jp/i/g/shop_item'};
 const prepared=await preview.prepareProduct(candidate);
 assert.equal(prepared?.priceJpy,3000);assert.equal(prepared?.productUrl,candidate.productUrl);assert.equal(prepared?.imageUrl,candidate.imageUrl);
 assert.deepEqual(urls,[candidate.imageUrl]);assert.ok(await preview.fetchResolvedProductImage(candidate.productUrl,candidate.imageUrl));
});
test('Yahoo!の画像ヒントも不正ホスト・プライベートIPへの転送を許可しない',async()=>{
 let reads=0;
 const preview=createProductPreview({resolve:async()=>[publicAddress],read:async value=>{reads++;if(value.hostname==='item-shopping.c.yimg.jp')return {status:302,headers:{location:'https://127.0.0.1/secret'},body:Buffer.alloc(0)};return html('<html></html>');}});
 const url='https://store.shopping.yahoo.co.jp/shop/item.html';
 assert.equal(await preview.fetchResolvedProductImage(url,'https://evil.example/a.png'),null);
 assert.equal(reads,1);assert.equal(await preview.fetchResolvedProductImage(url,'https://item-shopping.c.yimg.jp/i/g/shop_item'),null);assert.equal(reads,2);
});
