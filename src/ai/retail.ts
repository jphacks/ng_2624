import type { GenerationResult } from './gemini.ts';
import type { ConversationRequest } from './prompt.ts';
import { ConversationError } from './errors.ts';
import { searchAmazon } from './amazon.ts';

function plain(value: string): string {
    return value.replace(/<[^>]*>/g, '').replace(/&(?:amp|quot|apos|lt|gt|nbsp|#\d+|#x[\da-f]+);/gi, entity => {
        const named: Record<string, string> = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>', '&nbsp;': ' ' };
        if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
        const code = entity[2].toLowerCase() === 'x' ? parseInt(entity.slice(3, -1), 16) : parseInt(entity.slice(2, -1), 10);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }).replace(/\s+/g, ' ').trim();
}

export function parseYodobashiResults(html: string): GenerationResult {
    const result: GenerationResult = { text: '', search: { queries: [], sources: [], searchSuggestionsHtml: null }, evidence: {}, candidates: [] };
    const cards = [...html.matchAll(/<div\b(?=[^>]*\bdata-sku=["']\d+["'])(?=[^>]*\bclass=["'][^"']*\bpListBlock\b)[^>]*>/g)];
    const seen = new Set<string>();
    for (let i = 0; i < cards.length && seen.size < 6; i++) {
        const sku = cards[i][0].match(/\bdata-sku=["'](\d+)["']/)![1];
        if (seen.has(sku)) continue;
        const card = html.slice(cards[i].index, cards[i + 1]?.index ?? html.length).split('<!-- /pListBlock -->')[0];
        if (/販売を終了|販売終了|予約受付を終了|予定数の販売を終了/.test(plain(card))) continue;
        const imageTag = card.match(/<div\b[^>]*class=["'][^"']*\bpImg\b[^"']*["'][^>]*>\s*(<img\b[^>]*>)/i)?.[1];
        const name = plain(imageTag?.match(/\salt=["']([^"']+)["']/i)?.[1] ?? '').slice(0, 300);
        const imageUrl = plain(imageTag?.match(/\ssrc=["']([^"']+)["']/i)?.[1] ?? '');
        if (!name || !/^https:\/\/image\.yodobashi\.com\/product\/(?:\d+\/)+[^/?]+\.(?:jpg|png|webp)(?:\?[^]*)?$/i.test(imageUrl) || !imageUrl.includes(sku)) continue;
        const priceText = plain(card.match(/<span\b[^>]*class=["'][^"']*\bproductPrice\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? '');
        const priceMatch = priceText.match(/^[￥¥]([\d,]+)$/);
        const price = priceMatch ? Number(priceMatch[1].replaceAll(',', '')) : NaN;
        if (!Number.isSafeInteger(price) || price <= 0) continue;
        const id = `yodobashi-${sku}`, url = `https://www.yodobashi.com/product/${sku}/`;
        const quote = `${name}。表示価格：￥${price.toLocaleString('en-US')}`;
        result.search!.sources.push({ id, url, title: name });
        result.evidence[id] = [quote];
        result.candidates!.push({ name, priceJpy: price, productUrl: url, imageUrl, description: name,
            recommendationReason: 'ヨドバシ.comの検索結果で画像と表示価格を確認しました。', sourceUrls: [url] });
        result.text += `${quote}\n商品ページ：${url}\n`;
        seen.add(sku);
    }
    return result;
}

export async function searchYodobashi(request: ConversationRequest, send: typeof fetch = fetch): Promise<GenerationResult> {
    const { query } = JSON.parse(request.input);
    if (typeof query !== 'string' || !query.trim() || query.length > 300) throw new ConversationError('INVALID_INPUT', '商品検索の条件を確認してください。');
    const timeout = AbortSignal.timeout(8000);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    const url = new URL('https://www.yodobashi.com/');
    url.searchParams.set('word', query.trim());
    const response = await send(url, { redirect: 'error', signal, headers: { Accept: 'text/html', 'Accept-Language': 'ja-JP' } });
    if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) {
        await response.body?.cancel();
        throw new ConversationError('API_ERROR', '商品の検索結果を取得できませんでした。');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new ConversationError('EMPTY_RESPONSE', '商品の検索結果を取得できませんでした。');
    let bytes = 0, html = '';
    const decoder = new TextDecoder();
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            bytes += value.length;
            if (bytes > 4 * 1024 * 1024) throw new ConversationError('API_ERROR', '商品の検索結果が大きすぎます。');
            html += decoder.decode(value, { stream: true });
        }
        html += decoder.decode();
    } finally { await reader.cancel().catch(() => {}); }
    const result = parseYodobashiResults(html);
    result.search!.queries.push(query.trim());
    return result;
}

/** Amazonが取得できない場合も別販売店から実商品の画像と価格を取得する。 */
export async function searchRetail(request: ConversationRequest, send: typeof fetch = fetch): Promise<GenerationResult> {
    let amazon: GenerationResult | undefined;
    try { amazon = await searchAmazon(request, send); } catch { request.signal?.throwIfAborted(); }
    if ((amazon?.candidates?.length ?? 0) >= 3) return amazon!;
    try {
        const retail = await searchYodobashi(request, send);
        if (!amazon) return retail;
        return { text: amazon.text + retail.text, search: { queries: [...amazon.search!.queries, ...retail.search!.queries],
            sources: [...amazon.search!.sources, ...retail.search!.sources], searchSuggestionsHtml: null },
            evidence: { ...amazon.evidence, ...retail.evidence }, candidates: [...amazon.candidates!, ...retail.candidates!] };
    } catch (error) {
        request.signal?.throwIfAborted();
        if (amazon?.candidates?.length) return amazon;
        throw error;
    }
}
