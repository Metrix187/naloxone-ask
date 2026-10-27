// The tool layer: narcan.delivery's state-by-state dataset (CC0), unchanged,
// plus the crisis lines. Every location, phone number and link the agent can
// show comes from here — the model only chooses among these records.
//
// What the dataset does NOT contain: street addresses, opening hours, or
// coordinates. Tool results say so explicitly so the model never fills the gap.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(readFileSync(join(here, '..', 'data', 'naloxone-data.json'), 'utf8'));
const adjacency = JSON.parse(readFileSync(join(here, '..', 'data', 'adjacency.json'), 'utf8'));

export const DATASET_META = {
  source: raw.source,
  generated_at: raw.generated_at,
  license: raw.license,
  state_count: raw.states.length,
};

// Verified 2026-10-27: 911/988/SAMHSA from narcan.delivery's own page;
// Never Use Alone from https://neverusealone.com.
export const CRISIS_RESOURCES = [
  { id: 'crisis-911', name: 'Emergency (overdose happening now)', phone: '911', note: 'Call if someone is unresponsive or not breathing.' },
  { id: 'crisis-988', name: '988 Suicide & Crisis Lifeline', phone: '988', note: 'Call or text, 24/7.' },
  { id: 'crisis-nua', name: 'Never Use Alone', phone: '800-484-3731', alt_phone: '877-696-1996', website: 'https://neverusealone.com', note: 'If you are using alone: stays on the line and sends EMS if you stop responding. 24/7, confidential.' },
  { id: 'crisis-samhsa', name: 'SAMHSA National Helpline', phone: '1-800-662-4357', website: 'https://www.samhsa.gov/find-help/helplines/national-helpline', note: 'Free, 24/7. Finds naloxone or treatment anywhere in the U.S.' },
];

function normalizeState(s) {
  const ab = s.abbreviation;
  const ac = s.access_channels;
  const options = [];
  ac.mail_based_programs.forEach((p, i) => options.push({
    id: `${ab}-mail-${i + 1}`, kind: 'mail', name: p.name, cost: p.cost, website: p.website, phone: p.phone,
  }));
  ac.community_programs.forEach((p, i) => options.push({
    id: `${ab}-community-${i + 1}`, kind: 'community', name: p.name, services: p.services, website: p.website, phone: p.phone,
  }));
  options.push({
    id: `${ab}-pharmacy`, kind: 'pharmacy', name: 'Pharmacy (no prescription needed in most cases)',
    mechanism: ac.pharmacies.mechanism, typical_cost: ac.pharmacies.typical_cost, medicaid: ac.pharmacies.medicaid_coverage_notes,
  });
  return {
    state: s.state,
    abbreviation: ab,
    last_updated: s.last_updated,
    naloxone_legal_status: s.legal_framework.naloxone_legal_status,
    good_samaritan: s.legal_framework.good_samaritan_overdose_immunity,
    quickest_route: s.practical_guidance.how_to_get_naloxone_quickly,
    barriers_and_workarounds: s.practical_guidance.barriers_and_workarounds,
    options,
    neighbors: adjacency[ab] || [],
    sources: s.sources,
  };
}

const STATES = raw.states.map(normalizeState);
const BY_ABBR = new Map(STATES.map((s) => [s.abbreviation, s]));
const BY_NAME = new Map(STATES.map((s) => [s.state.toLowerCase(), s]));

export function allStates() {
  return STATES;
}

export function listStates() {
  return STATES.map((s) => ({ state: s.state, abbreviation: s.abbreviation }));
}

export function findState(query) {
  if (!query || typeof query !== 'string') return null;
  const q = query.trim();
  return BY_ABBR.get(q.toUpperCase()) || BY_NAME.get(q.toLowerCase()) || null;
}

export function optionById(id) {
  if (typeof id !== 'string') return null;
  if (id.startsWith('crisis-')) return CRISIS_RESOURCES.find((c) => c.id === id) || null;
  const st = BY_ABBR.get(id.split('-')[0]);
  return st?.options.find((o) => o.id === id) || null;
}

const DATA_LIMITS = 'This dataset lists programs, phone numbers and websites only. It has NO street addresses, NO opening hours and NO coordinates. Never state an address, hours, distance or "open now" — tell the person to call ahead or use the maps link for pharmacies near them.';

// Tool: state_lookup
export function stateLookup({ state }) {
  const s = findState(state);
  if (!s) {
    return {
      found: false,
      error: `No match for "${String(state).slice(0, 60)}". narcan.delivery covers the 50 US states (use a full state name or 2-letter code). DC and US territories are not in the dataset.`,
    };
  }
  return { found: true, data_limits: DATA_LIMITS, ...s };
}

// Tool: crisis_resources
export function crisisResources() {
  return { resources: CRISIS_RESOURCES, data_limits: 'These lines are national (US). Do not add any other numbers.' };
}

// Every phone number and URL the app is allowed to show, for the output guard.
export function verifiedFactsFor(stateAbbrs = []) {
  const phones = new Set();
  const urls = new Set();
  const add = (o) => {
    if (o.phone) phones.add(o.phone);
    if (o.alt_phone) phones.add(o.alt_phone);
    if (o.website) urls.add(o.website);
  };
  CRISIS_RESOURCES.forEach(add);
  for (const ab of stateAbbrs) {
    const s = BY_ABBR.get(ab);
    if (!s) continue;
    s.options.forEach(add);
    s.sources.forEach((u) => urls.add(u));
  }
  return { phones, urls };
}

export const normText = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

// Full state names anywhere (case-insensitive); 2-letter codes only when
// written in capitals, so "in", "or", "me", "ok" in a sentence don't match.
export function detectStates(text) {
  const t = String(text || '');
  const lower = ` ${normText(t)} `;
  const hits = [];
  for (const { state, abbreviation } of listStates()) {
    // "Virginia" must not match inside "West Virginia".
    const hay = state === 'Virginia' ? lower.replace(/ west virginia /g, ' ') : lower;
    if (hay.includes(` ${state.toLowerCase()} `)) hits.push(abbreviation);
  }
  for (const m of t.matchAll(/\b([A-Z]{2})\b/g)) {
    if (findState(m[1]) && !hits.includes(m[1])) hits.push(m[1]);
  }
  return hits;
}
