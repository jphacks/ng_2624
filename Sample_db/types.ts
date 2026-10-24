
// Shared contract v0.5: import into frontend, AI module, and Edge Functions.

export type UserRole = 'parent' | 'child';
export type Gender = 'male' | 'female' | 'other' | null;

export interface User {
  id: string;
  display_name: string;
  role: UserRole;
  age_group: string | null;
  grade_level: string | null;
  gender: Gender;
  onboarding_completed: boolean;
  created_at: string;
}

export type ResponseType = AIOutput['action'];
export type ProposalDecision = 'approved' | 'rejected' | 'revision_requested';
export type GoalSize = 'small' | 'medium' | 'large';

export interface ChatMessage {
  id: string;
  sender: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

export interface Product {
  id: string;
  name: string;
  priceJpy: number | null;
  productUrl: string;
  imageUrl?: string | null;
  priceCheckedAt?: string | null;
}

export interface SharedCondition {
  id: string;
  sourceUserId: string;
  targetUserId: string;
  content: string;
  approvedAt: string;
}

export interface Proposal {
  id: string;
  negotiationId: string;
  productId: string;
  version: number;
  persuasionText: string;
  purchaseConditions: string[];
  status: 'draft' | 'pending' | 'rejected' | 'agreed' | 'superseded';
}

export interface AIUserProfile {
  age: number | null;
  gender: Gender;
  preferences: { interests: string[]; wishes: string[]; expectations: string[] };
}

export interface PurchaseConstraints {
  mustHave: string[];
  mustAvoid: string[];
}

/** 保護者設定の参考価格。nullは未設定。購入確約ではない。 */
export interface RewardGuidelines {
  smallJpy: number | null;
  mediumJpy: number | null;
  largeJpy: number | null;
}

export interface ProductCandidate extends Product {
  size: GoalSize;
  description: string;
  recommendationReason: string;
  sourceUrls: string[];
}

export interface SearchSource { id: string; title: string; url: string }

export interface SearchMetadata {
  queries: string[];
  sources: SearchSource[];
  /** Geminiが返した検索候補。フロントでは隔離したiframe等で表示する。 */
  searchSuggestionsHtml: string | null;
}

export interface AIInput {
  requestId: string;
  now: string;
  role: UserRole;
  /** BEが選択する。発言やモデルの判断から共有許可を推測しない。 */
  mode: 'consultation' | 'negotiation';
  /** 本人の非公開発言。consultationでのみモデルへ渡す。 */
  message: string;
  /** 本人の履歴のみ。今回のmessageを含めない。所有者はBEが検証する。 */
  history: ChatMessage[];
  /** 本人の非公開プロフィール。consultationでのみ使用する。 */
  profile: AIUserProfile | null;
  /** BEが本人・共有先・許可の有効性を検証済みの情報のみ。 */
  sharedConditions: SharedCondition[];
  /** 以下はBEが共有範囲を検証済みの情報。未共有の発言から補完しない。 */
  constraints: PurchaseConstraints;
  /** BEが保護者の設定と共有範囲を検証済み。許容範囲は各金額の80〜120%。 */
  rewardGuidelines: RewardGuidelines;
  products: ProductCandidate[];
  selectedProductId: string | null;
  currentProposal: Proposal | null;
  negotiationResult: NegotiationResult | null;
}

/** BEが記録し、今回の共有先に公開できる結果。理由も共有許可の対象。 */
export type NegotiationResult = {
  proposalId: string;
  version: number;
} & (
  | { decision: 'approved'; reason: string | null }
  | { decision: 'rejected' | 'revision_requested'; reason: string }
);

/** 検索・提案に渡せる項目だけを列挙。非公開コンテキストを持たせない。 */
export type NegotiationContext = Pick<AIInput,
  'role' | 'now' | 'sharedConditions' | 'constraints' | 'rewardGuidelines' | 'products'
  | 'selectedProductId' | 'currentProposal' | 'negotiationResult'>;

export interface ProposalDraft {
  productId: string;
  target: UserRole;
  persuasionText: string;
  purchaseConditions: string[];
  basedOn: { proposalId: string; version: number } | null;
}

interface AIOutputBase {
  requestId: string;
  reply: string;
  /** 候補が0件でも検索の出典表示データを保持する。 */
  search: SearchMetadata | null;
}

export type AIOutput = AIOutputBase & (
  | { action: 'HEARING' }
  | { action: 'PRODUCT'; products: ProductCandidate[] }
  | { action: 'PROPOSAL'; proposalDraft: ProposalDraft }
  | { action: 'NEGOTIATION'; proposalDraft: ProposalDraft | null }
);

// The server decides whether to send messages,
// record approvals, or create goals.
