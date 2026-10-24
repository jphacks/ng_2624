// 仮の値。チームで決まったらここだけ直す。
import type { Genre, GoalSize } from './types.ts';

export const PRESENT_CONFIG = {
  /** 指標を見る期間（日） */
  windowDays: 14,
  /** 正答率に使う直近の件数 */
  accuracySampleSize: 20,
  /** goals.required_points */
  sizePoints: { small: 100, medium: 300, large: 800 } satisfies Record<GoalSize, number>,
  /** 予測週数：direct 以下はそのまま、withMilestone 以下は中間マイルストーン、超えたらサイズを下げる */
  weeks: { direct: 2, withMilestone: 6 },
  /** 完了率の境目 */
  completion: { low: 0.5, high: 0.8 },
  /** 提示する商品の数 */
  optionCount: { low: 1, middle: 2, high: 3, coldStart: 2 },
  /** これ未満の件数しかなければ「データ不足」とみなす */
  coldStartMinSamples: 3,
  /** 学習延長型を優先する条件 */
  quality: { highAccuracy: 0.85, minChallengeRatio: 1.0 },
  /** 同じ商品を再提示するまでの日数 */
  representCooldownDays: 7,
  /** 平均ポイントが出せないときの1回あたりのポイント */
  defaultRewardPoints: 10,
  /** 連続記録で許す休みの日数 */
  streakAllowedGapDays: 1,
  /** 失敗した日の翌朝、何時に再提示するか */
  morningHour: 7,
  /** 日本時間 */
  utcOffsetHours: 9,
  conditions: {
    submitDays: 4,
    /** 完了率が低い子は、達成できるところから始める */
    submitDaysWhenLow: 3,
    outOfDays: 5,
    accuracyFloor: 0.7,
    accuracyCeil: 0.9,
    allowedMisses: 1,
    /** 予測週数に足す余裕（週） */
    deadlineBufferWeeks: 1,
  },
  /** 本命の中間地点を何週ごとに置くか */
  flagshipCheckpointWeeks: 4,
  /** ペース不明のとき本命を何分割するか */
  flagshipDefaultSegments: 4,
  /** 本命の中間地点は直近のいくつまで出すか */
  flagshipMaxCheckpoints: 3,
} as const;

export const GENRE_LABELS: Record<Genre, string> = {
  learning: '学習延長型',
  experience: '体験型',
  collectible: '消耗・コレクション型',
  flagship: '本命型',
};

/** §3 の基本の優先順位（本命は別枠なので含めない） */
export const DEFAULT_GENRE_ORDER: Genre[] = ['learning', 'experience', 'collectible'];
