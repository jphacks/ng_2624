import type { APISuccess, JSONOperation } from '../../Sample_db/api.ts';

/** 返却型の検証とFE向け資料で共有するJSONスキーマのサブセット。 */
export interface ResponseSchema {
  type?: 'object' | 'array' | 'string' | 'integer' | 'boolean' | 'null';
  $ref?: string;
  properties?: Record<string, ResponseSchema>;
  required?: string[];
  additionalProperties?: false;
  items?: ResponseSchema;
  anyOf?: ResponseSchema[];
  enum?: readonly (string | boolean)[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  format?: 'date-time' | 'https-url';
}
const ref = (name: string): ResponseSchema => ({ $ref: name });
const str = (maxLength = 4000, minLength = 1): ResponseSchema => ({ type: 'string', minLength, maxLength });
const id = str(128), name = str(100), strings = { type: 'array', items: str(300) } as ResponseSchema;
const integer = (minimum = 0): ResponseSchema => ({ type: 'integer', minimum, maximum: Number.MAX_SAFE_INTEGER });
const nil: ResponseSchema = { type: 'null' }, bool: ResponseSchema = { type: 'boolean' };
const nullable = (schema: ResponseSchema): ResponseSchema => ({ anyOf: [schema, nil] });
const array = (items: ResponseSchema): ResponseSchema => ({ type: 'array', items });
const enumeration = (...values: (string | boolean)[]): ResponseSchema => ({ enum: values });
const object = (properties: Record<string, ResponseSchema>, optional: string[] = []): ResponseSchema => ({
  type: 'object', properties, required: Object.keys(properties).filter(key => !optional.includes(key)), additionalProperties: false,
});
const time: ResponseSchema = { ...str(40), format: 'date-time' };
const url: ResponseSchema = { ...str(4096), format: 'https-url' };
const role = enumeration('parent', 'child');
const aiBase = { requestId: id, reply: str(), search: nullable(ref('SearchMetadata')) };
const chatBase = { products: array(ref('ProductCandidate')), selectedProductId: nullable(id),
  currentProposal: nullable(ref('Proposal')), latestAIOutput: nullable(ref('AIOutput')) };

export const RESPONSE_MODELS: Record<string, ResponseSchema> = {
  ProfileView: object({ displayName: name, profile: ref('AIUserProfile') }),
  AIUserProfile: object({ age: nullable({ ...integer(), maximum: 120 }), gender: nullable(enumeration('male', 'female', 'other')),
    preferences: object({ interests: strings, wishes: strings, expectations: strings }) }),
  ChildView: object({ childId: id, displayName: name }),
  ChildList: object({ children: array(ref('ChildView')) }),
  ChildSettingsView: object({ childId: id, rewardGuidelines: ref('RewardGuidelines'), constraints: ref('PurchaseConstraints') }),
  RewardGuidelines: object({ smallJpy: nullable(integer()), mediumJpy: nullable(integer()), largeJpy: nullable(integer()) }),
  PurchaseConstraints: object({ mustHave: strings, mustAvoid: strings }),
  ConversationSummary: object({ conversationId: id, childId: nullable(id), createdAt: time, updatedAt: time }),
  ConversationList: object({ conversations: array(ref('ConversationSummary')) }),
  NegotiationSummary: object({ negotiationId: id, childId: id, status: enumeration('open', 'agreed', 'closed'), createdAt: time, updatedAt: time }),
  NegotiationList: object({ negotiations: array(ref('NegotiationSummary')) }),
  ConversationView: object({ conversationId: id, childId: nullable(id), messages: array(ref('ChatMessage')), ...chatBase }),
  ChatMessage: object({ id, sender: enumeration('user', 'assistant'), content: str(), createdAt: time }),
  NegotiationView: object({ negotiationId: id, childId: id, status: enumeration('open', 'agreed', 'closed'),
    messages: array(ref('NegotiationMessage')), ...chatBase, sharedConditions: array(ref('SharedCondition')),
    negotiationResult: nullable(ref('NegotiationResult')) }),
  NegotiationMessage: object({ id, sender: enumeration('parent', 'child', 'assistant'), content: str(), createdAt: time }),
  ProductCandidate: object({ id, name: str(300), priceJpy: nullable(integer()), productUrl: url,
    imageUrl: nullable(url), priceCheckedAt: nullable(time), size: enumeration('small', 'medium', 'large'),
    description: str(1000), recommendationReason: str(1000), sourceUrls: array(url) }, ['imageUrl', 'priceCheckedAt']),
  Proposal: object({ id, negotiationId: nullable(id), productId: id, version: integer(1), persuasionText: str(),
    purchaseConditions: array(str(500)), status: enumeration('draft', 'pending', 'rejected', 'agreed', 'superseded') }),
  ProposalView: object({ proposal: ref('Proposal'), negotiationResult: nullable(ref('NegotiationResult')) }),
  NegotiationResult: { anyOf: [
    object({ proposalId: id, version: integer(1), decision: enumeration('approved'), reason: nullable(str()) }),
    object({ proposalId: id, version: integer(1), decision: enumeration('rejected', 'revision_requested'), reason: str() }),
  ] },
  SharedCondition: object({ id, sourceUserId: id, targetUserId: id, content: str(), approvedAt: time }),
  SharedConditionResult: object({ sharedCondition: ref('SharedCondition') }),
  SharedConditionRevocation: object({ sharedConditionId: id, revoked: enumeration(true) }),
  SearchMetadata: object({ queries: array(str()), sources: array(ref('SearchSource')), searchSuggestionsHtml: nullable(str(100000, 0)) }),
  SearchSource: object({ id, title: str(), url }),
  ProposalDraft: object({ productId: id, target: role, persuasionText: str(), purchaseConditions: array(str(500)),
    basedOn: nullable(object({ proposalId: id, version: integer(1) })) }),
  AIOutput: { anyOf: [
    object({ ...aiBase, action: enumeration('HEARING') }),
    object({ ...aiBase, action: enumeration('PRODUCT'), products: array(ref('ProductCandidate')) }),
    object({ ...aiBase, action: enumeration('PROPOSAL'), proposalDraft: ref('ProposalDraft') }),
    object({ ...aiBase, action: enumeration('NEGOTIATION'), proposalDraft: nullable(ref('ProposalDraft')) }),
  ] },
  SignedInSession: object({ authenticated: enumeration(true), user: { anyOf: [
    object({ role: enumeration('parent'), displayName: name, childId: nil }),
    object({ role: enumeration('child'), displayName: name, childId: id }),
  ] }, csrfToken: str(4096), idleExpiresAt: time, absoluteExpiresAt: time }),
  SignedOutSession: object({ authenticated: enumeration(false), user: nil, csrfToken: nil, idleExpiresAt: nil, absoluteExpiresAt: nil }),
  SessionView: { anyOf: [ref('SignedInSession'), ref('SignedOutSession')] },
  AuthorizationRedirect: object({ authorizationUrl: url }),
  LogoutResult: object({ loggedOut: enumeration(true) }),
  DeviceView: object({ deviceSessionId: id, role, childId: nullable(id), deviceLabel: str(300), createdAt: time, lastActiveAt: time, isCurrent: bool }),
  DeviceList: object({ devices: array(ref('DeviceView')) }),
  DeviceRevocation: object({ deviceSessionId: id, currentDeviceRevoked: bool }),
  InvitationResult: object({ invitationToken: str(1024), childId: id, expiresAt: time }),
  PairingSession: object({ csrfToken: str(4096), expiresAt: time }),
  PairingView: object({ pairingRequestId: id, childId: id, childDisplayName: name, confirmationCode: str(32), deviceLabel: str(300),
    status: enumeration('pending', 'approved', 'rejected', 'expired', 'cancelled'), requestedAt: time, expiresAt: time }),
  PairingList: object({ requests: array(ref('PairingView')) }),
};

function valid(schema: ResponseSchema, value: unknown): boolean {
  if (schema.$ref) return Object.hasOwn(RESPONSE_MODELS, schema.$ref) && valid(RESPONSE_MODELS[schema.$ref], value);
  if (schema.anyOf) return schema.anyOf.some(candidate => valid(candidate, value));
  if (schema.enum) return schema.enum.includes(value as string | boolean);
  if (schema.type === 'null') return value === null;
  if (schema.type === 'boolean') return typeof value === 'boolean';
  if (schema.type === 'integer') return typeof value === 'number' && Number.isSafeInteger(value)
    && value >= schema.minimum! && value <= schema.maximum!;
  if (schema.type === 'string') {
    if (typeof value !== 'string' || value.length < schema.minLength! || value.length > schema.maxLength!) return false;
    if (schema.format === 'date-time') return /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)
      && Number.isFinite(Date.parse(value)) && new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) === value.slice(0, 10);
    if (schema.format === 'https-url') {
      try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; }
    }
    return true;
  }
  if (schema.type === 'array') return Array.isArray(value) && value.every(item => valid(schema.items!, item));
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>, properties = schema.properties!;
    return schema.required!.every(key => Object.hasOwn(record, key))
      && Object.keys(record).every(key => Object.hasOwn(properties, key) && valid(properties[key], record[key]));
  }
  return false;
}
export function parseAPISuccess<K extends JSONOperation>(model: string, value: unknown): APISuccess<K> {
  if (!Object.hasOwn(RESPONSE_MODELS, model) || !valid(object({ data: ref(model), requestId: id }), value)) {
    throw new Error('API応答の形式が正しくありません。');
  }
  return value as APISuccess<K>;
}
