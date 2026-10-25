/** 実店舗・公式ストアの個別販売URL。記事・検索結果は含めない。 */
export function isRetailProductUrl(value: string): boolean {
    let url: URL;
    try { url = new URL(value); } catch { return false; }
    if (url.protocol !== 'https:' || url.port || url.username || url.password) return false;
    const host = url.hostname.toLowerCase();
    const path = url.pathname;
    if (/^(?:www\.)?amazon\.co\.jp$/.test(host)) return /\/(?:dp|gp\/product)\/[A-Z0-9]{10}(?:[/?]|$)/i.test(path);
    if (host === 'item.rakuten.co.jp') return /^\/[^/]+\/[^/]+\/?$/.test(path);
    if (/^(?:www\.)?yodobashi\.com$/.test(host)) return /^\/product\/\d+\/?$/.test(path);
    if (/^(?:www\.)?biccamera\.com$/.test(host)) return /^\/bc\/item\/\d+\/?$/.test(path);
    if (host === 'store-jp.nintendo.com') return /^\/item\/(?:software|hardware)\/[^/]+\/?$/.test(path) && /\d{8,}/.test(path);
    if (host === 'store.playstation.com') return /^\/ja-jp\/(?:product|concept)\/[^/]+\/?$/.test(path);
    if (/^(?:www\.)?microsoft\.com$/.test(host)) return /^\/ja-jp\/(?:d|store\/d)\/[^/]+\/[^/]+\/?$/.test(path);
    return false;
}
