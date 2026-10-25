import type { ProductSearchContext, ProductCandidate, SearchMetadata } from '../shared/types.ts';
import type { ReplyGenerator, GenerationResult } from './gemini.ts';
import { buildExtractionRequest, buildSearchRequest } from './prompt.ts';
import { parseProducts } from './protocol.ts';
import { selectRewards } from './rewards.ts';
import { publicUrl } from './validation.ts';
import { ConversationError } from './errors.ts';
import { searchAmazon } from './amazon.ts';
import { isRetailProductUrl } from '../shared/product-source.ts';

// 販売店の直接取得は各8秒。その後の補助検索も含め、会話生成とHTTPの150秒に収める。
export const SEARCH_BUDGET_MS = 85_000;

/** 不透明な検索出典は後段で解決する。判別できるURLは実商品のページだけを許可する。 */
export function isProductSourceUrl(value: string): boolean {
    const safe = publicUrl(value);
    if (!safe) return false;
    const url = new URL(safe);
    if (url.hostname === 'vertexaisearch.cloud.google.com' && url.pathname.startsWith('/grounding-api-redirect/')) return true;
    return isRetailProductUrl(safe);
}

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
    let best: { products: ProductCandidate[]; search: SearchMetadata } | null = null;
    const deadline = new Promise<{ products: ProductCandidate[]; search: SearchMetadata }>((resolve, reject) => {
        timer = setTimeout(() => {
            const error = new ConversationError('TIMEOUT', '商品検索が時間内に完了しませんでした。もう一度商品検索をお試しください。');
            controller.abort(error);
            if (best?.products.length) resolve(best); else reject(error);
        }, SEARCH_BUDGET_MS);
    });
    async function work() {
        const results = await Promise.allSettled([searchProvider({
            ...buildSearchRequest(query, input), timeoutMs: 20_000, signal: controller.signal,
        })]);
        controller.signal.throwIfAborted();
        const successful = results.filter((r): r is PromiseFulfilledResult<GenerationResult> => r.status === 'fulfilled');
        const directAmazon = searchProvider === searchAmazon || successful.some(({ value }) => value.candidates !== undefined);
        if (!successful.length && !directAmazon) {
            const failed = results.find(r => r.status === 'rejected');
            if (failed?.status === 'rejected') throw failed.reason;
        }
        async function collect() {
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
                const products = selectRewards([...unique.values()]);
                return { products, search };
            }
            if (!search.sources.length) return { products: [], search };
            const products: Omit<ProductCandidate, 'size'>[] = successful.flatMap(({ value }) => (value.candidates ?? []).map(candidate => ({ ...candidate, id: createId(), priceCheckedAt: input.now })));
            let extracted: GenerationResult;
            try { extracted = await generate({ ...buildExtractionRequest(result.text, search, input, result.evidence), timeoutMs: 10_000, signal: controller.signal }); }
            catch (error) {
                controller.signal.throwIfAborted();
                if (!directAmazon) throw error;
                return { products: selectRewards(products), search };
            }
            controller.signal.throwIfAborted();
            const usedUrls = new Set(products.map(p => p.productUrl));
            for (const item of parseProducts(extracted.text)) {
                const source = search.sources.find(source => source.id === item.productSourceId);
                // 未知の出典を混ぜた候補は捨てる。URLをモデルに自由生成させない。
                if (!source || !isProductSourceUrl(source.url) || !item.sourceIds.length || !item.sourceIds.includes(source.id)
                    || item.sourceIds.some(id => !search.sources.some(source => source.id === id))) continue;
                const productUrl = publicUrl(source.url)!;
                if (usedUrls.has(productUrl)) continue;
                const priceJpy = supportedPrice(item.priceJpy, item.priceEvidence, [source.id], result);

                products.push({
                    id: createId(), name: item.name, priceJpy, productUrl, imageUrl: null,
                    priceCheckedAt: priceJpy === null ? null : input.now,
                    description: item.description, recommendationReason: item.recommendationReason + (priceJpy === null ? ' 価格は未確認です。' : ''),
                    sourceUrls: [...new Set(item.sourceIds.map(id => publicUrl(search.sources.find(source => source.id === id)!.url)!))],
                });
                usedUrls.add(productUrl);
            }
            return { products: selectRewards(products), search };
        }
        best = await collect();
        // Native Amazon search is authoritative: never fill gaps with Google or another shop.
        if (directAmazon) return best;
        for (let attempt = 0; attempt < 2 && best.products.length < 3; attempt++) {
            try {
                const request = buildSearchRequest(query, input);
                request.systemInstruction += '\n直接取得では候補が不足しました。Amazonが見つからなければ楽天市場・ヨドバシ・ビックカメラ・メーカー公式ストアで購入できる個別商品を探してください。価格・機能・ブランドの条件を緩め、主要用途に近い実商品を3件探してください。価格未確認でも実商品の販売ページの出典があれば含め、未確認と明記してください。既に見つかった商品とは異なる商品を優先してください。';
                request.input = JSON.stringify({ ...JSON.parse(request.input), query: `${query} ${attempt === 0 ? 'site:item.rakuten.co.jp' : 'site:yodobashi.com/product/ OR site:biccamera.com/bc/item/'}`, existingProducts: best.products.map(p => ({ name: p.name, productUrl: p.productUrl })), retry: attempt > 0 });
                successful.push({ status: 'fulfilled', value: await generate({ ...request, timeoutMs: 20_000, signal: controller.signal }) });
                const found = await collect();
                // 再整形で候補が減っても、取得済みの実商品を捨てない。
                const merged: Map<string, ProductCandidate> = new Map([...best.products, ...found.products].map(p => [p.productUrl, p]));
                best = { products: selectRewards([...merged.values()]), search: found.search };
            } catch (error) { controller.signal.throwIfAborted(); /* 次の補助検索へ進み、取得済み候補は保持する。 */ }
        }
        return best;
    }
    try { return await Promise.race([work(), deadline]); }
    finally { clearTimeout(timer!); }
}
