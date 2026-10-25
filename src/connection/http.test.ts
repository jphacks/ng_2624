import test from 'node:test';
import assert from 'node:assert/strict';
import type { FEOperation, FERequestMap } from '../../Sample_db/fe-be.ts';
import type { APISuccess, ConversationView, FEResponseMap, JSONOperation, PairingView, SignedInSession } from '../../Sample_db/api.ts';
import { API_ERRORS } from '../../Sample_db/api.ts';
import { FEInputError, FE_REQUEST_DEFINITIONS } from './requests.ts';
import type { InputRule } from './requests.ts';
import { createFEClient, FEAPIError, FE_HTTP_DEFINITIONS, FETransportError, prepareFERequest } from './http.ts';
import { parseAPISuccess } from './responses.ts';

const time = '2026-10-24T00:00:00Z';
const conversation: ConversationView = { conversationId: 'c-1', childId: 'child-1', messages: [
  { id: 'm-1', sender: 'user', content: '相談したい', createdAt: time }], products: [], selectedProductId: null,
  currentProposal: null, latestAIOutput: { requestId: 'ai-1', action: 'HEARING', reply: '希望を教えてください。', search: null } };
const proposal = { proposal: { id: 'p-1', negotiationId: null, productId: 'product-1', version: 1,
  persuasionText: '提案', purchaseConditions: [], status: 'draft' as const }, negotiationResult: null };
const pairing: PairingView = { pairingRequestId: 'pair-1', childId: 'child-1', childDisplayName: '子供', confirmationCode: '123456',
  deviceLabel: 'Safari', status: 'pending', requestedAt: time, expiresAt: '2026-10-24T00:05:00Z' };
const signedIn: SignedInSession = { authenticated: true, user: { role: 'child', displayName: '子供', childId: 'child-1' },
  csrfToken: 'example-csrf', idleExpiresAt: '2026-10-31T00:00:00Z', absoluteExpiresAt: '2026-11-23T00:00:00Z' };
const examples: { [K in JSONOperation]: FEResponseMap[K] } = {
  'profile.get': { displayName: '親', profile: { age: null, gender: null, preferences: { interests: [], wishes: [], expectations: [] } } },
  'profile.update': { displayName: '親', profile: { age: null, gender: null, preferences: { interests: [], wishes: [], expectations: [] } } },
  'child.create': { childId: 'child-1', displayName: '子供' },
  'child.rename': { childId: 'child-1', displayName: '子供' },
  'child.settings.get': { childId: 'child-1', rewardGuidelines: { smallJpy: 1000, mediumJpy: null, largeJpy: null }, constraints: { mustHave: [], mustAvoid: [] } },
  'child.settings.update': { childId: 'child-1', rewardGuidelines: { smallJpy: 1000, mediumJpy: null, largeJpy: null }, constraints: { mustHave: [], mustAvoid: [] } },
  'children.list': { children: [{ childId: 'child-1', displayName: '子供' }] },
  'conversations.list': { conversations: [{ conversationId: 'c-1', childId: 'child-1', createdAt: time, updatedAt: time }] },
  'negotiations.list': { negotiations: [{ negotiationId: 'n-1', childId: 'child-1', status: 'open', createdAt: time, updatedAt: time }] },
  'conversation.create': conversation, 'conversation.get': conversation, 'conversation.message': conversation,
  'conversation.select_product': conversation, 'conversation.generate_proposal': conversation,
  'negotiation.get': { negotiationId: 'n-1', childId: 'child-1', status: 'open', messages: [
    { id: 'm-2', sender: 'parent', content: '相談しましょう', createdAt: time }], products: [], selectedProductId: null,
    currentProposal: null, latestAIOutput: null, sharedConditions: [], negotiationResult: null },
  'negotiation.message': { negotiationId: 'n-1', childId: 'child-1', status: 'open', messages: [], products: [],
    selectedProductId: null, currentProposal: null, latestAIOutput: null, sharedConditions: [], negotiationResult: null },
  'negotiation.select_product': { negotiationId: 'n-1', childId: 'child-1', status: 'open', messages: [], products: [],
    selectedProductId: null, currentProposal: null, latestAIOutput: null, sharedConditions: [], negotiationResult: null },
  'negotiation.generate_proposal': { negotiationId: 'n-1', childId: 'child-1', status: 'open', messages: [], products: [],
    selectedProductId: null, currentProposal: null, latestAIOutput: null, sharedConditions: [], negotiationResult: null },
  'proposal.get': proposal, 'proposal.edit': proposal, 'proposal.send': proposal, 'proposal.respond': proposal,
  'sharing.publish': { sharedCondition: { id: 's-1', sourceUserId: 'user-1', targetUserId: 'user-2', content: '確認した要約', approvedAt: time } },
  'sharing.revoke': { sharedConditionId: 's-1', revoked: true },
  'auth.session': { authenticated: false, user: null, csrfToken: null, idleExpiresAt: null, absoluteExpiresAt: null },
  'auth.logout': { loggedOut: true },
  'devices.list': { devices: [{ deviceSessionId: 'd-1', role: 'child', childId: 'child-1', deviceLabel: 'Safari', createdAt: time, lastActiveAt: time, isCurrent: false }] },
  'invitation.create': { invitationToken: 'example-invitation', childId: 'child-1', expiresAt: time },
  'pairing.bootstrap': { csrfToken: 'example-csrf', expiresAt: time },
  'pairing.request': pairing, 'pairing.requests.list': { requests: [pairing] }, 'pairing.status': pairing, 'pairing.respond': pairing,
  'pairing.complete': signedIn,
  'device.revoke': { deviceSessionId: 'd-1', currentDeviceRevoked: false },
};

