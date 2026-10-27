// Chat widget. Conversation state lives only in this tab's memory: no
// localStorage, no cookies. Everything from the server is rendered with
// textContent, never innerHTML.

import { triage } from './triage.js';

const $ = (s) => document.querySelector(s);
const log = $('#log');
const form = $('#ask');
const input = $('#q');
const photoInput = $('#photo');
const preview = $('#photo-preview');

let history = []; // [{role, content}] text only, sent back for follow-ups
let pendingImage = null;
let busy = false;
let staticData = null; // public/states.json, loaded only if the API is unreachable

// Lets screen readers pick a Spanish voice for Spanish answers.
const looksSpanish = (s) => /[¿¡ñ]|\b(?:puedes|naloxona|gratis|llama|opciones|farmacias?|abajo)\b/i.test(s);

const KIND_LABEL = { mail: 'Free by mail', community: 'Community program', pharmacy: 'Pharmacy', crisis: '24/7 line' };

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else n.setAttribute(k, v);
  }
  for (const k of kids) if (k) n.append(k);
  return n;
}

const telHref = (p) => `tel:${String(p).replace(/[^\d+]/g, '')}`;
const safeUrl = (u) => (/^https:\/\//i.test(u || '') ? u : null);

function cardFor(opt) {
  const kind = opt.id?.startsWith('crisis-') ? 'crisis' : opt.kind;
  const node = $('#tpl-card').content.firstElementChild.cloneNode(true);
  const badge = node.querySelector('.kind');
  badge.textContent = kind === 'mail' && !/free/i.test(opt.cost || '') ? 'By mail' : KIND_LABEL[kind] || kind;
  badge.classList.add(`kind-${kind}`);
  node.querySelector('.name').textContent = opt.name;

  const detail = node.querySelector('.detail');
  if (kind === 'pharmacy') {
    detail.textContent = opt.mechanism || '';
    if (opt.typical_cost) detail.append(el('small', { text: `Cost: ${opt.typical_cost}` }));
    if (opt.medicaid) detail.append(el('small', { text: `Medicaid: ${opt.medicaid}` }));
  } else {
    detail.textContent = opt.services || opt.note || (opt.cost ? `Cost: ${opt.cost}` : '');
  }

  const actions = node.querySelector('.actions');
  if (opt.phone) actions.append(el('a', { class: 'btn btn-primary', href: telHref(opt.phone), text: `Call ${opt.phone}` }));
  if (opt.alt_phone) actions.append(el('a', { class: 'btn', href: telHref(opt.alt_phone), text: opt.alt_phone }));
  const web = safeUrl(opt.website);
  if (web) actions.append(el('a', { class: 'btn', href: web, target: '_blank', rel: 'noopener noreferrer', text: kind === 'mail' ? 'Order free kit ↗' : 'Website ↗' }));
  if (!actions.children.length) actions.remove();
  return node;
}

function howItWorked(r) {
  const m = r.meta || {};
  const d = el('details', { class: 'how' }, el('summary', { text: 'How this answer was made' }));
  const ol = el('ol');
  for (const t of m.trace || []) {
    const args = t.args ? `(${Object.values(t.args).join(', ')})` : '()';
    ol.append(el('li', {}, el('code', { text: `${t.tool}${t.tool.startsWith('(') ? '' : args}` }), t.found === false ? ' → not in dataset' : ''));
  }
  d.append(ol);
  const removed = r.guard?.removed?.length || 0;
  const dropped = r.guard?.dropped_ids?.length || 0;
  const bits = [];
  if (r.mode === 'live') bits.push(`${m.model} (Standard mode) · ${m.calls} model call${m.calls === 1 ? '' : 's'}`);
  if (r.mode === 'cached') bits.push(`Recorded answer from ${m.model} (Standard mode)`);
  if (r.mode === 'offline') bits.push('Offline: no AI used');
  if (m.latency_ms != null) bits.push(`${(m.latency_ms / 1000).toFixed(1)}s`);
  if (m.usage) bits.push(`${m.usage.prompt_tokens} in (${m.usage.cached_tokens} cached) / ${m.usage.completion_tokens} out tokens`);
  if (m.cost_usd != null) bits.push(`$${Number(m.cost_usd).toFixed(4)}`);
  bits.push(`fact check: ${removed} unverified detail${removed === 1 ? '' : 's'} removed${dropped ? `, ${dropped} unknown id${dropped === 1 ? '' : 's'} dropped` : ''}`);
  d.append(el('p', { text: bits.join(' · ') }));
  if (r.dataset) d.append(el('p', { text: `Data: narcan.delivery dataset (${r.dataset.license}), generated ${String(r.dataset.generated_at).slice(0, 10)}.` }));
  return d;
}

function statePicker() {
  const wrap = el('div', { class: 'state-pick' });
  const sel = el('select', { 'aria-label': 'Choose your state' }, el('option', { value: '', text: 'Choose your state…' }));
  const names = staticData?.states?.map((s) => [s.abbreviation, s.state]) || [];
  const fill = (list) => list.forEach(([ab, name]) => sel.append(el('option', { value: name, text: name })));
  if (names.length) fill(names);
  else loadStatic().then((d) => fill(d.states.map((s) => [s.abbreviation, s.state])));
  const go = el('button', { class: 'btn', type: 'button', text: 'Show options' });
  go.addEventListener('click', () => sel.value && ask(`I'm in ${sel.value}`));
  wrap.append(sel, go);
  return wrap;
}

function renderAnswer(r) {
  $('#emergency').hidden = !(r.emergency || $('#emergency').dataset.sticky === '1');
  if (r.emergency) $('#emergency').dataset.sticky = '1';

  const box = el('section', { class: 'answer' });
  if (r.notice) box.append(el('p', { class: 'notice', text: r.notice }));
  if (r.message) box.append(el('p', { class: 'bubble', text: r.message, lang: looksSpanish(r.message) ? 'es' : 'en' }));
  if (r.state) box.append(el('p', { class: 'state-line', text: `${r.state.name} · dataset updated ${r.state.last_updated}` }));
  for (const c of r.cards || []) box.append(cardFor(c));
  if (r.maps?.url?.startsWith('https://www.google.com/maps/')) {
    box.append(el('a', { class: 'btn', href: r.maps.url, target: '_blank', rel: 'noopener noreferrer', text: `📍 ${r.maps.label} (opens Google Maps)` }));
  }
  if (r.clarify?.length) {
    const c = el('div', { class: 'clarify' });
    for (const o of r.clarify) {
      const b = el('button', { class: 'chip', type: 'button', text: o.label });
      b.addEventListener('click', () => ask(o.label));
      c.append(b);
    }
    box.append(c);
  }
  if (r.pick_state || (!r.state && !r.cards?.length && !r.clarify?.length && !r.out_of_coverage)) box.append(statePicker());
  box.append(howItWorked(r));
  log.append(box);
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function loadStatic() {
  if (!staticData) staticData = await (await fetch('/states.json')).json();
  return staticData;
}

// Last resort when /api/ask can't be reached at all (network or server down).
async function renderUnreachable(text) {
  let d = null;
  try { d = await loadStatic(); } catch { /* crisis bar is static HTML and still works */ }
  const lower = ` ${text.toLowerCase()} `;
  const s = d?.states.find((x) => lower.includes(` ${x.state.toLowerCase()} `) || new RegExp(`\\b${x.abbreviation}\\b`).test(text));
  const free = s ? s.options.filter((o) => o.kind !== 'pharmacy' && /free/i.test(`${o.cost || ''} ${o.services || ''}`)).slice(0, 2) : [];
  renderAnswer({
    mode: 'offline',
    notice: "Can't reach the assistant right now. Showing saved narcan.delivery data with no AI.",
    message: s ? `Verified options for ${s.state}. Hours aren't listed, so call ahead.` : 'Which state are you in?',
    state: s ? { name: s.state, last_updated: s.last_updated } : null,
    cards: s ? [...free, s.options.find((o) => o.kind === 'pharmacy')] : [],
    pick_state: !s,
    meta: { trace: [{ tool: 'static_fallback' }] },
    guard: { removed: [] },
    dataset: d ? { license: d.license, generated_at: d.generated_at } : null,
  });
}

async function ask(text) {
  text = String(text || '').trim();
  if (busy || (!text && !pendingImage)) return;
  busy = true;
  $('#starter')?.remove();
  // Overdose in progress: show Call 911 now, before any network call.
  if (triage(text)) {
    $('#emergency').hidden = false;
    $('#emergency').dataset.sticky = '1';
  }
  const bubble = el('div', { class: 'msg-user', text: text || '(photo)' });
  if (pendingImage) bubble.append(el('img', { src: pendingImage, alt: 'Photo you sent' }));
  log.append(bubble);
  const thinking = el('p', { class: 'thinking', text: 'Checking verified sources…' });
  log.append(thinking);
  thinking.scrollIntoView({ behavior: 'smooth', block: 'end' });

  const image = pendingImage;
  clearPhoto();
  input.value = '';
  try {
    const res = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, history, image }),
    });
    const r = await res.json();
    thinking.remove();
    if (!res.ok && !r.message) throw new Error(r.error || `HTTP ${res.status}`);
    renderAnswer(r);
    history.push({ role: 'user', content: text || '(photo of where I am)' });
    history.push({ role: 'assistant', content: r.message || '' });
    history = history.slice(-8);
  } catch {
    thinking.remove();
    await renderUnreachable(text);
  } finally {
    busy = false;
  }
}

// Photos are re-encoded through a canvas: max 1024px, JPEG. Re-encoding drops
// EXIF metadata, including GPS location.
async function downscale(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1024 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.8);
}

function clearPhoto() {
  pendingImage = null;
  photoInput.value = '';
  preview.hidden = true;
}

photoInput.addEventListener('change', async () => {
  const f = photoInput.files?.[0];
  if (!f) return;
  pendingImage = await downscale(f);
  preview.querySelector('img').src = pendingImage;
  preview.hidden = false;
});
$('#photo-remove').addEventListener('click', clearPhoto);

form.addEventListener('submit', (e) => {
  e.preventDefault();
  ask(input.value);
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    ask(input.value);
  }
});
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
});
document.querySelectorAll('[data-example]').forEach((b) => b.addEventListener('click', () => ask(b.textContent)));
$('#clear').addEventListener('click', () => {
  history = [];
  log.replaceChildren();
  $('#emergency').hidden = true;
  delete $('#emergency').dataset.sticky;
});
