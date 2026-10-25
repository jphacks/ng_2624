import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { Interactions } from '@google/genai';
import type { AIInput, ProductCandidate, Proposal } from '../../Sample_db/types.ts';
import { createReply } from './conversation.ts';
import { ConversationError } from './errors.ts';
import { generateGeminiReply, readGrounding } from './gemini.ts';
import type { GenerationResult } from './gemini.ts';
import type { ConversationRequest } from './prompt.ts';
import { publicUrl } from './validation.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const NOW = '2026-10-23T20:00:00+09:00';
const PRODUCT_URL = 'https://www.tamiya.com/japan/products/70216/index.html';
const QUOTE = 'ロボット工作セットの価格は2,980円です。';
const product: ProductCandidate = {
    size: 'medium', id: 'product-1', name: 'ロボット工作セット', priceJpy: 2980, productUrl: PRODUCT_URL,
    priceCheckedAt: NOW, imageUrl: null, sourceUrls: [PRODUCT_URL], description: '組み立てて動かす工作キット。', recommendationReason: '工作への興味に合う。',
};
const proposal: Proposal = {
    id: 'proposal-1', negotiationId: 'negotiation-1', productId: product.id, version: 2,
    persuasionText: 'ロボットを組み立てたいです。', purchaseConditions: ['今週は宿題を4日提出する'], status: 'pending',
};
function input(): AIInput {
    return {
        requestId: 'request-1', now: NOW, role: 'child', message: '工作キットを探したい。',
        mode: 'negotiation', negotiationHistory: [],
        history: [{ id: 'c', sender: 'user', content: '非公開の工作相談。', createdAt: NOW }],
        profile: { age: 10, gender: null, preferences: { interests: ['非公開の興味'], wishes: [], expectations: [] } },
        sharedConditions: [{ id: 'shared-1', sourceUserId: 'child-1', targetUserId: 'parent-1',
            content: '小学生向けのロボット工作キットを探したい。', approvedAt: NOW }],
        constraints: { mustHave: ['小学生向け'], mustAvoid: [] },
        rewardGuidelines: { smallJpy: 1000, mediumJpy: 3000, largeJpy: 10000 },
        products: [], selectedProductId: null, currentProposal: null, negotiationResult: null,
    };
}
function decision(overrides: Record<string, unknown> = {}): GenerationResult {
    return { text: JSON.stringify({ action: 'HEARING', reply: 'どんな工作に興味がありますか？', searchQuery: null,
        persuasionText: null, purchaseConditions: [], constraintsSatisfied: false, ...overrides }), search: null, evidence: {} };
}
function draft(overrides: Record<string, unknown> = {}) {
    return decision({ action: 'PROPOSAL', reply: 'この内容で相手に提案しますか？', persuasionText: 'ロボットを組み立てて動きを学びたいです。',
        purchaseConditions: ['今週は宿題を4日提出する'], constraintsSatisfied: true, ...overrides });
}
function grounded(): GenerationResult {
    return { text: QUOTE, search: { queries: ['小学生 ロボット工作キット 大中小の目安に合う価格'],
        sources: [{ id: 'source-1', title: '販売元', url: PRODUCT_URL }], searchSuggestionsHtml: '<div>Google検索候補</div>' }, evidence: { 'source-1': [QUOTE] } };
}
function extraction(overrides: Record<string, unknown> = {}): GenerationResult {
    return { text: JSON.stringify({ products: [{ name: product.name, description: product.description,
        recommendationReason: product.recommendationReason, productSourceId: 'source-1', sourceIds: ['source-1'], priceJpy: 2980, priceEvidence: QUOTE, ...overrides }] }),
        search: null, evidence: {} };
}
function searchQueue(results: GenerationResult[], requests: ConversationRequest[] = []) {
    let count = 0;
    return async (request: ConversationRequest): Promise<GenerationResult> => {
        requests.push(request);
        assert.ok(count < results.length, 'unexpected extra API call');
        return results[count++];
    };
}
const SEARCH = () => decision({ action: 'SEARCH', searchQuery: '小学生 ロボット工作キット 大中小の目安に合う価格' });
function hasCode(code: ConversationError['code']) { return (error: unknown) => error instanceof ConversationError && error.code === code; }

for (const role of ['parent', 'child'] as const) {
    test(`${role}への個別相談に本人の履歴だけを渡し、相手の情報や不要な属性を除く`, async () => {
        const value = { ...input(), mode: 'consultation' as const, role, secret: '送信不要',
            history: [{ ...input().history[0], content: `${role}本人の非公開相談`, token: 'secret-token' }],
            profiles: { parent: '相手の非公開プロフィール', child: '相手の非公開プロフィール' },
            otherHistory: [{ content: '相手の非公開履歴' }] };
        const original = structuredClone(value);
        const result = await createReply(value, { generate: async request => {
            const payload = JSON.parse(request.input);
            assert.equal(payload.role, role);
            assert.equal(payload.history[0].content, value.history[0].content);
            assert.equal(payload.profile.age, 10);
            assert.equal(request.input.includes('送信不要'), false);
            assert.equal(request.input.includes('secret-token'), false);
            assert.equal('id' in payload.history[0], false);
            assert.equal(request.input.includes('相手の非公開'), false);
            assert.equal(request.input.includes('child-1'), false);
            assert.match(request.systemInstruction, role === 'parent' ? /相手は保護者/ : /相手は子供/);
            assert.ok(request.schema);
            return decision();
        } });
        assert.deepEqual(result, { requestId: value.requestId, action: 'HEARING', reply: 'どんな工作に興味がありますか？', search: null });
        assert.deepEqual(value, original);
    });
}

test('プロフィール・履歴がまだなくても聞き取りできる', async () => {
    await createReply({ ...input(), mode: 'consultation', history: [], profile: null }, { generate: async () => decision() });
});

