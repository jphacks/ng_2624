import { randomUUID } from 'node:crypto';
import { createApp } from '../src/server/app.ts';
import { AppError, assert, cookie, cookieName, cookies, hash, protectMutation, randomToken, seal, unseal } from '../src/server/core.ts';
import type { Config, Row } from '../src/server/core.ts';
import { createLocalDatabase } from './database.ts';

type Dependencies = Omit<Parameters<typeof createApp>[1], 'db'>;
const DAY = 86400000;
export function readDemoConfig(env = process.env): Config {
  const port = Number(env.DEMO_PORT || 3001);
  const origin = new URL(env.DEMO_ORIGIN || `http://localhost:${port}`);
  assert(Number.isInteger(port) && port > 0 && port < 65536, 500, 'DEMO_CONFIG', 'DEMO_PORTを確認してください。');
  assert(origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname) && Number(origin.port || 80) === port && origin.pathname === '/' && !origin.username && !origin.password && !origin.search && !origin.hash, 500, 'DEMO_CONFIG', 'デモは同じポートのlocalhostまたは127.0.0.1だけで利用できます。');
  assert(!env.HOST || ['localhost', '127.0.0.1'].includes(env.HOST), 500, 'DEMO_CONFIG', 'デモのHOSTはループバックに限定してください。');
  return { origin: origin.origin, port, cookiePrefix: 'wb_demo_', sessionSecret: randomToken(), supabaseUrl: 'http://local-demo.invalid', serviceKey: 'local-only', publishableKey: 'local-only', geminiKey: env.GEMINI_API_KEY || '' };
}
export async function createDemo(config: Config, dependencies: Dependencies) {
  // Validate even callers supplying their own configuration; production cookies are never accepted.
  const safe = readDemoConfig({ DEMO_PORT: String(config.port), DEMO_ORIGIN: config.origin });
  config = { ...config, cookiePrefix: safe.cookiePrefix, supabaseUrl: safe.supabaseUrl, serviceKey: safe.serviceKey, publishableKey: safe.publishableKey };
  const controlSecret = randomToken();
  let active = 0, resetting = false;
  async function fresh() {
    const local = await createLocalDatabase();
    try {
      local.db.auth = async (path, method = 'GET') => {
        if (path === 'admin/users' && method === 'POST') {
          const id = randomUUID(); await local.pg.query('insert into auth.users(id) values($1)', [id]); return { id };
        }
        const match = /^admin\/users\/([a-f0-9-]+)$/.exec(path);
        if (match && method === 'DELETE') { await local.pg.query('delete from auth.users where id=$1', [match[1]]); return {}; }
        throw new AppError(403, 'LOCAL_AUTH_ONLY', 'ローカルデモではこの認証操作を利用できません。');
      };
      const parentId = (await local.db.auth('admin/users', 'POST')).id;
      const childId = (await local.db.auth('admin/users', 'POST')).id;
      await local.db.rpc('wb_register_parent', { p_user_id: parentId, p_display_name: 'デモの保護者' });
      await local.db.rpc('wb_create_child', { p_actor_id: parentId, p_child_id: childId, p_display_name: 'デモの子ども', p_birth_date: '2017-04-01', p_gender: null, p_grade_level: null, p_grade_base_school_year: null });
      await local.db.update('users', {}, { onboarding_completed: true });
      await local.db.update('child_settings', {child_id:'eq.'+childId}, {reward_guidelines:{smallJpy:1000,mediumJpy:3000,largeJpy:10000}});
      return { ...local, parentId, childId, app: createApp(config, { ...dependencies, db: local.db }) };
    } catch (error) { await local.pg.close(); throw error; }
  }
  let current = await fresh();
  function json(data: Row, status = 200, headers = new Headers()) {
    headers.set('Content-Type', 'application/json; charset=utf-8'); headers.set('Cache-Control', 'no-store');
    return new Response(JSON.stringify({ data }), { status, headers });
  }
  const app = async (request: Request, remoteAddress = '127.0.0.1'): Promise<Response> => {
    active++;
    try {
      assert(['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteAddress) && new URL(request.url).origin === config.origin, 403, 'LOCAL_ONLY', 'ローカルデモ専用です。');
      assert(!resetting, 409, 'DEMO_BUSY', 'リセット中です。少し待ってください。');
      const path = new URL(request.url).pathname;
      if (path === '/api/auth/google/start' && request.method === 'GET') return Response.redirect(config.origin + '/demo', 302);
      if (path === '/api/auth/google/reauthenticate' && request.method === 'POST') {
        // Preserve normal session/CSRF/role checks, but never start upstream OAuth.
        const response = await current.app(new Request(config.origin + '/api/auth/session', { headers: request.headers }), remoteAddress);
        const { data } = await response.json();
        assert(data.authenticated && data.user.role === 'parent', 403, 'FORBIDDEN');
        protectMutation(request, config, data.csrfToken);
        const token = cookies(request)[cookieName(config, 'session')];
        await current.db.update('app_sessions', { token_hash: 'eq.' + hash(token) }, { reauthenticated_at: new Date().toISOString() });
        return json({ authorizationUrl: config.origin + '/#children' });
      }
      if (path.startsWith('/api/demo/')) {
        const jar = cookies(request), headers = new Headers();
        let control = unseal(jar[cookieName(config, 'control')] || '', controlSecret);
        if (path === '/api/demo/state' && request.method === 'GET') {
          if (!control) { control = { csrf: randomToken(), exp: Date.now() + DAY }; headers.append('Set-Cookie', cookie(config, 'control', seal(control, controlSecret), 86400)); }
          return json({ csrfToken: control.csrf, parentId: current.parentId, childId: current.childId }, 200, headers);
        }
        assert(control, 403, 'CSRF_INVALID', 'デモ操作画面を再読み込みしてください。');
        protectMutation(request, config, control.csrf);
        assert(request.method === 'POST', 405, 'METHOD_NOT_ALLOWED');
        assert(request.headers.get('content-type')?.startsWith('application/json'));
        const raw = await request.text(); assert(Buffer.byteLength(raw) <= 1024, 413);
        let body: Row; try { body = JSON.parse(raw); } catch { throw new AppError(400, 'INVALID_INPUT', '入力形式が正しくありません。'); }
        assert(body && typeof body === 'object' && !Array.isArray(body));
        if (path === '/api/demo/login') {
          assert(['parent', 'child'].includes(body.role));
          const old = jar[cookieName(config, 'session')];
          if (old) await current.db.update('app_sessions', { token_hash: 'eq.' + hash(old) }, { revoked_at: new Date().toISOString() });
          const token = randomToken(), userId = body.role === 'parent' ? current.parentId : current.childId;
          await current.db.insert('app_sessions', { token_hash: hash(token), user_id: userId, csrf_token: randomToken(), expires_at: new Date(Date.now() + 7 * DAY).toISOString(), reauthenticated_at: body.role === 'parent' ? new Date().toISOString() : null, device_label: 'ローカルデモ' });
          headers.append('Set-Cookie', cookie(config, 'session', token));
          headers.append('Set-Cookie', cookie(config, 'pair', '', 0));
          return json({ loggedIn: true }, 200, headers);
        }
        if (path === '/api/demo/reset') {
          assert(active === 1, 409, 'DEMO_BUSY', 'ほかの操作が完了してからリセットしてください。');
          resetting = true;
          try { const next = await fresh(); const previous = current; current = next; await previous.pg.close(); }
          finally { resetting = false; }
          for (const name of ['session', 'pair', 'oauth']) headers.append('Set-Cookie', cookie(config, name, '', 0));
          return json({ reset: true }, 200, headers);
        }
        throw new AppError(404, 'NOT_FOUND', '操作が見つかりません。');
      }
      const response = await current.app(request, remoteAddress);
      if (path === '/api/auth/session' && response.ok) {
        const result = await response.json(); result.data.demo = true;
        return new Response(JSON.stringify(result), { status: response.status, headers: response.headers });
      }
      return response;
    } catch (error) {
      const e = error instanceof AppError ? error : new AppError(500, 'DEMO_ERROR', 'デモの処理に失敗しました。');
      return new Response(JSON.stringify({ error: { code: e.code, message: e.message } }), { status: e.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    } finally { active--; }
  };
  return { app, get db() { return current.db; }, close: () => current.pg.close() };
}
