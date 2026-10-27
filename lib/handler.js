// POST /api/ask — shared by the local server and the serverless adapter.
//
// Privacy: nothing about the question is written anywhere. The log line per
// request holds only mode, latency, token counts and cost. Rate limiting
// keeps a per-IP counter in memory for 60 seconds; IPs are never logged.

import { loadConfig, TierViolation } from './config.js';
import { runAgent, CRISIS_RESOURCES } from './agent.js';
import { fallbackAnswer } from './fallback.js';
import { triage } from './guard.js';
import { DATASET_META } from './data.js';

const MAX_TEXT = 500;
const MAX_HISTORY = 8;
const MAX_IMAGE_CHARS = 2_000_000; // ~1.5 MB base64; the widget downsizes photos first
const RATE_PER_MIN = 12;

let spentUsd = 0;
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > RATE_PER_MIN;
}

function cleanHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 600) }));
}

function reasonFor(err) {
  const s = err?.status;
  if (s === 401 || s === 403) return 'API key rejected';
  if (s === 402) return 'API credits used up';
  if (s === 429) return 'rate limited';
  if (s === 504) return 'timed out';
  if (s >= 500) return 'Meta API error';
  return 'API unavailable';
}

export async function handleAsk(body, { ip = 'local', env = process.env } = {}) {
  const cfg = loadConfig(env);
  const text = typeof body?.text === 'string' ? body.text.trim().slice(0, MAX_TEXT) : '';
  const image = typeof body?.image === 'string' && body.image.startsWith('data:image/') && body.image.length <= MAX_IMAGE_CHARS ? body.image : null;
  if (!text && !image) return { status: 400, json: { error: 'Type where you are, or add a photo of a street sign.' } };

  const base = { emergency: triage(text), crisis: CRISIS_RESOURCES, dataset: DATASET_META };

  if (rateLimited(ip)) {
    return { status: 429, json: emergencyFirst({ ...base, ...fallbackAnswer({ text, reason: "too many requests — try again in a minute" }) }) };
  }

  let reason = null;
  if (cfg.forceOffline) reason = 'offline demo mode';
  else if (!cfg.apiKey) reason = 'no API key configured';
  else if (spentUsd >= cfg.spendCapUsd) reason = `spend cap of $${cfg.spendCapUsd} reached`;

  if (!reason) {
    try {
      const answer = await runAgent(cfg, { text, history: cleanHistory(body.history), imageDataUrl: image });
      spentUsd += answer.meta.cost_usd;
      log({ mode: 'live', ...answer.meta, image: Boolean(image) });
      return { status: 200, json: emergencyFirst({ ...base, ...answer, mode: "live" }) };
    } catch (err) {
      if (err instanceof TierViolation) throw err; // configuration error: fail loudly, never degrade silently
      reason = reasonFor(err);
      log({ mode: 'error', status: err.status || null, error: String(err.message).slice(0, 200) });
    }
  }

  const fb = fallbackAnswer({ text, reason });
  log({ mode: fb.mode, reason });
  return { status: 200, json: emergencyFirst({ ...base, ...fb }) };
}

// If triage flagged an overdose in progress, the answer always opens with 911,
// whatever the model (or the offline path) wrote.
const NINE_ONE_ONE = "Call 911 now if they won't wake up or aren't breathing.";
function emergencyFirst(json) {
  if (json.emergency && !/^[^.!?]*\b911\b/.test(json.message || '')) {
    json.message = `${NINE_ONE_ONE} ${json.message || ''}`.trim();
  }
  return json;
}

function log(o) {
  const { trace, ...rest } = o;
  console.log(JSON.stringify({ t: new Date().toISOString(), ...rest, tools: trace?.map((x) => x.tool), spent_total_usd: Number(spentUsd.toFixed(6)) }));
}
