import type { AIInput, AIUserProfile, ChatMessage, NegotiationMessage, ProductCandidate, Proposal, SharedCondition, NegotiationResult } from '../shared/types.ts';
import { ConversationError } from './errors.ts';

function invalid(field: string): never {
    throw new ConversationError('INVALID_INPUT', `${field}の形式が正しくありません。`);
}

export function record(value: unknown, field: string): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(field);
    return value as Record<string, unknown>;
}

export function text(value: unknown, field: string, max = 4000): string {
    if (typeof value !== 'string' || !value.trim() || value.length > max) invalid(field);
    return value.trim();
}

export function date(value: unknown, field: string): string {
    const result = text(value, field, 40);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(result)
        || !Number.isFinite(Date.parse(result))) invalid(field);
    if (new Date(`${result.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== result.slice(0, 10)) invalid(field);
    return result;
}

export function list<T>(value: unknown, field: string, parse: (item: unknown, field: string) => T, max = 40): T[] {
    if (!Array.isArray(value) || value.length > max) invalid(field);
    return value.map((item, index) => parse(item, `${field}[${index}]`));
}

function money(value: unknown, field: string): number | null {
    if (value === null) return null;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid(field);
    return value;
}

/** 公開HTTPSリンクだけを許可。リンクへのサーバー側fetchは行わない。 */
export function publicUrl(value: unknown): string | null {
    if (typeof value !== 'string' || value.length > 4096) return null;
    try {
        const url = new URL(value);
        const host = url.hostname.toLowerCase();
        if (url.protocol !== 'https:' || url.username || url.password || url.port
            || !host.includes('.') || /^[\d.]+$/.test(host) || host.includes(':')
            || /(^|\.)(localhost|local|internal|test|invalid|example|example\.com|example\.org|example\.net)$/.test(host)) return null;
        url.hash = '';
        return url.href;
    } catch { return null; }
}

function url(value: unknown, field: string): string {
    const result = publicUrl(value);
    if (!result) invalid(field);
    return result;
}

function chatMessage(value: unknown, field: string): ChatMessage {
    const item = record(value, field);
    if (item.sender !== 'user' && item.sender !== 'assistant') invalid(`${field}.sender`);
    return {
        id: text(item.id, `${field}.id`, 128), sender: item.sender,
        content: text(item.content, `${field}.content`), createdAt: date(item.createdAt, `${field}.createdAt`),
    };
}

function negotiationMessage(value: unknown, field: string): NegotiationMessage {
    const item = record(value, field);
    if (item.sender !== 'parent' && item.sender !== 'child' && item.sender !== 'assistant') invalid(`${field}.sender`);
    return {
        id: text(item.id, `${field}.id`, 128), sender: item.sender,
        content: text(item.content, `${field}.content`), createdAt: date(item.createdAt, `${field}.createdAt`),
    };
}

function profile(value: unknown, field: string): AIUserProfile | null {
    if (value === null) return null;
    const item = record(value, field);
    if (item.age !== null && (typeof item.age !== 'number' || !Number.isInteger(item.age) || item.age < 0 || item.age > 120)) invalid(`${field}.age`);
    if (item.gender !== null && !['male', 'female', 'other'].includes(item.gender as string)) invalid(`${field}.gender`);
    const preferences = record(item.preferences, `${field}.preferences`);
    const strings = (key: string) => list(preferences[key], `${field}.preferences.${key}`, (v, f) => text(v, f, 300), 12);
    return { age: item.age as number | null, gender: item.gender as AIUserProfile['gender'],
        preferences: { interests: strings('interests'), wishes: strings('wishes'), expectations: strings('expectations') } };
}

function goalSize(value: unknown, field: string): ProductCandidate['size'] {
    if (value !== 'small' && value !== 'medium' && value !== 'large') invalid(field);
    return value;
}

function product(value: unknown, field: string): ProductCandidate {
    const item = record(value, field);
    const sourceUrls = list(item.sourceUrls, `${field}.sourceUrls`, url, 10);
    const productUrl = url(item.productUrl, `${field}.productUrl`);
    if (sourceUrls.length === 0 || !sourceUrls.includes(productUrl)) invalid(`${field}.sourceUrls`);
    return {
        size: goalSize(item.size, `${field}.size`),
        id: text(item.id, `${field}.id`, 128), name: text(item.name, `${field}.name`, 300),
        priceJpy: money(item.priceJpy, `${field}.priceJpy`), productUrl,
        imageUrl: item.imageUrl == null ? null : url(item.imageUrl, `${field}.imageUrl`),
        priceCheckedAt: item.priceCheckedAt == null ? null : date(item.priceCheckedAt, `${field}.priceCheckedAt`),
        description: text(item.description, `${field}.description`, 1000),
        recommendationReason: text(item.recommendationReason, `${field}.recommendationReason`, 1000), sourceUrls,
    };
}

function proposal(value: unknown): Proposal | null {
    if (value === null) return null;
    const item = record(value, 'currentProposal');
    if (typeof item.version !== 'number' || !Number.isSafeInteger(item.version) || item.version < 1) invalid('currentProposal.version');
    if (!['draft', 'pending', 'rejected', 'agreed', 'superseded'].includes(item.status as string)) invalid('currentProposal.status');
    return {
        id: text(item.id, 'currentProposal.id', 128), negotiationId: item.negotiationId === null ? null : text(item.negotiationId, 'currentProposal.negotiationId', 128),
        productId: text(item.productId, 'currentProposal.productId', 128), version: item.version,
        persuasionText: text(item.persuasionText, 'currentProposal.persuasionText'),
        purchaseConditions: list(item.purchaseConditions, 'currentProposal.purchaseConditions', (v, f) => text(v, f, 500), 12),
        status: item.status as Proposal['status'],
    };
}

function sharedCondition(value: unknown, field: string): SharedCondition {
    const item = record(value, field);
    return {
        id: text(item.id, `${field}.id`, 128),
        sourceUserId: text(item.sourceUserId, `${field}.sourceUserId`, 128),
        targetUserId: text(item.targetUserId, `${field}.targetUserId`, 128),
        content: text(item.content, `${field}.content`),
        approvedAt: date(item.approvedAt, `${field}.approvedAt`),
    };
}

function negotiationResult(value: unknown): NegotiationResult | null {
    if (value === null) return null;
    const item = record(value, 'negotiationResult');
    if (typeof item.version !== 'number' || !Number.isSafeInteger(item.version) || item.version < 1) invalid('negotiationResult.version');
    const reference = { proposalId: text(item.proposalId, 'negotiationResult.proposalId', 128), version: item.version };
    if (item.decision === 'approved') return { ...reference, decision: 'approved',
        reason: item.reason === null ? null : text(item.reason, 'negotiationResult.reason') };
    if (item.decision !== 'rejected' && item.decision !== 'revision_requested') invalid('negotiationResult.decision');
    return { ...reference, decision: item.decision, reason: text(item.reason, 'negotiationResult.reason') };
}

/** 必要な項目だけを新しいオブジェクトへ詰め替える。認証・家族関係はバックエンドが保証する。 */
export function parseAIInput(value: unknown): AIInput {
    const input = record(value, 'input');
    if (input.role !== 'parent' && input.role !== 'child') invalid('role');
    if (input.mode !== 'consultation' && input.mode !== 'negotiation') invalid('mode');
    const constraints = record(input.constraints, 'constraints');
    const guidelines = record(input.rewardGuidelines, 'rewardGuidelines');
    const result: AIInput = {
        requestId: text(input.requestId, 'requestId', 128), now: date(input.now, 'now'),
        role: input.role, message: input.message === null ? null : text(input.message, 'message'),
        mode: input.mode,
        history: list(input.history, 'history', chatMessage),
        negotiationHistory: list(input.negotiationHistory, 'negotiationHistory', negotiationMessage),
        profile: profile(input.profile, 'profile'),
        sharedConditions: list(input.sharedConditions, 'sharedConditions', sharedCondition),
        constraints: {
            mustHave: list(constraints.mustHave, 'constraints.mustHave', (v, f) => text(v, f, 300), 12),
            mustAvoid: list(constraints.mustAvoid, 'constraints.mustAvoid', (v, f) => text(v, f, 300), 12),
        },
        rewardGuidelines: {
            smallJpy: money(guidelines.smallJpy, 'rewardGuidelines.smallJpy'),
            mediumJpy: money(guidelines.mediumJpy, 'rewardGuidelines.mediumJpy'),
            largeJpy: money(guidelines.largeJpy, 'rewardGuidelines.largeJpy'),
        },
        products: list(input.products, 'products', product, 20),
        selectedProductId: input.selectedProductId === null ? null : text(input.selectedProductId, 'selectedProductId', 128),
        currentProposal: proposal(input.currentProposal),
        negotiationResult: negotiationResult(input.negotiationResult),
    };
    if (input.searchQuery !== undefined) {
        if (result.mode !== 'consultation') invalid('searchQuery');
        result.searchQuery = text(input.searchQuery, 'searchQuery', 300);
    }
    if (input.childContext !== undefined && result.mode === 'consultation') {
        const child = record(input.childContext, 'childContext');
        for (const [key, max] of [['age', 120], ['gradeLevel', 12]] as const) {
            const n = child[key];
            if (n !== null && (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > max)) invalid(`childContext.${key}`);
        }
        result.childContext = { age: child.age as number | null, gradeLevel: child.gradeLevel as number | null };
    }
    if (result.message === null && !result.selectedProductId && !result.currentProposal && !result.negotiationResult) invalid('message');
    if (result.mode === 'consultation' && result.negotiationHistory.length) invalid('negotiationHistory');
    if (new Set(result.negotiationHistory.map(item => item.id)).size !== result.negotiationHistory.length) invalid('negotiationHistory.id');
    if (result.negotiationHistory.some((item, index, items) => Date.parse(item.createdAt) > Date.parse(result.now)
        || (index > 0 && Date.parse(item.createdAt) < Date.parse(items[index - 1].createdAt)))) invalid('negotiationHistory.createdAt');
    const ids = new Set(result.products.map(p => p.id));
    if (ids.size !== result.products.length) invalid('products.id');
    if (result.selectedProductId !== null && !ids.has(result.selectedProductId)) invalid('selectedProductId');
    if (result.currentProposal && !ids.has(result.currentProposal.productId)) invalid('currentProposal.productId');
    if (new Set(result.sharedConditions.map(item => item.id)).size !== result.sharedConditions.length) invalid('sharedConditions.id');
    if (result.sharedConditions.some(item => Date.parse(item.approvedAt) > Date.parse(result.now))) invalid('sharedConditions.approvedAt');
    if (result.negotiationResult && (!result.currentProposal
        || result.negotiationResult.proposalId !== result.currentProposal.id
        || result.negotiationResult.version !== result.currentProposal.version)) invalid('negotiationResult.reference');
    return result;
}
