import test from 'node:test';
import assert from 'node:assert/strict';
import { isProductSourceUrl } from './search.ts';

test('商品候補には個別商品ページだけを採用する', () => {
    for (const url of [
        'https://www.amazon.co.jp/dp/B08H93GKNJ',
        'https://amazon.co.jp/example/dp/B08H93GKNJ?th=1',
        'https://www.amazon.co.jp/gp/product/B08H93GKNJ',
        'https://item.rakuten.co.jp/example/switch/',
        'https://www.yodobashi.com/product/100000001005738823/',
        'https://www.biccamera.com/bc/item/8395831/',
        'https://store-jp.nintendo.com/item/software/D70010000000130/',
    ]) assert.equal(isProductSourceUrl(url), true, url);
    for (const url of [
        'https://detail.chiebukuro.yahoo.co.jp/qa/question_detail/q13238828848',
        'https://www.inside-games.jp/article/2021/04/29/132124.html',
        'https://www.amazon.co.jp/s?k=ゲーム',
        'https://www.amazon.co.jp/bestsellers/videogames',
        'https://amazon.co.jp.example.org/dp/B08H93GKNJ',
        'https://www.yodobashi.com/category/140007/',
        'https://www.biccamera.com/bc/category/001/150/',
        'https://item.rakuten.co.jp/example/',
    ]) assert.equal(isProductSourceUrl(url), false, url);
});

test('不透明な検索出典は後段で実際の商品URLを確認する', () => {
    assert.equal(isProductSourceUrl('https://vertexaisearch.cloud.google.com/grounding-api-redirect/example'), true);
    assert.equal(isProductSourceUrl('https://vertexaisearch.cloud.google.com/article/example'), false);
});
