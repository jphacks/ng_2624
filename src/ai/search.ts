import type { ProductSearchContext, ProductCandidate, SearchMetadata } from '../../Sample_db/types.ts';
import type { ReplyGenerator, GenerationResult } from './gemini.ts';
import { buildExtractionRequest, buildSearchRequest } from './prompt.ts';
import { parseProducts } from './protocol.ts';
import { selectRewards } from './rewards.ts';
import { publicUrl } from './validation.ts';
import { ConversationError } from './errors.ts';

export const SEARCH_BUDGET_MS = 30_000;

/** 価格は、選択した出典に紐づく引用に円表記の同額があるときだけ採用。 */
function supportedPrice(price: number | null, quote: string | null, sourceIds: string[], result: GenerationResult): number | null {
    if (price === null || !quote) return null;
    if (!sourceIds.some(id => (result.evidence[id] ?? []).some(segment => segment.includes(quote)))) return null;
    const yen = /(?:[¥￥]\s*([\d,]+)|([\d,]+)\s*円)/g;
    for (const match of quote.matchAll(yen)) {
        if (Number((match[1] ?? match[2]).replaceAll(',', '')) === price) return price;
    }
    return null;
}

export async function searchProducts(
    query: string, input: ProductSearchContext, generate: ReplyGenerator, createId: () => string,
): Promise<{ products: ProductCandidate[]; search: SearchMetadata }> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            const error = new ConversationError('TIMEOUT', '商品検索が時間内に完了しませんでした。検索条件を絞って再度お試しください。');
            controller.abort(error);
            reject(error);
        }, SEARCH_BUDGET_MS);
    });
    async function work() {
        const result = await generate({ ...buildSearchRequest(query, input), timeoutMs: 20_000, signal: controller.signal });
        controller.signal.throwIfAborted();
        const search: SearchMetadata = result.search ?? { queries: [], sources: [], searchSuggestionsHtml: null };
        search.sources = search.sources.filter(source => publicUrl(source.url) !== null);
        if (!search.sources.length) return { products: [], search };
        const extracted = await generate({ ...buildExtractionRequest(result.text, search, input), timeoutMs: 10_000, signal: controller.signal });
        controller.signal.throwIfAborted();
        const products: Omit<ProductCandidate, 'size'>[] = [];
        const usedUrls = new Set<string>();
        for (const item of parseProducts(extracted.text)) {
            const source = search.sources.find(source => source.id === item.productSourceId);
            // 未知の出典を混ぜた候補は捨てる。URLをモデルに自由生成させない。
            if (!source || !item.sourceIds.length || !item.sourceIds.includes(source.id)
                || item.sourceIds.some(id => !search.sources.some(source => source.id === id))) continue;
            const productUrl = publicUrl(source.url)!;
            if (usedUrls.has(productUrl)) continue;
            const priceJpy = supportedPrice(item.priceJpy, item.priceEvidence, item.sourceIds, result);
            if (priceJpy === null) continue;
            products.push({
                id: createId(), name: item.name, priceJpy, productUrl, imageUrl: null,
                priceCheckedAt: input.now,
                description: item.description, recommendationReason: item.recommendationReason,
                sourceUrls: [...new Set(item.sourceIds.map(id => publicUrl(search.sources.find(source => source.id === id)!.url)!))],
            });
            usedUrls.add(productUrl);
        }
        return { products: selectRewards(products, input.rewardGuidelines), search };
    }
    try { return await Promise.race([work(), deadline]); }
    finally { clearTimeout(timer!); }
}
