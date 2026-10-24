// 生データ → 取り組み指標（present_instruction.md §2）。純関数。
import { PRESENT_CONFIG as C } from './config.ts';
import { DAY_MS, localDateKey, localDayStart } from './time.ts';
import type { AssignmentRecord, Engagement, PointRecord, QuizAttemptRecord } from './types.ts';

export interface EngagementSource {
  now: string;
  assignments: AssignmentRecord[];
  quizAttempts: QuizAttemptRecord[];
  pointTransactions: PointRecord[];
  preferredDifficulty: number | null;
}

export function computeEngagement(src: EngagementSource): Engagement {
  const now = Date.parse(src.now);
  const from = now - C.windowDays * DAY_MS;
  const inWindow = (t: number) => t >= from && t <= now;

  const active = src.assignments.filter((a) => a.status !== 'cancelled');
  // 期限前でまだ提出していないものは評価できないので外す
  const evaluable = active.filter(
    (a) => inWindow(assignmentTime(a)) && !(a.submittedAt === null && a.dueAt !== null && Date.parse(a.dueAt) > now),
  );

  const approved = evaluable.filter((a) => a.reviewDecision === 'approved');
  const withDue = evaluable.filter((a) => a.dueAt !== null);
  const onTime = withDue.filter((a) => a.submittedAt !== null && Date.parse(a.submittedAt) <= Date.parse(a.dueAt!));

  const recentAttempts = [...src.quizAttempts]
    .sort((x, y) => Date.parse(y.attemptedAt) - Date.parse(x.attemptedAt))
    .slice(0, C.accuracySampleSize);

  const avgDifficulty = average(evaluable.map((a) => a.difficulty));
  const challengeRatio =
    avgDifficulty !== null && src.preferredDifficulty ? avgDifficulty / src.preferredDifficulty : null;

  const earned = src.pointTransactions
    .filter((p) => p.deltaPoints > 0 && inWindow(Date.parse(p.createdAt)))
    .reduce((sum, p) => sum + p.deltaPoints, 0);

  const rejectedTimes = active
    .filter((a) => a.reviewDecision === 'rejected' && a.reviewedAt !== null)
    .map((a) => Date.parse(a.reviewedAt!));

  return {
    completionRate: ratio(approved.length, evaluable.length),
    onTimeRate: ratio(onTime.length, withDue.length),
    streakDays: computeStreak(active, now),
    accuracy: ratio(recentAttempts.filter((q) => q.isCorrect).length, recentAttempts.length),
    challengeRatio,
    weeklyPace: earned / (C.windowDays / 7),
    avgRewardPoints: average(evaluable.map((a) => a.rewardPoints)),
    sampleSize: evaluable.length,
    lastRejectedAt: rejectedTimes.length > 0 ? new Date(Math.max(...rejectedTimes)).toISOString() : null,
  };
}

/**
 * 連続日数。宿題が出ていた日だけを数え、宿題のない日（土日など）は飛ばす。
 * 提出のない日が streakAllowedGapDays 日までなら途切れない（§4「1日できなくてもリセットしない」）。
 */
function computeStreak(assignments: AssignmentRecord[], now: number): number {
  const todayKey = localDateKey(now);
  const days = new Map<string, boolean>(); // 日付 → その日に提出があったか
  for (const a of assignments) {
    const key = assignmentDayKey(a);
    if (key > todayKey) continue;
    days.set(key, (days.get(key) ?? false) || a.submittedAt !== null);
  }
  // 今日はまだ終わっていないので、未提出なら数えない
  if (days.get(todayKey) === false) days.delete(todayKey);

  let streak = 0;
  let gap = 0;
  for (const key of [...days.keys()].sort().reverse()) {
    if (days.get(key)) {
      streak++;
      gap = 0;
    } else if (++gap > C.streakAllowedGapDays) {
      break;
    }
  }
  return streak;
}

function assignmentDayKey(a: AssignmentRecord): string {
  return a.assignedFor ?? localDateKey(a.dueAt ?? a.createdAt);
}

function assignmentTime(a: AssignmentRecord): number {
  return a.assignedFor ? localDayStart(a.assignedFor) : Date.parse(a.dueAt ?? a.createdAt);
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function average(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((s, v) => s + v, 0) / values.length;
}
