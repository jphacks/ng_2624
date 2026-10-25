import type { GenerationResult } from './gemini.ts';
import type { ConversationRequest } from './prompt.ts';
import { ConversationError } from './errors.ts';

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_CANDIDATES = 6;

function plain(value: string): string {
    return value.replace(/<[^>]*>/g, '').replace(/&(?:amp|quot|apos|lt|gt|nbsp|#\d+|#x[\da-f]+);/gi, entity => {
        const named: Record<string, string> = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>', '&nbsp;': ' ' };
        if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
        const code = entity[2].toLowerCase() === 'x' ? parseInt(entity.slice(3, -1), 16) : parseInt(entity.slice(2, -1), 10);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }).replace(/\s+/g, ' ').trim();
}

/** Amazonの検索カードから商品ID・商品名・表示価格を同じカード内で取得する。 */
export function parseAmazonResults(html: string, minJpy: number, maxJpy: number): GenerationResult {
    const result: GenerationResult = { text: '', search: { queries: [], sources: [], searchSuggestionsHtml: null }, evidence: {}, candidates: [] };
    const cards = [...html.matchAll(/<div\b[^>]*\bdata-component-type=["']s-search-result["'][^>]*>/g)];
    const seen = new Set<string>();
    for (let i = 0; i < cards.length && seen.size < MAX_CANDIDATES; i++) {
        const asin = cards[i][0].match(/\bdata-asin=["']([A-Z0-9]{10})["']/)?.[1];
        if (!asin || seen.has(asin)) continue;
        const card = html.slice(cards[i].index, cards[i + 1]?.index ?? html.length);
        const title = card.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i)?.[1];
        const name = title ? plain(title).slice(0, 300) : '';
        if (!name) continue;
        const prices = [...card.matchAll(/<span\b[^>]*class=["']([^"']*\ba-price\b[^"']*)["'][^>]*>\s*<span\b[^>]*class=["'][^"']*\ba-offscreen\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/g)];
        const current = prices.find(p => !p[1].split(/\s+/).includes('a-text-price'));
        const match = current && plain(current[2]).match(/^[¥￥]\s*([\d,]+)(?:\.00)?$/);
        if (!match) continue;
        const price = Number(match[1].replaceAll(',', ''));
        if (!Number.isSafeInteger(price) || price < minJpy || price > maxJpy) continue;
        const id = `amazon-${asin}`, url = `https://www.amazon.co.jp/dp/${asin}`;
        const quote = `${name}。表示価格：￥${price.toLocaleString('en-US')}`;
        result.search!.sources.push({ id, url, title: name });
        result.evidence[id] = [quote];
        result.candidates!.push({ name, priceJpy: price, productUrl: url, imageUrl: null,
            description: name, recommendationReason: 'Amazonで商品と表示価格を確認しました。希望の機能は商品ページで確認してください。', sourceUrls: [url] });
        result.text += `${quote}\n商品ページ：${url}\n`;
        seen.add(asin);
    }
    return result;
}

/** 固定のAmazonホストにだけ接続。リダイレクト・巨大な応答・長時間の取得を許可しない。 */
export async function searchAmazon(request: ConversationRequest, send: typeof fetch = fetch): Promise<GenerationResult> {
    const { query, targetBudget } = JSON.parse(request.input);
    if (typeof query !== 'string' || !query.trim() || query.length > 300
        || !Number.isSafeInteger(targetBudget?.minJpy) || !Number.isSafeInteger(targetBudget?.maxJpy)
        || targetBudget.minJpy < 0 || targetBudget.maxJpy < targetBudget.minJpy) {
        throw new ConversationError('INVALID_INPUT', '商品検索の条件を確認してください。');
    }
    const result: GenerationResult = { text: '', search: { queries: [], sources: [], searchSuggestionsHtml: null }, evidence: {}, candidates: [] };
    const seen = new Set<string>();
    const broadQuery = query.trim().split(/[\s、,]+/u)[0];
    const names = new Set<string>();
    const attempts = [query, broadQuery, 'おもちゃ'];
    for (let attempt = 0; attempt < attempts.length; attempt++) {
        request.signal?.throwIfAborted();
        const url = new URL('https://www.amazon.co.jp/s');
        url.searchParams.set('k', attempts[attempt]);
        if (attempt === 0) url.searchParams.set('rh', `p_36:${targetBudget.minJpy * 100}-${targetBudget.maxJpy * 100}`);
        const timeout = AbortSignal.timeout(8000);
        const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
        const response = await send(url, { redirect: 'error', signal, headers: { Accept: 'text/html', 'Accept-Language': 'ja-JP' } });
        if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) {
            await response.body?.cancel();
            throw new ConversationError('API_ERROR', 'Amazonの商品検索に接続できませんでした。');
        }
        const reader = response.body?.getReader();
        if (!reader) throw new ConversationError('EMPTY_RESPONSE', 'Amazonの検索結果を取得できませんでした。');
        let bytes = 0, html = '';
        const decoder = new TextDecoder();
        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                bytes += value.length;
                if (bytes > MAX_BYTES) throw new ConversationError('API_ERROR', 'Amazonの検索結果を処理できませんでした。');
                html += decoder.decode(value, { stream: true });
            }
            html += decoder.decode();
        } finally { await reader.cancel().catch(() => {}); }
        if (/<title>[^<]*(?:Robot Check|ロボットチェック)/i.test(html) || /action=["'][^"']*validateCaptcha/i.test(html)) {
            throw new ConversationError('API_ERROR', 'Amazonの商品検索を一時的に利用できません。');
        }
        const found = parseAmazonResults(html, attempt === 0 ? targetBudget.minJpy : 0, attempt === 0 ? targetBudget.maxJpy : Number.MAX_SAFE_INTEGER);
        result.search!.queries.push(attempts[attempt]);
        for (const candidate of found.candidates!) {
            const key = candidate.name.trim().toLowerCase();
            if (seen.has(candidate.productUrl) || names.has(key)) continue;
            seen.add(candidate.productUrl);
            names.add(key);
            result.candidates!.push({ ...candidate, recommendationReason: attempt === 0 ? candidate.recommendationReason : '候補を揃えるため価格・検索条件を緩めた代案です。希望の機能は未確認です。' });
        }
        for (const source of found.search!.sources) {
            if (result.search!.sources.some(item => item.id === source.id)) continue;
            result.search!.sources.push(source);
            result.evidence[source.id] = found.evidence[source.id];
        }
        result.text += found.text;
        if (result.candidates!.length >= 3) break;
    }
    return result;
}
