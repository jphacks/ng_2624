// 手元で試すための仮サーバー。本番では supabase/functions/ai-reply を使う。
// ログインは省き、会話はこのサーバーのメモリに持つ（再起動で消える）。
//
// 起動（プロジェクトのルートで）: node --env-file=.env frontend/dev-server.ts
// 開く: http://127.0.0.1:5173
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createReply } from '../src/ai/index.ts';
import type { AIInput, ChatMessage, ProductCandidate } from '../Sample_db/types.ts';

const PORT = 5173;
const HOST = '127.0.0.1';

// 試作用の固定値。本番では保護者の設定（user_preferences の budget_*）から取る。
const REWARD_GUIDELINES = { smallJpy: 1000, mediumJpy: 3000, largeJpy: 10000 };

const STATIC_FILES: Record<string, [file: string, type: string]> = {
  '/': ['index.html', 'text/html'],
  '/index.html': ['index.html', 'text/html'],
  '/app.js': ['app.js', 'text/javascript'],
  '/data.js': ['data.js', 'text/javascript'],
  '/style.css': ['style.css', 'text/css'],
};

let history: ChatMessage[] = [];
let products: ProductCandidate[] = [];
let busy = false;

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16 * 1024) throw new Error('too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const ERROR_STATUS: Record<string, number> = {
  INVALID_INPUT: 400, RATE_LIMIT: 429, TIMEOUT: 504, MISSING_API_KEY: 503,
};

async function chat(req: IncomingMessage, res: ServerResponse) {
  let message: unknown;
  try { message = (await readJson(req) as { message?: unknown })?.message; }
  catch { return send(res, 400, { error: '送信内容を読み取れませんでした' }); }
  if (typeof message !== 'string' || !message.trim() || message.length > 4000) {
    return send(res, 400, { error: 'メッセージが空か、長すぎます' });
  }
  if (busy) return send(res, 409, { error: '前の返事を待っています' });

  busy = true;
  const now = new Date().toISOString();
  const input: AIInput = {
    requestId: randomUUID(), now, role: 'child', mode: 'consultation',
    message: message.trim(), history, negotiationHistory: [], profile: null,
    sharedConditions: [], constraints: { mustHave: [], mustAvoid: [] },
    rewardGuidelines: REWARD_GUIDELINES,
    products, selectedProductId: null, currentProposal: null, negotiationResult: null,
  };

  try {
    const output = await createReply(input);
    history = [
      ...history,
      { id: randomUUID(), sender: 'user' as const, content: input.message!, createdAt: now },
      { id: randomUUID(), sender: 'assistant' as const, content: output.reply, createdAt: new Date().toISOString() },
    ].slice(-40);
    if (output.action === 'PRODUCT') products = output.products;
    console.log(`[${output.action}] ${output.action === 'PRODUCT' ? output.products.map(p => p.name).join(' / ') : ''}`);
    send(res, 200, output);
  } catch (error) {
    const code = (error as { code?: string }).code ?? '';
    const text = error instanceof Error && code ? error.message : 'AIの処理に失敗しました';
    console.error(`[error] ${code || 'UNKNOWN'} ${text}`);
    send(res, ERROR_STATUS[code] ?? 502, { error: text });
  } finally {
    busy = false;
  }
}

createServer(async (req, res) => {
  // 他のサイトからこのサーバーを操作されないよう、ホスト名を確認する
  if (req.headers.host !== `${HOST}:${PORT}` && req.headers.host !== `localhost:${PORT}`) {
    res.writeHead(403).end();
    return;
  }
  const path = new URL(req.url ?? '/', `http://${HOST}`).pathname;

  if (req.method === 'POST' && path === '/api/chat') return chat(req, res);
  if (req.method === 'POST' && path === '/api/reset') {
    history = [];
    products = [];
    return send(res, 200, { ok: true });
  }

  const entry = STATIC_FILES[path];
  if (req.method === 'GET' && entry) {
    const body = await readFile(new URL(`./${entry[0]}`, import.meta.url));
    res.writeHead(200, { 'Content-Type': `${entry[1]}; charset=utf-8`, 'Cache-Control': 'no-store' });
    res.end(body);
    return;
  }
  res.writeHead(404).end();
}).listen(PORT, HOST, () => {
  console.log(`試作サーバーを起動しました: http://${HOST}:${PORT}`);
  if (!process.env.GEMINI_API_KEY) console.log('注意: .env の GEMINI_API_KEY が空です');
});
