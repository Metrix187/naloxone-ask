// Deterministic guardrails that run outside the model.
//
// 1. triage(): spots an overdose in progress BEFORE any model call, so the
//    "call 911" banner never depends on the model or the network.
// 2. checkFacts(): scans the model's prose for phone numbers, URLs, clock
//    times and street addresses. Anything not in the verified set (dataset +
//    crisis lines + the user's own words) is removed and counted.

export { triage } from '../public/triage.js';

// During an overdose in progress the answer is fixed text, not model prose:
// 911 first, then where the options are. The model still resolves the state
// and picks the cards. The dataset has no usage instructions, so the text says
// nothing about when or how to use naloxone; the 911 dispatcher guides that.
// LATER_RE still flags model wording that framed naloxone as "for later", so
// the smoke test can report how often the prompt rule alone would have failed.
const LATER_RE = /\b(?:after(?:wards?)?|later|next\s+time|in\s+case|for\s+the\s+future|future\s+use|on\s+hand|keep\s+(?:one|it|some)|despu[eé]s|m[aá]s\s+tarde|la\s+pr[oó]xima\s+vez|por\s+si\s+acaso)(?![\p{L}])/iu;
const SPANISH_RE = /\b(?:no\s+respira|no\s+responde|sobredosis|mi\s+(?:amig|herman|hij|novi)|estamos|estoy)\b/i;

export function emergencyMessage(userText, { stateName = null, hasClarify = false } = {}) {
  if (SPANISH_RE.test(userText || '')) {
    if (!stateName) return 'Llama al 911 ahora. Luego dime en qué estado estás para ver opciones de naloxona.';
    return `Llama al 911 ahora. Abajo están las opciones de naloxona gratis o de bajo costo en ${stateName}.${hasClarify ? ' ¿No es el lugar correcto? Toca el tuyo abajo.' : ''}`;
  }
  if (!stateName) return "Call 911 now. Then tell me which state you're in to see naloxone options.";
  return `Call 911 now. Free and low-cost naloxone options for ${stateName} are listed below.${hasClarify ? " Not the right place? Tap yours below." : ''}`;
}

export function laterWording(message) {
  const m = String(message || '').match(LATER_RE);
  return m ? [{ kind: 'timing', value: m[0] }] : [];
}

const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b|\b(?:911|988)\b/g;
const URL_RE = /\bhttps?:\/\/[^\s)<>"']+|\b(?:www\.)[^\s)<>"']+/gi;
const CLOCK = String.raw`\d{1,2}(?::\d{2})?\s?(?:a\.?m\.?|p\.?m\.?)`;
const TIME_RE = new RegExp(String.raw`\bopen\s+(?:until|till|til)\s+${CLOCK}|\b${CLOCK}(?=\W|$)|\bopen\s+(?:until|till|til|now)\b|\bopen\s+24\s*(?:hours|\/\s*7)\b`, 'gi');
const ADDRESS_RE = /\b\d{1,5}\s+(?:[A-Z][a-z]+\s){1,3}(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Hwy|Highway|Pike)\b\.?/g;

const digits = (s) => s.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
const normUrl = (u) => u.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/.,;:]+$/, '');

export function checkFacts(text, { phones, urls }, userText = '') {
  if (!text) return { text: '', removed: [] };
  const removed = [];
  const okPhones = new Set([...phones].map(digits));
  const okUrls = [...urls].map(normUrl);
  const userLower = userText.toLowerCase();

  let out = text.replace(URL_RE, (m) => {
    const n = normUrl(m);
    if (okUrls.some((u) => n === u || n.startsWith(u) || u.startsWith(n))) return m;
    removed.push({ kind: 'url', value: m });
    return '[link removed: not in verified data]';
  });
  out = out.replace(PHONE_RE, (m) => {
    if (okPhones.has(digits(m))) return m;
    removed.push({ kind: 'phone', value: m });
    return '[number removed: not in verified data]';
  });
  out = out.replace(TIME_RE, (m) => {
    removed.push({ kind: 'hours', value: m });
    return '[hours not listed — call ahead]';
  });
  out = out.replace(ADDRESS_RE, (m) => {
    if (userLower.includes(m.toLowerCase())) return m; // echoing the user's own words is fine
    removed.push({ kind: 'address', value: m });
    return '[address not listed]';
  });
  return { text: out, removed };
}
