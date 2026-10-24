import type { FEOperation, FERequestMap, GoogleAuthCallback } from '../../Sample_db/fe-be.ts';
import type { UserRole } from '../../Sample_db/types.ts';

export type InputRule =
  | { kind: 'string'; max: number }
  | { kind: 'integer'; min: number; max: number }
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'array'; item: InputRule; max: number }
  | { kind: 'nullable'; value: InputRule }
  | { kind: 'object'; fields: Record<string, InputRule>; required: readonly string[]; min: number };
export interface FERequestDefinition {
  label: string;
  section: 'settings' | 'conversation' | 'operation' | 'auth';
  rule: InputRule;
  authentication: 'session' | 'pairing' | 'none';
  roles: readonly UserRole[];
  csrf: boolean;
  googleReauthentication: boolean;
  note: string;
}
const str = (max = 4000): InputRule => ({ kind: 'string', max });
const id = str(128);
const integer = (min: number, max = Number.MAX_SAFE_INTEGER): InputRule => ({ kind: 'integer', min, max });
const nullable = (value: InputRule): InputRule => ({ kind: 'nullable', value });
const strings = (max = 300): InputRule => ({ kind: 'array', item: str(max), max: 12 });
const enumeration = (...values: string[]): InputRule => ({ kind: 'enum', values });
const object = (fields: Record<string, InputRule>, required: string[] = Object.keys(fields), min = required.length): InputRule =>
  ({ kind: 'object', fields, required, min });
const ownProfile = object({
  displayName: str(100),
  profile: object({ age: nullable(integer(0, 120)), gender: nullable(enumeration('male', 'female', 'other')),
    preferences: object({ interests: strings(), wishes: strings(), expectations: strings() }, [], 1) }, [], 1),
}, [], 1);
function definition(label: string, section: FERequestDefinition['section'], rule: InputRule,
  options: Partial<Omit<FERequestDefinition, 'label' | 'section' | 'rule'>> = {}): FERequestDefinition {
  return { label, section, rule, authentication: 'session', roles: ['parent', 'child'], csrf: true,
    googleReauthentication: false, note: '', ...options };
}
const read = { csrf: false };
const parent = { roles: ['parent'] as const };
const important = { ...parent, googleReauthentication: true };
const proposalRef = { proposalId: id, version: integer(1) };