test('実商品検索は判断→検索→整形の順に進み、出典のURLとコード発行IDを返す', async () => {
    const requests: ConversationRequest[] = [];
    const output = await createReply(input(), { createId: () => 'generated-id', generate: searchQueue([SEARCH(), grounded(), extraction()], requests) });
    assert.equal(output.action, 'PRODUCT');
    if (output.action !== 'PRODUCT') return;
    assert.equal(output.products[0].id, 'generated-id');
    assert.equal(output.products[0].productUrl, PRODUCT_URL);
    assert.equal(output.products[0].priceJpy, 2980);
    assert.equal(output.products[0].priceCheckedAt, NOW);
    assert.equal(output.search?.searchSuggestionsHtml, '<div>Google検索候補</div>');
    assert.deepEqual(requests.map(r => !!r.search), [false, true, false]);
    assert.equal(requests[1].input.includes('工作に取り組んでほしい'), false);
    assert.equal(requests[2].input.includes('history'), false);
});

const rejectedCases: Array<[string, Record<string, unknown>, GenerationResult]> = [
    ['架空の出典ID', { productSourceId: 'invented' }, grounded()],
    ['出典IDに未知の値が混ざる', { sourceIds: ['source-1', 'invented'] }, grounded()],
    ['出典が空', { sourceIds: [] }, grounded()],
    ['目安範囲外', { priceJpy: 6000, priceEvidence: '価格は6,000円です。' }, { ...grounded(), text: '価格は6,000円です。', evidence: { 'source-1': ['価格は6,000円です。'] } }],
];
for (const [label, item, source] of rejectedCases) {
    test(`${label}の商品を候補として返さない`, async () => {
        const result = await createReply(input(), { generate: searchQueue([SEARCH(), source, extraction(item)]) });
        assert.equal(result.action, 'HEARING');
        assert.ok(result.search);
    });
}

for (const changes of [{ priceEvidence: '価格は1円です。' }, { priceJpy: 2999 }, { priceJpy: null, priceEvidence: null }]) {
    test(`根拠のない価格を候補にしない：${JSON.stringify(changes)}`, async () => {
        const result = await createReply(input(), { generate: searchQueue([SEARCH(), grounded(), extraction(changes)]) });
        assert.equal(result.action, 'HEARING');
        assert.ok(result.search);
    });
}

test('検索に出典がなければ整形APIを呼ばずに聞き取りへ戻る', async () => {
    const requests: ConversationRequest[] = [];
    const result = await createReply(input(), { generate: searchQueue([SEARCH(), { text: '候補なし', search: null, evidence: {} }], requests) });
    assert.equal(result.action, 'HEARING');
    assert.equal(requests.length, 2);
});

test('目安未設定では検索APIを呼ばず設定を案内する', async () => {
    const requests: ConversationRequest[] = [];
    const value = input(); value.rewardGuidelines.mediumJpy = null;
    const result = await createReply(value, { generate: searchQueue([SEARCH()], requests) });
    assert.equal(result.action, 'HEARING'); assert.equal(requests.length, 1);
});

for (const role of ['parent', 'child'] as const) {
    test(`${role}からの提案は選択済み商品を参照し、相手宛ての下書きにする`, async () => {
        const value = { ...input(), role, products: [product], selectedProductId: product.id };
        const before = structuredClone(value);
        const output = await createReply(value, { generate: async () => draft({ productId: 'invented', target: role, status: 'agreed' }) });
        assert.equal(output.action, 'PROPOSAL');
        if (output.action !== 'PROPOSAL') return;
        assert.equal(output.proposalDraft.productId, product.id);
        assert.equal(output.proposalDraft.target, role === 'parent' ? 'child' : 'parent');
        assert.equal(output.proposalDraft.basedOn, null);
        assert.equal('status' in output, false);
        assert.equal('status' in output.proposalDraft, false);
        assert.deepEqual(value, before);
    });
}

test('再交渉は同じ提案ID/versionをbasedOnへ返し、承認や状態は変更しない', async () => {
    const value = { ...input(), products: [product], currentProposal: proposal };
    const before = structuredClone(value);
    const result = await createReply(value, { generate: async () => draft({ action: 'NEGOTIATION' }) });
    assert.equal(result.action, 'NEGOTIATION');
    if (result.action === 'NEGOTIATION') assert.deepEqual(result.proposalDraft?.basedOn, { proposalId: proposal.id, version: 2 });
    assert.deepEqual(value, before);
});

test('再交渉で商品を変える場合もバックエンドの選択IDを使う', async () => {
    const other = { ...product, id: 'product-2' };
    const result = await createReply({ ...input(), products: [product, other], selectedProductId: other.id, currentProposal: proposal }, { generate: async () => draft() });
    if (result.action !== 'NEGOTIATION') return assert.fail('expected negotiation');
    assert.equal(result.proposalDraft?.productId, other.id);
    assert.equal(result.proposalDraft?.basedOn?.version, 2);
});

for (const [label, changes] of [
    ['価格不明', { priceJpy: null }], ['目安範囲外', { priceJpy: 6000 }],
    ['価格確認なし', { priceCheckedAt: null }], ['古い価格', { priceCheckedAt: '2026-10-21T20:00:00+09:00' }],
    ['未来の価格', { priceCheckedAt: '2026-10-24T20:00:00+09:00' }],
] as const) {
    test(`${label}では提案下書きを返さない`, async () => {
        const result = await createReply({ ...input(), products: [{ ...product, ...changes }], selectedProductId: product.id }, { generate: async () => draft() });
        assert.equal(result.action, 'NEGOTIATION');
        if (result.action === 'NEGOTIATION') assert.equal(result.proposalDraft, null);
    });
}

