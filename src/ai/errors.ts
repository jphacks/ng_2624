export type ConversationErrorCode =
    | 'INVALID_INPUT'
    | 'INVALID_RESPONSE'
    | 'MISSING_API_KEY'
    | 'RATE_LIMIT'
    | 'TIMEOUT'
    | 'EMPTY_RESPONSE'
    | 'API_ERROR';

// モジュール内部の区分。HTTPレスポンスの形式はバックエンドと別途決める。
export class ConversationError extends Error {
    readonly code: ConversationErrorCode;

    constructor(code: ConversationErrorCode, message: string) {
        super(message);
        this.name = 'ConversationError';
        this.code = code;
    }
}

export function toConversationError(error: unknown): ConversationError {
    if (error instanceof ConversationError) return error;

    const details = error !== null && typeof error === 'object'
        ? error as Record<string, unknown>
        : {};
    const status = details.status ?? details.statusCode ?? details.code;
    const name = typeof details.name === 'string' ? details.name : '';

    if (status === 429 || status === 'RESOURCE_EXHAUSTED') {
        return new ConversationError('RATE_LIMIT', 'AIの利用上限に達しました。時間を置いて再度お試しください。');
    }
    if (
        status === 408 || status === 504 || status === 'ETIMEDOUT' || status === 'DEADLINE_EXCEEDED'
        || ['TimeoutError', 'AbortError', 'RequestTimeoutError', 'APIConnectionTimeoutError'].includes(name)
    ) {
        return new ConversationError('TIMEOUT', 'AIの応答が時間内に届きませんでした。再度お試しください。');
    }

    // SDKの生のエラーにはリクエスト情報が含まれ得るため、そのまま表示しない。
    return new ConversationError('API_ERROR', 'AIとの通信に失敗しました。接続状況を確認してください。');
}