/** 型・検証・Wordの一覧で共用する定義。運用上の権限照合はBEで別途必要。 */
export const FE_REQUEST_DEFINITIONS: Record<FEOperation, FERequestDefinition> = {
  'profile.update': definition('本人のプロフィールを更新', 'settings', ownProfile,
    { note: '省略した項目は保持。本人のプロフィールは認証から特定。空の更新は不可。' }),
  'child.create': definition('子供プロフィールを作成', 'settings', object({ displayName: str(100) }), parent),
  'child.rename': definition('子供の表示名を変更', 'settings', object({ childId: id, displayName: str(100) }), parent),
  'child.settings.update': definition('子供別の目安金額・条件を更新', 'settings', object({ childId: id,
    rewardGuidelines: object({ smallJpy: nullable(integer(0)), mediumJpy: nullable(integer(0)), largeJpy: nullable(integer(0)) }, [], 1),
    constraints: object({ mustHave: strings(), mustAvoid: strings() }, [], 1),
  }, ['childId'], 2), { ...parent, note: 'childIdと変更する項目を送信。省略は保持、金額のnullは未設定、[]はリストの全消去。' }),
  'children.list': definition('保護者に紐付く子供の一覧を取得', 'settings', object({}), { ...parent, ...read }),
  'conversation.create': definition('個別相談を作成', 'conversation', object({ childId: id, message: nullable(str()) }, []),
    { note: '親が対象の子供を指定する場合だけchildId。子供本人は認証から特定。作成だけなら本文なし。最初の発言をまとめる場合はmessage。' }),
  'conversation.get': definition('個別相談を取得', 'conversation', object({ conversationId: id }), read),
  'conversation.message': definition('個別相談へ発言', 'conversation', object({ conversationId: id, message: str() })),
  'conversation.select_product': definition('個別相談で商品を選択', 'operation', object({ conversationId: id, selectedProductId: id })),
  'conversation.generate_proposal': definition('個別相談で提案下書きを生成', 'operation', object({ conversationId: id }),
    { note: '選択済み商品はBEが取得。AIを呼ぶ場合のmessageはnull。' }),
  'negotiation.get': definition('共有交渉を取得', 'conversation', object({ negotiationId: id }), read),
  'negotiation.message': definition('共有交渉へ発言', 'conversation', object({ negotiationId: id, message: str() })),
  'negotiation.select_product': definition('共有交渉で商品を選択', 'operation', object({ negotiationId: id, selectedProductId: id })),
  'negotiation.generate_proposal': definition('共有交渉で修正下書きを生成', 'operation', object({ negotiationId: id }),
    { note: '対象提案・選択商品はBEが取得。AIを呼ぶ場合のmessageはnull。' }),
  'proposal.get': definition('提案を取得', 'operation', object({ proposalId: id }), read),
  'proposal.edit': definition('提案下書きを編集', 'operation', object({ ...proposalRef,
    persuasionText: str(), purchaseConditions: strings(500) }, ['proposalId', 'version'], 3),
    { note: '本文と購入条件は少なくとも一方を送信。BEが新しい版として保存。' }),
  'proposal.send': definition('確認した提案を送信', 'operation', object(proposalRef),
    { note: '送信した本人の同意を対象ID・版へ記録。初回提案にはnegotiationId不要。' }),
  'proposal.respond': definition('提案へ回答', 'operation', object({ ...proposalRef,
    decision: enumeration('approved', 'rejected', 'revision_requested'), reason: nullable(str()) }),
    { note: 'approvedのreasonはnull可。rejected・revision_requestedは理由必須。初回の親のYesは交渉省略、Noは共有交渉へ。' }),
  'sharing.publish': definition('個別相談の要約を交渉へ公開', 'operation', object({ conversationId: id, negotiationId: id, content: str() }),
    { note: '本人が確認・編集して公開を許可した要約だけ。私的な履歴全体は送信しない。' }),
  'sharing.revoke': definition('要約の公開を取り消す', 'operation', object({ sharedConditionId: id })),
  'auth.session': definition('現在のログイン状態とCSRFトークンを取得', 'auth', object({}),
    { authentication: 'none', roles: [], csrf: false, note: '本文なし。現在のCookieに対応するログイン状態とcsrfTokenを取得。' }),
  'auth.google.start': definition('Googleログインを開始', 'auth', object({}),
    { authentication: 'none', roles: [], csrf: false, note: 'BE主導の認可コード方式。JSON本文なし。Googleとの往復はstateで照合。' }),
  'auth.google.reauthenticate': definition('保護者がGoogleで再認証', 'auth', object({}), parent),
  'auth.logout': definition('現在の端末からログアウト', 'auth', object({})),
  'devices.list': definition('保護者が接続端末を確認', 'auth', object({}), { ...parent, ...read }),
  'invitation.create': definition('対象の子供の招待QRを発行・再発行', 'auth', object({ childId: id }), important),
  'pairing.bootstrap': definition('子供端末の仮セッションを開始', 'auth', object({}),
    { authentication: 'none', roles: [], csrf: false, note: '本文なし。接続申請用のCookieとcsrfTokenを取得。通常のログイン状態は変更しない。' }),
  'pairing.requests.list': definition('保護者が接続申請を確認', 'auth', object({}), { ...parent, ...read }),
  'pairing.request': definition('QRから子供端末の接続を申請', 'auth', object({ invitationToken: str(1024) }),
    { authentication: 'pairing', roles: [], note: 'BEが発行した仮セッションとCSRFトークンを使用。申請した端末へ紐付ける。' }),
  'pairing.status': definition('子供端末で接続承認の結果を取得', 'auth', object({ pairingRequestId: id }),
    { authentication: 'pairing', roles: [], csrf: false, note: '申請時の仮セッションで端末を確認。IDだけでは結果・セッションを渡さない。' }),
  'pairing.respond': definition('保護者が子供端末の接続を承認・拒否', 'auth', object({ pairingRequestId: id,
    decision: enumeration('approved', 'rejected') }), important),
  'device.revoke': definition('保護者が端末を解除', 'auth', object({ deviceSessionId: id }), important),
};

