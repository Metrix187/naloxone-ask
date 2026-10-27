// Checks every website in the dataset and the crisis list.
//   npm run check:links            all states
//   npm run check:links -- PA OH   just these
// Some government sites block scripted requests (403) but work in a browser;
// those are reported separately from hard failures.

import { allStates, CRISIS_RESOURCES } from '../lib/data.js';

const only = process.argv.slice(2).map((s) => s.toUpperCase());
const targets = [];
for (const c of CRISIS_RESOURCES) if (c.website) targets.push(['crisis', c.name, c.website]);
for (const s of allStates()) {
  if (only.length && !only.includes(s.abbreviation)) continue;
  for (const o of s.options) if (o.website) targets.push([s.abbreviation, o.name, o.website]);
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
async function check(url) {
  try {
    const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
    return res.status;
  } catch (e) {
    return e.name === 'TimeoutError' ? 'timeout' : 'network-error';
  }
}

const out = { ok: [], blocked: [], dead: [] };
for (let i = 0; i < targets.length; i += 8) {
  const batch = targets.slice(i, i + 8);
  const codes = await Promise.all(batch.map(([, , u]) => check(u)));
  batch.forEach((t, j) => {
    const c = codes[j];
    (c === 200 ? out.ok : c === 403 || c === 429 ? out.blocked : out.dead).push([...t, c]);
  });
}
console.log(`${targets.length} links: ${out.ok.length} ok, ${out.blocked.length} bot-blocked (verify by hand), ${out.dead.length} failing`);
for (const [ab, name, url, c] of [...out.dead, ...out.blocked]) console.log(`${String(c).padEnd(13)} ${ab.padEnd(6)} ${name} — ${url}`);
process.exitCode = out.dead.length ? 1 : 0;
