/** 明示的に実行する実API確認。通常のnpm testでは実行しない。 */
import { createReply } from './conversation.ts';
import { demoInput } from './demo.ts';
import { toConversationError } from './errors.ts';
import type { AIInput, AIOutput } from '../shared/types.ts';

function expect(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}
async function run(input: AIInput): Promise<AIOutput> {
    const result = await createReply(input);
    console.log(JSON.stringify({ stage: input.requestId, action: result.action,
        ...(result.action === 'PRODUCT' ? { products: result.products.map(p => ({ name: p.name, priceJpy: p.priceJpy, url: p.productUrl })), sources: result.search?.sources.length } : { reply: result.reply }),
    }));
    return result;
}

try {
    const initial: AIInput = { ...structuredClone(demoInput), requestId: 'smoke-hearing', role: 'parent',
        mode: 'consultation', message: 'こんにちは。子供のごほうびについて相談したいです。', history: [],
        profile: null, sharedConditions: [], constraints: { mustHave: [], mustAvoid: [] } };
    if (!process.argv.includes('--from-search')) {
        expect((await run(initial)).action === 'HEARING', '聞き取りへ進みませんでした。');
    }
    const searchInput = { ...structuredClone(demoInput), requestId: 'smoke-search', now: new Date().toISOString() };
    const found = await run(searchInput);
    expect(found.action === 'PRODUCT', '出典付きの商品候補が取得できませんでした。');
    const selected = found.products.find(p => p.priceJpy !== null);
    expect(selected, '価格の根拠がある候補を取得できませんでした。');
    const draftInput: AIInput = { ...searchInput, requestId: 'smoke-proposal', products: found.products,
        selectedProductId: selected.id, message: null,
        sharedConditions: [...searchInput.sharedConditions, { id: 'smoke-conditions', sourceUserId: 'demo-child', targetUserId: 'demo-parent',
            content: '選択商品について親に送る提案文を作ってください。今週の平日5日のうち4日宿題を提出することが条件。期限は2026年10月30日。1日休んでも大丈夫としてください。',
            approvedAt: searchInput.now }] };
    const draft = await run(draftInput);
    expect(draft.action === 'PROPOSAL', '商品選択後に提案下書きを取得できませんでした。');
    expect(draft.proposalDraft.target === 'parent', '提案先が正しくありません。');
    const revision = await run({ ...draftInput, requestId: 'smoke-revision', role: 'parent', mode: 'negotiation', history: [], profile: null,
        message: '4日の条件を3日に変えてください。期限は10月30日のままで、子供に返す修正提案を作ってください。',
        negotiationResult: { proposalId: 'smoke-proposal-id', version: 1, decision: 'revision_requested',
            reason: '宿題を提出する条件を4日から3日へ変更したい。期限は10月30日のままで子供向けの修正提案を作ってほしい。' },
        currentProposal: { id: 'smoke-proposal-id', negotiationId: 'smoke-negotiation-id', productId: selected.id,
            version: 1, status: 'pending', persuasionText: draft.proposalDraft.persuasionText, purchaseConditions: draft.proposalDraft.purchaseConditions } });
    expect(revision.action === 'NEGOTIATION' && revision.proposalDraft?.basedOn?.version === 1, '修正下書きの参照バージョンが正しくありません。');
    console.log('実API確認完了：聞き取り・商品検索・提案・再交渉。承認・目標登録はバックエンド側。');
} catch (error) {
    if (error instanceof Error && !(error.name === 'ConversationError')) console.error(error.message);
    else {
        const failure = toConversationError(error);
        console.error(`[${failure.code}] ${failure.message}`);
    }
    process.exitCode = 1;
}
