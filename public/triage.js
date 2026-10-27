// Spots an overdose in progress from the person's own words. Shared by the
// browser (shows the Call 911 banner the moment they tap Ask, before any
// network call) and the server (forces a 911-first answer). Plain module
// with no imports so both can load it.

export const EMERGENCY = [
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
