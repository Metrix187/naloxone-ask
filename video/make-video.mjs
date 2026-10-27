// Automated demo video: ElevenLabs voiceover + a screen recording of the live app + ffmpeg.
//   npm run video                  render video/out/demo.mp4 and demo.srt (captions for YouTube)
//   npm run video -- --voices      list this account's voices (the key needs voices_read)
//   npm run video -- --sample      make only the first voice line, to hear the voice
//   npm run video -- --tts-only    make the voice lines and print their lengths
//
// Needs MODEL_API_KEY and ELEVENLABS_API_KEY in .env.local, plus Chrome and ffmpeg on PATH.
// Voice lines are cached by content hash in video/out/audio/, so a re-render only
// pays ElevenLabs for lines that changed. Each render makes about 8 live Model API
// calls (a few cents). The render fails if any answer was not live, so the video
// never passes off a fallback answer as live; pass --allow-fallback to override.

import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENES } from './narration.mjs';
import { assertStandardModel } from '../lib/config.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = join(here, '..');
const OUT = join(here, 'out');
const AUDIO = join(OUT, 'audio');
const FRAMES = join(OUT, 'frames');
const ASSETS = join(OUT, 'stage');
const APP_PORT = 8791;
const STAGE_PORT = 8792;
const CDP_PORT = 9333;
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const REPO_URL = process.env.REPO_URL || 'github.com/Metrix187/naloxone-ask';

const XI = 'https://api.elevenlabs.io/v1';
const XI_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE = process.env.ELEVENLABS_VOICE_ID || 'cgSgspJ2msm6clMCkdW9'; // Jessica: young, playful, warm
const TTS_MODEL = process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2';
const VOICE_SETTINGS = { stability: 0.5, similarity_boost: 0.75, style: 0.25, use_speaker_boost: true, speed: 1.0 };
const LEAD = 0.35; // seconds between a scene appearing and its voice line starting
const GAP = 0.6; // seconds of quiet after each line
const MAX_SECONDS = 180;

const args = new Set(process.argv.slice(2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (s) => s.say || s.vo;

if (!XI_KEY && !args.has('--windows-voice')) {
  console.error('ELEVENLABS_API_KEY is not set (expected in .env.local). Nothing was called.');
  process.exit(2);
}

async function xi(path, init = {}) {
  const res = await fetch(`${XI}${path}`, { ...init, headers: { 'xi-api-key': XI_KEY, ...init.headers } });
  if (!res.ok) throw new Error(`ElevenLabs ${path.split('?')[0]} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res;
}

if (args.has('--voices')) {
  const { voices } = await (await xi('/voices')).json();
  for (const v of voices) {
    const l = v.labels || {};
    console.log(`${v.voice_id}  ${v.name.padEnd(28)} ${[l.gender, l.age, l.accent, l.descriptive || l.description, l.use_case || l.use_cases].filter(Boolean).join(' · ')}`);
  }
  process.exit(0);
}

// --- 1. Voice lines -------------------------------------------------------------

mkdirSync(AUDIO, { recursive: true });
let billedChars = 0;

// --windows-voice: placeholder lines from the built-in Windows voice, to test the pipeline
// without spending ElevenLabs credits. Never the submission voice.
function windowsVoice(i) {
  const text = say(SCENES[i]);
  const file = join(AUDIO, `${SCENES[i].id}-win-${createHash('sha256').update(text).digest('hex').slice(0, 16)}.wav`);
  if (!existsSync(file)) {
    const ps = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SelectVoice('Microsoft Zira Desktop'); $s.SetOutputToWaveFile($env:OUT_WAV); $s.Speak($env:SAY_TEXT); $s.Dispose()`;
    execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { env: { ...process.env, OUT_WAV: file, SAY_TEXT: text } });
  }
  return file;
}

async function tts(i) {
  if (args.has('--windows-voice')) return windowsVoice(i);
  const text = say(SCENES[i]);
  const body = {
    text, model_id: TTS_MODEL, voice_settings: VOICE_SETTINGS,
    // Neighbouring lines help the voice keep one tone across the cuts.
    previous_text: SCENES[i - 1] ? say(SCENES[i - 1]) : undefined,
    next_text: SCENES[i + 1] ? say(SCENES[i + 1]) : undefined,
  };
  const key = createHash('sha256').update(JSON.stringify([VOICE, body])).digest('hex').slice(0, 16);
  const file = join(AUDIO, `${SCENES[i].id}-${key}.mp3`);
  if (!existsSync(file)) {
    const res = await xi(`/text-to-speech/${VOICE}?output_format=mp3_44100_128`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'audio/mpeg' }, body: JSON.stringify(body),
    });
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    billedChars += text.length;
  }
  return file;
}

