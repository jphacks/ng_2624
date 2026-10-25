import test from 'node:test';
import assert from 'node:assert/strict';
import type { FEOperation, FERequestMap } from '../../Sample_db/fe-be.ts';
import type { AIUserProfile } from '../../Sample_db/types.ts';
import { FEInputError, FE_REQUEST_DEFINITIONS, parseFERequest, parseGoogleAuthCallback } from './requests.ts';
import { AUTH_POLICY, applyProfilePatch, roleMayCall, sessionStatus } from './policy.ts';

const examples: { [K in FEOperation]: FERequestMap[K] } = {
  'profile.get': {},
  'profile.update': { profile: { age: null, preferences: { interests: [] } } },
  'child.create': { displayName: '子供' },
  'child.rename': { childId: 'child-1', displayName: '子供' },
  'child.settings.get': { childId: 'child-1' },
  'child.settings.update': { childId: 'child-1', rewardGuidelines: { smallJpy: 0, mediumJpy: null } },
  'children.list': {},
  'conversations.list': {},
  'negotiations.list': {},
  'conversation.create': {},
  'conversation.get': { conversationId: 'conversation-1' },
  'conversation.message': { conversationId: 'conversation-1', message: '相談したい' },
  'conversation.select_product': { conversationId: 'conversation-1', selectedProductId: 'product-1' },
  'conversation.generate_proposal': { conversationId: 'conversation-1' },
  'negotiation.get': { negotiationId: 'negotiation-1' },
  'negotiation.message': { negotiationId: 'negotiation-1', message: '話し合いたい' },
  'negotiation.select_product': { negotiationId: 'negotiation-1', selectedProductId: 'product-1' },
  'negotiation.generate_proposal': { negotiationId: 'negotiation-1' },
  'proposal.get': { proposalId: 'proposal-1' },
  'proposal.edit': { proposalId: 'proposal-1', version: 1, purchaseConditions: [] },
  'proposal.send': { proposalId: 'proposal-1', version: 1 },
  'proposal.respond': { proposalId: 'proposal-1', version: 1, decision: 'approved', reason: null },
  'sharing.publish': { conversationId: 'conversation-1', negotiationId: 'negotiation-1', content: '確認した要約' },
  'sharing.revoke': { sharedConditionId: 'shared-1' },
  'auth.session': {},
  'auth.google.start': {},
  'auth.logout': {},
  'devices.list': {},
  'invitation.create': { childId: 'child-1' },
  'pairing.bootstrap': {},
  'pairing.requests.list': {},
  'pairing.request': { invitationToken: 'example-invitation-token' },
  'pairing.status': { pairingRequestId: 'pairing-1' },
  'pairing.respond': { pairingRequestId: 'pairing-1', decision: 'approved' },
  'pairing.complete': { pairingRequestId: 'pairing-1' },
  'device.revoke': { deviceSessionId: 'device-1' },
};
for (const operation of Object.keys(examples) as FEOperation[]) {
  test(`FE入力 ${operation}`, () => {
    const input = examples[operation];
    assert.deepEqual(parseFERequest(operation, input), input);
    assert.notEqual(parseFERequest(operation, input), input);
  });
}

