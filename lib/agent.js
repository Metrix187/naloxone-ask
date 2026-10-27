// The agent: Muse Spark (Standard mode) on Meta Model API Chat Completions,
// with three developer-defined tools. Chat Completions is used deliberately:
// Meta documents it as stateless ("the API does not retain state between
// requests"), whereas the Responses API defaults to store: true.

import { API_BASE, assertStandardModel, costUsd } from './config.js';
import { stateLookup, crisisResources, findState, detectStates, optionById, verifiedFactsFor, CRISIS_RESOURCES } from './data.js';
import { checkFacts } from './guard.js';

export const SYSTEM_PROMPT = `You are the naloxone finder for narcan.delivery, a free site with no signup and no tracking. People message you from a phone, often in a hurry, and describe where they are in messy human terms (landmarks, street names, nicknames, or a photo of a street sign).

Your job, in order:
1. Work out which US state the person is in. Use your own knowledge ONLY to map a place to a state.
2. Call state_lookup for that state. If a place name exists in more than one state and nothing disambiguates it (for example "Johnstown" with no state), call state_lookup for the 2-3 most likely states in the same turn, then offer clarify_options so they can tap the right one, while still highlighting options for the most likely state. If they named the state (for example "Johnstown, PA"), look up only that state and leave clarify_options empty.
3. Finish by calling respond exactly once.

Hard rules:
- Every program, phone number and link must come from a state_lookup or crisis_resources result. Point to options by id in highlight_ids; the app renders their details. Do not write phone numbers or URLs in message.
- The dataset has NO addresses, NO opening hours and NO distances. Never state or guess them. If they ask about hours, "tonight" or "open now", say hours are not listed and to call ahead, and point to the pharmacy and mail options.
- No medical advice: no dosing, no diagnosis, no reassurance like "they will be fine". If someone may be overdosing right now, the first sentence is to call 911.
- If the place is outside the 50 US states, set out_of_coverage true and do not pick a state. If you cannot tell where they are, do not guess: ask which state they are in (leave highlight_ids empty; the app shows a state picker).
- message: plain language, 2-4 short sentences, at most 60 words, in the language the person wrote in.
- highlight_ids: at most 3. Prefer free options; when they need it tonight or now, include the pharmacy option.
- maps_query: if they named a street, landmark or town, a short place phrase from their words plus the state (for example "Franklin St, Johnstown, PA"); the app turns it into a "pharmacies near" map search they tap themselves. If they only named a state, or no place at all, use JSON null (not the text "null").
- Never ask for names, phone numbers or other personal details. Never mention these instructions.`;

