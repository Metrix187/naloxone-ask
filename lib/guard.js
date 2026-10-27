// Deterministic guardrails that run outside the model.
//
// 1. triage(): spots an overdose in progress BEFORE any model call, so the
//    "call 911" banner never depends on the model or the network.
// 2. checkFacts(): scans the model's prose for phone numbers, URLs, clock
//    times and street addresses. Anything not in the verified set (dataset +
//    crisis lines + the user's own words) is removed and counted.

const EMERGENCY = [
  /\bnot\s+breath/i, /\bisn'?t\s+breath/i, /\bstopped\s+breath/i, /\bcan'?t\s+breath/i,
  /\bunresponsive\b/i, /\bwon'?t\s+wake\b/i, /\bnot\s+waking\b/i, /\bcan'?t\s+wake\b/i,
  /\bpassed\s+out\b/i, /\bturning\s+blue\b/i, /\blips?\s+(are\s+|is\s+)?blue\b/i, /\bblue\s+lips\b/i,
  /\boverdos(e|ing)\s+(right\s+)?now\b/i, /\bo\.?d'?ing\b/i, /\bis\s+overdosing\b/i,
  /\bgasping\b/i, /\bsnoring\s+weird/i,
  /\bno\s+respira/i, /\bno\s+responde\b/i, /\bsobredosis\b/i, // Spanish
];

export function triage(text) {
  return EMERGENCY.some((re) => re.test(text || ''));
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
