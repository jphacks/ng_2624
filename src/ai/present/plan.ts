// 取り組み指標 → 何を・いくつ・どう出すか（present_instruction.md §3, §4）。
// ここはすべてルールで決める。Gemini は結果を受け取って文面を書くだけ。
import { buildConditions, renderCondition } from './conditions.ts';
import { DEFAULT_GENRE_ORDER, PRESENT_CONFIG as C } from './config.ts';
import { DAY_MS, localDateKey, nextMorning } from './time.ts';
import type {
  AssignmentRecord,
  Budgets,
  CatalogItem,
  Engagement,
  FlagshipView,
  Genre,
  GoalSize,
  Milestone,
  Offer,
  PresentationPlan,
  PresentedRecord,
  Trigger,
} from './types.ts';

export interface PlanInput {
  now: string;
  trigger: Trigger;
  engagement: Engagement;
  pointBalance: number;
  budgets: Budgets;
  interests: string[];
  catalog: CatalogItem[];
  recentlyPresented: PresentedRecord[];
  assignments: AssignmentRecord[];
}

export function planPresentation(input: PlanInput): PresentationPlan {
  const { engagement: e, now } = input;
  const reasons: string[] = [];

  // 失敗した日には出さない。罰として受け取られるので翌朝に回す
  if (input.trigger !== 'morning' && e.lastRejectedAt && localDateKey(e.lastRejectedAt) === localDateKey(now)) {
    return {
      kind: 'skip',
      reason: 'recent_failure',
      retryAt: nextMorning(now),
      reasons: ['今日差し戻しがあったため、翌朝に回す'],
    };
  }

  const ctx = createContext(input);

  const optionCount = decideOptionCount(e, reasons);
  const genreOrder = decideGenreOrder(e, reasons);

  const size = decideOfferSize(ctx, reasons);
  const offers: Offer[] = [];
  if (size) {
    const ranked = rankItems(ctx.candidatesFor(size), genreOrder, input.interests);
    for (const item of pickDiverse(ranked, optionCount)) {
      offers.push(buildOffer(item, size, ctx));
    }
  }

  const flagship = buildFlagship(ctx);

  if (offers.length === 0 && flagship === null) {
    return { kind: 'skip', reason: 'no_candidates', retryAt: null, reasons: [...reasons, '予算内の商品がない'] };
  }

  const suggestedTask = optionCount === 1 ? pickTodayTask(input.assignments, now) : null;
  if (suggestedTask) reasons.push(`今日できるタスク「${suggestedTask.title}」をセットにする`);

  return { kind: 'present', engagement: e, offers, flagship, suggestedTask, reasons };
}

// ---------- 共通の計算 ----------

interface Context {
  input: PlanInput;
  /** 週次ペース。0（データなし）なら null */
  pace: number | null;
  /** 1回あたりのポイント */
  pointsPerTime: number;
  candidatesFor(size: GoalSize): CatalogItem[];
  isAffordable(item: CatalogItem): boolean;
  predict(requiredPoints: number): { remaining: number; weeks: number | null };
}

function createContext(input: PlanInput): Context {
  const e = input.engagement;
  const cooldownFrom = Date.parse(input.now) - C.representCooldownDays * DAY_MS;
  const recentIds = new Set(
    input.recentlyPresented.filter((p) => Date.parse(p.presentedAt) >= cooldownFrom).map((p) => p.productId),
  );
  const pace = e.weeklyPace > 0 ? e.weeklyPace : null;

  const isAffordable = (item: CatalogItem) => {
    const budget = input.budgets[item.size];
    return item.priceJpy !== null && budget !== null && item.priceJpy <= budget;
  };

  return {
    input,
    pace,
    pointsPerTime: e.avgRewardPoints ?? C.defaultRewardPoints,
    isAffordable,
    candidatesFor: (size) =>
      input.catalog.filter((i) => i.size === size && i.genre !== 'flagship' && isAffordable(i) && !recentIds.has(i.id)),
    predict: (requiredPoints) => {
      const remaining = Math.max(0, requiredPoints - input.pointBalance);
      return { remaining, weeks: pace ? remaining / pace : null };
    },
  };
}

// ---------- 判定ルール ----------

