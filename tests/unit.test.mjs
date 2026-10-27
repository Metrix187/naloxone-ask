// Network-free tests: guardrails, tool layer, fallback, and the agent loop
// driven by a scripted fake of the Model API.   npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { assertStandardModel, loadConfig, costUsd } from '../lib/config.js';
import { stateLookup, verifiedFactsFor } from '../lib/data.js';
import { checkFacts, triage } from '../lib/guard.js';
import { buildAnswer, runAgent } from '../lib/agent.js';
import { detectStates, fallbackAnswer } from '../lib/fallback.js';
import { handleAsk } from '../lib/handler.js';

test('Contributor mode is refused everywhere', () => {
  assert.throws(() => assertStandardModel('muse-spark-1.3-contributor'), /Refusing/);
  assert.throws(() => assertStandardModel('MUSE-SPARK-1.3-CONTRIBUTOR'), /Refusing/);
  assert.throws(() => assertStandardModel('muse-spark-1.2'), /Refusing/); // not on the allowlist
  assert.throws(() => loadConfig({ MUSE_MODEL: 'muse-spark-1.3-contributor' }), /Refusing/);
  assert.equal(assertStandardModel('muse-spark-1.3'), 'muse-spark-1.3');
});

test('cost uses Standard prices and the cached-input rate', () => {
  const usd = costUsd('muse-spark-1.3', { prompt_tokens: 1_000_000, prompt_tokens_details: { cached_tokens: 400_000 }, completion_tokens: 100_000 });
  assert.equal(usd.toFixed(4), (0.6 * 1.25 + 0.4 * 0.15 + 0.1 * 4.25).toFixed(4));
});

test('state_lookup returns ids and states the data limits', () => {
  const r = stateLookup({ state: 'Pennsylvania' });
  assert.equal(r.found, true);
  assert.match(r.data_limits, /NO street addresses/);
  assert.ok(r.options.some((o) => o.id === 'PA-pharmacy'));
  assert.equal(stateLookup({ state: 'Ontario' }).found, false);
  assert.equal(stateLookup({ state: 'DC' }).found, false);
});

test('fact check strips invented numbers, links, hours and addresses', () => {
  const facts = verifiedFactsFor(['PA']);
  const { text, removed } = checkFacts(
    'Call Prevention Point at 412-247-3404 or 814-555-0199, open until 9 PM at 123 Main Street. See https://evil.example.com or https://pppgh.org. Crisis: 988.',
    facts,
  );
  assert.match(text, /412-247-3404/);
  assert.match(text, /pppgh\.org/);
  assert.match(text, /988/);
  assert.doesNotMatch(text, /814-555-0199|evil\.example|9 PM|123 Main Street/);
  assert.deepEqual(removed.map((r) => r.kind).sort(), ['address', 'hours', 'phone', 'url']);
});

test('fact check keeps an address the user typed themselves', () => {
  const { removed } = checkFacts('Pharmacies near 400 Franklin Street are your fastest bet.', verifiedFactsFor([]), "I'm at 400 Franklin Street");
  assert.equal(removed.length, 0);
});

test('triage catches an overdose in progress, not a general question', () => {
  assert.ok(triage("my friend isn't breathing"));
  assert.ok(triage('he won’t wake up and his lips are blue'.replace('’', "'")));
  assert.ok(triage('mi amigo no responde'));
  assert.ok(!triage("I'm in Ohio, where's free Narcan near me tonight?"));
});

test('buildAnswer drops ids from states the tools never returned', () => {
  const a = buildAnswer(
    { message: 'ok', state: 'PA', highlight_ids: ['PA-mail-1', 'OH-mail-1', 'XX-made-up'], maps_query: 'Franklin St, Johnstown, PA', clarify_options: [{ label: 'Johnstown, NY', state: 'NY' }], out_of_coverage: false },
    { lookedUp: new Set(['PA']), userText: '' },
  );
  assert.deepEqual(a.cards.map((c) => c.id), ['PA-mail-1']);
  assert.deepEqual(a.guard.dropped_ids, ['OH-mail-1', 'XX-made-up']);
  assert.match(a.maps.url, /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=pharmacy%20near%20Franklin/);
  assert.deepEqual(a.clarify, [{ label: 'Johnstown, NY', state: 'NY' }]);
});

