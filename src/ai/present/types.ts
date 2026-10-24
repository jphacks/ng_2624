// 商品提示モジュール専用の型。
// 共有の Sample_db/types.ts には依存しない。DBとの接続時は変換関数で詰め替える。

export type GoalSize = 'small' | 'medium' | 'large';

/** present_instruction.md §3 のジャンル。flagship = 本命型 */
export type Genre = 'learning' | 'experience' | 'collectible' | 'flagship';

/** いつ提示しようとしているか */
export type Trigger = 'task_approved' | 'morning' | 'manual';

// ---------- 入力：生データ（DBの行に対応） ----------

export interface CatalogItem {
  id: string;
  name: string;
  priceJpy: number | null;
  productUrl: string;
  imageUrl?: string | null;
  genre: Genre;
  size: GoalSize;
  /** user_preferences.interests と突き合わせるタグ */
  tags: string[];
}

/** task_assignments + tasks + 最新の task_submissions / task_reviews を1行にまとめたもの */
export interface AssignmentRecord {
  id: string;
  title: string;
  status: 'assigned' | 'submitted' | 'approved' | 'rejected' | 'cancelled';
  /** 'YYYY-MM-DD'（日本時間の日付） */
  assignedFor: string | null;
  dueAt: string | null;
  createdAt: string;
  difficulty: number;
  rewardPoints: number;
  submittedAt: string | null;
  reviewDecision: 'approved' | 'rejected' | null;
  reviewedAt: string | null;
}

export interface QuizAttemptRecord {
  isCorrect: boolean;
  attemptedAt: string;
}

export interface PointRecord {
  deltaPoints: number;
  createdAt: string;
}

export interface PresentedRecord {
  productId: string;
  presentedAt: string;
}

export interface Budgets {
  small: number | null;
  medium: number | null;
  large: number | null;
}

/** presentProducts() に渡す入力。すべて引数で受け取り、DBには触らない */
export interface PresentInput {
  now: string;
  trigger: Trigger;
  assignments: AssignmentRecord[];
  quizAttempts: QuizAttemptRecord[];
  pointTransactions: PointRecord[];
  /** 現在のポイント残高（point_transactions の合計） */
  pointBalance: number;
  preferredDifficulty: number | null;
  budgets: Budgets;
  interests: string[];
  catalog: CatalogItem[];
  recentlyPresented: PresentedRecord[];
}

// ---------- 中間：取り組み指標（§2） ----------

export interface Engagement {
  /** approved ÷ 評価可能な割り当て数。データなしは null */
  completionRate: number | null;
  /** 期限内に提出できた割合 */
  onTimeRate: number | null;
  /** 提出のあった連続日数（1日休みまでは途切れない） */
  streakDays: number;
  /** 直近20件の正答率 */
  accuracy: number | null;
  /** 平均難易度 ÷ 希望難易度 */
  challengeRatio: number | null;
  /** 直近2週の獲得ポイント ÷ 2 */
  weeklyPace: number;
  /** 1回あたりの平均獲得ポイント（「あと◯回」の計算用） */
  avgRewardPoints: number | null;
  /** 評価に使った割り当ての件数 */
  sampleSize: number;
  lastRejectedAt: string | null;
}

// ---------- 出力：提示プラン ----------

export type Condition =
  | { kind: 'weekday_submissions'; required: number; outOf: number }
  | { kind: 'accuracy'; minRate: number }
  | { kind: 'miss_tolerance'; allowedMisses: number }
  | { kind: 'deadline'; date: string };

export interface Milestone {
  /** この残高に到達したら達成 */
  atPoints: number;
  remainingTimes: number;
  weeksFromNow: number | null;
  /** 途中でもらえる small のごほうび。単なる中間地点なら null */
  rewardItem: CatalogItem | null;
}

export interface Offer {
  item: CatalogItem;
  size: GoalSize;
  requiredPoints: number;
  remainingPoints: number;
  /** 子供に見せる「あと◯回」 */
  remainingTimes: number;
  /** 到達予測（週）。ペース不明なら null */
  predictedWeeks: number | null;
  milestone: Milestone | null;
  conditions: Condition[];
  conditionTexts: string[];
}

export interface FlagshipView {
  item: CatalogItem;
  requiredPoints: number;
  remainingPoints: number;
  remainingTimes: number;
  predictedWeeks: number | null;
  checkpoints: Milestone[];
}

export type PresentationPlan =
  | {
      kind: 'skip';
      reason: 'recent_failure' | 'no_candidates';
      /** この時刻以降に再度呼び出す */
      retryAt: string | null;
      reasons: string[];
    }
  | {
      kind: 'present';
      engagement: Engagement;
      offers: Offer[];
      /** 進捗バー最上段に常に表示する本命 */
      flagship: FlagshipView | null;
      /** 1択のときにセットで出す「今日できるタスク」 */
      suggestedTask: AssignmentRecord | null;
      /** 判定理由（デバッグ・文面生成用） */
      reasons: string[];
    };