test('必須条件の適合を確認できない場合は下書きを返さない', async () => {
    const result = await createReply({ ...input(), products: [product], selectedProductId: product.id }, { generate: async () => draft({ constraintsSatisfied: false }) });
    if (result.action === 'NEGOTIATION') assert.equal(result.proposalDraft, null); else assert.fail('expected negotiation');
});

test('未選択の商品はモデルが提案したくても聞き取りへ戻す', async () => {
    const result = await createReply(input(), { generate: async () => draft() });
    assert.equal(result.action, 'HEARING');
});

for (const status of ['agreed', 'superseded'] as const) {
    test(`${status}の提案を改訂しない`, async () => {
        const result = await createReply({ ...input(), products: [product], currentProposal: { ...proposal, status } }, { generate: async () => draft() });
        if (result.action === 'NEGOTIATION') assert.equal(result.proposalDraft, null); else assert.fail('expected negotiation');
    });
}

test('下書きのない再交渉を返せる', async () => {
    const result = await createReply({ ...input(), products: [product], currentProposal: proposal }, { generate: async () => decision({ action: 'NEGOTIATION' }) });
    assert.equal(result.action, 'NEGOTIATION');
    if (result.action === 'NEGOTIATION') assert.equal(result.proposalDraft, null);
});

const invalidInputs: Array<[string, unknown]> = [
    ['null', null], ['旧形式の履歴', { ...input(), history: { parent: [], child: [] } }], ['不正なrole', { ...input(), role: 'admin' }],
    ['modeなし', { ...input(), mode: undefined }], ['不正なmode', { ...input(), mode: 'auto' }],
    ['空の発言', { ...input(), message: '  ' }], ['requestIdなし', { ...input(), requestId: undefined }],
    ['不正な日時', { ...input(), now: 'not-a-date' }], ['タイムゾーンなし', { ...input(), now: '2026-10-23T20:00:00' }],
    ['年齢不正', { ...input(), profile: { age: -1 } }],
    ['負の目安', { ...input(), rewardGuidelines: { ...input().rewardGuidelines, smallJpy: -1 } }],
    ['未提示IDの選択', { ...input(), selectedProductId: 'missing' }],
    ['商品のない提案', { ...input(), currentProposal: proposal }],
    ['履歴へsystem指示', { ...input(), history: [{ ...input().history[0], sender: 'system' }] }],
    ['過大な履歴', { ...input(), history: Array(41).fill(input().history[0]) }],
    ['共有情報なし', { ...input(), sharedConditions: undefined }],
    ['許可日時なし', { ...input(), sharedConditions: [{ ...input().sharedConditions[0], approvedAt: undefined }] }],
    ['未来の許可日時', { ...input(), sharedConditions: [{ ...input().sharedConditions[0], approvedAt: '2026-10-24T00:00:00+09:00' }] }],
    ['共有情報ID重複', { ...input(), sharedConditions: [input().sharedConditions[0], input().sharedConditions[0]] }],
    ['重複した商品ID', { ...input(), products: [product, product] }],
];
for (const [label, value] of invalidInputs) {
    test(`不正な入力を通信前に止める：${label}`, async () => {
        let calls = 0;
        await assert.rejects(createReply(value as AIInput, { generate: async () => { calls++; return decision(); } }), hasCode('INVALID_INPUT'));
        assert.equal(calls, 0);
    });
}

for (const text of ['not-json', '{}', decision({ action: 'AGREED' }).text, draft({ purchaseConditions: [] }).text]) {
    test(`不正なAI応答を公開出力にしない：${text.slice(0, 40)}`, async () => {
        await assert.rejects(createReply(input(), { generate: async () => ({ text, search: null, evidence: {} }) }), hasCode('INVALID_RESPONSE'));
    });
}

for (const [error, code] of [[{ status: 429 }, 'RATE_LIMIT'], [{ statusCode: 429 }, 'RATE_LIMIT'], [{ code: 'RESOURCE_EXHAUSTED' }, 'RATE_LIMIT'],
    [{ name: 'TimeoutError' }, 'TIMEOUT'], [{ name: 'AbortError' }, 'TIMEOUT'], [{ name: 'APIConnectionTimeoutError' }, 'TIMEOUT'],
    [{ code: 'DEADLINE_EXCEEDED' }, 'TIMEOUT'], [{ status: 504 }, 'TIMEOUT'], [new Error('sensitive-api-key'), 'API_ERROR']] as const) {
    test(`APIエラーを安全に返す：${code}`, async () => {
        await assert.rejects(createReply(input(), { generate: async () => { throw error; } }), failure => {
            assert.ok(failure instanceof ConversationError);
            assert.equal(failure.code, code); assert.equal(failure.message.includes('sensitive'), false); assert.equal(failure.cause, undefined);
            return true;
        });
    });
}

test('実SDKの出典はUTF-8バイト位置で読み取り、同じURLをまとめる', () => {
    const text = `調査結果。${QUOTE}`;
    const start = new TextEncoder().encode('調査結果。').length;
    const result = readGrounding({ id: 'test', status: 'completed', steps: [
        { type: 'google_search_call', id: 'search', arguments: { queries: ['工作キット'] } },
        { type: 'google_search_result', call_id: 'search', result: [{ search_suggestions: '<div>Google</div>' }] },
        { type: 'model_output', content: [{ type: 'text', text, annotations: [
            { type: 'url_citation', url: PRODUCT_URL, title: '販売元', start_index: start, end_index: new TextEncoder().encode(text).length },
            { type: 'url_citation', url: PRODUCT_URL, title: '販売元' },
            { type: 'url_citation', url: 'javascript:alert(1)' },
        ] }] },
    ] } as Interactions.Interaction);
    assert.equal(result.search?.sources.length, 1);
    assert.deepEqual(result.evidence['source-1'], [QUOTE]);
    assert.deepEqual(result.search?.queries, ['工作キット']);
});