/** 完了率が低いと1択、高いと3択（§4 選択肢の数を変える） */
function decideOptionCount(e: Engagement, reasons: string[]): number {
  if (e.sampleSize < C.coldStartMinSamples || e.completionRate === null) {
    reasons.push(`データ不足のため${C.optionCount.coldStart}択`);
    return C.optionCount.coldStart;
  }
  const rate = percent(e.completionRate);
  if (e.completionRate < C.completion.low) {
    reasons.push(`完了率${rate}のため${C.optionCount.low}択（選択肢が多いと停滞が悪化する）`);
    return C.optionCount.low;
  }
  if (e.completionRate >= C.completion.high) {
    reasons.push(`完了率${rate}のため${C.optionCount.high}択（自分で選んだ目標は続く）`);
    return C.optionCount.high;
  }
  reasons.push(`完了率${rate}のため${C.optionCount.middle}択`);
  return C.optionCount.middle;
}

/** 取り組みの「質」でジャンルの順番を変える（§1 質→ジャンル） */
function decideGenreOrder(e: Engagement, reasons: string[]): Genre[] {
  let order: Genre[];
  if (e.completionRate !== null && e.completionRate < C.completion.low) {
    order = ['collectible', 'experience', 'learning'];
    reasons.push('停滞気味なので、小刻みに出せる消耗・コレクション型を優先');
  } else if (
    e.accuracy !== null &&
    e.accuracy >= C.quality.highAccuracy &&
    (e.challengeRatio ?? 0) >= C.quality.minChallengeRatio
  ) {
    order = DEFAULT_GENRE_ORDER;
    reasons.push('正答率が高く難しい課題にも挑戦できているので、学習延長型を優先');
  } else if (e.accuracy === null) {
    order = DEFAULT_GENRE_ORDER;
    reasons.push('正答率のデータがないので、基本の優先順位');
  } else {
    order = ['experience', 'learning', 'collectible'];
    reasons.push('正答率・挑戦度が平均的なので、体験型を優先');
  }
  return order;
}

/**
 * 量（ポイントとペース）で価格帯を決める（§4 到達予測）。
 * 6週以内に届く一番大きいサイズを選ぶ。large は本命として別枠で常に表示するので、ここでは扱わない。
 */
function decideOfferSize(ctx: Context, reasons: string[]): GoalSize | null {
  for (const size of ['medium', 'small'] as const) {
    if (ctx.candidatesFor(size).length === 0) continue;
    const { weeks } = ctx.predict(C.sizePoints[size]);
    if (weeks !== null && weeks <= C.weeks.withMilestone) {
      reasons.push(`${size}は約${round1(weeks)}週で届くので${size}を提示`);
      return size;
    }
    reasons.push(
      weeks === null ? `${size}は到達予測が出せないため見送り` : `${size}は約${round1(weeks)}週かかるため見送り`,
    );
  }
  // どれも6週を超える場合は、候補がある一番小さいサイズで出す
  for (const size of ['small', 'medium'] as const) {
    if (ctx.candidatesFor(size).length > 0) {
      reasons.push(`届きやすいサイズがないため${size}を提示`);
      return size;
    }
  }
  return null;
}

/** ジャンルの順位 → 興味との一致数 → 安い順 */
function rankItems(items: CatalogItem[], genreOrder: Genre[], interests: string[]): CatalogItem[] {
  const score = (item: CatalogItem) => {
    const matches = item.tags.filter((t) => interests.includes(t)).length;
    let rank = genreOrder.indexOf(item.genre);
    if (rank === -1) rank = genreOrder.length;
    // 学習延長型は興味に接続していなければ意味が薄いので後ろに回す
    if (item.genre === 'learning' && matches === 0) rank = genreOrder.length;
    return rank * 10 - matches;
  };
  return [...items].sort((a, b) => score(a) - score(b) || (a.priceJpy ?? 0) - (b.priceJpy ?? 0));
}

/** なるべく違うジャンルから選ぶ */
function pickDiverse(ranked: CatalogItem[], count: number): CatalogItem[] {
  const picked: CatalogItem[] = [];
  const genres = new Set<Genre>();
  for (const item of ranked) {
    if (picked.length >= count) break;
    if (genres.has(item.genre)) continue;
    picked.push(item);
    genres.add(item.genre);
  }
  for (const item of ranked) {
    if (picked.length >= count) break;
    if (!picked.includes(item)) picked.push(item);
  }
  return picked;
}

