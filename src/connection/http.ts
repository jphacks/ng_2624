import type { FEOperation, FERequestMap } from '../../Sample_db/fe-be.ts';
import { API_ERRORS } from '../../Sample_db/api.ts';
import type { APIErrorBody, APISuccess, JSONOperation } from '../../Sample_db/api.ts';
import { AUTH_POLICY } from './policy.ts';
import { FEInputError, FE_REQUEST_DEFINITIONS, parseFERequest } from './requests.ts';
import { parseAPISuccess } from './responses.ts';

export interface HTTPDefinition {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  pathParameters: readonly string[];
  successStatus: 200 | 201 | 303;
  response: string;
}
const route = (method: HTTPDefinition['method'], path: string, response: string,
  successStatus: HTTPDefinition['successStatus'] = 200): HTTPDefinition => ({
    method, path, response, successStatus,
    pathParameters: [...path.matchAll(/\{(\w+)\}/g)].map(match => match[1]),
  });
export const FE_HTTP_DEFINITIONS: Record<FEOperation, HTTPDefinition> = {
  'profile.get': route('GET', '/api/profile', 'ProfileView'),
  'profile.update': route('PATCH', '/api/profile', 'ProfileView'),
  'child.create': route('POST', '/api/children', 'ChildView', 201),
  'child.rename': route('PATCH', '/api/children/{childId}', 'ChildView'),
  'child.settings.get': route('GET', '/api/children/{childId}/settings', 'ChildSettingsView'),
  'child.settings.update': route('PATCH', '/api/children/{childId}/settings', 'ChildSettingsView'),
  'children.list': route('GET', '/api/children', 'ChildList'),
  'conversations.list': route('GET', '/api/conversations', 'ConversationList'),
  'negotiations.list': route('GET', '/api/negotiations', 'NegotiationList'),
  'conversation.create': route('POST', '/api/conversations', 'ConversationView', 201),
  'conversation.get': route('GET', '/api/conversations/{conversationId}', 'ConversationView'),
  'conversation.message': route('POST', '/api/conversations/{conversationId}/messages', 'ConversationView'),
  'conversation.select_product': route('PATCH', '/api/conversations/{conversationId}/selected-product', 'ConversationView'),
  'conversation.generate_proposal': route('POST', '/api/conversations/{conversationId}/proposal-drafts', 'ConversationView'),
  'negotiation.get': route('GET', '/api/negotiations/{negotiationId}', 'NegotiationView'),
  'negotiation.message': route('POST', '/api/negotiations/{negotiationId}/messages', 'NegotiationView'),
  'negotiation.select_product': route('PATCH', '/api/negotiations/{negotiationId}/selected-product', 'NegotiationView'),
  'negotiation.generate_proposal': route('POST', '/api/negotiations/{negotiationId}/proposal-drafts', 'NegotiationView'),
  'proposal.get': route('GET', '/api/proposals/{proposalId}', 'ProposalView'),
  'proposal.edit': route('PATCH', '/api/proposals/{proposalId}', 'ProposalView'),
  'proposal.send': route('POST', '/api/proposals/{proposalId}/send', 'ProposalView'),
  'proposal.respond': route('POST', '/api/proposals/{proposalId}/responses', 'ProposalView'),
  'sharing.publish': route('POST', '/api/negotiations/{negotiationId}/shared-conditions', 'SharedConditionResult', 201),
  'sharing.revoke': route('DELETE', '/api/shared-conditions/{sharedConditionId}', 'SharedConditionRevocation'),
  'auth.session': route('GET', '/api/auth/session', 'SessionView'),
  'auth.google.start': route('GET', '/api/auth/google/start', 'BrowserRedirect', 303),
  'auth.logout': route('POST', '/api/auth/logout', 'LogoutResult'),
  'devices.list': route('GET', '/api/devices', 'DeviceList'),
  'invitation.create': route('POST', '/api/children/{childId}/invitations', 'InvitationResult', 201),
  'pairing.bootstrap': route('POST', '/api/pairing/session', 'PairingSession', 201),
  'pairing.request': route('POST', '/api/pairing/requests', 'PairingView', 201),
  'pairing.requests.list': route('GET', '/api/pairing/requests', 'PairingList'),
  'pairing.status': route('GET', '/api/pairing/requests/{pairingRequestId}', 'PairingView'),
  'pairing.respond': route('POST', '/api/pairing/requests/{pairingRequestId}/responses', 'PairingView'),
  'pairing.complete': route('POST', '/api/pairing/requests/{pairingRequestId}/complete', 'SignedInSession'),
  'device.revoke': route('DELETE', '/api/devices/{deviceSessionId}', 'DeviceRevocation'),
};
export const GOOGLE_CALLBACK = {
  method: 'GET', path: '/api/auth/google/callback', successStatus: 303,
  successLocation: '/', failureLocation: '/?authError=login_failed',
} as const;

