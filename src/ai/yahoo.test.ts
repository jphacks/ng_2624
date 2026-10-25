import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createYahooShoppingSearch, parseYahooResults } from './yahoo.ts';
import { ConversationError } from './errors.ts';
const request = (query = '工作') => ({ systemInstruction: '', input: JSON.stringify({ query }) });
const hit = (i = 1) => ({ name: `工作${i}`, price: i * 1000, url: `https://store.shopping.yahoo.co.jp/shop/item${i}.html`, image: { medium: `https://item-shopping.c.yimg.jp/i/g/shop_item${i}` } });
const code = (expected: string) => (error: unknown) => error instanceof ConversationError && error.code === expected;

test('v3の商品名・価格・画像・購入URLは同じhitから取得し、不正値や重複を除外する', () => {
 const found=parseYahooResults({hits:[hit(),hit(),{...hit(2),price:null},{...hit(3),url:'http://127.0.0.1/a'}, {...hit(4),image:{medium:'https://127.0.0.1/a'}}, {...hit(5),price:1.5}, { ...hit(6),priceLabel:{fixedPrice:99999}}]});
 assert.deepEqual(found.candidates?.map(p=>[p.name,p.priceJpy,p.imageUrl]),[['工作1',1000,hit().image.medium],['工作4',4000,null],['工作6',6000,hit(6).image.medium]]);
 assert.equal(found.candidates?.[0].productUrl,hit().url);
 assert.deepEqual(found.evidence['yahoo-1'],['工作1。表示価格：￥1,000']);
 assert.throws(()=>parseYahooResults({Error:{Message:'bad'}}),code('API_ERROR'));
 assert.deepEqual(parseYahooResults({hits:[]}).candidates,[]);
});
test('バックエンドのClient IDを固定HTTPSエンドポイントへ送り、キャンセルを伝播する',async()=>{
 const controller=new AbortController();let sent:AbortSignal|null|undefined;
 const search=createYahooShoppingSearch(async(value,init)=>{
  const url=new URL(String(value));assert.equal(url.origin,'https://shopping.yahooapis.jp');assert.equal(url.pathname,'/ShoppingWebService/V3/itemSearch');
  assert.equal(url.searchParams.get('appid'),'server-only');assert.equal(url.searchParams.get('query'),'車 & 動物');assert.equal(url.searchParams.get('image_size'),'300');assert.equal(url.searchParams.has('price_to'),false);assert.equal(init?.redirect,'error');sent=init?.signal;
  return Response.json({hits:[hit(1),hit(2),hit(3)]});
 },()=> 'server-only');
 const result=await search({...request('車 & 動物'),signal:controller.signal});assert.equal(result.candidates?.length,3);controller.abort();assert.equal(sent?.aborted,true);
});
test('環境変数は検索時に取得し、未設定と不正入力では通信しない',async()=>{
 const original=process.env.YAHOO_SHOPPING_APP_ID;let calls=0;
 try{
  delete process.env.YAHOO_SHOPPING_APP_ID;
  const search=createYahooShoppingSearch(async()=>{calls++;return Response.json({hits:[]});});
  await assert.rejects(search(request()),code('MISSING_API_KEY'));
  process.env.YAHOO_SHOPPING_APP_ID='from-env';await search(request());assert.equal(calls,1);
  await assert.rejects(search(request('')),code('INVALID_INPUT'));assert.equal(calls,1);
 }finally{if(original===undefined)delete process.env.YAHOO_SHOPPING_APP_ID;else process.env.YAHOO_SHOPPING_APP_ID=original;}
});
test('HTTPエラー・不正JSON・過大な応答・通信失敗は秘密を含めず返す',async()=>{
 for(const response of [new Response('denied',{status:403}),new Response('busy',{status:503}),new Response('html'),new Response('{',{headers:{'content-type':'application/json'}}),Response.json({error:'bad'}),new Response(' '.repeat(2*1024*1024+1),{headers:{'content-type':'application/json'}})]){
  await assert.rejects(createYahooShoppingSearch(async()=>response,()=> 'secret')(request()),code('API_ERROR'));
 }
 await assert.rejects(createYahooShoppingSearch(async()=>{throw Error('https://example/?appid=secret');},()=> 'secret')(request()),e=>code('API_ERROR')(e)&&!(e as Error).message.includes('secret'));
});
test('429のRetry-Afterと1秒あたりの制限は同じプロバイダーの後続検索にも適用する',async()=>{
 for(const retry of ['60',new Date(Date.now()+60000).toUTCString(),'invalid']){
  let calls=0;const search=createYahooShoppingSearch(async()=>{calls++;return new Response('',{status:429,headers:{'Retry-After':retry}});},()=> 'id');
  await assert.rejects(search(request()),code('RATE_LIMIT'));await assert.rejects(search(request('別の商品')),code('RATE_LIMIT'));assert.equal(calls,1);
 }
 let calls=0;const search=createYahooShoppingSearch(async()=>{calls++;return Response.json({hits:[]});},()=> 'id');
 await Promise.all([search(request()),assert.rejects(search(request()),code('RATE_LIMIT'))]);assert.equal(calls,1);
});
test('呼び出し元のキャンセルをTIMEOUTとして処理する',async()=>{
 const controller=new AbortController();const search=createYahooShoppingSearch(async(_url,init)=>new Promise((_resolve,reject)=>{init?.signal?.addEventListener('abort',()=>reject(init.signal!.reason),{once:true});}),()=> 'id');
 const pending=assert.rejects(search({...request(),signal:controller.signal}),code('TIMEOUT'));controller.abort();await pending;
 const timed=createYahooShoppingSearch(async()=>{throw new DOMException('expired','TimeoutError');},()=> 'id');await assert.rejects(timed(request()),code('TIMEOUT'));
});
test('条件を緩める追加検索は1秒以上空け、失敗時も取得済みの商品を返す',async()=>{
 let calls=0;const times:number[]=[];const search=createYahooShoppingSearch(async()=>{times.push(Date.now());if(++calls===2)throw Error('network');return Response.json({hits:[hit()]});},()=> 'id');
 const found=await search(request('工作 キット'));assert.equal(found.candidates?.length,1);assert.equal(calls,2);assert.ok(times[1]-times[0]>=1000);
});

test('8秒を超えるリクエストを実際に中断する',async()=>{
 const started=Date.now();const search=createYahooShoppingSearch(async(_url,init)=>new Promise((_resolve,reject)=>{
  init?.signal?.addEventListener('abort',()=>reject(init.signal!.reason),{once:true});
 }),()=> 'id');
 // AbortSignalのタイマーはunrefのため、このテスト中だけイベントループを保持する。
 const keepAlive=setInterval(()=>{},1000);
 try{await assert.rejects(search(request()),code('TIMEOUT'));assert.ok(Date.now()-started>=7900);}finally{clearInterval(keepAlive);}
});
