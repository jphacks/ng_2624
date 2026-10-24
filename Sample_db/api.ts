import type { AIOutput, AIUserProfile, ChatMessage, NegotiationMessage, NegotiationResult,
  ProductCandidate, Proposal, PurchaseConstraints, RewardGuidelines, SharedCondition, UserRole } from './types.ts';
import type { FEOperation } from './fe-be.ts';

export interface ProfileView { displayName: string; profile: AIUserProfile }
export interface ChildView { childId: string; displayName: string }
export interface ChildSettingsView { childId: string; rewardGuidelines: RewardGuidelines; constraints: PurchaseConstraints }
export interface ChatView {
  products: ProductCandidate[];
  selectedProductId: string | null;
  currentProposal: Proposal | null;
  /** 最後に保存されたAI出力。保存済みのmessagesと同じ返答を重複表示しない。 */
  latestAIOutput: AIOutput | null;
}
export interface ConversationView extends ChatView {
  conversationId: string;
  childId: string | null;
  messages: ChatMessage[];
}
export interface NegotiationView extends ChatView {
  negotiationId: string;
  childId: string;
  status: 'open' | 'agreed' | 'closed';
  messages: NegotiationMessage[];
  sharedConditions: SharedCondition[];
  negotiationResult: NegotiationResult | null;
}
export interface ConversationSummary { conversationId: string; childId: string | null; createdAt: string; updatedAt: string }
export interface NegotiationSummary { negotiationId: string; childId: string; status: NegotiationView['status']; createdAt: string; updatedAt: string }
export interface ProposalView { proposal: Proposal; negotiationResult: NegotiationResult | null }
export interface SignedInSession {
  authenticated: true;
  user: { role: 'parent'; displayName: string; childId: null } | { role: 'child'; displayName: string; childId: string };
  csrfToken: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
}
export interface SignedOutSession {
  authenticated: false;
  user: null;
  csrfToken: null;
  idleExpiresAt: null;
  absoluteExpiresAt: null;
}
export type SessionView = SignedInSession | SignedOutSession;
export interface DeviceView {
  deviceSessionId: string;
  role: UserRole;
  childId: string | null;
  deviceLabel: string;
  createdAt: string;
  lastActiveAt: string;
  isCurrent: boolean;
}
export interface PairingView {
  pairingRequestId: string;
  childId: string;
  childDisplayName: string;
  confirmationCode: string;
  deviceLabel: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled';
  requestedAt: string;
  expiresAt: string;
}
export interface FEResponseMap {
  'profile.get': ProfileView;
  'profile.update': ProfileView;
  'child.create': ChildView;
  'child.rename': ChildView;
  'child.settings.get': ChildSettingsView;
  'child.settings.update': ChildSettingsView;
  'children.list': { children: ChildView[] };
  'conversations.list': { conversations: ConversationSummary[] };
  'negotiations.list': { negotiations: NegotiationSummary[] };
  'conversation.create': ConversationView;
  'conversation.get': ConversationView;
  'conversation.message': ConversationView;
  'conversation.select_product': ConversationView;
  'conversation.generate_proposal': ConversationView;
  'negotiation.get': NegotiationView;
  'negotiation.message': NegotiationView;
  'negotiation.select_product': NegotiationView;
  'negotiation.generate_proposal': NegotiationView;
  'proposal.get': ProposalView;
  'proposal.edit': ProposalView;
  'proposal.send': ProposalView;
  'proposal.respond': ProposalView;
  'sharing.publish': { sharedCondition: SharedCondition };
  'sharing.revoke': { sharedConditionId: string; revoked: true };
  'auth.session': SessionView;
  /** JSONを返さず、ブラウザ遷移で開始する。 */
  'auth.google.start': never;
  'auth.google.reauthenticate': { authorizationUrl: string };
  'auth.logout': { loggedOut: true };
  'devices.list': { devices: DeviceView[] };
  'invitation.create': { invitationToken: string; childId: string; expiresAt: string };
  'pairing.bootstrap': { csrfToken: string; expiresAt: string };
  'pairing.request': PairingView;
  'pairing.requests.list': { requests: PairingView[] };
  'pairing.status': PairingView;
  'pairing.respond': PairingView;
  'pairing.complete': SignedInSession;
  'device.revoke': { deviceSessionId: string; currentDeviceRevoked: boolean };
}
export type JSONOperation = Exclude<FEOperation, 'auth.google.start'>;
export interface APISuccess<K extends JSONOperation> { data: FEResponseMap[K]; requestId: string }

export const API_ERRORS = {
  INVALID_INPUT: { status: 400, action: 'field', description: '入力内容を修正する' },
  UNAUTHENTICATED: { status: 401, action: 'login', description: '親はGoogleで再ログイン、子供はQRで再接続する' },
  FORBIDDEN: { status: 403, action: 'stop', description: '操作を中止し、権限がないことを表示する' },
  CSRF_INVALID: { status: 403, action: 'refresh_session', description: 'セッション情報を取得し直す。自動再送しない' },
  REAUTH_REQUIRED: { status: 403, action: 'reauthenticate', description: '保護者のGoogle再認証後、操作を再確認する' },
  NOT_FOUND: { status: 404, action: 'stop', description: '対象が見つからないことを表示する' },
  VERSION_CONFLICT: { status: 409, action: 'reload', description: '最新の提案を取得し直して確認する' },
  INVALID_STATE: { status: 409, action: 'reload', description: '対象の現在の状態を取得する' },
  INVITATION_INVALID: { status: 410, action: 'new_invitation', description: '期限切れ・使用済み・取り消しを区別せず、新しいQRを要求する' },
  PAIRING_EXPIRED: { status: 410, action: 'new_invitation', description: '接続準備からやり直す' },
  RATE_LIMITED: { status: 429, action: 'wait', description: 'retryAfterSecondsの経過後に利用者が再操作する' },
  AI_UNAVAILABLE: { status: 502, action: 'check_state', description: '発言の保存結果を取得して確認し、同じ発言を自動再送しない' },
  INTERNAL_ERROR: { status: 500, action: 'check_state', description: '更新結果を確認する。自動再送しない' },
} as const;
export type APIErrorCode = keyof typeof API_ERRORS;
export interface APIErrorBody {
  error: {
    code: APIErrorCode;
    message: string;
    field: string | null;
    requestId: string;
    stateMayHaveChanged: boolean;
    retryAfterSeconds: number | null;
  };
}