for (const unsafe of ['javascript:alert(1)', 'http://www.tamiya.com/', 'https://127.0.0.1/', 'https://[::1]/', 'https://localhost/', 'https://foo.local/', 'https://user:pass@www.tamiya.com/', 'https://example.com/products/1']) {
    test(`危険・架空のリンクを返さない：${unsafe}`, () => assert.equal(publicUrl(unsafe), null));
}

test('キーなしなら通信前に失敗する', async () => {
    await assert.rejects(generateGeminiReply({ systemInstruction: 'test', input: '{}' }, ''), hasCode('MISSING_API_KEY'));
});

test('import時にAPI通信やデモが走らない', () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./src/ai/index.ts')"], {
        cwd: root, encoding: 'utf8', env: { ...process.env, GEMINI_API_KEY: '', GOOGLE_API_KEY: '' },
    });
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, '');
});

test('従来の直接起動を維持し、キーなしなら安全なエラーを返す', () => {
    const result = spawnSync(process.execPath, ['src/ai/conversation.ts'], { cwd: root, encoding: 'utf8', env: { ...process.env, GEMINI_API_KEY: '', GOOGLE_API_KEY: '' } });
    assert.equal(result.status, 1); assert.match(result.stdout, /Geminiに問い合わせています/); assert.match(result.stderr, /MISSING_API_KEY/);
});

test('実SDKが固定指示・JSON Schema・検索ツール・store=falseを正しいAPI形式で送る', async () => {
    const original = globalThis.fetch;
    const originalTimeout = AbortSignal.timeout;
    const timeouts: number[] = [];
    AbortSignal.timeout = milliseconds => {
        timeouts.push(milliseconds);
        return originalTimeout(milliseconds);
    };
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = async (_url, init) => {
        const body = init?.body ?? (_url instanceof Request ? await _url.clone().text() : '');
        bodies.push(JSON.parse(String(body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ id: 'sdk-test', status: 'completed',
            steps: [{ type: 'model_output', content: [{ type: 'text', text: '{"ok":true}' }] }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    try {
        const result = await generateGeminiReply({ systemInstruction: '固定の指示', input: '{}', schema: { type: 'object' } }, 'fake-key-for-test');
        assert.equal(result.text, '{"ok":true}');
        assert.equal(bodies[0].model, 'gemini-4-argon');
        assert.equal(bodies[0].store, false);
        assert.equal(bodies[0].system_instruction, '固定の指示');
        assert.deepEqual(bodies[0].response_format, { type: 'text', mime_type: 'application/json', schema: { type: 'object' } });
        assert.equal('tools' in bodies[0], false);
        await generateGeminiReply({ systemInstruction: '検索指示', input: '{}', search: true }, 'fake-key-for-test');
        assert.equal(bodies[1].model, 'gemini-3.8-flash');
        assert.deepEqual(bodies[1].tools, [{ type: 'google_search' }]);
        assert.equal('response_format' in bodies[1], false);
        assert.deepEqual(timeouts, [30_000, 60_000]);
    } finally { globalThis.fetch = original; AbortSignal.timeout = originalTimeout; }
});

test('実SDKの429を再試行せず安全なエラーへ変換する', async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
        calls++;
        return new Response(JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'private-quota-detail' } }), {
            status: 429, headers: { 'content-type': 'application/json' },
        });
    };
    try {
        await assert.rejects(createReply(input(), { generate: request => generateGeminiReply(request, 'fake-key-for-test') }), hasCode('RATE_LIMIT'));
        assert.equal(calls, 1);
    } finally { globalThis.fetch = original; }
});

test('存在しない日付を入力として受け付けない', async () => {
    await assert.rejects(createReply({ ...input(), now: '2026-02-30T20:00:00+09:00' }, { generate: async () => decision() }), hasCode('INVALID_INPUT'));
});

test('別の出典にしか存在しない価格の引用を採用しない', async () => {
    const result = grounded(); result.evidence = { 'other-source': [QUOTE] };
    const output = await createReply(input(), { generate: searchQueue([SEARCH(), result, extraction()]) });
    assert.equal(output.action, 'HEARING');
    assert.ok(output.search);
});

test('検索結果の重複URLを商品候補へ重複して入れない', async () => {
    const raw = JSON.parse(extraction().text);
    raw.products.push(raw.products[0]);
    let ids = 0;
    const output = await createReply(input(), { generate: searchQueue([SEARCH(), grounded(), { text: JSON.stringify(raw), search: null, evidence: {} }]), createId: () => `generated-${++ids}` });
    if (output.action !== 'PRODUCT') return assert.fail('expected products');
    assert.equal(output.products.length, 1); assert.equal(ids, 1);
});

test('公開入口で検索した出力をそのまま次の提案・修正の入力へ渡せる', async () => {
    const value = input();
    const found = await createReply(value, { generate: searchQueue([SEARCH(), grounded(), extraction()]), createId: () => product.id });
    if (found.action !== 'PRODUCT') return assert.fail('expected products');
    const chosen = { ...value, products: found.products, selectedProductId: found.products[0].id };
    const offered = await createReply(chosen, { generate: async () => draft() });
    if (offered.action !== 'PROPOSAL') return assert.fail('expected proposal');
    const current: Proposal = { ...proposal, productId: offered.proposalDraft.productId, version: 1,
        persuasionText: offered.proposalDraft.persuasionText, purchaseConditions: offered.proposalDraft.purchaseConditions };
    const revised = await createReply({ ...chosen, role: 'parent', currentProposal: current }, { generate: async () => draft({ action: 'NEGOTIATION' }) });
    if (revised.action !== 'NEGOTIATION') return assert.fail('expected negotiation');
    assert.equal(revised.proposalDraft?.target, 'child');
    assert.deepEqual(revised.proposalDraft?.basedOn, { proposalId: current.id, version: 1 });
});

