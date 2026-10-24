import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { AppError, assert, text, uuid, integer, strings, date, randomToken, hash, equal, seal, unseal, cookie, cookieName, cookies, protectMutation, configured } from './core.ts';
import type { Config, DB, Row } from './core.ts';
import type { AIInput, AIOutput, ProductCandidate } from '../../Sample_db/types.ts';

interface Dependencies { db: DB; ai: (input: AIInput) => Promise<AIOutput>; enrich: (product: ProductCandidate) => Promise<ProductCandidate | null>; image: (url: string) => Promise<{ body: Buffer; contentType: string } | null>; qr: (url: string) => Promise<string>; }
const DAY = 86400000;
const emptySettings = () => ({ rewardGuidelines: { smallJpy: null, mediumJpy: null, largeJpy: null }, constraints: { mustHave: [], mustAvoid: [] }, chorePreferences: [] });
const eq = (v: string) => `eq.${v}`;
const listOf = (v: string[]) => `in.(${v.join(',')})`;
function age(birth: string | null) { if (!birth) return null; const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }); const years = +today.slice(0, 4) - +birth.slice(0, 4); return years - (today.slice(5) < birth.slice(5) ? 1 : 0); }
function demographic(input: Row): Row {
  const out: Row = {};
  if ('displayName' in input) out.display_name = text(input.displayName, 100);
  if ('birthDate' in input) { const b = input.birthDate; assert(b === null || typeof b === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b) && Number.isFinite(Date.parse(b)) && new Date(b).toISOString().slice(0, 10) === b && b <= new Date().toISOString().slice(0, 10) && age(b)! <= 120); out.birth_date = b; }
  if ('gender' in input) { assert([null, 'male', 'female', 'other'].includes(input.gender)); out.gender = input.gender; }
  if ('gradeLevel' in input) { out.grade_level = input.gradeLevel === null || input.gradeLevel === '' ? null : integer(input.gradeLevel, 12); assert(out.grade_level === null || out.grade_level >= 1); }
  if ('gradeBaseSchoolYear' in input) { out.grade_base_school_year = integer(input.gradeBaseSchoolYear, 2200); assert(out.grade_base_school_year >= 2000); }
  return out;
}
function validateSettings(input: Row) {
  if (input.rewardGuidelines) {
    const values = ['smallJpy', 'mediumJpy', 'largeJpy'].map(k => input.rewardGuidelines[k]);
    for (const value of values) if (value !== undefined && value !== null) integer(value);
    const [small, medium, large] = values;
    assert(!(small != null && medium != null && small > medium) && !(medium != null && large != null && medium > large), 400, 'INVALID_INPUT', '目標金額は小・中・大の順に同じか大きい金額を入力してください。');
  }
  if (input.constraints) for (const k of ['mustHave', 'mustAvoid']) if (k in input.constraints) strings(input.constraints[k]);
  if ('chorePreferences' in input) strings(input.chorePreferences);
}
function childView(u: Row): Row {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }); const year = +today.slice(0, 4) - (+today.slice(5, 7) < 4 ? 1 : 0);
  const current = u.grade_level && u.grade_base_school_year ? u.grade_level + year - u.grade_base_school_year : u.grade_level;
  return { childId: u.id, displayName: u.display_name, birthDate: u.birth_date, gender: u.gender, gradeLevel: current && current <= 12 ? current : null, gradeBaseSchoolYear: year };
}
function mapProposal(p: Row) { return { id: p.id, negotiationId: p.negotiation_id, productId: p.product_id, version: p.version, persuasionText: p.persuasion_text, purchaseConditions: p.purchase_conditions, status: p.status }; }
function mapProduct(p: Row): ProductCandidate { return { id: p.id, name: p.name, priceJpy: p.price_jpy, productUrl: p.product_url, imageUrl: p.image_url, priceCheckedAt: p.price_checked_at, size: p.size || 'small', description: p.description || '', recommendationReason: p.recommendation_reason || '', sourceUrls: p.source_urls || [] }; }
export function createApp(config: Config, dep: Dependencies) {
  const { db } = dep;
  const limits = new Map<string, { count: number; until: number }>();
  function rate(key: string, max: number, ms: number) { const now = Date.now(); if (limits.size > 5000) for (const [k, v] of limits) if (v.until < now) limits.delete(k); assert(limits.size < 10000, 429, 'RATE_LIMITED', 'しばらく待ってからお試しください。'); let v = limits.get(key); if (!v || v.until < now) { v = { count: 0, until: now + ms }; limits.set(key, v); } assert(++v.count <= max, 429, 'RATE_LIMITED', 'しばらく待ってからお試しください。'); }
  async function one(table: string, query: Record<string, string>, required = true): Promise<Row> { const r = (await db.list(table, { ...query, limit: '1' }))[0]; if (required) assert(r, 404, 'NOT_FOUND', 'データが見つかりません。'); return r; }
  async function family(user: Row, childId: string) { return db.rpc('wb_family', { p_actor_id: user.id, p_child_id: uuid(childId) }); }
  async function children(user: Row): Promise<Row[]> {
    if (user.role === 'child') return [childView(user)];
    const memberships = await db.list('family_members', { user_id: eq(user.id), family_role: 'eq.parent' });
    if (!memberships.length) return [];
    const members = await db.list('family_members', { family_id: listOf(memberships.map(x => x.family_id)), family_role: 'eq.child' });
    if (!members.length) return [];
    return (await db.list('users', { id: listOf([...new Set(members.map(x => x.user_id))]), order: 'created_at.asc' })).map(childView);
  }
  async function settings(childId: string): Promise<Row> { const s = await one('child_settings', { child_id: eq(childId) }, false); return s ? { childId, rewardGuidelines: { ...emptySettings().rewardGuidelines, ...s.reward_guidelines }, constraints: { ...emptySettings().constraints, ...s.constraints }, chorePreferences: Array.isArray(s.chore_preferences) ? s.chore_preferences : [] } : { childId, ...emptySettings() }; }
  async function profile(user: Row): Promise<Row> { const p = await one('user_preferences', { user_id: eq(user.id) }, false); return { displayName: user.display_name, birthDate: user.birth_date || null, gradeLevel: childView(user).gradeLevel, gradeBaseSchoolYear: childView(user).gradeBaseSchoolYear, onboardingCompleted: user.onboarding_completed, chorePreferences: p?.expected_activities || [], profile: { gradeLevel: childView(user).gradeLevel, age: age(user.birth_date), gender: user.gender || null, preferences: { interests: p?.interests || [], wishes: p?.desired_items || [], expectations: p?.expected_activities || [] } } }; }
  async function ownedChat(user: Row, id: string) { return one('conversations', { id: eq(uuid(id)), user_id: eq(user.id) }); }
  async function accessibleProposal(user: Row, id: string): Promise<Row> {
    const p = await one('proposals', { id: eq(uuid(id)) });
    if (p.proposed_by === user.id) { const c = await ownedChat(user, p.conversation_id); await family(user, c.child_id || user.id); return p; }
    assert(p.status !== 'draft' && p.negotiation_id, 404, 'NOT_FOUND', '提案が見つかりません。');
    const n = await one('negotiations', { id: eq(p.negotiation_id) });
    assert([n.child_id, n.parent_id].includes(user.id), 404, 'NOT_FOUND', '提案が見つかりません。'); await family(user, n.child_id); return p;
  }
  async function proposalView(user: Row, p: Row): Promise<Row> {
    const product = mapProduct(await one('products', { id: eq(p.product_id) }));
    const responses = await db.list('proposal_approvals', { proposal_id: eq(p.id), order: 'decided_at.desc' });
    const answer = responses.find(x => x.user_id !== p.proposed_by);
    return { proposal: mapProposal(p), product, negotiationResult: answer ? { proposalId: p.id, version: p.version, decision: answer.decision, reason: answer.comment || null } : null,
      canEdit: p.proposed_by === user.id && p.status === 'draft', canRespond: p.proposed_by !== user.id && p.status === 'pending' && !responses.some(x => x.user_id === user.id) };
  }
  async function currentProposal(user: Row, c: Row): Promise<Row | null> {
    const own = await one('proposals', { conversation_id: eq(c.id), proposed_by: eq(user.id), order: 'created_at.desc,id.desc' }, false);
    if (own) return own;
    return c.context_proposal_id ? accessibleProposal(user, c.context_proposal_id) : null;
  }
  async function chatView(user: Row, c: Row): Promise<Row> {
    const messages = await db.list('messages', { conversation_id: eq(c.id), order: 'sequence_no.desc', limit: '100' });
    const p = await currentProposal(user, c);
    return { conversationId: c.id, childId: c.child_id, products: c.products, selectedProductId: c.selected_product_id, currentProposal: p ? mapProposal(p) : null, latestAIOutput: c.latest_ai_output, messages: messages.reverse().filter(x => ['user', 'assistant'].includes(x.sender)).map(x => ({ id: x.id, sender: x.sender, content: x.content, createdAt: x.created_at })) };
  }
  async function proposalsFor(user: Row, childId: string): Promise<Row[]> {
    const n = await db.list('negotiations', { child_id: eq(childId), ...(user.role === 'parent' ? { parent_id: eq(user.id) } : {}), order: 'created_at.desc', limit: '100' });
    const list = n.length ? await db.list('proposals', { negotiation_id: listOf(n.map(x => x.id)), status: 'neq.draft', order: 'created_at.desc', limit: '100' }) : [];
    const chats = await db.list('conversations', { user_id: eq(user.id), child_id: eq(childId) });
    const drafts = chats.length ? await db.list('proposals', { conversation_id: listOf(chats.map(x => x.id)), proposed_by: eq(user.id), status: 'eq.draft', order: 'created_at.desc', limit: '100' }) : [];
    const child = await one('users', { id: eq(childId) });
    return Promise.all([...drafts, ...list].map(async p => ({ ...await proposalView(user, p), childId, childDisplayName: child.display_name })));
  }
  async function runAI(user: Row, conversationId: string, message: string | null, searchQuery?: string) {
    rate(`ai:${user.id}`, 20, 600000);
    assert(config.geminiKey, 503, 'SETUP_REQUIRED', 'AIの接続設定がまだ完了していません。');
    const lockId = randomUUID();
    const c = await db.rpc('wb_begin_ai', { p_actor_id: user.id, p_conversation_id: uuid(conversationId), p_lock_id: lockId });
    try {
      await family(user, c.child_id || user.id);
      const [p, pref, configChild, history] = await Promise.all([currentProposal(user, c), profile(user), settings(c.child_id || user.id), db.list('messages', { conversation_id: eq(c.id), order: 'sequence_no.desc', limit: '40' })]);
      const pv = p ? await proposalView(user, p) : null;
      const products = [...c.products];
      if (pv && !products.some(x => x.id === pv.product.id)) products.push(pv.product);
      const child = await one('users', { id: eq(c.child_id || user.id) });
      const input: AIInput = { searchQuery, childContext: { age: age(child.birth_date), gradeLevel: childView(child).gradeLevel }, requestId: randomUUID(), now: new Date().toISOString(), role: user.role, mode: 'consultation', message, history: history.reverse().filter(x => ['user', 'assistant'].includes(x.sender)).map(x => ({ id: x.id, sender: x.sender, content: x.content, createdAt: x.created_at })), negotiationHistory: [], profile: { ...pref.profile, preferences: { ...pref.profile.preferences, expectations: [...new Set([...pref.profile.preferences.expectations, ...configChild.chorePreferences])] } }, sharedConditions: [], constraints: configChild.constraints, rewardGuidelines: configChild.rewardGuidelines, products: products.map(p => ({ ...p, imageUrl: null })), selectedProductId: c.selected_product_id, currentProposal: p ? mapProposal(p) : null, negotiationResult: pv?.negotiationResult || null };
      let output = await dep.ai(input);
      if (output.action === 'PRODUCT') { const products = (await Promise.all(output.products.map(dep.enrich))).filter((p): p is ProductCandidate => p !== null); output = products.length ? { ...output, products } : { requestId: output.requestId, action: 'HEARING', search: output.search, reply: 'Amazonの商品ページを確認できませんでした。希望する商品や条件を少し変えて、もう一度探してみましょう。' }; }
      const updated = await db.rpc('wb_finish_ai', { p_actor_id: user.id, p_conversation_id: c.id, p_lock_id: lockId, p_message: message, p_output: output });
      return chatView(user, updated);
    } catch (e) {
      await db.rpc('wb_cancel_ai', { p_actor_id: user.id, p_conversation_id: c.id, p_lock_id: lockId }).catch(() => {});
      if (e instanceof AppError) throw e;
      console.error('AI request failed', { name: e instanceof Error ? e.name : 'unknown' });
      throw new AppError(502, 'AI_UNAVAILABLE', 'AIの返答を取得できませんでした。少し待ってからお試しください。');
    }
  }
  return async function app(request: Request, remoteAddress = 'local'): Promise<Response> {
    const responseHeaders = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    function setCookie(name: string, value: string, secs?: number) { responseHeaders.append('Set-Cookie', cookie(config, name, value, secs)); }
    function result(data: unknown, status = 200) { return new Response(JSON.stringify({ data }), { status, headers: responseHeaders }); }
    function redirect(url: string) { responseHeaders.set('Location', url); return new Response(null, { status: 303, headers: responseHeaders }); }
    try {
      const url = new URL(request.url), path = url.pathname, method = request.method;
      const jar = cookies(request);
      if (path === '/api/health' && method === 'GET') return result({ configured: configured(config) });
      assert(configured(config), 503, 'SETUP_REQUIRED', '接続設定がまだ完了していません。SETUP.mdを確認してください。');
      let body: Row = {};
      if (!['GET', 'HEAD'].includes(method)) {
        protectMutation(request, config);
        const raw = await request.text(); assert(Buffer.byteLength(raw) <= 32768, 413, 'INVALID_INPUT', '入力が長すぎます。');
        if (raw) { assert(request.headers.get('content-type')?.startsWith('application/json')); try { body = JSON.parse(raw); } catch { throw new AppError(400, 'INVALID_INPUT', '入力形式が正しくありません。'); } assert(body && typeof body === 'object' && !Array.isArray(body)); }
      }
      async function loadSession(required = true): Promise<{ row: Row; user: Row } | null> {
        const token = jar[cookieName(config, 'session')];
        const row = token && /^[A-Za-z0-9_-]{43}$/.test(token) ? await one('app_sessions', { token_hash: eq(hash(token)), revoked_at: 'is.null' }, false) : null;
        const user = row ? await one('users', { id: eq(row.user_id) }, false) : null;
        const idle = user?.role === 'parent' ? DAY : 7 * DAY;
        if (!row || !user || Date.parse(row.expires_at) <= Date.now() || Date.parse(row.last_active_at) + idle <= Date.now()) { setCookie('session', '', 0); if (required) throw new AppError(401, 'UNAUTHENTICATED', 'ログインしてください。'); return null; }
        await db.update('app_sessions', { token_hash: eq(row.token_hash), revoked_at: 'is.null' }, { last_active_at: new Date().toISOString() });
        return { row, user };
      }
      function sessionView(s: { row: Row; user: Row } | null) { return s ? { authenticated: true, user: { id: s.user.id, role: s.user.role, displayName: s.user.display_name, childId: s.user.role === 'child' ? s.user.id : null, onboardingCompleted: s.user.onboarding_completed }, csrfToken: s.row.csrf_token, idleExpiresAt: new Date(Math.min(Date.now() + (s.user.role === 'parent' ? DAY : 7 * DAY), Date.parse(s.row.expires_at))).toISOString(), absoluteExpiresAt: s.row.expires_at } : { authenticated: false, user: null, csrfToken: null, idleExpiresAt: null, absoluteExpiresAt: null }; }
      async function startOAuth(reauthUserId?: string) {
        rate(`oauth:${remoteAddress}`, 20, 600000);
        const verifier = randomToken(), flow = randomToken();
        setCookie('oauth', seal({ verifier, flow, reauthUserId, exp: Date.now() + 600000 }, config.sessionSecret), 600);
        const target = new URL('/auth/v1/authorize', config.supabaseUrl);
        target.search = new URLSearchParams({ provider: 'google', redirect_to: `${config.origin}/api/auth/google/callback?flow=${flow}`, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 's256', prompt: 'select_account', ...(reauthUserId ? { max_age: '0' } : {}) }).toString();
        return target.href;
      }
      if (path === '/api/auth/google/start' && method === 'GET') return redirect(await startOAuth());
      if (path === '/api/auth/google/callback' && method === 'GET') {
        const flow = unseal(jar[cookieName(config, 'oauth')] || '', config.sessionSecret); setCookie('oauth', '', 0);
        if (!flow || !equal(flow.flow, url.searchParams.get('flow') || '') || !url.searchParams.get('code') || url.searchParams.has('error')) return redirect(`${config.origin}/?authError=login_failed`);
        try {
          const auth = await db.auth('token?grant_type=pkce', 'POST', { auth_code: url.searchParams.get('code'), code_verifier: flow.verifier });
          const u = auth.user;
          assert(u?.id && u.identities?.some((i: Row) => i.provider === 'google'), 403, 'FORBIDDEN');
          if (flow.reauthUserId) assert(flow.reauthUserId === u.id, 403, 'FORBIDDEN');
          await db.rpc('wb_register_parent', { p_user_id: u.id, p_display_name: String(u.user_metadata?.full_name || 'おうちの人').slice(0, 100) });
          // Access/refresh tokens never leave the server or become app cookies.
          const token = randomToken(), csrf = randomToken(), now = new Date().toISOString();
          await db.insert('app_sessions', { token_hash: hash(token), user_id: u.id, csrf_token: csrf, expires_at: new Date(Date.now() + 7 * DAY).toISOString(), reauthenticated_at: now, device_label: '保護者の端末' });
          const old = jar[cookieName(config, 'session')]; if (old) await db.update('app_sessions', { token_hash: eq(hash(old)), user_id: eq(u.id) }, { revoked_at: now });
          setCookie('session', token, 7 * 86400); return redirect(`${config.origin}/#children`);
        } catch { return redirect(`${config.origin}/?authError=login_failed`); }
      }
      if (path === '/api/auth/session' && method === 'GET') return result(sessionView(await loadSession(false)));
      // Pairing uses a separate short-lived, encrypted browser cookie and explicit parent confirmation.
      if (path === '/api/pairing/session' && method === 'POST') {
        rate(`bootstrap:${remoteAddress}`, 30, 600000);
        const existing = unseal(jar[cookieName(config, 'pair')] || '', config.sessionSecret);
        const invitationHash = body.invitationToken ? hash(text(body.invitationToken, 200).replace(/[\s-]/g, '').toUpperCase()) : undefined;
        const pair = existing && (!invitationHash || existing.invitationHash === invitationHash) ? existing : { token: randomToken(), csrf: randomToken(), exp: Date.now() + 600000, ...(invitationHash ? { invitationHash } : {}) };
        setCookie('pair', seal(pair, config.sessionSecret), Math.max(0, Math.ceil((pair.exp - Date.now()) / 1000)));
        return result({ csrfToken: pair.csrf, expiresAt: new Date(pair.exp).toISOString() }, 201);
      }
      const pairStatus = /^\/api\/pairing\/requests\/([\w-]+)(\/complete)?$/.exec(path);
      if (path === '/api/pairing/requests' && method === 'POST' || pairStatus && (method === 'GET' || pairStatus[2] && method === 'POST')) {
        const pair = unseal(jar[cookieName(config, 'pair')] || '', config.sessionSecret); assert(pair, 401, 'PAIRING_EXPIRED', '招待コードを入力し直してください。');
        if (method === 'POST') protectMutation(request, config, pair.csrf);
        rate(`pair:${remoteAddress}`, 30, 600000);
        let r: Row;
        if (!pairStatus || pairStatus[2]) assert(!(await loadSession(false)), 409, 'ALREADY_AUTHENTICATED', 'ログイン中です。子どもの別ブラウザーまたは別端末で招待を開いてください。');
        if (!pairStatus) { const token = text(body.invitationToken, 200).replace(/[\s-]/g, '').toUpperCase(); assert(/^[A-Z2-9]{12}$/.test(token), 400, 'INVALID_INPUT', '招待コードは12文字の英数字です。6桁の確認番号とは異なります。'); r = await db.rpc('wb_request_pairing', { p_invitation_hash: hash(token), p_token_hash: hash(pair.token) }); }
        else r = await one('app_pairing_requests', { id: eq(uuid(pairStatus[1])), token_hash: eq(hash(pair.token)) });
        const inv = await one('app_invitations', { id: eq(r.invitation_id) });
        const child = await one('users', { id: eq(inv.child_id) });
        if (pairStatus?.[2]) {
          const token = randomToken(); const s = await db.rpc('wb_complete_pairing', { p_request_id: r.id, p_token_hash: hash(pair.token), p_session_token_hash: hash(token), p_csrf_token: randomToken() });
          setCookie('session', token, 30 * 86400); setCookie('pair', '', 0); return result(sessionView({ row: s, user: child }));
        }
        return result({ pairingRequestId: r.id, childId: inv.child_id, childDisplayName: child.display_name, status: Date.parse(r.expires_at) <= Date.now() || Date.parse(inv.expires_at) <= Date.now() ? 'expired' : r.status, confirmationCode: r.confirmation_code, expiresAt: r.expires_at, csrfToken: pair.csrf });
      }
      const session = (await loadSession())!, user = session.user;
      if (method !== 'GET') protectMutation(request, config, session.row.csrf_token);
      rate(`api:${user.id}`, 300, 60000);
      const requireParent = () => assert(user.role === 'parent', 403, 'FORBIDDEN', '保護者の操作が必要です。');
      const reauth = () => { requireParent(); assert(session.row.reauthenticated_at && Date.parse(session.row.reauthenticated_at) + 10 * 60000 > Date.now(), 403, 'REAUTH_REQUIRED', '安全のためGoogleで本人確認をしてください。'); };
      if (path === '/api/auth/google/reauthenticate' && method === 'POST') { requireParent(); return result({ authorizationUrl: await startOAuth(user.id) }); }
      if (path === '/api/auth/logout' && method === 'POST') { await db.update('app_sessions', { token_hash: eq(session.row.token_hash) }, { revoked_at: new Date().toISOString() }); setCookie('session', '', 0); return result({ loggedOut: true }); }
      if (path === '/api/profile' && method === 'GET') return result(await profile(user));
      if (path === '/api/profile' && method === 'PATCH') {
        const updates = user.role === 'parent' ? demographic(body) : {};
        if (user.role === 'child') assert(!Object.keys(body).some(k => !['profile', 'onboardingCompleted'].includes(k)), 403, 'FORBIDDEN');
        const p = await one('user_preferences', { user_id: eq(user.id) }, false); const values: Row = { user_id: user.id };
        const preferences = body.profile?.preferences;
        if (preferences) { if ('interests' in preferences) values.interests = strings(preferences.interests); if ('wishes' in preferences) values.desired_items = strings(preferences.wishes); if ('expectations' in preferences) values.expected_activities = strings(preferences.expectations); }
        if (user.role === 'parent' && 'chorePreferences' in body) values.expected_activities = strings(body.chorePreferences);
        if ('onboardingCompleted' in body) { assert(body.onboardingCompleted === true); updates.onboarding_completed = true; }
        if (Object.keys(values).length > 1) { if (p) await db.update('user_preferences', { user_id: eq(user.id) }, values); else await db.insert('user_preferences', values); }
        const changed = Object.keys(updates).length ? (await db.update('users', { id: eq(user.id) }, updates))[0] : user;
        return result(await profile(changed));
      }
      if (path === '/api/children' && method === 'GET') { requireParent(); return result({ children: await children(user) }); }
      if (path === '/api/children' && method === 'POST') {
        requireParent(); const d = demographic(body); assert(d.display_name && d.birth_date, 400, 'INVALID_INPUT', '子どもの名前と誕生日を入力してください。'); validateSettings(body); const auth = await db.auth('admin/users', 'POST', { email: `child-${randomUUID()}@wishbridge.invalid`, password: randomToken(), email_confirm: true, app_metadata: { app_role: 'child' } }); const id = auth.id || auth.user?.id; assert(id, 502, 'DATABASE_ERROR');
        let registered = false;
        try { const record = await db.rpc('wb_create_child', { p_actor_id: user.id, p_child_id: id, p_display_name: d.display_name, p_birth_date: d.birth_date || null, p_gender: d.gender || null, p_grade_level: d.grade_level || null, p_grade_base_school_year: d.grade_base_school_year || null }); registered = true; try { await saveSettings(user, id, body); } catch { return result({ ...childView(record.user), settingsSaved: false }, 201); } return result({ ...childView(record.user), settingsSaved: true }, 201); }
        catch (e) { if (!registered) await db.auth(`admin/users/${id}`, 'DELETE').catch(() => {}); throw e; }
      }
      const childRoute = /^\/api\/children\/([\w-]+)(\/(settings|invitations))?$/.exec(path);
      if (childRoute) {
        requireParent(); const id = uuid(childRoute[1]); await family(user, id);
        if (!childRoute[3] && method === 'PATCH') { const d = demographic(body); assert(Object.keys(d).length); return result(childView((await db.update('users', { id: eq(id), role: 'eq.child' }, d))[0])); }
        if (childRoute[3] === 'settings' && method === 'GET') return result(await settings(id));
        if (childRoute[3] === 'settings' && method === 'PATCH') return result(await saveSettings(user, id, body));
        if (childRoute[3] === 'invitations' && method === 'POST') {
          reauth(); rate(`invite:${user.id}`, 10, 600000);
          const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; const token = [...randomBytes(12)].map(x => alphabet[x % 32]).join('');
          const inv = await db.rpc('wb_create_invitation', { p_actor_id: user.id, p_child_id: id, p_token_hash: hash(token) });
          const link = `${config.origin}/pairing#invitationToken=${token}`;
          return result({ invitationToken: token, childId: id, expiresAt: inv.expires_at, pairingUrl: link, qrDataUrl: await dep.qr(link) }, 201);
        }
      }
      async function saveSettings(actor: Row, id: string, input: Row) {
        validateSettings(input);
        const old = await settings(id), patch: Row = { child_id: id, parent_id: actor.id, reward_guidelines: old.rewardGuidelines, constraints: old.constraints, chore_preferences: old.chorePreferences };
        if (input.rewardGuidelines) { const g = { ...old.rewardGuidelines }; for (const k of ['smallJpy', 'mediumJpy', 'largeJpy']) if (k in input.rewardGuidelines) g[k] = input.rewardGuidelines[k] === null ? null : integer(input.rewardGuidelines[k]); assert(g.smallJpy === null || g.mediumJpy === null || g.smallJpy <= g.mediumJpy); assert(g.mediumJpy === null || g.largeJpy === null || g.mediumJpy <= g.largeJpy); patch.reward_guidelines = g; }
        if (input.constraints) { patch.constraints = { ...old.constraints }; for (const k of ['mustHave', 'mustAvoid']) if (k in input.constraints) patch.constraints[k] = strings(input.constraints[k]); }
        if ('chorePreferences' in input) patch.chore_preferences = strings(input.chorePreferences);
        await db.insert('child_settings', patch, 'child_id'); return settings(id);
      }
      if (path === '/api/pairing/requests' && method === 'GET') {
        requireParent(); const invites = await db.list('app_invitations', { parent_id: eq(user.id), expires_at: `gt.${new Date().toISOString()}` });
        const requests = invites.length ? await db.list('app_pairing_requests', { invitation_id: listOf(invites.map(x => x.id)), status: 'eq.pending' }) : [];
        return result({ requests: await Promise.all(requests.map(async r => { const inv = invites.find(i => i.id === r.invitation_id)!; return { pairingRequestId: r.id, childId: inv.child_id, childDisplayName: (await one('users', { id: eq(inv.child_id) })).display_name, confirmationCode: r.confirmation_code, status: r.status, expiresAt: r.expires_at }; })) });
      }
      const pairReply = /^\/api\/pairing\/requests\/([\w-]+)\/responses$/.exec(path);
      if (pairReply && method === 'POST') {
        reauth(); const r = await one('app_pairing_requests', { id: eq(uuid(pairReply[1])) }); const inv = await one('app_invitations', { id: eq(r.invitation_id), parent_id: eq(user.id) }); await family(user, inv.child_id);
        assert(['approved', 'rejected'].includes(body.decision)); let updated;
        if (body.decision === 'approved') updated = await db.rpc('wb_approve_pairing', { p_actor_id: user.id, p_request_id: r.id, p_confirmation_code: text(body.confirmationCode, 6) });
        else updated = (await db.update('app_pairing_requests', { id: eq(r.id), status: 'eq.pending' }, { status: 'rejected' }))[0] || r;
        return result({ pairingRequestId: r.id, childId: inv.child_id, status: updated.status, expiresAt: r.expires_at });
      }
      if (path === '/api/devices' && method === 'GET') {
        requireParent(); const cs = await children(user), ids = [user.id, ...cs.map(c => c.childId)]; const devices = await db.list('app_sessions', { user_id: listOf(ids), revoked_at: 'is.null', expires_at: `gt.${new Date().toISOString()}` });
        return result({ devices: devices.map(d => ({ deviceSessionId: d.token_hash, role: d.user_id === user.id ? 'parent' : 'child', childId: d.user_id === user.id ? null : d.user_id, childDisplayName: cs.find(c => c.childId === d.user_id)?.displayName || null, deviceLabel: d.device_label || '端末', createdAt: d.created_at, lastActiveAt: d.last_active_at, isCurrent: d.token_hash === session.row.token_hash })) });
      }
      const device = /^\/api\/devices\/([a-f0-9]{64})$/.exec(path);
      if (device && method === 'DELETE') { reauth(); const d = await one('app_sessions', { token_hash: eq(device[1]) }); if (d.user_id !== user.id) await family(user, d.user_id); await db.update('app_sessions', { token_hash: eq(device[1]) }, { revoked_at: new Date().toISOString() }); if (device[1] === session.row.token_hash) setCookie('session', '', 0); return result({ deviceSessionId: device[1], revoked: true, currentDeviceRevoked: device[1] === session.row.token_hash }); }
      if (path === '/api/dashboard' && method === 'GET') {
        const cs = await children(user); const id = user.role === 'child' ? user.id : url.searchParams.get('childId') || cs[0]?.childId;
        if (!id) return result({ children: cs, childId: null, balanceYen: 0, lifetimeEarnedYen: 0, weeklyPaceYen: 0, goals: [], chores: [], choreRequests: [], proposals: [] });
        await family(user, id);
        const [totals, goals, assignments, requests, proposals] = await Promise.all([db.rpc('wb_dashboard_totals', { p_actor_id: user.id, p_child_id: id }), db.list('goals', { child_id: eq(id), status: 'in.(active,achieved,requested)', order: 'created_at.desc' }), db.list('task_assignments', { child_id: eq(id), order: 'created_at.desc', limit: '100' }), db.list('chore_requests', { child_id: eq(id), requested_by: eq(id), order: 'created_at.desc', limit: '100' }), proposalsFor(user, id)]);
        const chores = await Promise.all(assignments.map(async a => { const t = await one('tasks', { id: eq(a.task_id) }); if (t.category !== 'chore') return null; const sub = await one('task_submissions', { assignment_id: eq(a.id), order: 'submitted_at.desc' }, false); const review = sub ? await one('task_reviews', { submission_id: eq(sub.id) }, false) : null; return { id: a.id, title: t.title, description: t.description, rewardAmountYen: t.reward_amount_yen, dueAt: a.due_at, status: a.status, submissionId: sub?.id || null, submissionNote: sub?.answer_text || '', reviewComment: review?.comment || null }; }));
        return result({ children: cs, childId: id, ...totals, goals: await Promise.all(goals.map(async g => ({ ...mapProduct(await one('products', { id: eq(g.product_id) })), id: g.id, productId: g.product_id, targetAmountYen: g.target_amount_yen, size: g.size, status: g.status }))), chores: chores.filter(Boolean), choreRequests: requests.map(r => ({ id: r.id, title: r.title, note: r.description, status: r.status, rewardAmountYen: r.reward_amount_yen, dueAt: r.due_at, reason: r.review_comment })), proposals });
      }
      if (path === '/api/chores' && method === 'POST') { requireParent(); return result(await db.rpc('wb_create_chore', { p_actor_id: user.id, p_child_id: uuid(body.childId), p_title: text(body.title, 200), p_description: text(body.description, 1000, true), p_reward_amount_yen: integer(body.rewardAmountYen, 1000000, 10), p_due_at: date(body.dueAt) }), 201); }
      if (path === '/api/chore-requests' && method === 'POST') { assert(user.role === 'child', 403, 'FORBIDDEN'); return result(await db.rpc('wb_create_chore', { p_actor_id: user.id, p_child_id: user.id, p_title: text(body.title, 200), p_description: text(body.note, 1000, true), p_reward_amount_yen: 0, p_due_at: null }), 201); }
      const choreRequest = /^\/api\/chore-requests\/([\w-]+)\/respond$/.exec(path);
      if (choreRequest && method === 'POST') { requireParent(); assert(['approved', 'rejected'].includes(body.decision)); return result(await db.rpc('wb_review_chore_request', { p_actor_id: user.id, p_request_id: uuid(choreRequest[1]), p_decision: body.decision, p_title: body.title ? text(body.title, 200) : null, p_reward_amount_yen: body.decision === 'approved' ? integer(body.rewardAmountYen, 1000000, 10) : 0, p_due_at: date(body.dueAt), p_comment: text(body.reason, 1000, body.decision === 'approved') })); }
      const chore = /^\/api\/chores\/([\w-]+)\/(submit|review)$/.exec(path);
      if (chore && method === 'POST') { const id = uuid(chore[1]); if (chore[2] === 'submit') { assert(user.role === 'child', 403, 'FORBIDDEN'); return result(await db.rpc('wb_submit_chore', { p_actor_id: user.id, p_assignment_id: id, p_answer_text: text(body.note, 1000, true) })); } requireParent(); assert(['approved', 'rejected'].includes(body.decision)); return result(await db.rpc('wb_review_chore', { p_actor_id: user.id, p_assignment_id: id, p_decision: body.decision, p_comment: text(body.reason, 1000, body.decision === 'approved') })); }
      const purchase = /^\/api\/goals\/([\w-]+)\/purchase$/.exec(path);
      if (purchase && method === 'POST') { requireParent(); return result(await db.rpc('wb_purchase_goal', { p_actor_id: user.id, p_goal_id: uuid(purchase[1]) })); }
      if (path === '/api/conversations' && method === 'GET') { const list = await db.list('conversations', { user_id: eq(user.id), ...(user.role === 'parent' && url.searchParams.has('childId') ? { child_id: eq(uuid(url.searchParams.get('childId'))) } : {}), order: 'created_at.desc', limit: '100' }); return result({ conversations: list.map(c => ({ conversationId: c.id, childId: c.child_id, createdAt: c.created_at, updatedAt: c.latest_ai_output ? c.updated_at || c.created_at : c.created_at })) }); }
      if (path === '/api/conversations' && method === 'POST') {
        let id = user.role === 'child' ? user.id : body.proposalId ? '' : uuid(body.childId); let reference: Row | null = null;
        if (body.proposalId) { reference = await accessibleProposal(user, body.proposalId); assert(reference.status !== 'draft', 409, 'CONFLICT'); const n = await one('negotiations', { id: eq(reference.negotiation_id) }); id = n.child_id; }
        await family(user, id); const pv = reference ? await proposalView(user, reference) : null;
        const c = (await db.insert('conversations', { user_id: user.id, child_id: id, context_proposal_id: reference?.id || null, products: pv ? [pv.product] : [], selected_product_id: pv?.product.id || null }))[0];
        return result(body.message ? await runAI(user, c.id, text(body.message)) : await chatView(user, c), 201);
      }
      const conversation = /^\/api\/conversations\/([\w-]+)(\/(messages|selected-product|proposal-drafts|search))?$/.exec(path);
      if (conversation) {
        const c = await ownedChat(user, conversation[1]);
        if (!conversation[3] && method === 'GET') return result(await chatView(user, c));
        if (conversation[3] === 'search' && method === 'POST') { const query = text(body.query, 300); return result(await runAI(user, c.id, `商品検索：${query}`, query)); }
        if (conversation[3] === 'messages' && method === 'POST') return result(await runAI(user, c.id, text(body.message)));
        if (conversation[3] === 'selected-product' && method === 'PATCH') return result(await chatView(user, await db.rpc('wb_select_product', { p_actor_id: user.id, p_conversation_id: c.id, p_product_id: uuid(body.selectedProductId) })));
        if (conversation[3] === 'proposal-drafts' && method === 'POST') return result(await runAI(user, c.id, null));
      }
      if (path === '/api/proposals/received' && method === 'GET') { const cs = await children(user); return result({ proposals: (await Promise.all(cs.map(c => proposalsFor(user, c.childId)))).flat().filter(v => !v.canEdit) }); }
      const proposal = /^\/api\/proposals\/([\w-]+)(\/(send|responses))?$/.exec(path);
      if (proposal) {
        const p = await accessibleProposal(user, proposal[1]);
        if (!proposal[3] && method === 'GET') return result(await proposalView(user, p));
        const version = integer(body.version); assert(version > 0);
        if (!proposal[3] && method === 'PATCH') { const updated = await db.rpc('wb_save_proposal', { p_actor_id: user.id, p_conversation_id: p.conversation_id, p_product_id: p.product_id, p_persuasion_text: body.persuasionText === undefined ? p.persuasion_text : text(body.persuasionText, 4000), p_purchase_conditions: body.purchaseConditions === undefined ? p.purchase_conditions : strings(body.purchaseConditions, 12), p_goal_size: p.goal_size, p_proposal_id: p.id, p_expected_version: version, p_based_on_proposal_id: p.based_on_proposal_id }); return result(await proposalView(user, updated)); }
        if (proposal[3] === 'send' && method === 'POST') {
          const c = await ownedChat(user, p.conversation_id); const id = c.child_id || user.id; const set = await one('child_settings', { child_id: eq(id) }, false); let parentId = user.role === 'parent' ? user.id : set?.parent_id;
          if (!parentId) { const f = await family(user, id); parentId = (await one('family_members', { family_id: eq(f), family_role: 'eq.parent', order: 'joined_at.asc' })).user_id; }
          return result(await proposalView(user, await db.rpc('wb_send_proposal', { p_actor_id: user.id, p_proposal_id: p.id, p_expected_version: version, p_parent_id: parentId })));
        }
        if (proposal[3] === 'responses' && method === 'POST') { assert(['approved', 'rejected', 'revision_requested'].includes(body.decision)); const reason = text(body.reason, 1000, body.decision === 'approved') || null; return result(await proposalView(user, await db.rpc('wb_review_proposal', { p_actor_id: user.id, p_proposal_id: p.id, p_expected_version: version, p_decision: body.decision, p_comment: reason }))); }
      }
      const imageRoute = /^\/api\/products\/([\w-]+)\/image$/.exec(path);
      if (imageRoute && method === 'GET') {
        const id = uuid(imageRoute[1]); let allowed = !!await one('conversations', { user_id: eq(user.id), products: `cs.${JSON.stringify([{ id }])}` }, false);
        if (!allowed) { const ps = await db.list('proposals', { product_id: eq(id), status: 'neq.draft', limit: '100' }); for (const p of ps) { try { await accessibleProposal(user, p.id); allowed = true; break; } catch {} } }
        assert(allowed, 404, 'NOT_FOUND'); rate(`image:${user.id}`, 60, 60000); const p = await one('products', { id: eq(id) }); const image = await dep.image(p.product_url); assert(image, 404, 'NOT_FOUND', '画像を取得できません。');
        responseHeaders.set('Content-Type', image.contentType); responseHeaders.set('Cache-Control', 'private, max-age=300'); return new Response(new Uint8Array(image.body), { headers: responseHeaders });
      }
      throw new AppError(404, 'NOT_FOUND', 'この操作は見つかりません。');
    } catch (e) {
      const err = e instanceof AppError ? e : new AppError(500, 'INTERNAL_ERROR', '処理に失敗しました。画面を再読み込みして状態を確認してください。');
      if (!(e instanceof AppError)) console.error('API error', { name: e instanceof Error ? e.name : 'unknown' });
      if (err.status === 429) responseHeaders.set('Retry-After', '60');
      return new Response(JSON.stringify({ error: { code: err.code, message: err.message, requestId: randomUUID(), field: null, stateMayHaveChanged: request.method !== 'GET', retryAfterSeconds: err.status === 429 ? 60 : null } }), { status: err.status, headers: responseHeaders });
    }
  };
}