test('buildAnswer: "null" map query falls back to near-you, no clarify chips once the state is named', () => {
  const a = buildAnswer(
    { message: 'ok', state: 'PA', highlight_ids: ['PA-mail-1'], maps_query: 'null', clarify_options: [{ label: 'Johnstown, NY', state: 'NY' }], out_of_coverage: false },
    { lookedUp: new Set(['PA', 'NY']), userText: 'Johnstown, PA' },
  );
  assert.equal(a.maps.label, 'Pharmacies near you');
  assert.match(a.maps.url, /query=pharmacy%20near%20me$/);
  assert.deepEqual(a.clarify, []);
});

test('buildAnswer will not show a state the model never looked up', () => {
  const a = buildAnswer({ message: 'x', state: 'OH', highlight_ids: [], maps_query: 'x' }, { lookedUp: new Set(), userText: '' });
  assert.equal(a.state, null);
  assert.equal(a.cards.length, 0);
  assert.equal(a.maps, null);
});

test('offline state detection', () => {
  assert.deepEqual(detectStates("I'm in Ohio, where's free Narcan near me tonight?"), ['OH']);
  assert.deepEqual(detectStates('west virginia please'), ['WV']);
  assert.deepEqual(detectStates('virginia beach'), ['VA']);
  assert.deepEqual(detectStates('i am in or near me ok'), []);
  assert.deepEqual(detectStates('Johnstown PA'), ['PA']);
});

test('a tier violation inside the agent loop is not swallowed by the fallback', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => assert.fail('must not reach the network');
  try {
    await assert.rejects(runAgent({ ...CFG, model: 'muse-spark-1.3-contributor' }, { text: 'Ohio' }), { name: 'TierViolation' });
  } finally {
    globalThis.fetch = real;
  }
});

test('emergency answers always open with 911', async () => {
  const r = await handleAsk({ text: "my friend isnt breathing, we're in Altoona PA" }, { env: { FORCE_OFFLINE: '1' } });
  assert.equal(r.json.emergency, true);
  assert.match(r.json.message, /^Call 911 now/);
});

test('emergency answers never frame naloxone as something for later', () => {
  const said = 'Call 911 right now. I listed free Dayton, Ohio options below in case you need naloxone after.';
  const a = buildAnswer({ message: said, state: 'OH', highlight_ids: ['OH-community-1'] }, { lookedUp: new Set(['OH']), userText: "my brother won't wake up, we're in Dayton" });
  assert.match(a.message, /^Call 911 now\./);
  assert.doesNotMatch(a.message, /after|in case/i);
  assert.deepEqual(a.guard.removed.map((r) => r.kind), ['timing']);
  const es = buildAnswer({ message: 'Llama al 911. Pide naloxona para después.', state: 'TX', highlight_ids: [] }, { lookedUp: new Set(['TX']), userText: 'mi amigo no responde, estamos en Houston' });
  assert.match(es.message, /^Llama al 911 ahora\./);
  // Outside an emergency the same words are fine.
  const calm = buildAnswer({ message: 'Order a free kit to keep on hand.', state: 'OH', highlight_ids: [] }, { lookedUp: new Set(['OH']), userText: 'free naloxone in Ohio' });
  assert.equal(calm.message, 'Order a free kit to keep on hand.');
});

test('fallback with no state asks for one and cites nothing', () => {
  const f = fallbackAnswer({ text: 'near the moon base', reason: 'test' });
  assert.equal(f.pick_state, true);
  assert.equal(f.cards.length, 0);
  assert.equal(f.mode, 'offline');
});

