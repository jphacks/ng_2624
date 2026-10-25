import test from 'node:test';
import assert from 'node:assert/strict';
import { parseYodobashiResults, searchYodobashi, searchRetail } from './retail.ts';

function card(sku: string, name: string, price: string, extra = ''): string {
    return `<div data-sku="${sku}" class="srcResultItem_block pListBlock"><a href="/product/${sku}/"><div class="pImg mb15"><img alt="${name}" onerror="this.src='https://image.yodobashi.com/product/NoImage_180x180.jpg'" src="https://image.yodobashi.com/product/100/000/001/009/063/421/${sku}_10205.jpg"/></div></a><span class="productPrice">￥${price}</span>${extra}</div><!-- /pListBlock -->`;
}
const html = card('100000001009063421', 'Nintendo Switch 2 &amp; 本体', '59,980') + card('100000001010200724', 'ゼルダの伝説', '8,530') + card('100000001010200725', '売切', '60,000', '予約受付を終了しました');
test('実商品のカードごとに画像・価格・商品URLを対応付ける', () => {
    const result = parseYodobashiResults(html);
    assert.equal(result.candidates!.length, 2);
    assert.equal(result.candidates![0].name, 'Nintendo Switch 2 & 本体');
    assert.equal(result.candidates![0].priceJpy, 59980);
    assert.equal(result.candidates![1].priceJpy, 8530);
    assert.match(result.candidates![1].imageUrl!, /100000001010200724_10205.jpg$/);
    assert.equal(result.candidates![1].productUrl, 'https://www.yodobashi.com/product/100000001010200724/');
});
test('画像欠落・価格欠落・別商品の画像を候補にしない', () => {
    assert.equal(parseYodobashiResults(card('100000001009063421', '商品', '0')).candidates!.length, 0);
    assert.equal(parseYodobashiResults(html.replaceAll('https://image.yodobashi.com/product/100/', 'https://evil.example/product/100/')).candidates!.length, 0);
    assert.equal(parseYodobashiResults('<title>Access denied</title>').candidates!.length, 0);
});
test('固定ホストの検索で取得し、巨大な応答を拒否する', async () => {
    const request = { input: JSON.stringify({ query: 'ゲーム' }), systemInstruction: '' };
    const result = await searchYodobashi(request, (async (url, init) => {
        assert.equal(new URL(String(url)).hostname, 'www.yodobashi.com');
        assert.equal(new URL(String(url)).searchParams.get('word'), 'ゲーム');
        assert.equal(init!.redirect, 'error');
        return new Response(html, { headers: { 'content-type': 'text/html' } });
    }) as typeof fetch);
    assert.equal(result.candidates!.length, 2);
    await assert.rejects(searchYodobashi(request, (async () => new Response('x'.repeat(4 * 1024 * 1024 + 1), { headers: { 'content-type': 'text/html' } })) as typeof fetch));
});
test('互換入口もYahoo! APIを使い、別販売店に切り替えない', async () => {
    const original=process.env.YAHOO_SHOPPING_APP_ID;
    process.env.YAHOO_SHOPPING_APP_ID='test-only';
    try {
        let calls=0;
        await assert.rejects(searchRetail({input:JSON.stringify({query:'ゲーム'}),systemInstruction:''},async url=>{
            calls++;assert.equal(new URL(String(url)).hostname,'shopping.yahooapis.jp');
            return new Response('unavailable',{status:503});
        }));
        assert.equal(calls,1);
    } finally {if(original===undefined)delete process.env.YAHOO_SHOPPING_APP_ID;else process.env.YAHOO_SHOPPING_APP_ID=original;}
});
