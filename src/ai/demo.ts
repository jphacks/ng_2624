import type { AIInput, AIOutput } from '../../Sample_db/types.ts';

/** 実際の履歴取得・保存・目安金額の設定はバックエンドが担当する。 */
export const demoInput: AIInput = {
    requestId: 'demo-search', now: new Date().toISOString(), role: 'child',
    mode: 'negotiation', message: '目安金額に合わせて、実際に買えるロボット工作キットを探して。',
    history: [], profile: null,
    // デモ用の許可済みデータ。実運用ではBEが同意記録と共有先を確認して構築する。
    sharedConditions: [{ id: 'demo-shared-1', sourceUserId: 'demo-child', targetUserId: 'demo-parent',
        content: '10歳向けのロボット工作キットを大中小それぞれの目安に合わせて探したい。', approvedAt: '2026-10-23T10:02:00+09:00' }],
    constraints: { mustHave: ['小学生向け'], mustAvoid: [] },
    rewardGuidelines: { smallJpy: 1000, mediumJpy: 3000, largeJpy: 10000 },
    products: [], selectedProductId: null, currentProposal: null, negotiationResult: null,
};

export async function runDemo(reply: (input: AIInput) => Promise<AIOutput>): Promise<void> {
    console.log('Geminiに問い合わせています…');
    console.log(JSON.stringify(await reply(demoInput), null, 2));
}