for (const role of ['parent', 'child'] as const) {
    test(`${role}の個別相談で本人の情報を使って商品を検索でき、公開検索へ履歴を直接渡さない`, async () => {
        const value: AIInput = { ...input(), role, mode: 'consultation', sharedConditions: [],
            message: '本人専用の希望PRIVATE',
            profile: { ...input().profile!, preferences: { interests: ['本人の興味PRIVATE'], wishes: [], expectations: [] } },
            history: [{ ...input().history[0], content: '本人専用の事情PRIVATE' }] };
        const before = structuredClone(value);
        const requests: ConversationRequest[] = [];
        const result = await createReply(value, { generate: searchQueue([SEARCH(), grounded(), extraction()], requests) });
        assert.equal(result.action, 'PRODUCT');
        const payload = JSON.parse(requests[0].input);
        assert.equal(payload.message, value.message);
        assert.equal(payload.history[0].content, value.history[0].content);
        assert.deepEqual(payload.profile.preferences, value.profile!.preferences);
        assert.deepEqual((requests[0].schema?.properties as Record<string, unknown>).action,
            { type: 'string', enum: ['HEARING', 'SEARCH', 'PROPOSAL'] });
        for (const request of requests.slice(1)) {
            assert.equal(request.input.includes('PRIVATE'), false);
            for (const field of ['message', 'history', 'profile']) assert.equal(field in JSON.parse(request.input), false);
        }
        assert.deepEqual(value, before);
    });
    test(`${role}の個別相談から共有交渉へモデルの判断で移行しない`, async () => {
        const output = await createReply({ ...input(), role, mode: 'consultation' }, {
            generate: async () => draft({ action: 'NEGOTIATION' }),
        });
        assert.equal(output.action, 'HEARING');
        assert.equal('proposalDraft' in output, false);
    });
    test(`${role}の検索・整形・提案・再交渉の全リクエストに非公開情報を含めない`, async () => {
        const value = { ...input(), role, message: '公開の変更希望MESSAGE',
            negotiationHistory: [{ id: 'public-1', sender: 'parent' as const, content: '公開済みの希望HISTORY', createdAt: NOW, token: 'SECRET' }],
            history: [{ ...input().history[0], content: '未共有履歴SECRET' }],
            profile: { ...input().profile!, preferences: { interests: ['未共有プロフィールSECRET'], wishes: [], expectations: [] } },
            otherHistory: ['相手の秘密SECRET'], profiles: { parent: '相手の秘密SECRET', child: '相手の秘密SECRET' } };
        const requests: ConversationRequest[] = [];
        const found = await createReply(value, { generate: searchQueue([SEARCH(), grounded(), extraction()], requests), createId: () => product.id });
        if (found.action !== 'PRODUCT') return assert.fail('expected products');
        const chosen = { ...value, products: found.products, selectedProductId: product.id };
        await createReply(chosen, { generate: searchQueue([draft()], requests) });
        await createReply({ ...chosen, currentProposal: proposal }, { generate: searchQueue([draft({ action: 'NEGOTIATION' })], requests) });
        for (const request of requests) {
            assert.equal(request.input.includes('SECRET'), false);
            const payload = JSON.parse(request.input);
            for (const field of ['history', 'profile', 'profiles', 'otherHistory']) assert.equal(field in payload, false);
            if ('message' in payload) {
                assert.equal(payload.message, value.message);
                assert.deepEqual(payload.negotiationHistory, [{ sender: 'parent', content: '公開済みの希望HISTORY' }]);
            } else {
                assert.equal(request.input.includes('MESSAGE'), false);
                assert.equal(request.input.includes('HISTORY'), false);
            }
        }
        assert.equal(JSON.parse(requests[0].input).sharedConditions[0].content, value.sharedConditions[0].content);
        assert.equal(requests[0].input.includes('child-1'), false);
        assert.equal(requests.length, 5);
    });
}

for (const resultDecision of ['rejected', 'revision_requested'] as const) {
    test(`BEの${resultDecision}理由を再提案に利用し、対象ID/versionと状態を保持する`, async () => {
        const reason = '宿題4日では負担が大きいので3日に変更してほしい。';
        const value: AIInput = { ...input(), products: [product], currentProposal: { ...proposal, status: 'rejected' },
            negotiationResult: { proposalId: proposal.id, version: proposal.version, decision: resultDecision, reason } };
        const before = structuredClone(value);
        const output = await createReply(value, { generate: async request => {
            const payload = JSON.parse(request.input);
            assert.deepEqual(payload.negotiationResult, value.negotiationResult);
            assert.match(request.systemInstruction, /reasonを踏まえて/);
            assert.equal(payload.currentProposal.id, proposal.id);
            return draft({ action: 'NEGOTIATION', purchaseConditions: ['今週は宿題を3日提出する'] });
        } });
        if (output.action !== 'NEGOTIATION') return assert.fail('expected negotiation');
        assert.deepEqual(output.proposalDraft?.purchaseConditions, ['今週は宿題を3日提出する']);
        assert.deepEqual(output.proposalDraft?.basedOn, { proposalId: proposal.id, version: proposal.version });
        assert.equal('decision' in output, false);
        assert.deepEqual(value, before);
    });
}

