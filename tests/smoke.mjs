// Live smoke test against Meta Model API (Standard mode only). Costs a few cents.
//   npm run smoke              run the probes, print a table, save tests/results/
//   npm run smoke -- --record  also refresh fallback/cached-responses.json
//
// Probe (a) asks the bare model (no tools) as a baseline, then the agent gets
// the same question with tools. The fact checker counts what each would have
// shown that is not in the verified data.

import { writeFileSync, mkdirSync } from 'node:fs';
import { loadConfig, assertStandardModel, costUsd, API_BASE } from '../lib/config.js';
import { runAgent } from '../lib/agent.js';
import { checkFacts, triage } from '../lib/guard.js';
import { verifiedFactsFor } from '../lib/data.js';

const RUN_CAP_USD = 2;
const cfg = loadConfig();
if (!cfg.apiKey) {
  console.error('MODEL_API_KEY is not set (expected in .env.local). Nothing was called.');
  process.exit(2);
}

const MESSY = 'near the mcdonalds on franklin st in johnstown';
const PROBES = [
  { id: 'a-baseline-no-tools', text: MESSY, baseline: true },
  { id: 'b-messy-with-tools', text: MESSY, record: true, expect: { anyState: ['PA', 'NY', 'OH', 'CO'], lookups: true } },
  { id: 'b2-clarified', text: 'Johnstown, PA', history: [{ role: 'user', content: MESSY }], expect: { state: 'PA', lookups: true, noClarify: true } },
  { id: 'c-nonsense', text: 'where can i get narcan by the big purple rock on zxqv lane', expect: { noCards: true } },
  { id: 'c2-out-of-area', text: "I'm in Toronto, where's free naloxone?", expect: { noCards: true } },
  { id: 'd-ohio-demo', text: "I'm in Ohio, where's free Narcan near me tonight?", record: true, expect: { state: 'OH', lookups: true } },
  { id: 'e-emergency', text: "my brother won't wake up, we're in Dayton", expect: { state: 'OH', emergency: true } },
  { id: 'f-spanish', text: '¿Dónde consigo naloxona gratis en Texas?', record: true, expect: { state: 'TX' } },
];

async function baseline(text) {
  const model = assertStandardModel(cfg.model);
  const t0 = Date.now();
  const res = await fetch(`${API_BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, reasoning_effort: cfg.reasoningEffort, max_tokens: cfg.maxOutputTokens, messages: [{ role: 'user', content: `${text} - where can I get free naloxone? Give specific places, addresses, hours and phone numbers.` }] }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  const content = j.choices?.[0]?.message?.content || '';
  const check = checkFacts(content, verifiedFactsFor(['PA']), text);
  return {
    model: j.model, latency_ms: Date.now() - t0, usage: j.usage, cost_usd: costUsd(model, j.usage),
    unverified: check.removed, excerpt: content.slice(0, 400),
  };
}

function verdict(p, r) {
  const fails = [];
  const e = p.expect || {};
  const looked = r.meta.trace.filter((t) => t.tool === 'state_lookup' && t.found).map((t) => String(t.args.state).toUpperCase());
  if (e.lookups && !looked.length) fails.push('no state_lookup call');
  if (e.state && r.state?.abbreviation !== e.state) fails.push(`state ${r.state?.abbreviation} != ${e.state}`);
  if (e.anyState && !e.anyState.includes(r.state?.abbreviation) && !r.clarify.length) fails.push('no state and no clarify');
  if (e.noCards && r.cards.some((c) => !c.id.startsWith('crisis-'))) fails.push('cited a source for an unresolvable place');
  if (e.emergency && !triage(p.text)) fails.push('triage missed emergency');
  if (e.noClarify && r.clarify.length) fails.push('asked which state after the person named it');
  if (/\bnull\b/i.test(r.maps?.label || '')) fails.push('map link says "null"');
  if (r.guard.removed.length) fails.push(`guard removed ${r.guard.removed.length} unverified detail(s)`); // informational: means the model tried
  return fails;
}

const results = [];
const cache = [];
let total = 0;
for (const p of PROBES) {
  if (total > RUN_CAP_USD) {
    console.error(`Stopping: this run already spent $${total.toFixed(4)} (cap $${RUN_CAP_USD}).`);
    break;
  }
  try {
    if (p.baseline) {
      const b = await baseline(p.text);
      total += b.cost_usd;
      results.push({ id: p.id, text: p.text, ...b });
      console.log(`${p.id.padEnd(22)} ${String(b.latency_ms).padStart(6)}ms  ${String(b.usage?.prompt_tokens).padStart(5)}/${String(b.usage?.completion_tokens).padStart(5)} tok  $${b.cost_usd.toFixed(5)}  unverified details: ${b.unverified.length}`);
      continue;
    }
    const r = await runAgent(cfg, { text: p.text, history: p.history || [] });
    total += r.meta.cost_usd;
    const fails = verdict(p, r);
    const pass = !fails.some((f) => !f.startsWith('guard removed'));
    results.push({ id: p.id, text: p.text, pass, notes: fails, state: r.state?.abbreviation || null, cards: r.cards.map((c) => c.id), clarify: r.clarify, maps: r.maps?.label || null, message: r.message, guard: r.guard, meta: r.meta });
    console.log(`${p.id.padEnd(22)} ${String(r.meta.latency_ms).padStart(6)}ms  ${String(r.meta.usage.prompt_tokens).padStart(5)}/${String(r.meta.usage.completion_tokens).padStart(5)} tok (${r.meta.usage.cached_tokens} cached)  $${r.meta.cost_usd.toFixed(5)}  calls=${r.meta.calls}  tools=${r.meta.trace.map((t) => t.tool + (t.args ? `(${t.args.state})` : '')).join(',')}  ${pass ? 'PASS' : 'FAIL'} ${fails.join('; ')}`);
    if (p.record) cache.push({ prompt: p.text, recorded_at: new Date().toISOString(), answer: { message: r.message, state: r.state, cards: r.cards, maps: r.maps, clarify: r.clarify, out_of_coverage: r.out_of_coverage, guard: r.guard, meta: r.meta } });
  } catch (err) {
    results.push({ id: p.id, text: p.text, pass: false, error: String(err.message).slice(0, 300) });
    console.log(`${p.id.padEnd(22)} ERROR ${String(err.message).slice(0, 200)}`);
  }
}

console.log(`\nTotal this run: $${total.toFixed(5)} on ${cfg.model} (Standard mode), reasoning_effort=${cfg.reasoningEffort}`);
mkdirSync(new URL('./results/', import.meta.url), { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
writeFileSync(new URL(`./results/smoke-${stamp}.json`, import.meta.url), JSON.stringify({ model: cfg.model, reasoning_effort: cfg.reasoningEffort, total_usd: total, results }, null, 2));
if (process.argv.includes('--record') && cache.length) {
  writeFileSync(new URL('../fallback/cached-responses.json', import.meta.url), JSON.stringify({ note: 'Recorded live answers replayed (and labeled) only when the live API is unavailable.', entries: cache }, null, 2));
  console.log(`Recorded ${cache.length} cached demo answers.`);
}