const seconds = (file) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString().trim());

if (args.has('--sample')) {
  const file = await tts(0);
  console.log(`sample: ${file} (${seconds(file).toFixed(1)} s, ${billedChars} characters billed)`);
  process.exit(0);
}

const lines = [];
for (let i = 0; i < SCENES.length; i++) {
  const file = await tts(i);
  lines.push({ file, dur: seconds(file) });
}
const voiceTotal = lines.reduce((a, l) => a + l.dur + LEAD + GAP, 0);
for (const [i, l] of lines.entries()) console.log(`${SCENES[i].id.padEnd(10)} ${l.dur.toFixed(1).padStart(5)} s`);
console.log(`voice ≈ ${voiceTotal.toFixed(1)} s before waiting on live answers · ElevenLabs characters billed this run: ${billedChars}`);
if (args.has('--tts-only')) process.exit(0);

// --- 2. App server (live) and the stage page -----------------------------------------

const children = [];
function cleanup() { for (const c of children) try { c.kill(); } catch {} }
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

const app = spawn(process.execPath, ['--env-file-if-exists=.env.local', 'server.js'], {
  cwd: root, env: { ...process.env, PORT: String(APP_PORT), FORCE_OFFLINE: '0' }, stdio: ['ignore', 'pipe', 'inherit'],
});
children.push(app);
await new Promise((resolve, reject) => {
  app.stdout.on('data', (d) => {
    const s = d.toString();
    if (/naloxone finder on/.test(s)) {
      if (!/key=set/.test(s) || /offline=true/.test(s)) reject(new Error('app server is not in live mode'));
      else resolve();
    }
  });
  app.on('exit', (code) => reject(new Error(`app server exited (${code})`)));
});

// Writes the scene assets: the architecture diagram from the README, the Standard-mode guard
// from lib/config.js, and a phone screenshot of the narcan.delivery snapshot (taken below).
mkdirSync(ASSETS, { recursive: true });
const readme = readFileSync(join(root, 'README.md'), 'utf8');
const diagram = readme.split('## Architecture')[1].split('```')[1].replace(/^\n/, '').trimEnd();
const config = readFileSync(join(root, 'lib/config.js'), 'utf8').split('\n');
const allowed = config.findIndex((l) => l.startsWith('export const ALLOWED_MODELS'));
const guard = config.findIndex((l) => l.startsWith('export function assertStandardModel'));
const guardEnd = config.findIndex((l, i) => i > guard && l === '}');
const code = [config[allowed], '', ...config.slice(guard, guardEnd + 1)].join('\n');

