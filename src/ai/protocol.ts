import { ConversationError } from './errors.ts';
import { list, record, text } from './validation.ts';

export type JsonSchema = Record<string, unknown>;
export interface Decision {
    action: 'HEARING' | 'SEARCH' | 'PROPOSAL' | 'NEGOTIATION';
    reply: string;
    searchQuery: string | null;
    persuasionText: string | null;
    purchaseConditions: string[];
    constraintsSatisfied: boolean;
}
export interface ExtractedProduct {
    name: string;
    description: string;
    recommendationReason: string;
    productSourceId: string;
    sourceIds: string[];
    priceJpy: number | null;
    priceEvidence: string | null;
}

const string = { type: 'string' };
const nullableString = { type: ['string', 'null'] };
export const DECISION_SCHEMA: JsonSchema = {
    type: 'object', additionalProperties: false,
    properties: {
        action: { type: 'string', enum: ['HEARING', 'SEARCH', 'PROPOSAL', 'NEGOTIATION'] },
        reply: string, searchQuery: nullableString, persuasionText: nullableString,
        purchaseConditions: { type: 'array', items: string, maxItems: 12 },
        constraintsSatisfied: { type: 'boolean' },
    },
    required: ['action', 'reply', 'searchQuery', 'persuasionText', 'purchaseConditions', 'constraintsSatisfied'],
};
export const PRODUCTS_SCHEMA: JsonSchema = {
    type: 'object', additionalProperties: false,
    properties: { products: { type: 'array', maxItems: 12, items: {
        type: 'object', additionalProperties: false,
        properties: {
            name: string, description: string, recommendationReason: string,
            productSourceId: string, sourceIds: { type: 'array', items: string, minItems: 1, maxItems: 10 },
            priceJpy: { type: ['integer', 'null'], minimum: 0 }, priceEvidence: nullableString,
        },
        required: ['name', 'description', 'recommendationReason', 'productSourceId', 'sourceIds', 'priceJpy', 'priceEvidence'],
    } } }, required: ['products'],
};

function parse<T>(raw: string, convert: (value: unknown) => T): T {
    try { return convert(JSON.parse(raw)); }
    catch {
        throw new ConversationError('INVALID_RESPONSE', 'AIの応答形式を確認できませんでした。もう一度お試しください。');
    }
}
export function parseDecision(raw: string): Decision {
    return parse(raw, value => {
        const item = record(value, 'decision');
        if (!['HEARING', 'SEARCH', 'PROPOSAL', 'NEGOTIATION'].includes(item.action as string)
            || typeof item.constraintsSatisfied !== 'boolean') throw new Error('invalid decision');
        const result: Decision = {
            action: item.action as Decision['action'], reply: text(item.reply, 'reply'),
            searchQuery: item.searchQuery === null ? null : text(item.searchQuery, 'searchQuery', 300),
            persuasionText: item.persuasionText === null ? null : text(item.persuasionText, 'persuasionText'),
            purchaseConditions: list(item.purchaseConditions, 'purchaseConditions', (v, f) => text(v, f, 500), 12),
            constraintsSatisfied: item.constraintsSatisfied,
        };
        if (result.action === 'SEARCH' && !result.searchQuery) throw new Error('missing query');
        if (result.action === 'PROPOSAL' && !result.persuasionText) throw new Error('missing draft');
        return result;
    });
}
export function parseProducts(raw: string): ExtractedProduct[] {
    return parse(raw, value => list(record(value, 'result').products, 'products', (v, f) => {
        const item = record(v, f);
        if (item.priceJpy !== null && (typeof item.priceJpy !== 'number' || !Number.isSafeInteger(item.priceJpy) || item.priceJpy < 0)) throw new Error('invalid price');
        return {
            name: text(item.name, `${f}.name`, 300), description: text(item.description, `${f}.description`, 1000),
            recommendationReason: text(item.recommendationReason, `${f}.recommendationReason`, 1000),
            productSourceId: text(item.productSourceId, `${f}.productSourceId`, 128),
            sourceIds: list(item.sourceIds, `${f}.sourceIds`, (v, f) => text(v, f, 128), 10),
            priceJpy: item.priceJpy as number | null,
            priceEvidence: item.priceEvidence === null ? null : text(item.priceEvidence, `${f}.priceEvidence`, 1000),
        };
    }, 12));
}
