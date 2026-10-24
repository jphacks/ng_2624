// 商品提示モジュールの入口。DB にも Gemini にも依存しない。
import { computeEngagement } from './engagement.ts';
import { planPresentation } from './plan.ts';
import type { PresentationPlan, PresentInput } from './types.ts';

export function presentProducts(input: PresentInput): PresentationPlan {
  const engagement = computeEngagement(input);
  return planPresentation({ ...input, engagement });
}

export { computeEngagement } from './engagement.ts';
export { planPresentation } from './plan.ts';
export { PRESENT_CONFIG, GENRE_LABELS } from './config.ts';
export type * from './types.ts';
