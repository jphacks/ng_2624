import { createHash, randomBytes, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';
export type Row = Record<string, any>;
export class AppError extends Error {
  status: number; code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
export function assert(condition: unknown, status = 400, code = 'INVALID_INPUT', message = '入力内容を確認してください。'): asserts condition {
  if (!condition) throw new AppError(status, code, message);
}
export function text(v: unknown, max = 4000, optional = false): string {
  if (optional && (v === undefined || v === null || v === '')) return '';
  assert(typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max); return v.trim();
}
export function uuid(v: unknown): string { const s = text(v, 36); assert(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s)); return s; }
export function integer(v: unknown, max = 1000000, step = 1): number { assert(Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= max && (v as number) % step === 0); return v as number; }
export function strings(v: unknown, max = 20): string[] { assert(Array.isArray(v) && v.length <= max); return v.map(x => text(x, 300)); }
export function date(v: unknown): string | null { if (v === null || v === undefined || v === '') return null; const s = text(v, 40); assert(/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(s) && Number.isFinite(Date.parse(s))); return s.length === 10 ? `${s}T14:59:59.000Z` : new Date(s).toISOString(); }
export const randomToken = () => randomBytes(32).toString('base64url');
export const hash = (v: string) => createHash('sha256').update(v).digest('hex');
export const equal = (a: string, b: string) => Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export interface Config { origin: string; supabaseUrl: string; serviceKey: string; publishableKey: string; sessionSecret: string; geminiKey: string; port: number; }
export function readConfig(env = process.env): Config {
  const origin = new URL(env.APP_ORIGIN || 'http://localhost:3000');
  assert(!origin.username && !origin.password && origin.pathname === '/' && !origin.search && !origin.hash, 500, 'SETUP_REQUIRED', 'APP_ORIGINを確認してください。');
  assert(origin.protocol === 'https:' || origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname), 500, 'SETUP_REQUIRED', '公開環境ではHTTPSが必要です。');
  return { origin: origin.origin, supabaseUrl: (env.SUPABASE_URL || '').replace(/\/$/, ''), serviceKey: env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY || '', publishableKey: env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || '', sessionSecret: env.SESSION_SECRET || '', geminiKey: env.GEMINI_API_KEY || '', port: Number(env.PORT || 3000) };
}
export function configured(c: Config) { return !!(c.supabaseUrl && c.serviceKey && c.publishableKey && c.sessionSecret.length >= 32); }
export function seal(value: Row, secret: string): string {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', Buffer.from(hash(secret), 'hex'), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}
export function unseal(value: string, secret: string): Row | null {
  try { const data = Buffer.from(value, 'base64url'); const cipher = createDecipheriv('aes-256-gcm', Buffer.from(hash(secret), 'hex'), data.subarray(0, 12)); cipher.setAuthTag(data.subarray(12, 28)); const result = JSON.parse(Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString()); return result.exp > Date.now() ? result : null; } catch { return null; }
}
export function cookieName(config: Config, name: string) { return (config.origin.startsWith('https:') ? '__Host-wb_' : 'wb_local_') + name; }
export function cookie(config: Config, name: string, value: string, seconds = 604800) { return `${cookieName(config, name)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${config.origin.startsWith('https:') ? '; Secure' : ''}`; }
export function cookies(request: Request): Record<string, string> { return Object.fromEntries((request.headers.get('cookie') || '').split(';').map(x => x.trim().split('=')).filter(x => x.length === 2)); }
export function protectMutation(request: Request, config: Config, csrf?: string) {
  assert(request.headers.get('origin') === config.origin, 403, 'FORBIDDEN', 'この画面から操作をやり直してください。');
  if (csrf !== undefined) assert(equal(request.headers.get('x-csrf-token') || '', csrf), 403, 'CSRF_INVALID', '画面を再読み込みしてください。');
}
export interface DB {
  list(table: string, query?: Record<string, string>): Promise<Row[]>;
  insert(table: string, values: Row | Row[], upsert?: string): Promise<Row[]>;
  update(table: string, query: Record<string, string>, values: Row): Promise<Row[]>;
  remove(table: string, query: Record<string, string>): Promise<void>;
  rpc(name: string, args: Row): Promise<any>;
  auth(path: string, method?: string, body?: Row, token?: string): Promise<Row>;
}
export function createDB(config: Config, send: typeof fetch = fetch): DB {
  async function request(path: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}, authToken?: string): Promise<any> {
    assert(configured(config), 503, 'SETUP_REQUIRED', '接続設定がまだ完了していません。');
    const headers: Record<string, string> = { apikey: config.serviceKey, 'Content-Type': 'application/json', ...extra };
    if (authToken) { headers.apikey = config.publishableKey; headers.Authorization = `Bearer ${authToken}`; }
    else if (config.serviceKey.startsWith('eyJ')) headers.Authorization = `Bearer ${config.serviceKey}`;
    let response: Response;
    try { response = await send(`${config.supabaseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) }); }
    catch { throw new AppError(503, 'DATABASE_UNAVAILABLE', '接続できませんでした。状態を確認してから再操作してください。'); }
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      const code = result?.code;
      if (code === '42501' || response.status === 403) throw new AppError(403, 'FORBIDDEN', 'この操作は許可されていません。');
      if (response.status === 401) throw new AppError(401, 'UNAUTHENTICATED', 'ログインをやり直してください。');
      if (['PGRST205', 'PGRST202', '42P01', '42703'].includes(code)) throw new AppError(503, 'SETUP_REQUIRED', 'DBの更新がまだ適用されていません。');
      if (code === 'P0001' || code === '23505' || code === '23514' || response.status === 409) {
        const msg = String(result?.message || '');
        const hint = /Insufficient/i.test(msg) ? '使えるポイントが足りません。' : /slot|size.*goal|active goal/i.test(msg) ? 'この大きさの目標がすでにあります。購入済みにしてから新しい目標を登録してください。' : /expired|unavailable/i.test(msg) ? '有効期限または現在の状態を確認してください。' : /version|stale/i.test(msg) ? '提案が更新されています。画面を再読み込みしてください。' : '現在の状態では操作できません。再読み込みして確認してください。';
        throw new AppError(409, 'CONFLICT', hint);
      }
      console.error('Supabase request failed', { path: path.split('?')[0], status: response.status, code });
      throw new AppError(502, 'DATABASE_ERROR', '保存または取得に失敗しました。画面を再読み込みして状態を確認してください。');
    }
    return result;
  }
  const path = (table: string, query: Record<string, string> = {}) => `/rest/v1/${table}?${new URLSearchParams(query)}`;
  return {
    list: (t, q) => request(path(t, { select: '*', ...q })),
    insert: (t, v, conflict) => request(path(t, conflict ? { on_conflict: conflict } : {}), 'POST', v, { Prefer: `return=representation${conflict ? ',resolution=merge-duplicates' : ''}` }),
    update: (t, q, v) => request(path(t, q), 'PATCH', v, { Prefer: 'return=representation' }),
    remove: async (t, q) => { await request(path(t, q), 'DELETE'); },
    rpc: (n, a) => request(`/rest/v1/rpc/${n}`, 'POST', a),
    auth: (p, m, b, token) => request(`/auth/v1/${p}`, m, b, {}, token),
  };
}
