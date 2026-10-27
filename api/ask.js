// Serverless adapter (Vercel Node runtime: export default (req, res)).
// Set MODEL_API_KEY in the host's environment settings, never in code.

import { handleAsk } from '../lib/handler.js';

export default async function ask(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.end();
  }
  try {
    // Vercel usually parses JSON into req.body; if not, read the raw stream (capped).
    let raw = req.body;
    if (raw === undefined) {
      raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 2_200_000) {
          res.statusCode = 413;
          return res.end();
        }
      }
    }
    const body = typeof raw === 'object' && raw ? raw : JSON.parse(raw || '{}');
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    const { status, json } = await handleAsk(body, { ip });
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(json));
  } catch (err) {
    console.error(err.name, String(err.message).slice(0, 200));
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'request failed' }));
  }
}