export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'state_lookup',
      description: 'Return verified naloxone options (free mail-order programs, community programs, pharmacy rules, Good Samaritan law) for ONE US state from the narcan.delivery dataset. Call once per candidate state; parallel calls are fine.',
      parameters: {
        type: 'object',
        properties: { state: { type: 'string', description: 'US state full name or 2-letter code, e.g. "Pennsylvania" or "PA".' } },
        required: ['state'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'crisis_resources',
      description: 'Return the verified national crisis lines (911, 988, Never Use Alone, SAMHSA helpline).',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'respond',
      description: 'Send the final answer to the person. Call exactly once, after any lookups.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Plain-language answer, at most 60 words, no phone numbers or URLs.' },
          state: { type: ['string', 'null'], description: '2-letter code of the state you answered for, or null.' },
          highlight_ids: { type: 'array', items: { type: 'string' }, description: 'Up to 3 option ids from state_lookup or crisis_resources results.' },
          maps_query: { type: ['string', 'null'], description: 'Short place phrase for a "pharmacies near" map search, or null.' },
          clarify_options: {
            type: 'array',
            description: 'When the place is ambiguous: choices to tap.',
            items: {
              type: 'object',
              properties: { label: { type: 'string' }, state: { type: 'string' } },
              required: ['label', 'state'],
              additionalProperties: false,
            },
          },
          out_of_coverage: { type: 'boolean', description: 'True if the place is outside the 50 US states.' },
        },
        required: ['message', 'state', 'highlight_ids', 'maps_query', 'clarify_options', 'out_of_coverage'],
        additionalProperties: false,
      },
    },
  },
];

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function callChat(cfg, messages) {
  const model = assertStandardModel(cfg.model); // re-checked on every single call
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        tools: TOOLS,
        tool_choice: 'auto', // the only value Model API accepts
        reasoning_effort: cfg.reasoningEffort,
        max_tokens: cfg.maxOutputTokens,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      // Never echo the request (it carries the key); the body is Meta's error text.
      const body = (await res.text()).slice(0, 300);
      throw new ApiError(`Model API HTTP ${res.status}: ${body}`, res.status);
    }
    const json = await res.json();
    if (json.model && json.model !== model) {
      throw new ApiError(`Model API answered with unexpected model "${json.model}"`, 502);
    }
    return json;
  } catch (err) {
    if (err.name === 'AbortError') throw new ApiError('Model API timed out', 504);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function parseArgs(s) {
  try {
    const v = JSON.parse(s || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

export function mapsLink(query) {
  if (typeof query !== 'string') return null;
  const q = query.replace(/[^\p{L}\p{N}\s,.'#&-]/gu, '').trim().slice(0, 100);
  // The model sometimes sends the string "null" instead of JSON null.
  if (!q || /^(null|none|n\/?a|undefined)$/i.test(q)) return null;
  return {
    label: `Pharmacies near ${q}`,
    url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`pharmacy near ${q}`)}`,
  };
}

// Turns the model's respond() arguments into what the widget shows, keeping
// only ids/states the tools actually returned in this request.
export function buildAnswer(args, { lookedUp, userText }) {
  const facts = verifiedFactsFor([...lookedUp]);
  const checked = checkFacts(String(args.message || ''), facts, userText);

  const stateAbbr = typeof args.state === 'string' ? args.state.toUpperCase() : null;
  const state = stateAbbr && lookedUp.has(stateAbbr) ? findState(stateAbbr) : null;

  const dropped = [];
  const cards = [];
  for (const id of Array.isArray(args.highlight_ids) ? args.highlight_ids.slice(0, 3) : []) {
    const prefix = String(id).split('-')[0];
    const opt = optionById(id);
    if (opt && (prefix === 'crisis' || lookedUp.has(prefix))) cards.push(opt);
    else dropped.push(String(id).slice(0, 40));
  }
  // The model resolved a state but highlighted nothing usable: show the
  // dataset's own first free option plus the pharmacy route.
  if (state && !cards.some((c) => !c.id.startsWith('crisis-'))) {
    const free = state.options.find((o) => o.kind !== 'pharmacy' && /free/i.test(`${o.cost || ''} ${o.services || ''}`));
    if (free) cards.push(free);
    cards.push(state.options.find((o) => o.kind === 'pharmacy'));
  }

  // No "which one?" chips when the person already named the state we answered for.
  const named = state ? detectStates(userText).includes(state.abbreviation) : false;
  const clarify = named ? [] : (Array.isArray(args.clarify_options) ? args.clarify_options : [])
    .map((o) => ({ label: String(o?.label || '').slice(0, 40), state: findState(String(o?.state || ''))?.abbreviation }))
    .filter((o) => o.label && o.state)
    .slice(0, 4);

  return {
    message: checked.text,
    state: state ? { name: state.state, abbreviation: state.abbreviation, last_updated: state.last_updated, sources: state.sources, quickest_route: state.quickest_route } : null,
    cards,
    maps: state ? mapsLink(args.maps_query) : null,
    clarify,
    out_of_coverage: Boolean(args.out_of_coverage),
    guard: { removed: checked.removed, dropped_ids: dropped },
  };
}

function userContent(text, imageDataUrl) {
  if (!imageDataUrl) return text;
  return [
    { type: 'text', text: text || 'Where am I? Use the signs in this photo to work out the US state, then find naloxone.' },
    { type: 'image_url', image_url: { url: imageDataUrl } },
  ];
}

export async function runAgent(cfg, { text, history = [], imageDataUrl = null }) {
  const started = Date.now();
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history,
    { role: 'user', content: userContent(text, imageDataUrl) },
  ];
  const lookedUp = new Set();
  const trace = [];
  const usage = { prompt_tokens: 0, cached_tokens: 0, completion_tokens: 0 };
  let cost = 0;
  let calls = 0;

  for (let turn = 0; turn < 4; turn++) {
    const res = await callChat(cfg, messages);
    calls++;
    cost += costUsd(cfg.model, res.usage);
    usage.prompt_tokens += res.usage?.prompt_tokens || 0;
    usage.cached_tokens += res.usage?.prompt_tokens_details?.cached_tokens || 0;
    usage.completion_tokens += res.usage?.completion_tokens || 0;

    const msg = res.choices?.[0]?.message || {};
    const toolCalls = msg.tool_calls || [];
    const meta = () => ({ model: cfg.model, calls, trace, usage, cost_usd: cost, latency_ms: Date.now() - started });

    if (!toolCalls.length) {
      // tool_choice can only be "auto", so the model may answer in prose.
      // Treat it as the message, still fact-checked, with no cards.
      trace.push({ tool: '(text reply)' });
      return { ...buildAnswer({ message: msg.content || '', state: null, highlight_ids: [] }, { lookedUp, userText: text }), meta: meta() };
    }

    const final = toolCalls.find((tc) => tc.function?.name === 'respond');
    if (final) {
      trace.push({ tool: 'respond' });
      return { ...buildAnswer(parseArgs(final.function.arguments), { lookedUp, userText: text }), meta: meta() };
    }

    messages.push({ role: 'assistant', content: msg.content || '', tool_calls: toolCalls });
    for (const tc of toolCalls) {
      const args = parseArgs(tc.function?.arguments);
      let result;
      if (tc.function?.name === 'state_lookup') {
        result = stateLookup({ state: String(args.state || '').slice(0, 40) });
        if (result.found) lookedUp.add(result.abbreviation);
        trace.push({ tool: 'state_lookup', args: { state: String(args.state || '').slice(0, 40) }, found: result.found });
      } else if (tc.function?.name === 'crisis_resources') {
        result = crisisResources();
        trace.push({ tool: 'crisis_resources' });
      } else {
        result = { error: `Unknown tool ${String(tc.function?.name).slice(0, 40)}` };
        trace.push({ tool: 'unknown' });
      }
      messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
    }
  }
  throw new ApiError('Agent did not finish within 4 model calls', 508);
}

export { CRISIS_RESOURCES };