function inputFor(rule: InputRule): unknown {
  if (rule.kind === 'nullable') return null;
  if (rule.kind === 'string') return 'example';
  if (rule.kind === 'integer') return rule.min;
  if (rule.kind === 'enum') return rule.values[0];
  if (rule.kind === 'array') return [];
  const keys = [...rule.required];
  for (const key of Object.keys(rule.fields)) if (keys.length < rule.min && !keys.includes(key)) keys.push(key);
  return Object.fromEntries(keys.map(key => [key, inputFor(rule.fields[key])]));
}
test('全操作でURLと本文の配置が揃いGETに本文を付けない', () => {
  assert.deepEqual(Object.keys(FE_HTTP_DEFINITIONS).sort(), Object.keys(FE_REQUEST_DEFINITIONS).sort());
  const methodPaths = new Set<string>();
  for (const operation of Object.keys(FE_REQUEST_DEFINITIONS) as FEOperation[]) {
    const definition = FE_HTTP_DEFINITIONS[operation];
    const input = inputFor(FE_REQUEST_DEFINITIONS[operation].rule) as FERequestMap[typeof operation];
    const prepared = prepareFERequest(operation, input, 'example-csrf');
    assert.equal(prepared.path.startsWith('/api/'), true);
    assert.equal(prepared.path.includes('{'), false);
    const body = prepared.init.body ? JSON.parse(String(prepared.init.body)) : {};
    for (const id of definition.pathParameters) assert.equal(Object.hasOwn(body, id), false);
    if (definition.method === 'GET') assert.equal(prepared.init.body, undefined);
    assert.equal(prepared.init.credentials, 'same-origin');
    assert.equal(prepared.init.redirect, 'error');
    const key = definition.method + definition.path;
    assert.equal(methodPaths.has(key), false, key);
    methodPaths.add(key);
  }
});
test('提案回答ではIDだけをURLへ置きversionと回答を本文へ置く', () => {
  const request = prepareFERequest('proposal.respond', { proposalId: 'p-1', version: 2, decision: 'rejected', reason: '相談したい' }, 'example-csrf');
  assert.equal(request.path, '/api/proposals/p-1/responses');
  assert.deepEqual(JSON.parse(String(request.init.body)), { version: 2, decision: 'rejected', reason: '相談したい' });
  assert.equal(new Headers(request.init.headers).get('X-CSRF-Token'), 'example-csrf');
});
test('CSRF不足やURLのドット区間や区切り文字を通信前に拒否する', () => {
  assert.throws(() => prepareFERequest('auth.logout', {}), FEInputError);
  assert.throws(() => prepareFERequest('auth.logout', {}, 'bad\r\nvalue'), FEInputError);
  for (const conversationId of ['..', '.', 'a/b', 'a\\b', 'a?b', '%2f']) {
    assert.throws(() => prepareFERequest('conversation.get', { conversationId }), FEInputError);
  }
});
for (const operation of Object.keys(examples) as JSONOperation[]) {
  test(`API返却 ${operation}`, async () => {
    const expected = { data: examples[operation], requestId: 'request-1' };
    const client = createFEClient({ origin: 'https://app.example', csrfToken: () => 'example-csrf',
      fetch: async () => Response.json(expected, { status: FE_HTTP_DEFINITIONS[operation].successStatus }) });
    const input = inputFor(FE_REQUEST_DEFINITIONS[operation].rule) as FERequestMap[typeof operation];
    assert.deepEqual(await client.request(operation, input), expected);
  });
}
test('共有交渉の返却に私的な履歴やプロフィールを混ぜられない', () => {
  for (const extra of [{ profile: examples['profile.update'].profile }, { history: conversation.messages },
    { messages: [{ id: 'm', sender: 'user', content: '非公開', createdAt: time }] }]) {
    assert.throws(() => parseAPISuccess('NegotiationView', { data: { ...examples['negotiation.get'], ...extra }, requestId: 'r' }));
  }
});
test('Google開始はブラウザ遷移でありfetchしない', () => {
  let calls = 0;
  const client = createFEClient({ origin: 'https://app.example', fetch: async () => { calls++; return Response.json({}); } });
  assert.equal(client.googleLoginUrl(), 'https://app.example/api/auth/google/start');
  assert.equal(calls, 0);
  for (const origin of ['https://app.example/path', 'https://user:password@app.example', 'http://app.example']) {
    assert.throws(() => createFEClient({ origin }), FEInputError);
  }
});
test('ネットワーク断は一度だけ送信し、書き込み結果を不明として返す', async () => {
  let calls = 0;
  const client = createFEClient({ origin: 'https://app.example', csrfToken: () => 'example-csrf', fetch: async () => { calls++; throw Error('network'); } });
  await assert.rejects(client.request('conversation.message', { conversationId: 'c-1', message: '発言' }),
    (error: unknown) => error instanceof FETransportError && error.code === 'NETWORK_ERROR' && error.stateMayHaveChanged);
  assert.equal(calls, 1);
  await assert.rejects(client.request('conversation.get', { conversationId: 'c-1' }),
    (error: unknown) => error instanceof FETransportError && !error.stateMayHaveChanged);
});
test('定義したAPIエラーを状態コードと合わせて返す', async () => {
  for (const [code, definition] of Object.entries(API_ERRORS)) {
    const client = createFEClient({ origin: 'https://app.example', fetch: async () => Response.json({ error: {
      code, message: '処理できません。', field: null, requestId: 'request-1', stateMayHaveChanged: false,
      retryAfterSeconds: code === 'RATE_LIMITED' ? 60 : null,
    } }, { status: definition.status }) });
    await assert.rejects(client.request('conversation.get', { conversationId: 'c-1' }),
      (error: unknown) => error instanceof FEAPIError && error.detail.code === code && error.status === definition.status);
  }
});
test('不正な成功JSONやHTMLや未知のエラーを正常扱いしない', async () => {
  for (const response of [Response.json({ data: {}, requestId: 'r' }), Response.json({ data: examples['auth.session'] }),
    new Response('<html>error</html>', { headers: { 'Content-Type': 'text/html' } }),
    Response.json({ error: { code: 'UNKNOWN' } }, { status: 500 }),
    Response.json({ data: examples['auth.session'], requestId: 'r' }, { status: 201 })]) {
    const client = createFEClient({ origin: 'https://app.example', fetch: async () => response });
    await assert.rejects(client.request('auth.session', {}), FETransportError);
  }
});
test('承認確認はGET、通常セッションへの切り替えはCSRF付きPOST', () => {
  const status = prepareFERequest('pairing.status', { pairingRequestId: 'pair-1' });
  assert.equal(status.init.method, 'GET');
  assert.equal(new Headers(status.init.headers).has('X-CSRF-Token'), false);
  const complete = prepareFERequest('pairing.complete', { pairingRequestId: 'pair-1' }, 'example-csrf');
  assert.equal(complete.init.method, 'POST');
  assert.equal(complete.init.body, undefined);
  assert.equal(complete.path, '/api/pairing/requests/pair-1/complete');
});

