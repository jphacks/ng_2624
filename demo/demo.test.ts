import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemo, readDemoConfig } from './app.ts';

test('demo configuration is local and ignores production settings', () => {
  const config = readDemoConfig({ APP_ORIGIN: 'https://production.example', SUPABASE_URL: 'https://production.supabase.co', PORT: '8000', SESSION_SECRET: 'production' });
  assert.equal(config.origin, 'http://localhost:3001'); assert.equal(config.cookiePrefix, 'wb_demo_');
  assert.equal(config.supabaseUrl, 'http://local-demo.invalid');
  for (const env of [{ DEMO_ORIGIN: 'https://example.com:3001' }, { DEMO_ORIGIN: 'http://localhost:4000' }, { HOST: '0.0.0.0' }, { DEMO_PORT: 'NaN' }]) assert.throws(() => readDemoConfig(env));
});

test('local demo supports isolated login, child creation, real pairing and safe reset', async () => {
  const config = readDemoConfig();
  let qrUrl = '';
  const demo = await createDemo(config, { ai: async () => { throw Error('AI should not run in this test'); }, enrich: async p => p, image: async () => null, qr: async url => { qrUrl = url; return 'data:image/png;base64,qr'; } });
  const parent = new Map<string, string>(), child = new Map<string, string>(), directChild = new Map<string, string>();
  async function call(jar: Map<string, string>, path: string, method = 'GET', body?: unknown, csrf = '', origin = config.origin) {
    const response = await demo.app(new Request(config.origin + path, { method, headers: { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    for (const cookie of response.headers.getSetCookie()) { const pair = cookie.split(';')[0], pos = pair.indexOf('='); jar.set(pair.slice(0, pos), pair.slice(pos + 1)); }
    return { status: response.status, ...await response.json() };
  }
  try {
    const controls = await call(parent, '/api/demo/state'); const csrf = controls.data.csrfToken;
    assert.equal((await call(parent, '/api/demo/login', 'POST', { role: 'parent' }, 'wrong')).status, 403);
    assert.equal((await call(parent, '/api/demo/login', 'POST', { role: 'parent' }, csrf, 'http://evil.example')).status, 403);
    assert.equal((await call(parent, '/api/demo/login', 'POST', { role: 'parent' }, csrf)).status, 200);
    assert([...parent.keys()].every(key => key.startsWith('wb_demo_')));
    const session = (await call(parent, '/api/auth/session')).data;
    assert.equal(session.demo, true); assert.equal(session.user.role, 'parent');
    assert.equal((await call(new Map([['wb_local_session', parent.get('wb_demo_session')!]]), '/api/auth/session')).data.authenticated, false);
    const dashboard = (await call(parent, '/api/dashboard')).data;
    assert.equal(dashboard.children.length, 1); assert.equal(dashboard.balanceYen, 0);
    for (const key of ['goals', 'chores', 'choreRequests', 'proposals']) assert.deepEqual(dashboard[key], []);
    assert.deepEqual((await call(parent, '/api/conversations')).data.conversations, []);
    const directCsrf = (await call(directChild, '/api/demo/state')).data.csrfToken;
    await call(directChild, '/api/demo/login', 'POST', { role: 'child' }, directCsrf);
    assert.equal((await call(directChild, '/api/auth/session')).data.user.role, 'child');
    const created = await call(parent, '/api/children', 'POST', { displayName: '追加の子', birthDate: '2019-01-01' }, session.csrfToken);
    assert.equal(created.status, 201); assert.equal((await call(parent, '/api/children')).data.children.length, 2);
    const invitation = await call(parent, `/api/children/${controls.data.childId}/invitations`, 'POST', {}, session.csrfToken);
    assert.equal(invitation.status, 201); assert.equal(qrUrl, invitation.data.pairingUrl);
    const boot = await call(child, '/api/pairing/session', 'POST', { invitationToken: invitation.data.invitationToken });
    assert.equal(boot.status, 201);
    const pending = await call(child, '/api/pairing/requests', 'POST', { invitationToken: invitation.data.invitationToken }, boot.data.csrfToken);
    assert.equal(pending.status, 200); const id = pending.data.pairingRequestId;
    assert.equal((await call(parent, `/api/pairing/requests/${id}/responses`, 'POST', { decision: 'approved', confirmationCode: pending.data.confirmationCode }, session.csrfToken)).status, 200);
    assert.equal((await call(child, `/api/pairing/requests/${id}/complete`, 'POST', {}, boot.data.csrfToken)).status, 200);
    assert.equal((await call(child, '/api/auth/session')).data.user.id, controls.data.childId);
    const originalList = demo.db.list;
    let unblock!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    demo.db.list = async (table, query) => { if (table === 'family_members') { entered(); await gate; } return originalList(table, query); };
    const busy = call(parent, '/api/children'); await started;
    assert.equal((await call(parent, '/api/demo/reset', 'POST', {}, csrf)).status, 409);
    unblock(); assert.equal((await busy).status, 200); demo.db.list = originalList;
    assert.equal((await call(parent, '/api/demo/reset', 'POST', {}, csrf)).status, 200);
    assert.equal((await call(child, '/api/auth/session')).data.authenticated, false);
    assert.equal((await call(directChild, '/api/auth/session')).data.authenticated, false);
    await call(parent, '/api/demo/login', 'POST', { role: 'parent' }, csrf);
    const after = (await call(parent, '/api/dashboard')).data;
    assert.equal(after.children.length, 1); assert.equal(after.balanceYen, 0); assert.deepEqual(after.goals, []);
    const rejected = await demo.app(new Request(config.origin + '/api/demo/state'), '192.168.1.1'); assert.equal(rejected.status, 403);
    assert.equal((await demo.app(new Request('http://evil.example/api/demo/state'))).status, 403);
  } finally { await demo.close(); }
});
