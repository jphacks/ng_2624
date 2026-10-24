import type { AIUserProfile, PurchaseConstraints, RewardGuidelines, ProposalDecision } from './types.ts';

/** 設定更新は省略した項目を維持し、nullは未設定、[]はリストの全消去を表す。 */
export interface ProfilePatch {
  age?: AIUserProfile['age'];
  gender?: AIUserProfile['gender'];
  preferences?: Partial<AIUserProfile['preferences']>;
}
export interface OwnProfileUpdate {
  displayName?: string;
  profile?: ProfilePatch;
}
export interface ChildSettingsUpdate {
  childId: string;
  rewardGuidelines?: Partial<RewardGuidelines>;
  constraints?: Partial<PurchaseConstraints>;
}
export interface ProposalReference { proposalId: string; version: number }
export type ProposalResponse = ProposalReference & (
  | { decision: 'approved'; reason: string | null }
  | { decision: Exclude<ProposalDecision, 'approved'>; reason: string }
);
export type GoogleAuthCallback =
  | { code: string; state: string; error?: never }
  | { error: string; state: string; code?: never };

/** 操作キーはBEのルート等から決める内部識別子。JSON本文へ追加する変数ではない。
 * IDはURL等から取り出してここへまとめてもよい。履歴・role・時刻をFEから受け取らない。
 */
export interface FERequestMap {
  'profile.update': OwnProfileUpdate;
  'child.create': { displayName: string };
  'child.rename': { childId: string; displayName: string };
  'child.settings.update': ChildSettingsUpdate;
  'children.list': Record<string, never>;
  'conversation.create': { childId?: string; message?: string | null };
  'conversation.get': { conversationId: string };
  'conversation.message': { conversationId: string; message: string };
  'conversation.select_product': { conversationId: string; selectedProductId: string };
  'conversation.generate_proposal': { conversationId: string };
  'negotiation.get': { negotiationId: string };
  'negotiation.message': { negotiationId: string; message: string };
  'negotiation.select_product': { negotiationId: string; selectedProductId: string };
  'negotiation.generate_proposal': { negotiationId: string };
  'proposal.get': { proposalId: string };
  'proposal.edit': ProposalReference & { persuasionText?: string; purchaseConditions?: string[] };
  'proposal.send': ProposalReference;
  'proposal.respond': ProposalResponse;
  'sharing.publish': { conversationId: string; negotiationId: string; content: string };
  'sharing.revoke': { sharedConditionId: string };
  'auth.google.start': Record<string, never>;
  'auth.google.reauthenticate': Record<string, never>;
  'auth.logout': Record<string, never>;
  'devices.list': Record<string, never>;
  'invitation.create': { childId: string };
  'pairing.request': { invitationToken: string };
  'pairing.status': { pairingRequestId: string };
  'pairing.respond': { pairingRequestId: string; decision: 'approved' | 'rejected' };
  'device.revoke': { deviceSessionId: string };
}
export type FEOperation = keyof FERequestMap;
