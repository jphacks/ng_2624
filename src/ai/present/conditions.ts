// purchase_conditions の組み立て（present_instruction.md §4「条件の書き方」）。
// 判定できる数値・失敗許容・期限を必ず含める。文面はAIに任せず、ここで決める。
import { PRESENT_CONFIG as C } from './config.ts';
import { addDaysKey, formatJapaneseDate, localDateKey } from './time.ts';
import type { Condition, Engagement } from './types.ts';

export function buildConditions(engagement: Engagement, predictedWeeks: number | null, now: string): Condition[] {
  const isLow = engagement.completionRate !== null && engagement.completionRate < C.completion.low;
  const conditions: Condition[] = [
    {
      kind: 'weekday_submissions',
      required: isLow ? C.conditions.submitDaysWhenLow : C.conditions.submitDays,
      outOf: C.conditions.outOfDays,
    },
  ];

  if (engagement.accuracy !== null) {
    conditions.push({ kind: 'accuracy', minRate: accuracyTarget(engagement.accuracy) });
  }

  conditions.push({ kind: 'miss_tolerance', allowedMisses: C.conditions.allowedMisses });

  const weeks = Math.ceil(predictedWeeks ?? C.weeks.direct) + C.conditions.deadlineBufferWeeks;
  conditions.push({ kind: 'deadline', date: addDaysKey(localDateKey(now), weeks * 7) });

  return conditions;
}

export function renderCondition(c: Condition): string {
  switch (c.kind) {
    case 'weekday_submissions':
      return `毎週、平日${c.outOf}日のうち${c.required}日、宿題を提出する`;
    case 'accuracy':
      return `ドリルの正答率を${Math.round(c.minRate * 100)}%以上にする`;
    case 'miss_tolerance':
      return `${c.allowedMisses}日できなくても連続記録はリセットしない`;
    case 'deadline':
      return `${formatJapaneseDate(c.date)}まで`;
  }
}

/** 今の正答率より少し上（5%刻み）を目標にする */
function accuracyTarget(current: number): number {
  const raised = Math.ceil((current + 0.05) * 20) / 20;
  return Math.min(C.conditions.accuracyCeil, Math.max(C.conditions.accuracyFloor, raised));
}