export interface PreparedFERequest { path: string; init: RequestInit }
/** URL内のIDとJSON本文を分離し、送信前に共通入力を検証する。 */
export function prepareFERequest<K extends FEOperation>(operation: K, input: FERequestMap[K],
  csrfToken?: string): PreparedFERequest {
  const parsed = parseFERequest(operation, input) as Record<string, unknown>;
  const definition = FE_HTTP_DEFINITIONS[operation];
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (FE_REQUEST_DEFINITIONS[operation].csrf) {
    if (!csrfToken || csrfToken.length > 4096 || /[\x00-\x20\x7f]/.test(csrfToken)) throw new FEInputError(AUTH_POLICY.csrfHeader);
    headers[AUTH_POLICY.csrfHeader] = csrfToken;
  }
  let path = definition.path;
  for (const parameter of definition.pathParameters) {
    const value = parsed[parameter];
    // ドット区間やスラッシュの解釈差による投稿先の変更を防ぐ。
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new FEInputError(parameter);
    path = path.replace(`{${parameter}}`, encodeURIComponent(value));
  }
  const body = Object.fromEntries(Object.entries(parsed).filter(([key]) => !definition.pathParameters.includes(key)));
  const init: RequestInit = { method: definition.method, headers, credentials: 'same-origin', cache: 'no-store', redirect: 'error' };
  if (Object.keys(body).length) {
    if (definition.method === 'GET' || definition.method === 'DELETE') throw new FEInputError('body');
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  return { path, init };
}

export class FEAPIError extends Error {
  readonly detail: APIErrorBody['error'];
  readonly status: number;
  constructor(status: number, detail: APIErrorBody['error']) {
    super(detail.message); this.name = 'FEAPIError'; this.status = status; this.detail = detail;
  }
}
export class FETransportError extends Error {
  readonly code: 'NETWORK_ERROR' | 'INVALID_RESPONSE';
  readonly stateMayHaveChanged: boolean;
  constructor(code: FETransportError['code'], stateMayHaveChanged: boolean) {
    super(code === 'NETWORK_ERROR' ? '通信結果を確認できません。状態を取得して確認してください。' : '応答の形式が正しくありません。');
    this.name = 'FETransportError'; this.code = code; this.stateMayHaveChanged = stateMayHaveChanged;
  }
}
function parseError(value: unknown, status: number): APIErrorBody['error'] {
  if (!value || typeof value !== 'object' || !('error' in value)) throw new FETransportError('INVALID_RESPONSE', true);
  const detail = (value as APIErrorBody).error;
  if (!detail || !Object.hasOwn(API_ERRORS, detail.code) || API_ERRORS[detail.code].status !== status
    || typeof detail.message !== 'string' || !detail.message || typeof detail.requestId !== 'string' || !detail.requestId
    || !(detail.field === null || typeof detail.field === 'string') || typeof detail.stateMayHaveChanged !== 'boolean'
    || !(detail.retryAfterSeconds === null || Number.isSafeInteger(detail.retryAfterSeconds) && detail.retryAfterSeconds >= 0)
    || (detail.code === 'RATE_LIMITED') !== (detail.retryAfterSeconds !== null)) {
    throw new FETransportError('INVALID_RESPONSE', true);
  }
  return detail;
}
export interface FEClientOptions {
  /** サイト自身のオリジン。パスやクエリを含めない。 */
  origin: string;
  csrfToken?: () => string | undefined;
  fetch?: typeof fetch;
}
/** Cookieを同一オリジンだけに送信する。認証失敗や通信断も自動再送しない。 */
export function createFEClient(options: FEClientOptions) {
  const origin = new URL(options.origin);
  if (!['https:', 'http:'].includes(origin.protocol) || origin.username || origin.password
    || origin.pathname !== '/' || origin.search || origin.hash) throw new FEInputError('origin');
  if (origin.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) throw new FEInputError('origin');
  const browserOrigin = (globalThis as { location?: { origin: string } }).location?.origin;
  if (browserOrigin && browserOrigin !== origin.origin) throw new FEInputError('origin');
  const send = options.fetch ?? globalThis.fetch;
  return {
    /** window.location.assignへ渡す。fetchでGoogle認証画面を開かない。 */
    googleLoginUrl: () => new URL(FE_HTTP_DEFINITIONS['auth.google.start'].path, origin).href,
    async request<K extends JSONOperation>(operation: K, input: FERequestMap[K], signal?: AbortSignal): Promise<APISuccess<K>> {
      if ((operation as FEOperation) === 'auth.google.start') throw new FEInputError('operation');
      const prepared = prepareFERequest(operation, input, options.csrfToken?.());
      const uncertain = !['GET'].includes(prepared.init.method!);
      let response: Response;
      try { response = await send(new URL(prepared.path, origin), { ...prepared.init, signal }); }
      catch { throw new FETransportError('NETWORK_ERROR', uncertain); }
      const contentType = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
      if (contentType !== 'application/json') throw new FETransportError('INVALID_RESPONSE', uncertain);
      let payload: unknown;
      try { payload = await response.json(); } catch { throw new FETransportError('INVALID_RESPONSE', uncertain); }
      if (!response.ok) {
        let detail: APIErrorBody['error'];
        try { detail = parseError(payload, response.status); }
        catch { throw new FETransportError('INVALID_RESPONSE', uncertain); }
        throw new FEAPIError(response.status, detail);
      }
      if (response.status !== FE_HTTP_DEFINITIONS[operation].successStatus) throw new FETransportError('INVALID_RESPONSE', uncertain);
      try { return parseAPISuccess<K>(FE_HTTP_DEFINITIONS[operation].response, payload); }
      catch { throw new FETransportError('INVALID_RESPONSE', uncertain); }
    },
  };
}