// Scripted fake of POST /v1/chat/completions.
function fakeFetch(script) {
  const seen = [];
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push(body);
    const step = script[seen.length - 1];
    const message = step.tool_calls
      ? { role: 'assistant', content: null, tool_calls: step.tool_calls.map(([name, args], i) => ({ id: `call_${seen.length}_${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) }
      : { role: 'assistant', content: step.content };
    return new Response(JSON.stringify({ model: body.model, choices: [{ message }], usage: { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 800 } } }), { status: 200 });
  };
  return { fn, seen };
}

const CFG = { apiKey: 'test', model: 'muse-spark-1.3', reasoningEffort: 'low', maxOutputTokens: 500, timeoutMs: 5000 };

test('agent loop: parallel lookups for an ambiguous town, then respond', async () => {
  const { fn, seen } = fakeFetch([
    { tool_calls: [['state_lookup', { state: 'PA' }], ['state_lookup', { state: 'NY' }]] },
    { tool_calls: [['respond', { message: 'Johnstown, PA: free kits by mail. Hours not listed.', state: 'PA', highlight_ids: ['PA-mail-1', 'PA-pharmacy'], maps_query: 'Franklin St, Johnstown, PA', clarify_options: [{ label: 'Johnstown, NY', state: 'NY' }], out_of_coverage: false }]] },
  ]);
  const real = globalThis.fetch;
  globalThis.fetch = fn;
  try {
    const r = await runAgent(CFG, { text: 'near the mcdonalds on franklin st in johnstown' });
    assert.equal(seen.length, 2);
    assert.ok(seen.every((b) => b.model === 'muse-spark-1.3' && b.tool_choice === 'auto'));
    // Second request carries one tool result per call, in order.
    const toolMsgs = seen[1].messages.filter((m) => m.role === 'tool');
    assert.equal(toolMsgs.length, 2);
    assert.equal(JSON.parse(toolMsgs[0].content).abbreviation, 'PA');
    assert.deepEqual(r.cards.map((c) => c.id), ['PA-mail-1', 'PA-pharmacy']);
    assert.equal(r.state.abbreviation, 'PA');
    assert.equal(r.meta.calls, 2);
    assert.ok(r.meta.cost_usd > 0);
  } finally {
    globalThis.fetch = real;
  }
});

test('agent loop: a prose reply with an invented phone number is cleaned', async () => {
  const { fn } = fakeFetch([{ content: 'Try the Johnstown clinic at 814-555-0100, open till 8pm.' }]);
  const real = globalThis.fetch;
  globalThis.fetch = fn;
  try {
    const r = await runAgent(CFG, { text: 'johnstown' });
    assert.doesNotMatch(r.message, /814-555-0100|8pm/);
    assert.equal(r.cards.length, 0);
    assert.equal(r.guard.removed.length, 2);
  } finally {
    globalThis.fetch = real;
  }
});

test('handler falls back when the API errors, and never on a tier violation', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"error":"insufficient credits"}', { status: 402 });
  try {
    const r = await handleAsk({ text: "I'm in Ohio, where's free Narcan near me tonight?" }, { env: { MODEL_API_KEY: 'x' } });
    assert.equal(r.status, 200);
    assert.ok(['offline', 'cached'].includes(r.json.mode));
    assert.match(r.json.notice, /credits used up/);
    assert.ok(r.json.crisis.length >= 3);
    await assert.rejects(handleAsk({ text: 'hi' }, { env: { MODEL_API_KEY: 'x', MUSE_MODEL: 'muse-spark-1.3-contributor' } }), /Refusing/);
  } finally {
    globalThis.fetch = real;
  }
});

test('serverless adapter answers with a parsed body or a raw stream', async () => {
  const { default: ask } = await import('../api/ask.js');
  const { Readable } = await import('node:stream');
  const fakeRes = () => ({ statusCode: 0, headers: {}, out: '', setHeader(k, v) { this.headers[k] = v; }, end(s = '') { this.out = s; } });
  const prev = process.env.FORCE_OFFLINE;
  process.env.FORCE_OFFLINE = '1';
  try {
    const parsed = fakeRes();
    await ask({ method: 'POST', headers: {}, body: { text: 'free naloxone in Ohio' } }, parsed);
    assert.equal(parsed.statusCode, 200);
    assert.equal(JSON.parse(parsed.out).state.abbreviation, 'OH');
    assert.equal(parsed.headers['Cache-Control'], 'no-store');

    const streamed = fakeRes();
    const req = Object.assign(Readable.from([JSON.stringify({ text: 'free naloxone in Ohio' })]), { method: 'POST', headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' } });
    await ask(req, streamed);
    assert.equal(streamed.statusCode, 200);
    assert.equal(JSON.parse(streamed.out).state.abbreviation, 'OH');

    const get = fakeRes();
    await ask({ method: 'GET', headers: {} }, get);
    assert.equal(get.statusCode, 405);
  } finally {
    if (prev === undefined) delete process.env.FORCE_OFFLINE;
    else process.env.FORCE_OFFLINE = prev;
  }
});

test('triage is one browser-safe module shared with the server', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../public/triage.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /^\s*import\b/m); // the browser loads it as-is
  const browser = await import('../public/triage.js');
  assert.equal(browser.triage, triage); // same function the server uses
});