test('BEの承認結果を個別相談へ渡すが、AI出力で承認や合意状態を確定しない', async () => {
    const value: AIInput = { ...input(), mode: 'consultation', products: [product], currentProposal: proposal,
        negotiationResult: { proposalId: proposal.id, version: proposal.version, decision: 'approved', reason: null } };
    const output = await createReply(value, { generate: async request => {
        assert.deepEqual(JSON.parse(request.input).negotiationResult, value.negotiationResult);
        assert.match(request.systemInstruction, /AIの判断で合意成立を確定/);
        return decision();
    } });
    assert.equal(output.action, 'HEARING');
    assert.equal('status' in output, false);
});

for (const changes of [
    { proposalId: 'other-proposal' }, { version: 1 }, { version: 0 }, { decision: 'agreed' }, { reason: '' }, { reason: null },
]) {
    test(`不正・不一致の交渉結果を通信前に拒否する：${JSON.stringify(changes)}`, async () => {
        let calls = 0;
        const value = { ...input(), products: [product], currentProposal: proposal,
            negotiationResult: { proposalId: proposal.id, version: proposal.version, decision: 'rejected', reason: '変更したい', ...changes } };
        await assert.rejects(createReply(value as AIInput, { generate: async () => { calls++; return decision(); } }), hasCode('INVALID_INPUT'));
        assert.equal(calls, 0);
    });
}

test('参照する提案がない交渉結果を拒否する', async () => {
    await assert.rejects(createReply({ ...input(), negotiationResult: {
        proposalId: proposal.id, version: 2, decision: 'rejected', reason: '変更したい',
    } }, { generate: async () => assert.fail('must not call model') }), hasCode('INVALID_INPUT'));
});

test('BEが取り消した共有条件を次回呼び出しのコンテキストへ再利用しない', async () => {
    const requests: ConversationRequest[] = [];
    await createReply(input(), { generate: searchQueue([decision()], requests) });
    await createReply({ ...input(), sharedConditions: [] }, { generate: searchQueue([decision()], requests) });
    assert.equal(JSON.parse(requests[0].input).sharedConditions.length, 1);
    assert.deepEqual(JSON.parse(requests[1].input).sharedConditions, []);
    assert.equal(requests[1].input.includes(input().sharedConditions[0].content), false);
});

// 新しい報酬設定の境界・区分選定を公開入口と同じ関数で確認する。
test('目安±20％の境界を含み、直外と未設定を除外する', async () => {
    const { withinGuideline } = await import('./rewards.ts');
    for (const price of [800, 1000, 1200]) assert.equal(withinGuideline(price, 1000), true);
    for (const price of [799, 1201]) assert.equal(withinGuideline(price, 1000), false);
    assert.equal(withinGuideline(1000, null), false);
    assert.equal(withinGuideline(0, 0), true);
    assert.equal(withinGuideline(1, 0), false);
    assert.equal(withinGuideline(801, 1001), true);
    assert.equal(withinGuideline(800, 1001), false);
    assert.equal(withinGuideline(1202, 1001), false);
});

test('各区分1件を目安に近い価格で選び、範囲の重なりでも同じ商品を重複させない', async () => {
    const { selectRewards } = await import('./rewards.ts');
    const candidate = (id: string, priceJpy: number) => ({ ...product, id, name: id, productUrl: `https://www.tamiya.com/${id}`, priceJpy });
    const selected = selectRewards([candidate('s-far', 800), candidate('s', 1000), candidate('m', 3000), candidate('l', 10000)], input().rewardGuidelines);
    assert.deepEqual(selected.map(p => [p.size, p.id]), [['small', 's'], ['medium', 'm'], ['large', 'l']]);
    // 重なりの候補をsmallに先取りするとmediumが空く。最大件数を優先して割り当てる。
    const overlap = selectRewards([candidate('overlap', 1100), candidate('only-small', 800), candidate('l', 10000)],
        { smallJpy: 1000, mediumJpy: 1300, largeJpy: 10000 });
    assert.deepEqual(overlap.map(p => [p.size, p.id]), [['small', 'only-small'], ['medium', 'overlap'], ['large', 'l']]);
    const duplicate = selectRewards([candidate('same', 1100), { ...candidate('other', 1100), name: 'same' }],
        { smallJpy: 1000, mediumJpy: 1300, largeJpy: 10000 });
    assert.equal(duplicate.length, 1);
});

test('検索で大中小各1件を返し、そのまま提案へ進める', async () => {
    const source = grounded();
    const raw = JSON.parse(extraction().text);
    source.search!.sources = [800, 3000, 12000].map((price, index) => ({ id: `s${index}`, title: '販売元', url: `https://www.tamiya.com/product-${index}` }));
    source.evidence = Object.fromEntries([800, 3000, 12000].map((price, index) => [`s${index}`, [`価格は${price}円です。`]]));
    raw.products = [800, 3000, 12000].map((price, index) => ({ ...raw.products[0], name: `商品${index}`, priceJpy: price,
        priceEvidence: `価格は${price}円です。`, productSourceId: `s${index}`, sourceIds: [`s${index}`] }));
    let ids = 0;
    const found = await createReply(input(), { generate: searchQueue([SEARCH(), source, { ...extraction(), text: JSON.stringify(raw) }]), createId: () => `p${++ids}` });
    if (found.action !== 'PRODUCT') return assert.fail('expected products');
    assert.deepEqual(found.products.map(p => p.size), ['small', 'medium', 'large']);
    assert.doesNotMatch(found.reply, /見直し/);
    for (const candidate of found.products) {
        const offered = await createReply({ ...input(), products: found.products, selectedProductId: candidate.id }, { generate: async () => draft() });
        assert.equal(offered.action, 'PROPOSAL');
    }
});

test('不足区分の条件変更を相談し、目安を勝手に変更しない', async () => {
    const value = input();
    const before = structuredClone(value);
    const found = await createReply(value, { generate: searchQueue([SEARCH(), grounded(), extraction()]) });
    assert.equal(found.action, 'PRODUCT');
    assert.match(found.reply, /小・大/);
    assert.match(found.reply, /希望条件や目安金額を見直し/);
    assert.deepEqual(value, before);
});

