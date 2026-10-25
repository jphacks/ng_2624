import { GoogleGenAI } from '@google/genai';
import type { Interactions } from '@google/genai';
import type { SearchMetadata } from '../../Sample_db/types.ts';
import { ConversationError } from './errors.ts';
import type { ConversationRequest } from './prompt.ts';
import { publicUrl } from './validation.ts';

export const CONVERSATION_MODEL = 'gemini-3.5-flash-lite';
export const REQUEST_TIMEOUT_MS = 30_000;
export interface GenerationResult {
    text: string;
    search: SearchMetadata | null;
    /** 出典ごとの引用対象テキスト。内部の価格検証にだけ使う。 */
    evidence: Record<string, string[]>;
}
export type ReplyGenerator = (request: ConversationRequest) => Promise<GenerationResult>;
export interface GeminiOptions {
    apiKey?: string;
    model?: string;
    searchModel?: string;
}

function environment(name: string): string | undefined {
    const runtime = globalThis as typeof globalThis & {
        process?: { env: Record<string, string | undefined> };
        Deno?: { env: { get(name: string): string | undefined } };
    };
    return runtime.process?.env[name] ?? runtime.Deno?.env.get(name);
}

/** Edge Functionsではサーバー側の環境変数を明示注入することもできる。 */
export function createGeminiGenerator(options: GeminiOptions): ReplyGenerator {
    return request => generateGeminiReply(request, options.apiKey, options);
}

/** SDKの出典だけを採用し、本文に書かれただけのURLを根拠扱いしない。 */
export function readGrounding(result: Interactions.Interaction): Pick<GenerationResult, 'search' | 'evidence'> {
    const sources: SearchMetadata['sources'] = [];
    const queries = new Set<string>();
    const suggestions: string[] = [];
    const evidence: Record<string, string[]> = {};
    for (const step of result.steps ?? []) {
        if (step.type === 'google_search_call') {
            for (const query of step.arguments.queries ?? []) queries.add(query);
        }
        if (step.type === 'google_search_result' && !step.is_error) {
            for (const item of step.result) if (item.search_suggestions) suggestions.push(item.search_suggestions);
        }
        if (step.type !== 'model_output') continue;
        for (const block of step.content ?? []) {
            if (block.type !== 'text') continue;
            for (const annotation of block.annotations ?? []) {
                if (annotation.type !== 'url_citation') continue;
                const url = publicUrl(annotation.url);
                if (!url) continue;
                let source = sources.find(s => s.url === url);
                if (!source) {
                    source = { id: `source-${sources.length + 1}`, url, title: annotation.title || new URL(url).hostname };
                    sources.push(source);
                }
                // Interactions APIのstart/endはUTF-8バイト単位。日本語を文字位置で切らない。
                const bytes = new TextEncoder().encode(block.text);
                if (annotation.start_index !== undefined && annotation.end_index !== undefined
                    && annotation.start_index >= 0 && annotation.end_index > annotation.start_index
                    && annotation.end_index <= bytes.length) {
                    (evidence[source.id] ??= []).push(new TextDecoder().decode(bytes.slice(annotation.start_index, annotation.end_index)));
                }
            }
        }
    }
    return {
        search: { queries: [...queries], sources, searchSuggestionsHtml: suggestions.length ? suggestions.join('\n') : null },
        evidence,
    };
}

/** import時には通信しない。既存のInteractions APIとモデルを維持する。 */
export async function generateGeminiReply(
    request: ConversationRequest,
    apiKey: string | undefined = environment('GEMINI_API_KEY'),
    options: GeminiOptions = {},
): Promise<GenerationResult> {
    if (!apiKey?.trim()) throw new ConversationError('MISSING_API_KEY', 'GEMINI_API_KEYが設定されていません。');
    request.signal?.throwIfAborted();
    const timeoutMs = Math.min(request.timeoutMs ?? REQUEST_TIMEOUT_MS, REQUEST_TIMEOUT_MS);
    const ai = new GoogleGenAI({ apiKey });
    const result = await ai.interactions.create({
        model: (request.search ? options.searchModel || environment('GEMINI_SEARCH_MODEL') : undefined)
            || options.model || environment('GEMINI_MODEL') || CONVERSATION_MODEL,
        input: request.input, system_instruction: request.systemInstruction, store: false,
        ...(request.maxOutputTokens ? { generation_config: { max_output_tokens: request.maxOutputTokens } } : {}),
        ...(request.search ? { tools: [{ type: 'google_search' as const }] } : {}),
        ...(request.schema ? { response_format: { type: 'text' as const, mime_type: 'application/json', schema: request.schema } } : {}),
    }, { timeout_ms: timeoutMs, retries: { strategy: 'none' },
        ...(request.signal ? { signal: AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]) } : {}),
    });
    if (result.status !== 'completed') throw new ConversationError('API_ERROR', 'AIの処理が完了しませんでした。もう一度お試しください。');
    if (!result.output_text?.trim()) throw new ConversationError('EMPTY_RESPONSE', 'Geminiから返答がありませんでした。');
    return { text: result.output_text, ...(request.search ? readGrounding(result) : { search: null, evidence: {} }) };
}