const answers = [];
const TYPES = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg' };
const stageServer = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/stage/')) {
    const name = url.pathname.slice(7);
    const file = name.startsWith('fixtures/') ? join(root, 'tests', name)
      : existsSync(join(here, 'stage', name)) ? join(here, 'stage', name) : join(ASSETS, name);
    if (/\.\./.test(name) || !existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    return res.end(readFileSync(file));
  }
  // Everything else goes to the app, so the stage and the app share one origin.
  const up = request({ host: '127.0.0.1', port: APP_PORT, path: req.url, method: req.method, headers: req.headers }, (r) => {
    if (url.pathname !== '/api/ask') { res.writeHead(r.statusCode, r.headers); return r.pipe(res); }
    const chunks = [];
    r.on('data', (c) => chunks.push(c));
    r.on('end', () => {
      const buf = Buffer.concat(chunks);
      try {
        const j = JSON.parse(buf.toString('utf8'));
        if (j.meta?.model) assertStandardModel(j.meta.model);
        answers.push({ mode: j.mode, model: j.meta?.model, cost: j.meta?.cost_usd || 0, state: j.state?.abbreviation || null });
      } catch (err) { answers.push({ mode: 'error', error: String(err.message).slice(0, 120) }); }
      res.writeHead(r.statusCode, r.headers);
      res.end(buf);
    });
  });
  up.on('error', () => { res.writeHead(502); res.end(); });
  req.pipe(up);
}).listen(STAGE_PORT);

// --- 3. Chrome over the DevTools protocol ------------------------------------------

const profile = mkdtempSync(join(tmpdir(), 'naloxone-video-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, '--window-size=1920,1080',
  '--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check', '--force-color-profile=srgb', 'about:blank',
], { stdio: 'ignore' });
children.push(chrome);

let target;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  try { target = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).find((t) => t.type === 'page'); } catch {}
}
if (!target) throw new Error('Chrome did not start');

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let nextId = 0;
const pending = new Map();
const handlers = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
  } else handlers.get(m.method)?.(m.params);
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`in page: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
  return r.result.value;
}
async function load(url) {
  const loaded = new Promise((r) => handlers.set('Page.loadEventFired', r));
  await send('Page.navigate', { url });
  await loaded;
}
await send('Page.enable');
await send('Runtime.enable');
// Light theme, to match the README screenshots and the narcan.delivery site.
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });

// Phone screenshot of the read-only narcan.delivery snapshot, if this checkout has it.
let site = '';
const snapshot = join(root, '..', 'reference', 'narcan-delivery-snapshot', 'index.html');
if (existsSync(snapshot)) {
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await load(`file:///${snapshot.replace(/\\/g, '/')}`);
  await sleep(800);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(ASSETS, 'site.png'), Buffer.from(shot.data, 'base64'));
  site = '/stage/site.png';
}

await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
await load(`http://127.0.0.1:${STAGE_PORT}/stage/stage.html`);
await evaluate(`stage.init(${JSON.stringify({ diagram, code, repo: REPO_URL, site })})`);

const appProxy = new Proxy({}, {
  get: (_, name) => (...a) => (name === 'pause' ? sleep(a[0]) : evaluate(`app.${String(name)}(...${JSON.stringify(a)})`)),
});

// --- 4. Record -----------------------------------------------------------------------

rmSync(FRAMES, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });
const frames = [];
handlers.set('Page.screencastFrame', ({ data, sessionId }) => {
  const file = join(FRAMES, `${String(frames.length).padStart(6, '0')}.jpg`);
  writeFileSync(file, Buffer.from(data, 'base64'));
  frames.push({ file, t: Date.now() / 1000 });
  send('Page.screencastFrameAck', { sessionId });
});
await evaluate(`stage.scene('title', '')`);
await send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 1920, maxHeight: 1080 });
for (let i = 0; i < 40 && !frames.length; i++) await sleep(50);

