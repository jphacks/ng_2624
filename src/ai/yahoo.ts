import type { ConversationRequest } from './prompt.ts';
import type { GenerationResult, ReplyGenerator } from './gemini.ts';
import { ConversationError } from './errors.ts';
import { isRetailProductUrl } from '../shared/product-source.ts';

const MAX_BYTES = 2 * 1024 * 1024;
const rateLimit = () => new ConversationError('RATE_LIMIT', 'Yahoo!ショッピングの商品検索が混み合っています。時間を置いて再度お試しください。');
function appId(): string | undefined {
    const runtime = globalThis as typeof globalThis & {
        process?: { env: Record<string, string | undefined> };
        Deno?: { env: { get(name: string): string | undefined } };
    };
    return runtime.process?.env.YAHOO_SHOPPING_APP_ID ?? runtime.Deno?.env.get('YAHOO_SHOPPING_APP_ID');
}

/** v3の同じ商品から価格・画像・購入URLを取得し、外部の任意URLは採用しない。 */
export function parseYahooResults(data: unknown): GenerationResult {
    if (!data || typeof data !== 'object' || !('hits' in data) || !Array.isArray(data.hits)) {
        throw new ConversationError('API_ERROR', 'Yahoo!ショッピングの検索結果を処理できませんでした。');
    }
    const result: GenerationResult = { text: '', search: { queries: [], sources: [], searchSuggestionsHtml: null }, evidence: {}, candidates: [] };
    const seen = new Set<string>();
    for (const hit of data.hits) {
        if (!hit || typeof hit !== 'object') continue;
        const { name, price, url } = hit;
        if (typeof name !== 'string' || !name.trim() || !Number.isSafeInteger(price) || price <= 0
            || typeof url !== 'string' || !isRetailProductUrl(url)
            || !['store.shopping.yahoo.co.jp', 'lohaco.yahoo.co.jp'].includes(new URL(url).hostname) || seen.has(url)) continue;
        let imageUrl: string | null = null;
        for (const value of [hit.exImage?.url, hit.image?.medium, hit.image?.small]) {
            if (typeof value !== 'string') continue;
            try {
                const image = new URL(value);
                if (image.protocol === 'https:' && !image.username && !image.password && !image.port
                    && image.hostname === 'item-shopping.c.yimg.jp' && image.pathname.startsWith('/i/')) { imageUrl = image.href; break; }
            } catch { /* 不正な画像は既存の画像未取得表示へ。 */ }
        }
        const title = name.trim().slice(0, 300), id = `yahoo-${result.candidates!.length + 1}`;
        const quote = `${title}。表示価格：￥${price.toLocaleString('en-US')}`;
        result.search!.sources.push({ id, url, title });
        result.evidence[id] = [quote];
        result.text += `${quote}\n商品ページ：${url}\n`;
        result.candidates!.push({ name: title, priceJpy: price, productUrl: url, imageUrl, description: title,
            recommendationReason: 'Yahoo!ショッピングで商品と表示価格を確認しました。希望の機能は商品ページで確認してください。', sourceUrls: [url] });
        seen.add(url);
    }
    return result;
}