for (const rewardGuidelines of [undefined, { smallJpy: 1000, mediumJpy: 3000 },
    { smallJpy: 1.5, mediumJpy: 3000, largeJpy: 10000 }]) {
    test(`旧形式や不正な目安は通信前に拒否：${JSON.stringify(rewardGuidelines)}`, async () => {
        let calls = 0;
        await assert.rejects(createReply({ ...input(), rewardGuidelines } as AIInput,
            { generate: async () => { calls++; return decision(); } }), hasCode('INVALID_INPUT'));
        assert.equal(calls, 0);
    });
}


for (const role of ['parent', 'child'] as const) {
    test(`${role}の交渉発言と親子・AIの共有履歴から修正案を作れる`, async () => {
        const value: AIInput = { ...input(), role, message: '条件を4日から3日に変えたい。',
            negotiationHistory: [
                { id: 'public-child', sender: 'child', content: '工作キットが欲しい。', createdAt: NOW },
                { id: 'public-parent', sender: 'parent', content: '宿題4日の条件でどうかな。', createdAt: NOW },
                { id: 'public-ai', sender: 'assistant', content: '条件を相談しましょう。', createdAt: NOW },
            ], products: [product], selectedProductId: product.id, currentProposal: proposal };
        const original = structuredClone(value);
        const output = await createReply(value, { generate: async request => {
            const payload = JSON.parse(request.input);
            assert.equal(payload.role, role);
            assert.equal(payload.message, value.message);
            assert.deepEqual(payload.negotiationHistory, value.negotiationHistory.map(({ sender, content }) => ({ sender, content })));
            assert.equal(request.input.includes('非公開'), false);
            assert.equal('history' in payload, false);
            assert.equal('profile' in payload, false);
            assert.match(request.systemInstruction, /参加者全員に公開/);
            return draft({ action: 'NEGOTIATION', purchaseConditions: ['今週は宿題を3日提出する'] });
        } });
        if (output.action !== 'NEGOTIATION') return assert.fail('expected negotiation');
        assert.deepEqual(output.proposalDraft?.purchaseConditions, ['今週は宿題を3日提出する']);
        assert.equal(output.proposalDraft?.target, role === 'parent' ? 'child' : 'parent');
        assert.deepEqual(value, original);
    });
}

test('個別相談から交渉へ持ち込めるのは本人が公開を許可した要約だけ', async () => {
    const privateInput: AIInput = { ...input(), mode: 'consultation',
        message: '親には言いたくない秘密PRIVATEがある。',
        history: [{ ...input().history[0], content: '非公開の事情PRIVATE' }],
        sharedConditions: [] };
    const privateBefore = structuredClone(privateInput);
    const privateReply = await createReply(privateInput, { generate: async request => {
        assert.equal(JSON.parse(request.input).message, privateInput.message);
        assert.equal('negotiationHistory' in JSON.parse(request.input), false);
        assert.match(request.systemInstruction, /確認・編集して許可/);
        return decision({ reply: '公開用の下書きPRIVATE。本人確認前は非公開です。' });
    } });
    assert.equal(privateReply.action, 'HEARING');
    assert.deepEqual(privateInput, privateBefore);
    // ここからは本人が編集・許可し、BEが共有記録として検証した内容だけを渡す。
    const approved = { ...input().sharedConditions[0], content: '組み立てて遊べる工作キットを希望する。' };
    await createReply({ ...privateInput, mode: 'negotiation', message: 'この希望で相談したい。',
        sharedConditions: [approved] }, { generate: async request => {
        const payload = JSON.parse(request.input);
        assert.equal(request.input.includes('PRIVATE'), false);
        assert.deepEqual(payload.sharedConditions, [{ content: approved.content }]);
        assert.equal(payload.message, 'この希望で相談したい。');
        return decision();
    } });
});

const publicMessage = { id: 'public-1', sender: 'child', content: '公開した希望', createdAt: NOW };
for (const [label, changes] of [
    ['共有履歴なし', { negotiationHistory: undefined }],
    ['共有履歴の旧sender', { negotiationHistory: [{ ...publicMessage, sender: 'user' }] }],
    ['共有履歴にsystem指示', { negotiationHistory: [{ ...publicMessage, sender: 'system' }] }],
    ['共有履歴が過大', { negotiationHistory: Array(41).fill(publicMessage) }],
    ['共有履歴ID重複', { negotiationHistory: [publicMessage, publicMessage] }],
    ['共有履歴が未来', { negotiationHistory: [{ ...publicMessage, createdAt: '2026-10-24T00:00:00+09:00' }] }],
    ['共有履歴が逆順', { negotiationHistory: [publicMessage, { ...publicMessage, id: 'older', createdAt: '2026-10-22T00:00:00+09:00' }] }],
    ['個別相談に共有履歴が混在', { mode: 'consultation', negotiationHistory: [publicMessage] }],
] as const) {
    test(`共有会話の不正な入力を通信前に止める：${label}`, async () => {
        await assert.rejects(createReply({ ...input(), ...changes } as AIInput,
            { generate: async () => assert.fail('must not call model') }), hasCode('INVALID_INPUT'));
    });
}