const starts = [];
const cues = [];
for (const [i, s] of SCENES.entries()) {
  await evaluate(`stage.scene(${JSON.stringify(s.scene)}, ${JSON.stringify(s.label || '')})`);
  const t = Date.now() / 1000;
  // One caption per sentence, timed by its share of the line. Splits only where
  // a sentence mark is followed by a space, so "narcan.delivery" and "1.3" stay whole.
  const parts = s.vo.split(/(?<=[.!?]["”’]?)\s+/);
  const chars = parts.reduce((a, p) => a + p.length, 0);
  const sceneCues = [];
  let at = LEAD;
  for (const p of parts) {
    sceneCues.push({ at, text: p });
    at += (p.length / chars) * lines[i].dur;
  }
  await evaluate(`stage.captions(${JSON.stringify(sceneCues)})`);
  starts.push(t + LEAD);
  cues.push(...sceneCues.map((c, k) => ({ start: t + c.at, end: t + (sceneCues[k + 1]?.at ?? LEAD + lines[i].dur), text: c.text })));
  await Promise.all([sleep((LEAD + lines[i].dur + GAP) * 1000), s.run ? s.run(appProxy) : null]);
  console.log(`recorded ${s.id}`);
}
await sleep(1500);
await send('Page.stopScreencast');
const end = Date.now() / 1000;
ws.close();
stageServer.close();
cleanup();

// --- 5. Check the answers, then mux --------------------------------------------------

const notLive = answers.filter((a) => a.mode !== 'live');
const cost = answers.reduce((a, x) => a + x.cost, 0);
console.log(`answers: ${answers.length} (${answers.map((a) => `${a.mode}${a.state ? `:${a.state}` : ''}`).join(', ')}) · Model API cost $${cost.toFixed(4)}`);
if (notLive.length && !args.has('--allow-fallback')) {
  console.error('Some answers were not live, so this recording would mislabel them. Not rendering. Re-run, or pass --allow-fallback.');
  process.exit(1);
}
// The voiceover describes each answer, so each must land where the line says it does.
const expected = SCENES.filter((s) => s.expect).map((s) => s.expect);
const got = answers.map((a) => a.state);
if (expected.join() !== got.join() && !args.has('--allow-mismatch')) {
  console.error(`Answers landed on ${got.join(', ')}, the voiceover expects ${expected.join(', ')}. Not rendering. Re-run (model answers vary), or pass --allow-mismatch.`);
  process.exit(1);
}

const t0 = frames[0].t;
const concat = ['ffconcat version 1.0'];
frames.forEach((f, k) => {
  concat.push(`file '${f.file.replace(/\\/g, '/')}'`, `duration ${((frames[k + 1]?.t ?? end) - f.t).toFixed(4)}`);
});
concat.push(`file '${frames.at(-1).file.replace(/\\/g, '/')}'`);
writeFileSync(join(OUT, 'frames.ffconcat'), concat.join('\n'));

const length = end - t0;
const inputs = lines.flatMap((l) => ['-i', l.file]);
const delays = lines.map((_, i) => `[${i + 1}:a]adelay=${Math.round((starts[i] - t0) * 1000)}:all=1[a${i}]`);
const mix = `${lines.map((_, i) => `[a${i}]`).join('')}amix=inputs=${lines.length}:normalize=0,apad[aud]`;
const filter = `[0:v]fps=30,scale=1920:1080:flags=lanczos,format=yuv420p[v];${delays.join(';')};${mix}`;
execFileSync('ffmpeg', [
  '-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', join(OUT, 'frames.ffconcat'), ...inputs,
  '-filter_complex', filter, '-map', '[v]', '-map', '[aud]', '-t', length.toFixed(3),
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart',
  join(OUT, 'demo.mp4'),
], { stdio: 'inherit' });

const stamp = (s) => {
  const ms = Math.max(0, Math.round((s - t0) * 1000));
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};
writeFileSync(join(OUT, 'demo.srt'), cues.map((c, k) => `${k + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.text}\n`).join('\n'));
rmSync(profile, { recursive: true, force: true });

console.log(`\nvideo/out/demo.mp4 · ${length.toFixed(1)} s · ${frames.length} frames${length > MAX_SECONDS ? `  ⚠ over the ${MAX_SECONDS} s limit` : ''}`);
console.log('video/out/demo.srt · captions to upload to YouTube');
process.exit(0);
