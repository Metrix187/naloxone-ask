// Local dev server: serves public/ and POST /api/ask. No dependencies.
//   npm start                  (reads .env.local if present)
//   FORCE_OFFLINE=1 npm start  (demo the fallback without calling the API)

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleAsk } from './lib/handler.js';
import { loadConfig } from './lib/config.js';

const root = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const PORT = Number(process.env.PORT || 8787);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'self'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

const cfg = loadConfig(); // throws at startup if a non-Standard model is configured

async function readBody(req, limit = 2_200_000) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('too large'), { status: 413 });
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/ask' && req.method === 'POST') {
      const body = await readBody(req);
      const { status, json } = await handleAsk(body, { ip: req.socket.remoteAddress });
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
      return res.end(JSON.stringify(json));
    }
    if (req.method !== 'GET') {
      res.writeHead(405);
      return res.end();
    }
    const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^(\.\.[/\\])+/, '');
    const file = join(root, rel);
    if (!file.startsWith(root)) {
      res.writeHead(403);
      return res.end();
    }
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...SECURITY_HEADERS });
    res.end(data);
  } catch (err) {
    const status = err.status || (err.code === 'ENOENT' ? 404 : err instanceof SyntaxError ? 400 : 500);
    if (status === 500) console.error(err.name, String(err.message).slice(0, 200));
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: status === 404 ? 'not found' : 'request failed' }));
  }
}).listen(PORT, () => {
  console.log(`naloxone finder on http://localhost:${PORT}  model=${cfg.model}  key=${cfg.apiKey ? 'set' : 'MISSING (offline mode)'}  offline=${cfg.forceOffline}`);
});