test('個別相談で検索→商品選択ボタン→交渉IDなしの初回提案を作成できる', async () => {
    const privateInput: AIInput = { ...input(), mode: 'consultation', sharedConditions: [] };
    const found = await createReply(privateInput, { generate: searchQueue([SEARCH(), grounded(), extraction()]), createId: () => product.id });
    if (found.action !== 'PRODUCT') return assert.fail('expected products');
    const selected: AIInput = { ...privateInput, message: null, products: found.products, selectedProductId: product.id };
    const draftResult = await createReply(selected, { generate: async request => {
        assert.equal(JSON.parse(request.input).message, null);
        return draft();
    } });
    if (draftResult.action !== 'PROPOSAL') return assert.fail('expected proposal');
    assert.equal(draftResult.proposalDraft.target, 'parent');
    assert.equal(draftResult.proposalDraft.basedOn, null);
    const savedDraft: Proposal = { ...proposal, negotiationId: null, version: 1, status: 'draft' };
    const revised = await createReply({ ...selected, currentProposal: savedDraft }, { generate: async () => draft() });
    if (revised.action !== 'PROPOSAL') return assert.fail('expected private proposal');
    assert.deepEqual(revised.proposalDraft.basedOn, { proposalId: savedDraft.id, version: 1 });
});

test('親のYesボタンでは交渉もGemini呼び出しも行わない', async () => {
    const value: AIInput = { ...input(), mode: 'consultation', role: 'parent', message: null,
        history: [], profile: null, products: [product], currentProposal: { ...proposal, negotiationId: null },
        negotiationResult: { proposalId: proposal.id, version: proposal.version, decision: 'approved', reason: null } };
    const before = structuredClone(value);
    const output = await createReply(value, { generate: async () => assert.fail('approved must skip Gemini') });
    assert.equal(output.action, 'HEARING');
    assert.equal('proposalDraft' in output, false);
    assert.equal('status' in output, false);
    assert.deepEqual(value, before);
});

test('親のNoボタンは発言なしでも理由を共有交渉へ渡し、個別相談は混ぜない', async () => {
    const value: AIInput = { ...input(), role: 'parent', message: null, products: [product], currentProposal: proposal,
        negotiationResult: { proposalId: proposal.id, version: proposal.version, decision: 'rejected', reason: '宿題は3日ならよい。' } };
    const output = await createReply(value, { generate: async request => {
        const payload = JSON.parse(request.input);
        assert.equal(payload.message, null);
        assert.deepEqual(payload.negotiationResult, value.negotiationResult);
        assert.equal('history' in payload, false);
        assert.equal('profile' in payload, false);
        return draft({ action: 'NEGOTIATION', purchaseConditions: ['宿題を3日提出する'] });
    } });
    if (output.action !== 'NEGOTIATION') return assert.fail('expected negotiation');
    assert.equal(output.proposalDraft?.target, 'child');
    assert.deepEqual(output.proposalDraft?.basedOn, { proposalId: proposal.id, version: proposal.version });
});

test('発言なしの共有交渉でも、選択済み商品と対象提案から修正下書きを作れる', async () => {
    const output = await createReply({ ...input(), message: null, products: [product],
        selectedProductId: product.id, currentProposal: proposal }, { generate: async () => draft({ action: 'NEGOTIATION' }) });
    assert.equal(output.action, 'NEGOTIATION');
});

test('発言も操作対象もない入力は通信前に拒否する', async () => {
    for (const mode of ['consultation', 'negotiation'] as const) {
        await assert.rejects(createReply({ ...input(), mode, message: null }, {
            generate: async () => assert.fail('must not call model'),
        }), hasCode('INVALID_INPUT'));
    }
});

test('個別相談の価格未確認・条件不適合でも交渉には移行しない', async () => {
    for (const changes of [
        { products: [{ ...product, priceJpy: null }] },
        { products: [product], rewardGuidelines: { ...input().rewardGuidelines, mediumJpy: null } },
    ]) {
        const output = await createReply({ ...input(), mode: 'consultation', message: null,
            selectedProductId: product.id, ...changes }, { generate: async () => draft() });
        assert.equal(output.action, 'HEARING');
        assert.equal('proposalDraft' in output, false);
    }
});

test('explicit product search skips hearing and uses only the supplied public query', async () => {
    const requests: ConversationRequest[] = [];
    const result = await createReply({ ...input(), mode: 'consultation', searchQuery: 'Switch スプラトゥーン' }, {
        generate: searchQueue([grounded(), extraction()], requests), createId: () => product.id,
    });
    assert.equal(result.action, 'PRODUCT');
    assert.equal(requests.length, 2);
    assert.equal(requests[0].search, true);
    const payload = JSON.parse(requests[0].input);
    assert.equal(payload.query, 'Switch スプラトゥーン');
    assert.equal(payload.history, undefined);
    assert.equal(payload.profile, undefined);
});

test('parent and target child ages remain distinct in individual consultation', async () => {
    let payload: any;
    await createReply({ ...input(), mode: 'consultation', role: 'parent', childContext: { age: 9, gradeLevel: 4 } }, {
        generate: async request => { payload = JSON.parse(request.input); return decision(); },
    });
    assert.deepEqual(payload.childContext, { age: 9, gradeLevel: 4 });
    assert.deepEqual(payload.profile.age, input().profile?.age);
});


test('standalone chore requests point to Home without starting an AI hearing',async()=>{
 for(const role of ['parent','child'] as const){
  const result=await createReply({...input(),mode:'consultation',role,message:role==='parent'?'子どもに洗濯物を干してとお願いしたい':'お手伝いの完了を報告したい'},{generate:async()=>{throw Error('must not call AI for a Home operation');}});
  assert.equal(result.action,'HEARING');assert.match(result.reply,/ホーム/);assert.doesNotMatch(result.reply,/[？?]/);
 }
});

test('chore terms in a product negotiation remain valid conversation content',async()=>{
 let called=false;
 await createReply({...input(),message:'商品の購入条件として洗濯物を干すお手伝いをしたい'},{generate:async()=>{called=true;return decision();}});
 assert.equal(called,true);
});
