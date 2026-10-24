import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createApp } from './app.ts';
import { createDB, readConfig } from './core.ts';
import { enrichProduct, fetchProductImage, resolveAmazonProductUrl } from './preview.ts';
import { createReply, createGeminiGenerator } from '../ai/index.ts';
const require = createRequire(import.meta.url);
const QRCode = require('qrcode') as { toDataURL: (url: string, options: object) => Promise<string> };
const config = readConfig();
const app = createApp(config, { db: createDB(config), ai: input => createReply(input, { generate: createGeminiGenerator({ apiKey: config.geminiKey }) }), enrich: async product => { const productUrl = await resolveAmazonProductUrl(product.productUrl); return productUrl ? enrichProduct({ ...product, productUrl }) : null; }, image: fetchProductImage, qr: url => QRCode.toDataURL(url, { width: 260, margin: 2, errorCorrectionLevel: 'M' }) });
const frontend = new URL('../../frontend/', import.meta.url);
const staticFiles: Record<string, [string, string]> = { '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'], '/pairing': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/api.js': ['api.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'], '/images/popo-doves.png': ['images/popo-doves.png', 'image/png'] };
const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'; object-src 'none'");
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  try {
    const url = new URL(req.url || '/', config.origin);
    if (!url.pathname.startsWith('/api/')) {
      const file = staticFiles[url.pathname];
      if (!file || !['GET', 'HEAD'].includes(req.method || '')) { res.writeHead(404); res.end('Not found'); return; }
      const content = await readFile(fileURLToPath(new URL(file[0], frontend)));
      res.setHeader('Content-Type', file[1]); res.setHeader('Cache-Control', 'no-cache'); res.writeHead(200); res.end(req.method === 'HEAD' ? undefined : content); return;
    }
    let size = 0; const chunks: Buffer[] = [];
    for await (const chunk of req) { size += chunk.length; if (size > 32768) { res.writeHead(413); res.end('Payload too large'); return; } chunks.push(chunk); }
    const headers = new Headers(); for (const [k, v] of Object.entries(req.headers)) { if (Array.isArray(v)) v.forEach(x => headers.append(k, x)); else if (v !== undefined) headers.set(k, v); }
    const body = Buffer.concat(chunks);
    const response = await app(new Request(url, { method: req.method, headers, ...(body.length && !['GET', 'HEAD'].includes(req.method || '') ? { body } : {}) }), req.socket.remoteAddress || 'unknown');
    for (const [k, v] of response.headers) if (k !== 'set-cookie') res.setHeader(k, v);
    const setCookies = response.headers.getSetCookie(); if (setCookies.length) res.setHeader('Set-Cookie', setCookies);
    res.writeHead(response.status); res.end(Buffer.from(await response.arrayBuffer()));
  } catch { if (!res.headersSent) res.writeHead(500); res.end('Server error'); }
});
server.requestTimeout = 180000; server.headersTimeout = 15000;
server.listen(config.port, process.env.HOST || '127.0.0.1', () => console.log(`ふぁみぽぽ: ${config.origin}`));
