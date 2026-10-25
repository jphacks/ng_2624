import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHttpServer } from '../src/server/http.ts';
import { prepareProduct, fetchResolvedProductImage } from '../src/server/preview.ts';
import { createReply, createGeminiGenerator, searchAmazon } from '../src/ai/index.ts';
import { createDemo, readDemoConfig } from './app.ts';
const require = createRequire(import.meta.url);
const QRCode = require('qrcode') as { toDataURL: (url: string, options: object) => Promise<string> };
const config = readDemoConfig();
const demo = await createDemo(config, {
  ai: (input, onSearchStart) => createReply(input, { onSearchStart, generate: createGeminiGenerator({ apiKey: config.geminiKey }), search: searchAmazon }),
  enrich: prepareProduct,
  image: fetchResolvedProductImage,
  qr: url => QRCode.toDataURL(url, { width: 260, margin: 2, errorCorrectionLevel: 'M' }),
});
const server = createHttpServer(config, demo.app, {
  '/demo': [fileURLToPath(new URL('./index.html', import.meta.url)), 'text/html; charset=utf-8'],
  '/demo.js': [fileURLToPath(new URL('./client.js', import.meta.url)), 'text/javascript; charset=utf-8'],
});
// Guard static files as well as API requests against DNS rebinding and nonlocal access.
const handlers = server.listeners('request');
server.removeAllListeners('request');
server.on('request', (request, response) => {
  if (request.headers.host !== new URL(config.origin).host || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress || '')) { response.writeHead(403); response.end('Local demo only'); return; }
  for (const handler of handlers) handler.call(server, request, response);
});
server.listen(config.port, '127.0.0.1', () => console.log(`ローカルデモ: ${config.origin}/demo`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { server.close(() => { void demo.close().then(() => { process.exitCode = 0; }); }); server.closeIdleConnections(); });
