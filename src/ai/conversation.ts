import type { AIInput, AIOutput, ProposalDraft } from '../../Sample_db/types.ts';
import { ConversationError, toConversationError } from './errors.ts';
import { generateGeminiReply } from './gemini.ts';
import type { ReplyGenerator } from './gemini.ts';
import { buildConversationRequest, negotiationContext } from './prompt.ts';
import { parseDecision } from './protocol.ts';
import { searchProducts } from './search.ts';
import { GOAL_SIZES, withinGuideline } from './rewards.ts';
import { parseAIInput } from './validation.ts';

/** 価格の再確認間隔。購入価格の保証ではなく、古い候補を提案へ進めないための初期値。 */
export const MAX_PRICE_AGE_MS = 24 * 60 * 60 * 1000;
export interface AIControllerDependencies {
    generate?: ReplyGenerator;
    createId?: () => string;
}

/** バックエンドとの唯一の入口。DB・承認・通知・目標登録は実行しない。 */
export async function createReply(
    value: AIInput,
    dependencies: AIControllerDependencies = {},
): Promise<AIOutput> {
    try {
        const input = parseAIInput(value);
        const generate = dependencies.generate ?? generateGeminiReply;
        const generated = await generate(buildConversationRequest(input));
        if (typeof generated.text !== 'string' || !generated.text.trim()) {
            throw new ConversationError('EMPTY_RESPONSE', 'Geminiから返答がありませんでした。');
        }
        const decision = parseDecision(generated.text);
        const base = { requestId: input.requestId, reply: decision.reply, search: null };
        // モデルが段階指定を無視しても、非公開コンテキストから検索・提案へ進ませない。
        if (input.mode === 'consultation') {
            return { ...base, action: 'HEARING', reply: decision.action === 'HEARING' ? decision.reply
                : '交渉で公開する内容を確認・編集して許可してから、親子共通の交渉へ進んでください。' };
        }
        if (decision.action === 'HEARING') return { ...base, action: 'HEARING' };
        if (decision.action === 'SEARCH') {
            if (Object.values(input.rewardGuidelines).some(amount => amount === null)) {
                return { ...base, action: 'HEARING', reply: '保護者の設定で、大中小それぞれの目安金額を決めてもらえますか？' };
            }
            const found = await searchProducts(decision.searchQuery!, negotiationContext(input), generate, dependencies.createId ?? (() => crypto.randomUUID()));
            const labels = { small: '小', medium: '中', large: '大' };
            const missing = GOAL_SIZES.filter(size => !found.products.some(product => product.size === size));
            const consultation = missing.length
                ? `${missing.map(size => labels[size]).join('・')}の目安±20％で希望に合う商品を確認できませんでした。この区分の希望条件や目安金額を見直しますか？`
                : '大中小それぞれ1件の候補が見つかりました。気になるものを1つ選んでください。';
            if (!found.products.length) return { ...base, action: 'HEARING', search: found.search, reply: consultation };
            return { ...base, action: 'PRODUCT', ...found, reply: `${consultation} 表示価格は検索時の参考価格です。` };
        }
        const current = input.currentProposal;
        const productId = input.selectedProductId ?? current?.productId;
        const product = input.products.find(product => product.id === productId);
        const blocked = (reply: string): AIOutput => ({ ...base, reply, action: 'NEGOTIATION', proposalDraft: null });
        if (current && ['agreed', 'superseded'].includes(current.status)) {
            return blocked('この提案は確定済み、または更新済みです。最新の提案を確認してから相談を続けてください。');
        }
        if (!product) return { ...base, action: 'HEARING', reply: 'まず商品候補から、提案したい商品を1つ選んでください。' };
        if (decision.action === 'NEGOTIATION' && !decision.persuasionText) {
            return { ...base, action: 'NEGOTIATION', proposalDraft: null };
        }
        if (Object.values(input.rewardGuidelines).some(amount => amount === null)) return blocked('保護者の設定で、大中小それぞれの目安金額を決めてもらえますか？');
        if (product.priceJpy === null) return blocked('この商品の価格は未確認です。価格を確認するため、もう一度検索してみませんか？');
        if (!withinGuideline(product.priceJpy, input.rewardGuidelines[`${product.size}Jpy`])) return blocked('この商品は対応する目安金額の±20％の範囲外です。希望条件や目安金額を見直しますか？');
        const age = product.priceCheckedAt ? Date.parse(input.now) - Date.parse(product.priceCheckedAt) : Infinity;
        if (age < 0 || age > MAX_PRICE_AGE_MS) return blocked('価格情報を更新する必要があります。この商品をもう一度検索してみませんか？');
        if (!decision.constraintsSatisfied) return blocked(decision.reply);
        const proposalDraft: ProposalDraft = {
            productId: product.id, target: input.role === 'parent' ? 'child' : 'parent',
            persuasionText: decision.persuasionText!, purchaseConditions: decision.purchaseConditions,
            basedOn: current ? { proposalId: current.id, version: current.version } : null,
        };
        return { ...base, action: current ? 'NEGOTIATION' : 'PROPOSAL', proposalDraft };
    } catch (error) { throw toConversationError(error); }
}

// 従来の起動方法を維持し、importだけではAPIを呼ばない。
if (import.meta.main) {
    const { runDemo } = await import('./demo.ts');
    try { await runDemo(createReply); }
    catch (error) {
        const failure = toConversationError(error);
        console.error(`[${failure.code}] ${failure.message}`);
        process.exitCode = 1;
    }
}
