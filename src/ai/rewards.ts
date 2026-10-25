import type { GoalSize, ProductCandidate } from '../shared/types.ts';

export const GOAL_SIZES: GoalSize[] = ['small', 'medium', 'large'];

/** 既存の目標区分との互換性のため、異なる候補を価格順で最大3件割り当てる。 */
export function selectRewards(candidates: Omit<ProductCandidate, 'size'>[]): ProductCandidate[] {
    const urls = new Set<string>(), names = new Set<string>();
    return candidates.filter(candidate => {
        const name = candidate.name.trim().toLowerCase();
        if (urls.has(candidate.productUrl) || names.has(name)) return false;
        urls.add(candidate.productUrl); names.add(name); return true;
    }).slice(0, 3).sort((a, b) => (a.priceJpy ?? Infinity) - (b.priceJpy ?? Infinity))
        .map((candidate, index) => ({ ...candidate, size: GOAL_SIZES[index] }));
}