// ---------- 出力の組み立て ----------

function buildOffer(item: CatalogItem, size: GoalSize, ctx: Context): Offer {
  const requiredPoints = C.sizePoints[size];
  const { remaining, weeks } = ctx.predict(requiredPoints);

  // 3〜6週かかるなら中間マイルストーンを1つ挟む
  let milestone: Milestone | null = null;
  if (weeks !== null && weeks > C.weeks.direct) {
    const half = Math.ceil(remaining / 2);
    milestone = {
      atPoints: ctx.input.pointBalance + half,
      remainingTimes: Math.ceil(half / ctx.pointsPerTime),
      weeksFromNow: round1(weeks / 2),
      // medium なら small のごほうびを挟む。ごほうびでポイントを消費するかは未定
      rewardItem: size === 'medium' ? pickMilestoneReward(ctx, item) : null,
    };
  }

  const conditions = buildConditions(ctx.input.engagement, weeks, ctx.input.now);
  return {
    item,
    size,
    requiredPoints,
    remainingPoints: remaining,
    remainingTimes: Math.ceil(remaining / ctx.pointsPerTime),
    predictedWeeks: weeks === null ? null : round1(weeks),
    milestone,
    conditions,
    conditionTexts: conditions.map(renderCondition),
  };
}

function pickMilestoneReward(ctx: Context, exclude: CatalogItem): CatalogItem | null {
  const smalls = ctx.candidatesFor('small').filter((i) => i.id !== exclude.id);
  return rankItems(smalls, ['collectible', 'experience', 'learning'], ctx.input.interests)[0] ?? null;
}

/** 本命は進捗バーの最上段に常に表示する。遠すぎるので中間地点を必ず置く（§3, §4） */
function buildFlagship(ctx: Context): FlagshipView | null {
  const items = ctx.input.catalog.filter((i) => i.genre === 'flagship' && i.size === 'large' && ctx.isAffordable(i));
  const item = rankItems(items, ['flagship'], ctx.input.interests)[0];
  if (!item) return null;

  const requiredPoints = C.sizePoints.large;
  const { remaining, weeks } = ctx.predict(requiredPoints);
  const segments =
    weeks !== null ? Math.max(1, Math.ceil(weeks / C.flagshipCheckpointWeeks)) : C.flagshipDefaultSegments;

  // 遠い先の地点を並べても意味がないので、直近のものだけ出す
  const checkpoints: Milestone[] = [];
  for (let k = 1; k < segments && checkpoints.length < C.flagshipMaxCheckpoints; k++) {
    const points = Math.round((remaining * k) / segments);
    checkpoints.push({
      atPoints: ctx.input.pointBalance + points,
      remainingTimes: Math.ceil(points / ctx.pointsPerTime),
      weeksFromNow: weeks === null ? null : round1((weeks * k) / segments),
      rewardItem: null,
    });
  }

  return {
    item,
    requiredPoints,
    remainingPoints: remaining,
    remainingTimes: Math.ceil(remaining / ctx.pointsPerTime),
    predictedWeeks: weeks === null ? null : round1(weeks),
    checkpoints,
  };
}

/** 1択のときにセットで出す、今日できる一番やさしいタスク */
function pickTodayTask(assignments: AssignmentRecord[], now: string): AssignmentRecord | null {
  const t = Date.parse(now);
  const todayKey = localDateKey(now);
  const open = assignments.filter((a) => a.status === 'assigned' && (a.dueAt === null || Date.parse(a.dueAt) >= t));
  const today = open.filter((a) => a.assignedFor === todayKey || (a.dueAt !== null && localDateKey(a.dueAt) === todayKey));
  const pool = today.length > 0 ? today : open;
  return (
    [...pool].sort(
      (a, b) =>
        a.difficulty - b.difficulty || Date.parse(a.dueAt ?? '9999-12-31') - Date.parse(b.dueAt ?? '9999-12-31'),
    )[0] ?? null
  );
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function percent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}
