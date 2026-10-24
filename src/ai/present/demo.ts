// 動作確認用：4人分の仮データで提示プランを出す。
// 実行: npx tsx src/ai/present/demo.ts
import { MOCK_CATALOG } from './catalog.ts';
import { GENRE_LABELS, presentProducts } from './index.ts';
import { addDaysKey, localDateKey } from './time.ts';
import type { AssignmentRecord, PointRecord, PresentationPlan, PresentInput, QuizAttemptRecord } from './types.ts';

const NOW = '2026-10-23T18:00:00+09:00';
const BUDGETS = { small: 1000, medium: 3000, large: 30000 };

type Outcome = 'approved' | 'rejected' | 'missed';

/** 直近14日の平日に宿題を1件ずつ出し、outcomes の順に結果をつける（古い日から） */
function makeHistory(outcomes: Outcome[], reward = 10, difficulty = 3) {
  const assignments: AssignmentRecord[] = [];
  const points: PointRecord[] = [];
  const today = localDateKey(NOW);
  let i = 0;
  for (let d = -14; d < 0; d++) {
    const key = addDaysKey(today, d);
    const weekday = new Date(`${key}T00:00:00Z`).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    const outcome = outcomes[i++ % outcomes.length];
    const submitted = outcome !== 'missed';
    assignments.push({
      id: `a-${key}`,
      title: '算数ドリル',
      status: outcome === 'missed' ? 'assigned' : outcome,
      assignedFor: key,
      dueAt: `${key}T20:00:00+09:00`,
      createdAt: `${key}T07:00:00+09:00`,
      difficulty,
      rewardPoints: reward,
      submittedAt: submitted ? `${key}T18:00:00+09:00` : null,
      reviewDecision: outcome === 'missed' ? null : outcome,
      reviewedAt: submitted ? `${key}T19:00:00+09:00` : null,
    });
    if (outcome === 'approved') points.push({ deltaPoints: reward, createdAt: `${key}T19:00:00+09:00` });
  }
  return { assignments, points };
}

function todayTasks(): AssignmentRecord[] {
  const key = localDateKey(NOW);
  const base = { assignedFor: key, dueAt: `${key}T20:00:00+09:00`, createdAt: `${key}T07:00:00+09:00`, rewardPoints: 10, submittedAt: null, reviewDecision: null, reviewedAt: null, status: 'assigned' as const };
  return [
    { ...base, id: 't-kanji', title: '漢字ドリル 1ページ', difficulty: 3 },
    { ...base, id: 't-ondoku', title: '音読 5分', difficulty: 1 },
  ];
}

function quiz(correct: number, total: number): QuizAttemptRecord[] {
  return Array.from({ length: total }, (_, k) => ({
    isCorrect: k < correct,
    attemptedAt: new Date(Date.parse(NOW) - (k + 1) * 3_600_000).toISOString(),
  }));
}

const daysAgo = (n: number) => new Date(Date.parse(NOW) - n * 86_400_000).toISOString();

// ---------- シナリオ ----------

const stable = makeHistory(['approved']);
const stalled = makeHistory(['approved', 'missed', 'missed', 'rejected', 'missed', 'approved', 'missed', 'missed', 'approved', 'missed']);

const scenarios: Record<string, PresentInput> = {
  'A. 安定して続けている子（顕微鏡は3日前に提示済み）': {
    now: NOW,
    trigger: 'task_approved',
    assignments: [...stable.assignments, ...todayTasks()],
    quizAttempts: quiz(18, 20),
    pointTransactions: stable.points,
    pointBalance: 120,
    preferredDifficulty: 3,
    budgets: BUDGETS,
    interests: ['science', 'robot'],
    catalog: MOCK_CATALOG,
    recentlyPresented: [{ productId: 'microscope', presentedAt: daysAgo(3) }],
  },
  'B. 停滞している子': {
    now: NOW,
    trigger: 'morning',
    assignments: [...stalled.assignments, ...todayTasks()],
    quizAttempts: quiz(11, 20),
    pointTransactions: stalled.points,
    pointBalance: 40,
    preferredDifficulty: 3,
    budgets: { ...BUDGETS, large: 20000 },
    interests: ['animals', 'art'],
    catalog: MOCK_CATALOG,
    recentlyPresented: [],
  },
  'C. 始めたばかりの子（データなし）': {
    now: NOW,
    trigger: 'manual',
    assignments: todayTasks(),
    quizAttempts: [],
    pointTransactions: [],
    pointBalance: 0,
    preferredDifficulty: null,
    budgets: BUDGETS,
    interests: ['science'],
    catalog: MOCK_CATALOG,
    recentlyPresented: [],
  },
  'D. 今日差し戻しがあった子': {
    now: NOW,
    trigger: 'task_approved',
    assignments: [
      ...stable.assignments,
      { ...todayTasks()[0], status: 'rejected', submittedAt: daysAgo(0.1), reviewDecision: 'rejected', reviewedAt: daysAgo(0.05) },
    ],
    quizAttempts: quiz(18, 20),
    pointTransactions: stable.points,
    pointBalance: 120,
    preferredDifficulty: 3,
    budgets: BUDGETS,
    interests: ['science'],
    catalog: MOCK_CATALOG,
    recentlyPresented: [],
  },
};

// ---------- 表示 ----------

const pct = (v: number | null) => (v === null ? '-' : `${Math.round(v * 100)}%`);
const weeks = (w: number | null) => (w === null ? '予測なし' : `約${w}週`);

function print(name: string, plan: PresentationPlan) {
  console.log(`\n==== ${name} ====`);
  if (plan.kind === 'skip') {
    console.log(`提示しない（${plan.reason}）。再提示: ${plan.retryAt ?? '-'}`);
    plan.reasons.forEach((r) => console.log(`  - ${r}`));
    return;
  }
  const e = plan.engagement;
  console.log(
    `指標: 完了率${pct(e.completionRate)} / 期限遵守${pct(e.onTimeRate)} / 連続${e.streakDays}日 / 正答率${pct(e.accuracy)} / 挑戦度${e.challengeRatio?.toFixed(2) ?? '-'} / 週${e.weeklyPace}pt`,
  );
  console.log('判定:');
  plan.reasons.forEach((r) => console.log(`  - ${r}`));

  if (plan.flagship) {
    const f = plan.flagship;
    console.log(`本命（常に表示）: ${f.item.name} あと${f.remainingTimes}回 ${weeks(f.predictedWeeks)}`);
    f.checkpoints.forEach((c) => console.log(`    中間地点: あと${c.remainingTimes}回 ${weeks(c.weeksFromNow)}`));
  }
  plan.offers.forEach((o, i) => {
    console.log(`提示${i + 1}: ${o.item.name}（${GENRE_LABELS[o.item.genre]} / ${o.size}）あと${o.remainingTimes}回 ${weeks(o.predictedWeeks)}`);
    if (o.milestone) {
      const reward = o.milestone.rewardItem ? `ごほうび: ${o.milestone.rewardItem.name}` : 'ごほうびなし';
      console.log(`    中間マイルストーン: あと${o.milestone.remainingTimes}回（${reward}）`);
    }
    o.conditionTexts.forEach((t) => console.log(`    条件: ${t}`));
  });
  if (plan.suggestedTask) console.log(`今日のタスク: ${plan.suggestedTask.title}`);
}

for (const [name, input] of Object.entries(scenarios)) {
  print(name, presentProducts(input));
}