export class FEInputError extends Error {
  readonly code = 'INVALID_INPUT';
  readonly field: string;
  constructor(field: string) {
    super(`${field}の形式が正しくありません。`);
    this.name = 'FEInputError';
    this.field = field;
  }
}
function invalid(field: string): never { throw new FEInputError(field); }
function parseRule(rule: InputRule, value: unknown, field: string): unknown {
  if (rule.kind === 'nullable') return value === null ? null : parseRule(rule.value, value, field);
  if (rule.kind === 'string') {
    if (typeof value !== 'string' || !value.trim() || value.length > rule.max) invalid(field);
    return value.trim();
  }
  if (rule.kind === 'integer') {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < rule.min || value > rule.max) invalid(field);
    return value;
  }
  if (rule.kind === 'enum') {
    if (typeof value !== 'string' || !rule.values.includes(value)) invalid(field);
    return value;
  }
  if (rule.kind === 'array') {
    if (!Array.isArray(value) || value.length > rule.max) invalid(field);
    return value.map((item, index) => parseRule(rule.item, item, `${field}[${index}]`));
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(field);
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length < rule.min || keys.some(key => !Object.hasOwn(rule.fields, key))) invalid(field);
  for (const key of rule.required) if (!Object.hasOwn(record, key)) invalid(`${field}.${key}`);
  return Object.fromEntries(keys.map(key => [key, parseRule(rule.fields[key], record[key], `${field}.${key}`)]));
}

/** 認証済みの投稿先と操作はBEが決める。未知の属性・空の更新・理由不足を受け付けない。 */
export function parseFERequest<K extends FEOperation>(operation: K, value: unknown): FERequestMap[K] {
  if (!Object.hasOwn(FE_REQUEST_DEFINITIONS, operation)) invalid('operation');
  const rule = FE_REQUEST_DEFINITIONS[operation].rule;
  const input = value === undefined && rule.kind === 'object' && rule.min === 0 ? {} : value;
  const result = parseRule(rule, input, operation) as FERequestMap[K];
  if (operation === 'proposal.respond') {
    const response = result as FERequestMap['proposal.respond'];
    if (response.decision !== 'approved' && response.reason === null) invalid('proposal.respond.reason');
  }
  return result;
}

/** Googleが返すscope等の付随項目は使用しない。code/stateをFEに捏造させる用途ではない。 */
export function parseGoogleAuthCallback(value: unknown): GoogleAuthCallback {
  const input = value instanceof URLSearchParams ? (() => {
    for (const field of ['code', 'state', 'error']) if (value.getAll(field).length > 1) invalid(field);
    return Object.fromEntries(value);
  })() : value;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) invalid('callback');
  const record = input as Record<string, unknown>;
  if (!Object.hasOwn(record, 'state')) invalid('state');
  const state = parseRule(str(1024), record.state, 'state') as string;
  if (state !== record.state) invalid('state');
  if (Object.hasOwn(record, 'code') === Object.hasOwn(record, 'error')) invalid('callback');
  if (Object.hasOwn(record, 'code')) {
    const code = parseRule(str(4096), record.code, 'code') as string;
    if (code !== record.code) invalid('code');
    return { code, state };
  }
  return { error: parseRule(str(200), record.error, 'error') as string, state };
}