/** 制限は同一プロセス内で共有。429ではRetry-Afterの間、新しい検索も停止する。 */
export function createYahooShoppingSearch(send: typeof fetch = (...args) => fetch(...args), getAppId = appId): ReplyGenerator {
    let nextRequestAt = 0;
    return async (request: ConversationRequest) => {
        let query: unknown;
        try { query = JSON.parse(request.input).query; } catch { /* 入力エラーとして返す。 */ }
        if (typeof query !== 'string' || !query.trim() || query.length > 300) throw new ConversationError('INVALID_INPUT', '商品検索の条件を確認してください。');
        const key = getAppId()?.trim();
        if (!key) throw new ConversationError('MISSING_API_KEY', 'YAHOO_SHOPPING_APP_IDが設定されていません。');
        const timeout = AbortSignal.timeout(8000);
        const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
        const queries = [...new Set([query.trim(), query.trim().split(/[\s、,]+/u)[0]])];
        let result: GenerationResult | undefined;
        for (let attempt = 0; attempt < queries.length; attempt++) {
            try {
                signal.throwIfAborted();
                // 補助検索だけ待機する。新しい検索の集中にはキューを積まず429相当を返す。
                while (attempt && nextRequestAt > Date.now()) await new Promise<void>((resolve, reject) => {
                    const abort = () => { clearTimeout(timer); reject(signal.reason); };
                    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, nextRequestAt - Date.now());
                    signal.addEventListener('abort', abort, { once: true });
                });
                signal.throwIfAborted();
                if (Date.now() < nextRequestAt) throw rateLimit();
                nextRequestAt = Date.now() + 1000;
                const url = new URL('https://shopping.yahooapis.jp/ShoppingWebService/V3/itemSearch');
                url.searchParams.set('appid', key);
                url.searchParams.set('query', queries[attempt]);
                url.searchParams.set('results', '20');
                url.searchParams.set('image_size', '300');
                const response = await send(url, { redirect: 'error', signal, headers: { Accept: 'application/json' } });
                if (response.status === 429) {
                    const retry = response.headers.get('retry-after');
                    const seconds = retry ? Number(retry) : NaN;
                    const until = Number.isFinite(seconds) ? Date.now() + seconds * 1000 : Date.parse(retry || '');
                    nextRequestAt = Math.max(nextRequestAt, Number.isFinite(until) ? until : Date.now() + 60_000);
                    await response.body?.cancel();
                    throw rateLimit();
                }
                if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
                    await response.body?.cancel();
                    throw new ConversationError('API_ERROR', 'Yahoo!ショッピングの商品検索に接続できませんでした。');
                }
                const reader = response.body?.getReader();
                if (!reader) throw new ConversationError('API_ERROR', 'Yahoo!ショッピングの検索結果を取得できませんでした。');
                let bytes = 0, body = '';
                const decoder = new TextDecoder();
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        bytes += value.length;
                        if (bytes > MAX_BYTES) throw new ConversationError('API_ERROR', 'Yahoo!ショッピングの検索結果が大きすぎます。');
                        body += decoder.decode(value, { stream: true });
                    }
                    body += decoder.decode();
                } finally { await reader.cancel().catch(() => {}); }
                const found = parseYahooResults(JSON.parse(body));
                if (!result) result = found;
                else for (let i = 0; i < found.candidates!.length; i++) {
                    const candidate = found.candidates![i];
                    if (result.candidates!.some(p => p.productUrl === candidate.productUrl || p.name === candidate.name)) continue;
                    const source = found.search!.sources[i], id = `yahoo-${result.candidates!.length + 1}`;
                    result.candidates!.push({ ...candidate, recommendationReason: '検索条件を緩めた代案です。希望の機能は商品ページで確認してください。' });
                    result.search!.sources.push({ ...source, id });
                    result.evidence[id] = found.evidence[source.id];
                    result.text += `${found.evidence[source.id].join('\n')}\n商品ページ：${source.url}\n`;
                }
                result.search!.queries.push(queries[attempt]);
                if (result.candidates!.length >= 3) break;
            } catch (error) {
                if (result?.candidates?.length) return result;
                if (error instanceof ConversationError) throw error;
                if (signal.aborted || (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))) {
                    throw new ConversationError('TIMEOUT', 'Yahoo!ショッピングの商品検索が時間内に完了しませんでした。再度お試しください。');
                }
                // Client IDを含むURLや外部エラー本文は利用者・ログへ渡さない。
                throw new ConversationError('API_ERROR', 'Yahoo!ショッピングの商品検索に失敗しました。再度お試しください。');
            }
        }
        return result!;
    };
}
export const searchYahooShopping = createYahooShoppingSearch();
