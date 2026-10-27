// Used when the live agent can't answer (no key, API down, credits gone,
// spend cap hit, timeout). Every result is labeled with how it was produced.
//
//  - "cached":  the exact demo prompt was answered by the live agent earlier;
//               we replay that recorded answer with its recording date.
//  - "offline": no model. A plain keyword match on a state name or 2-letter
//               code in the text, then the dataset's own options.
//  - neither:   ask the person to pick their state.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { findState, detectStates, normText as norm } from './data.js';
import { buildAnswer } from './agent.js';

export { detectStates };

const here = dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = join(here, '..', 'fallback', 'cached-responses.json');

function loadCache() {
  if (!existsSync(CACHE_FILE)) return [];
  try {
    return JSON.parse(readFileSync(CACHE_FILE, 'utf8')).entries || [];
  } catch {
    return [];
  }
}

export function fallbackAnswer({ text, reason }) {
  const cached = loadCache().find((e) => norm(e.prompt) === norm(text));
  if (cached) {
    return {
      ...cached.answer,
      mode: 'cached',
      notice: `Live assistant unavailable (${reason}). This is a recorded answer from the live agent on ${cached.recorded_at.slice(0, 10)} for this exact question. The listed programs come from the narcan.delivery dataset.`,
      meta: { ...cached.answer.meta, replayed: true },
    };
  }

  const states = detectStates(text);
  if (states.length === 1) {
    const s = findState(states[0]);
    const free = s.options.filter((o) => o.kind !== 'pharmacy' && /free/i.test(`${o.cost || ''} ${o.services || ''}`)).slice(0, 2);
    const ids = [...free.map((o) => o.id), `${s.abbreviation}-pharmacy`];
    const answer = buildAnswer(
      {
        message: `Here are verified naloxone options for ${s.state}. Hours aren't listed, so call ahead. Mail-order is free; pharmacies are the fastest walk-in option.`,
        state: s.abbreviation,
        highlight_ids: ids,
        maps_query: s.state,
        clarify_options: [],
        out_of_coverage: false,
      },
      { lookedUp: new Set([s.abbreviation]), userText: text },
    );
    return {
      ...answer,
      mode: 'offline',
      notice: `Live assistant unavailable (${reason}). Basic offline match on "${s.state}" in your message, with no AI. The programs are from the narcan.delivery dataset.`,
      meta: { model: null, calls: 0, trace: [{ tool: 'offline_keyword_match', args: { state: s.abbreviation } }], cost_usd: 0 },
    };
  }

  return {
    message: 'Which state are you in? Tap it below and I’ll show verified free naloxone options.',
    state: null,
    cards: [],
    maps: null,
    clarify: [],
    pick_state: true,
    out_of_coverage: false,
    guard: { removed: [], dropped_ids: [] },
    mode: 'offline',
    notice: `Live assistant unavailable (${reason}). Offline mode can only match a state name, so pick yours below.`,
    meta: { model: null, calls: 0, trace: [{ tool: 'offline_keyword_match', args: { state: null } }], cost_usd: 0 },
  };
}
