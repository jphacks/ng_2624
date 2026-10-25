import type { ProductSearchContext, ProductCandidate, SearchMetadata } from '../../Sample_db/types.ts';
import type { ReplyGenerator, GenerationResult } from './gemini.ts';
import { buildExtractionRequest, buildSearchRequest } from './prompt.ts';
import { parseProducts } from './protocol.ts';
import { GOAL_SIZES, selectRewards } from './rewards.ts';
import { publicUrl } from './validation.ts';
import { ConversationError } from './errors.ts';
import { searchAmazon } from './amazon.ts';

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
    query: string, input: ProductSearchContext, generate: ReplyGenerator, createId: () => string, searchProvider: ReplyGenerator = generate,
): Promise<{ products: ProductCandidate[]; search: SearchMetadata }> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            const error = new ConversationError('TIMEOUT', '商品検索が時間内に完了しませんでした。もう一度商品検索をお試しください。');
            controller.abort(error);
            reject(error);
        }, SEARCH_BUDGET_MS);
    });
    async function work() {
        const sizes = GOAL_SIZES.filter(size => input.rewardGuidelines[`${size}Jpy`] !== null);
        const results = await Promise.allSettled(sizes.map(size => searchProvider({
            ...buildSearchRequest(query, { ...input, rewardGuidelines: {
                smallJpy: null, mediumJpy: null, largeJpy: null, [`${size}Jpy`]: input.rewardGuidelines[`${size}Jpy`],
            } }, size), timeoutMs: 20_000, signal: controller.signal,
        })));
        controller.signal.throwIfAborted();
        const successful = results.filter((r): r is PromiseFulfilledResult<GenerationResult> => r.status === 'fulfilled');
        const directAmazon = searchProvider === searchAmazon || successful.some(({ value }) => value.candidates !== undefined);
        const nativeUrls = new Set(successful.flatMap(({ value }) => (value.candidates ?? []).map(p => p.productUrl)));
        if (directAmazon && nativeUrls.size < 3) {
            // データセンターからAmazonを取得できない場合は、検索エンジン経由でAmazonの商品を探す。
            // 価格帯ごとに3回呼ばず、3候補を1回のFlash検索で取得する。
            try {
                const request = buildSearchRequest(query, input);
                request.systemInstruction += '\n直接取得では候補が不足しました。価格・機能・ブランドの条件を緩め、Amazonの商品詳細ページを3件探してください。価格未確認でも実商品の出典があれば含め、未確認と明記してください。';
                successful.push({ status: 'fulfilled', value: await generate({ ...request, timeoutMs: 15_000, signal: controller.signal }) });
            } catch (error) {
                controller.signal.throwIfAborted();
                if (!nativeUrls.size) throw error;
            }
        }
        controller.signal.throwIfAborted();
        if (!successful.length) {
            const failed = results.find(r => r.status === 'rejected');
            if (failed?.status === 'rejected') throw failed.reason;
        }
        const search: SearchMetadata = { queries: [], sources: [], searchSuggestionsHtml: null };
        const result: GenerationResult = { text: '', search, evidence: {} };
        const suggestions = new Set<string>();
        for (const { value } of successful) {
            result.text += value.text + '\n';
            for (const query of value.search?.queries ?? []) if (!search.queries.includes(query)) search.queries.push(query);
            if (value.search?.searchSuggestionsHtml) suggestions.add(value.search.searchSuggestionsHtml);
            for (const source of value.search?.sources ?? []) {
                if (!publicUrl(source.url)) continue;
                let merged = search.sources.find(s => s.url === source.url);
                if (!merged) { merged = { ...source, id: `source-${search.sources.length + 1}` }; search.sources.push(merged); }
                (result.evidence[merged.id] ??= []).push(...(value.evidence[source.id] ?? []));
            }
        }
        search.searchSuggestionsHtml = [...suggestions].join('\n') || null;
        // Amazonで取得済みの実商品は、モデルの再選別によって空にしない。
        if (successful.length && successful.every(({ value }) => value.candidates !== undefined)) {
            const unique = new Map<string, Omit<ProductCandidate, 'size'>>();
            for (const { value } of successful) for (const candidate of value.candidates!) {
                if (!unique.has(candidate.productUrl)) unique.set(candidate.productUrl, { ...candidate, id: createId(), priceCheckedAt: input.now });
            }
            const products = selectRewards([...unique.values()], input.rewardGuidelines, true);
            for (const product of products) {
                const amount = input.rewardGuidelines[`${product.size}Jpy`]!;
                if (product.priceJpy! < amount * .8 || product.priceJpy! > amount * 1.2) product.recommendationReason += ' この区分の目安金額±20％を外れています。';
            }
            return { products, search };
        }
        if (!search.sources.length) return { products: [], search };
        const extracted = await generate({ ...buildExtractionRequest(result.text, search, input, result.evidence, directAmazon), timeoutMs: 10_000, signal: controller.signal });
        controller.signal.throwIfAborted();
        const products: Omit<ProductCandidate, 'size'>[] = successful.flatMap(({ value }) => (value.candidates ?? []).map(candidate => ({ ...candidate, id: createId(), priceCheckedAt: input.now })));
        const usedUrls = new Set(products.map(p => p.productUrl));
        for (const item of parseProducts(extracted.text)) {
            const source = search.sources.find(source => source.id === item.productSourceId);
            // 未知の出典を混ぜた候補は捨てる。URLをモデルに自由生成させない。
            if (!source || !item.sourceIds.length || !item.sourceIds.includes(source.id)
                || item.sourceIds.some(id => !search.sources.some(source => source.id === id))) continue;
            const productUrl = publicUrl(source.url)!;
            if (usedUrls.has(productUrl)) continue;
            const priceJpy = supportedPrice(item.priceJpy, item.priceEvidence, item.sourceIds, result);
            if (priceJpy === null && !directAmazon) continue;
            products.push({
                id: createId(), name: item.name, priceJpy, productUrl, imageUrl: null,
                priceCheckedAt: priceJpy === null ? null : input.now,
                description: item.description, recommendationReason: item.recommendationReason + (priceJpy === null ? ' 価格は未確認です。' : ''),
                sourceUrls: [...new Set(item.sourceIds.map(id => publicUrl(search.sources.find(source => source.id === id)!.url)!))],
            });
            usedUrls.add(productUrl);
        }
        return { products: selectRewards(products, input.rewardGuidelines, directAmazon), search };
    }
    try { return await Promise.race([work(), deadline]); }
    finally { clearTimeout(timer!); }
}
