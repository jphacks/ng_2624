import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../../frontend/api.js', import.meta.url), 'utf8');
function client(send: (url: string, options: RequestInit) => Promise<Response>) {
  const delays: number[] = [], window: any = {};
  vm.runInNewContext(source, { window, fetch: send, AbortSignal, TextDecoder, setTimeout(resolve: () => void, delay: number) { delays.push(delay); resolve(); } });
  return { api: window.API, delays };
}

test('GET recovers from a gateway HTML response and preserves CSRF for later saves', async () => {
  const calls: { url: string; options: RequestInit }[] = [];
  const { api, delays } = client(async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return new Response('<html>Starting</html>', { status: 502 });
    return Response.json({ data: { csrfToken: 'csrf', authenticated: true } });
  });
  assert.equal((await api.request('/auth/session')).authenticated, true);
  assert.deepEqual(delays, [1000]);
  await api.request('/profile', 'PATCH', { displayName: '親' });
  assert.equal(calls.length, 3);
  assert.equal(calls[1].url, '/api/auth/session');
  assert.equal(calls[1].options.credentials, 'same-origin');
  assert.equal((calls[2].options.headers as Record<string, string>)['X-CSRF-Token'], 'csrf');
});

test('GET retries a network failure and successful HTML responses within a fixed limit', async () => {
  let attempts = 0;
  const { api, delays } = client(async () => {
    attempts++;
    if (attempts === 1) throw Error('Connection reset');
    return new Response('<html>Starting</html>');
  });
  await assert.rejects(api.request('/dashboard'), /サーバーの応答を確認できません/);
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [1000, 2000]);
});

test('exhausted network retries report failure', async () => {
  let attempts = 0;
  const { api } = client(async () => { attempts++; throw Error('Offline'); });
  await assert.rejects(api.request('/auth/session'), /通信結果を確認できません/);
  assert.equal(attempts, 3);
});

test('saving and deleting are never automatically resent after network or HTML failures', async () => {
  for (const method of ['POST', 'PATCH', 'DELETE']) {
    for (const networkFailure of [false, true]) {
      let attempts = 0;
      const { api, delays } = client(async () => {
        attempts++;
        if (networkFailure) throw Error('Connection reset');
        return new Response('<html>Bad gateway</html>', { status: 502 });
      });
      await assert.rejects(api.request('/profile', method, {}));
      assert.equal(attempts, 1);
      assert.deepEqual(delays, []);
    }
  }
});

test('JSON application errors retain their code and status without retrying', async () => {
  for (const status of [401, 403, 503]) {
    let attempts = 0;
    const { api, delays } = client(async () => {
      attempts++;
      return Response.json({ error: { code: 'SETUP_REQUIRED', message: '設定を確認してください。' } }, { status });
    });
    await assert.rejects(api.request('/auth/session'), { code: 'SETUP_REQUIRED', status, message: '設定を確認してください。' });
    assert.equal(attempts, 1);
    assert.deepEqual(delays, []);
  }
});

test('nontransient HTTP failures and invalid JSON envelopes do not loop', async () => {
  for (const response of [new Response('Forbidden', { status: 403 }), Response.json(null), Response.json({})]) {
    let attempts = 0;
    const { api } = client(async () => { attempts++; return response; });
    await assert.rejects(api.request('/auth/session'), /サーバーの応答/);
    assert.equal(attempts, 1);
  }
});

test('検索開始を受信した時点で表示し、結果を待ってからdataを返す',async()=>{
 let finish!:(value:Uint8Array)=>void;
 const encoder=new TextEncoder(),waiting=new Promise<Uint8Array>(resolve=>{finish=resolve;});
 const progress:string[]=[];
 const {api}=client(async()=>new Response(new ReadableStream({async start(controller){controller.enqueue(encoder.encode('{"progress":"searching"}\n'));controller.enqueue(await waiting);controller.close();}}),{headers:{'Content-Type':'application/x-ndjson'}}));
 const pending=api.request('/conversations/c/messages','POST',{message:'Switch'},(event:string)=>progress.push(event));
 await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(progress,['searching']);
 finish(encoder.encode('{"data":{"products":[]}}\n'));
 assert.equal((await pending).products.length,0);
});
test('進捗通知後のエラーも利用者向けエラーとして伝え、自動再送しない',async()=>{
 let calls=0;const {api}=client(async()=>{calls++;return new Response('{"progress":"searching"}\n{"error":{"code":"CONFLICT","message":"状態が変わりました","status":409}}\n',{headers:{'Content-Type':'application/x-ndjson'}});});
 await assert.rejects(api.request('/conversations/c/messages','POST',{},()=>{}),(e:any)=>e.code==='CONFLICT'&&e.status===409);assert.equal(calls,1);
});