const reject = (operation: FEOperation, input: unknown) => assert.throws(() => parseFERequest(operation, input), FEInputError);
test('認証情報や非公開履歴をJSON本文へ混ぜられない', () => {
  for (const field of ['role', 'userId', 'history', 'profile', 'now', 'requestId']) {
    reject('conversation.message', { ...examples['conversation.message'], [field]: 'forged' });
  }
  reject('profile.update', JSON.parse('{"__proto__":{"role":"parent"}}'));
  reject('profile.update', { profile: { preferences: { expectations: [], role: 'parent' } } });
  assert.throws(() => parseFERequest('toString' as FEOperation, {}), FEInputError);
});
test('省略による保持とnullや空配列によるクリアを区別する', () => {
  const current: AIUserProfile = { age: 10, gender: 'other',
    preferences: { interests: ['音楽'], wishes: ['楽器'], expectations: ['練習'] } };
  const input = { profile: { age: null, preferences: { wishes: [] } } };
  const parsed = parseFERequest('profile.update', input);
  const updated = applyProfilePatch(current, parsed.profile!);
  assert.deepEqual(updated, { age: null, gender: 'other',
    preferences: { interests: ['音楽'], wishes: [], expectations: ['練習'] } });
  updated.preferences.interests.push('読書');
  assert.deepEqual(current.preferences.interests, ['音楽']);
  assert.equal(current.age, 10);
  assert.deepEqual(input.profile.preferences.wishes, []);
});
test('空の更新や部分オブジェクトのnullを拒否する', () => {
  for (const value of [{}, { profile: {} }, { profile: { preferences: {} } }, { profile: null }, { displayName: ' ' }]) {
    reject('profile.update', value);
  }
  for (const value of [{ childId: 'c' }, { childId: 'c', rewardGuidelines: {} }, { childId: 'c', constraints: null }]) {
    reject('child.settings.update', value);
  }
  reject('proposal.edit', { proposalId: 'p', version: 1 });
});
test('金額と年齢の範囲や配列要素数を検証する', () => {
  for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1000']) {
    reject('child.settings.update', { childId: 'c', rewardGuidelines: { smallJpy: value } });
  }
  for (const value of [-1, 121, 1.5, '10']) reject('profile.update', { profile: { age: value } });
  reject('profile.update', { profile: { preferences: { wishes: Array(13).fill('商品') } } });
  reject('profile.update', { profile: { preferences: { wishes: [''] } } });
  reject('profile.update', { profile: { gender: 'unspecified' } });
});
test('発言のnullは拒否し発言なしの作成やボタン入力を許可する', () => {
  for (const message of [null, '', ' ', 'a'.repeat(4001)]) {
    reject('conversation.message', { conversationId: 'c', message });
    reject('negotiation.message', { negotiationId: 'n', message });
  }
  assert.deepEqual(parseFERequest('conversation.create', { message: null }), { message: null });
  assert.deepEqual(parseFERequest('conversation.create', { childId: 'c', message: ' はじめまして ' }),
    { childId: 'c', message: 'はじめまして' });
  reject('conversation.generate_proposal', { conversationId: 'c', message: null });
  reject('conversation.get', { conversationId: '' });
  reject('conversation.get', { conversationId: 'a'.repeat(129) });
});
test('Noや修正希望の理由を必須にし対象の版を検証する', () => {
  for (const decision of ['rejected', 'revision_requested']) {
    for (const reason of [null, '', ' ']) reject('proposal.respond', { proposalId: 'p', version: 1, decision, reason });
    assert.equal(parseFERequest('proposal.respond', { proposalId: 'p', version: 2, decision, reason: '条件を変更したい' }).version, 2);
  }
  reject('proposal.respond', { proposalId: 'p', version: 1, decision: 'approved' });
  reject('proposal.respond', { proposalId: 'p', version: 1, decision: 'yes', reason: null });
  for (const version of [0, -1, 1.5, '1']) reject('proposal.send', { proposalId: 'p', version });
});
test('Googleのコールバック形式と重複や欠落を検証する', () => {
  assert.deepEqual(parseGoogleAuthCallback(new URLSearchParams('code=example&state=example-state&scope=openid')),
    { code: 'example', state: 'example-state' });
  assert.deepEqual(parseGoogleAuthCallback({ error: 'access_denied', state: 's' }), { error: 'access_denied', state: 's' });
  for (const input of [{ code: 'c' }, { state: 's' }, { code: 'c', error: 'e', state: 's' },
    { code: 'c', state: ' s ' }, { code: ' c ', state: 's' },
    Object.assign(Object.create({ state: 'inherited' }), { code: 'c' }),
    new URLSearchParams('code=c&state=s&state=s'), new URLSearchParams('code=c&code=d&state=s'),
    new URLSearchParams('error=e&error=f&state=s')]) {
    assert.throws(() => parseGoogleAuthCallback(input), FEInputError);
  }
});
test('端末操作は保護者権限とCSRFで守る', () => {
  for (const operation of ['child.create', 'child.rename', 'child.settings.update', 'children.list',
    'devices.list', 'pairing.requests.list', 'invitation.create', 'pairing.respond', 'device.revoke'] as const) {
    assert.equal(roleMayCall(operation, 'parent'), true);
    assert.equal(roleMayCall(operation, 'child'), false);
  }
  for (const operation of ['invitation.create', 'pairing.respond', 'device.revoke'] as const) {
    assert.equal(FE_REQUEST_DEFINITIONS[operation].csrf, true);
  }
  assert.equal(roleMayCall('pairing.request', 'parent'), false);
  assert.equal(roleMayCall('toString' as FEOperation, 'parent'), false);
  assert.equal(FE_REQUEST_DEFINITIONS['pairing.request'].authentication, 'pairing');
  assert.equal(FE_REQUEST_DEFINITIONS['pairing.request'].csrf, true);
});
const iso = (ms: number) => new Date(ms).toISOString();
const DAY = 86_400_000;
test('親子それぞれの無操作期限と絶対期限の境界で失効する', () => {
  for (const role of ['parent', 'child'] as const) {
    const { idleMs, absoluteMs } = AUTH_POLICY[role];
    const session = { role, createdAt: iso(0), lastActiveAt: iso(0), revokedAt: null };
    assert.equal(sessionStatus(session, iso(idleMs - 1)), 'active');
    assert.equal(sessionStatus(session, iso(idleMs)), 'idle_expired');
    session.lastActiveAt = iso(absoluteMs - 1);
    assert.equal(sessionStatus(session, iso(absoluteMs - 1)), 'active');
    assert.equal(sessionStatus(session, iso(absoluteMs)), 'absolute_expired');
    assert.equal(sessionStatus({ ...session, revokedAt: iso(absoluteMs - 1) }, iso(absoluteMs)), 'revoked');
    assert.equal(sessionStatus({ ...session, createdAt: 'invalid' }, iso(absoluteMs)), 'invalid');
    assert.equal(sessionStatus({ ...session, lastActiveAt: iso(absoluteMs + 1) }, iso(absoluteMs)), 'invalid');
  }
});
test('合意したCookieと端末や招待の制約を固定する', () => {
  assert.deepEqual(AUTH_POLICY.cookie, { secure: true, httpOnly: true, sameSite: 'Lax', path: '/', domain: null });
  assert.equal(AUTH_POLICY.sessionCookie, '__Host-rb_session');
  assert.equal(AUTH_POLICY.csrfHeader, 'X-CSRF-Token');
  assert.deepEqual(AUTH_POLICY.parent, { idleMs: DAY, absoluteMs: 7 * DAY, maxDevices: null });
  assert.deepEqual(AUTH_POLICY.child, { idleMs: 7 * DAY, absoluteMs: 30 * DAY, maxDevices: 1 });
  assert.deepEqual(AUTH_POLICY.invitation, { lifetimeMs: 300_000, singleUse: true, invalidatePreviousOnReissue: true });
  assert.equal(AUTH_POLICY.replaceChildSession, 'after_parent_approval');
  assert.equal(AUTH_POLICY.automaticRetry, false);
});

test('本文なしの操作はundefinedを空オブジェクトとして扱う', () => {
  for (const operation of ['auth.session', 'auth.google.start', 'pairing.bootstrap', 'pairing.requests.list', 'conversation.create'] as const) {
    assert.deepEqual(parseFERequest(operation, undefined), {});
    reject(operation, null);
  }
  reject('profile.update', undefined);
  reject('conversation.message', undefined);
});