test('商品とAI出力の各形を受け取り、認証URLの不正な形式を拒否する', () => {
  const product = { id: 'product-1', name: '商品', priceJpy: 1000, productUrl: 'https://shop.example/item',
    size: 'small' as const, description: '説明', recommendationReason: '希望に合う', sourceUrls: ['https://shop.example/item'] };
  const draft = { productId: 'product-1', target: 'parent' as const, persuasionText: '提案', purchaseConditions: [], basedOn: null };
  const base = { requestId: 'ai-2', reply: '候補です。', search: { queries: ['商品'],
    sources: [{ id: 'source-1', title: '出典', url: 'https://shop.example/item' }], searchSuggestionsHtml: null } };
  for (const output of [
    { ...base, action: 'PRODUCT', products: [product] },
    { ...base, action: 'PROPOSAL', proposalDraft: draft },
    { ...base, action: 'NEGOTIATION', proposalDraft: null },
  ]) {
    const response = { data: { ...conversation, products: [product], latestAIOutput: output }, requestId: 'r' };
    assert.deepEqual(parseAPISuccess('ConversationView', response), response);
  }
  assert.throws(() => parseAPISuccess('SessionView', { data: { ...signedIn, user: { role: 'child', displayName: '子供', childId: null } }, requestId: 'r' }));
});
