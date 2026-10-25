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

function attributes(tag: string): Record<string,string> {
    return Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(m=>[m[1].toLowerCase(),plain(m[2]??m[3])]));
}
function currentPrice(card: string): number | null {
    for(const start of card.matchAll(/<span\b[^>]*>/gi)){
        const classes=(attributes(start[0]).class||'').split(/\s+/);
        if(!classes.includes('a-price')||classes.includes('a-text-price'))continue;
        let depth=1,end=start.index!+start[0].length;
        const spans=/<\/?span\b[^>]*>/gi;spans.lastIndex=end;
        for(let tag;(tag=spans.exec(card));){depth+=/^<\//.test(tag[0])?-1:1;if(!depth){end=tag.index;break;}}
        if(depth)continue;
        const widget=card.slice(start.index!+start[0].length,end);
        const offscreen=widget.match(/<span\b[^>]*class=["'][^"']*\ba-offscreen\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1];
        let amount=offscreen&&plain(offscreen).match(/^[¥￥]\s*([\d,]+)(?:\.00)?$/)?.[1];
        // Some Amazon layouts expose the currency and whole amount without a-offscreen.
        if(!offscreen){
            const symbol=widget.match(/<span\b[^>]*class=["'][^"']*\ba-price-symbol\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1];
            const whole=widget.match(/<span\b[^>]*class=["'][^"']*\ba-price-whole\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1];
            if(symbol&&/^[¥￥]$/.test(plain(symbol))&&whole&&/^[\d,]+$/.test(plain(whole)))amount=plain(whole);
        }
        if(amount){const price=Number(amount.replaceAll(',',''));if(Number.isSafeInteger(price)&&price>0)return price;}
    }
    return null;
}
/** Amazonの検索カードから商品ID・商品名・表示価格を同じカード内で取得する。 */
export function parseAmazonResults(html: string): GenerationResult {
    const result: GenerationResult = { text: '', search: { queries: [], sources: [], searchSuggestionsHtml: null }, evidence: {}, candidates: [] };
    const cards = [...html.matchAll(/<div\b[^>]*>/gi)].filter(m => {
        const attrs=attributes(m[0]);return attrs['data-component-type']==='s-search-result'||(attrs.class||'').split(/\s+/).includes('s-result-item');
    });
    const seen = new Set<string>();
    for (let i = 0; i < cards.length && seen.size < MAX_CANDIDATES; i++) {
        const asin = cards[i][0].match(/\bdata-asin=["']([A-Z0-9]{10})["']/)?.[1];
        if (!asin || seen.has(asin)) continue;
        const card = html.slice(cards[i].index, cards[i + 1]?.index ?? html.length);
        const title = card.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i);
        const imageTag = card.match(/<img\b[^>]*\bclass=["'][^"']*\bs-image\b[^"']*["'][^>]*>/i)?.[0];
        const img=imageTag?attributes(imageTag):{};
        const name = plain(title?.[1]||attributes(title?.[0]||'')['aria-label']||img.alt||'').slice(0,300);
        const price=currentPrice(card);
        if(!name||price===null)continue;
        const id = `amazon-${asin}`, url = `https://www.amazon.co.jp/dp/${asin}`;
        const quote = `${name}。表示価格：￥${price.toLocaleString('en-US')}`;
        const image=[img.src,img['data-src'],img.srcset?.split(/\s+/)[0]].find(value=>value&&/^https:\/\/(?:m\.media-amazon\.com|images-(?:na|fe)\.ssl-images-amazon\.com)\/images\/I\//i.test(value));
        const imageUrl=image||null;
        result.search!.sources.push({ id, url, title: name });
        result.evidence[id] = [quote];
        result.candidates!.push({ name, priceJpy: price, productUrl: url, imageUrl,
            description: name, recommendationReason: 'Amazonで商品と表示価格を確認しました。希望の機能は商品ページで確認してください。', sourceUrls: [url] });
        result.text += `${quote}\n商品ページ：${url}\n`;
        seen.add(asin);
    }
    return result;
}

/** 固定のAmazonホストにだけ接続。リダイレクト・巨大な応答・長時間の取得を許可しない。 */
export async function searchAmazon(request: ConversationRequest, send: typeof fetch = fetch): Promise<GenerationResult> {
    const { query } = JSON.parse(request.input);
    if (typeof query !== 'string' || !query.trim() || query.length > 300) {
        throw new ConversationError('INVALID_INPUT', '商品検索の条件を確認してください。');
    }
    const result: GenerationResult = { text: '', search: { queries: [], sources: [], searchSuggestionsHtml: null }, evidence: {}, candidates: [] };
    const seen = new Set<string>();
    const broadQuery = query.trim().split(/[\s、,]+/u)[0];
    const names = new Set<string>();
    const attempts = [...new Set([query.trim(), broadQuery])];
    if(attempts.length===1)attempts.push(query.trim());
    // 同じ検索の重複や無関係なカテゴリへの置き換えを避け、取得全体を8秒に収める。
    const timeout = AbortSignal.timeout(8000);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    for (let attempt = 0; attempt < attempts.length; attempt++) {
        try {
            signal.throwIfAborted();
            const url = new URL('https://www.amazon.co.jp/s');
            url.searchParams.set('k', attempts[attempt]);
            if(attempt>0)url.searchParams.set('ref','nb_sb_noss');
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
            const found = parseAmazonResults(html);
            if(!found.candidates?.length)console.warn('Amazon search returned no readable cards',{bytes:html.length,cards:(html.match(/data-asin=/g)||[]).length});
            result.search!.queries.push(attempts[attempt]);
            for (const candidate of found.candidates!) {
                const key = candidate.name.trim().toLowerCase();
                if (seen.has(candidate.productUrl) || names.has(key)) continue;
                seen.add(candidate.productUrl);
                names.add(key);
                result.candidates!.push({ ...candidate, recommendationReason: attempt === 0 ? candidate.recommendationReason : '候補を揃えるため検索条件を緩めた代案です。希望の機能は未確認です。' });
            }
            for (const source of found.search!.sources) {
                if (result.search!.sources.some(item => item.id === source.id)) continue;
                result.search!.sources.push(source);
                result.evidence[source.id] = found.evidence[source.id];
            }
            result.text += found.text;
            if (result.candidates!.length >= 3) break;
        } catch (error) {
            // 後続の再検索が失敗しても、先に確認できた実商品は返す。
            if (result.candidates!.length) break;
            throw error;
        }
    }
    return result;
}
