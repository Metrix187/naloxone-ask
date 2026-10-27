// Serverless adapter (Vercel Node runtime: export default (req, res)).
// Set MODEL_API_KEY in the host's environment settings, never in code.

import { handleAsk } from '../lib/handler.js';

export default async function ask(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.end();
  }
  try {
    const body = typeof req.body === 'object' && req.body ? req.body : JSON.parse(req.body || '{}');
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
