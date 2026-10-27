// Writes public/states.json: the normalized dataset the widget uses when it
// cannot reach /api/ask at all (static last-resort fallback).
//   node scripts/build-public-data.mjs

import { writeFileSync } from 'node:fs';
import { allStates, CRISIS_RESOURCES, DATASET_META } from '../lib/data.js';

const out = { ...DATASET_META, crisis: CRISIS_RESOURCES, states: allStates() };
writeFileSync(new URL('../public/states.json', import.meta.url), JSON.stringify(out));
console.log(`public/states.json: ${out.states.length} states`);
