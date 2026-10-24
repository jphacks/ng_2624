import type { AIInput, AIOutput } from '../../Sample_db/types.ts';

/** 実際の履歴取得・保存・目安金額の設定はバックエンドが担当する。 */
export const demoInput: AIInput = {
    requestId: 'demo-search', now: new Date().toISOString(), role: 'child',
    mode: 'consultation', message: '目安金額に合わせて、実際に買えるロボット工作キットを探して。',
    history: [], negotiationHistory: [],
    profile: { age: 10, gender: null, preferences: { interests: ['ロボット工作'], wishes: [], expectations: [] } },
    sharedConditions: [],
    constraints: { mustHave: ['小学生向け'], mustAvoid: [] },
    rewardGuidelines: { smallJpy: 1000, mediumJpy: 3000, largeJpy: 10000 },
    products: [], selectedProductId: null, currentProposal: null, negotiationResult: null,
};

export async function runDemo(reply: (input: AIInput) => Promise<AIOutput>): Promise<void> {
    console.log('Geminiに問い合わせています…');
    console.log(JSON.stringify(await reply(demoInput), null, 2));
}
