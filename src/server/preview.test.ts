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
  assert.equal((await preview.enrichProduct(candidate)).imageUrl, '/api/products/product-1/image');
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
test('検索の引用リンクの解決失敗でゲーム候補を削除せず、未確認と明示する',async()=>{
  const preview=createProductPreview({resolve:async()=>[publicAddress],read:async()=>{throw new Error('upstream unavailable');}});
  const source='https://vertexaisearch.cloud.google.com/grounding-api-redirect/source-1';
  const candidate={...product,name:'ゲーム',productUrl:source,sourceUrls:[source]};
  const result=await preview.prepareProduct(candidate);
  assert.equal(result?.name,'ゲーム');assert.equal(result?.productUrl,source);assert.equal(result?.imageUrl,null);
  assert.match(result!.recommendationReason,/未確認/);
  assert.equal(await preview.prepareProduct({...candidate,sourceUrls:[]}),null);
  for(const value of ['https://evil.test/product','https://vertexaisearch.cloud.google.com.evil.test/grounding-api-redirect/id','http://vertexaisearch.cloud.google.com/grounding-api-redirect/id','https://vertexaisearch.cloud.google.com/other']){
    assert.equal(await preview.prepareProduct({...candidate,productUrl:value,sourceUrls:[value]}),null);
  }
});
