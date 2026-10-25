import type { GoalSize, ProductCandidate, RewardGuidelines } from '../shared/types.ts';

export const GOAL_SIZES: GoalSize[] = ['small', 'medium', 'large'];

/** 円の整数価格で80〜120%の境界を含む。端数は範囲の内側へ丸める。 */
export function withinGuideline(price: number, amount: number | null): boolean {
    return amount !== null && BigInt(price) * 5n >= BigInt(amount) * 4n
        && BigInt(price) * 5n <= BigInt(amount) * 6n;
}

/** 最大3区分を埋め、その中で目安からの相対的な価格差の合計を最小にする。 */
export function selectRewards(
    candidates: Omit<ProductCandidate, 'size'>[], guidelines: RewardGuidelines, relaxPrice = false,
): ProductCandidate[] {
    let best: ProductCandidate[] = [];
    let bestDistance = Infinity;
    function visit(index: number, chosen: ProductCandidate[], distance: number) {
        if (index === GOAL_SIZES.length) {
            if (chosen.length > best.length || (chosen.length === best.length && distance < bestDistance)) {
                best = [...chosen]; bestDistance = distance;
            }
            return;
        }
        const size = GOAL_SIZES[index];
        const amount = guidelines[`${size}Jpy`];
        for (const candidate of candidates) {
            if (amount === null || (!relaxPrice && (candidate.priceJpy === null || !withinGuideline(candidate.priceJpy, amount)))
                || chosen.some(item => item.id === candidate.id || item.productUrl === candidate.productUrl
                    || item.name.trim().toLowerCase() === candidate.name.trim().toLowerCase())) continue;
            chosen.push({ ...candidate, size });
            visit(index + 1, chosen, distance + (candidate.priceJpy === null ? 1e9 : Math.abs(candidate.priceJpy - amount) / Math.max(amount, 1)));
            chosen.pop();
        }
        visit(index + 1, chosen, distance);
    }
    visit(0, [], 0);
    return best;
}
