// The demo video, scene by scene. Follows docs/demo-script.md (2:30 target, 3:00 hard max).
//
//   vo       caption text shown on screen
//   say      what the voice reads, when it differs from vo (e.g. "nine one one")
//   scene    'title' | 'phone' | 'diagram' | 'code' | 'end'
//   run      what the browser does while the voice plays (see make-video.mjs `app`)
//   label    small step label in the side panel
//   expect   the state the live answer should land on; the render stops if it doesn't
//
// Voiceover says "naloxone", not the NARCAN trademark (see the trademark note in
// docs/demo-script.md). The Johnstown prompt avoids the restaurant brand for the
// same reason; set JOHNSTOWN_PROMPT=mcdonalds to use the chip text instead.

export const JOHNSTOWN = process.env.JOHNSTOWN_PROMPT === 'mcdonalds'
  ? 'near the mcdonalds on franklin st in johnstown'
  : 'near the bus station on franklin st in johnstown';

export const SCENES = [
  {
    id: 'hook', scene: 'title',
    vo: "When someone needs naloxone tonight, they don't type an address. They type what they see: a street, a sign, a town. And they're scared.",
  },
  {
    id: 'setup', scene: 'phone', label: 'narcan.delivery',
    vo: 'narcan.delivery is my free naloxone guide for all fifty states. No signup, no tracking. This week I gave it a voice with Meta’s Muse Spark. You just say where you are, in your own words.',
    say: 'narcan dot delivery is my free naloxone guide for all fifty states. No signup, no tracking. This week I gave it a voice with Meta’s Muse Spark. You just say where you are, in your own words.',
    run: async (app) => { await app.showSite(3500); await app.reset(); },
  },
  {
    id: 'ohio', scene: 'phone', expect: 'OH', label: 'Live · Ohio',
    vo: "Here's a real question, answered live. It finds Ohio's free options in the verified dataset, and it tells you what it doesn't know. No hours are listed, so it says call ahead instead of guessing.",
    run: async (app) => { await app.tapExample(0); await app.waitAnswer(); await app.pause(1200); await app.scrollThrough(5000); },
  },
  {
    id: 'johnstown', scene: 'phone', expect: 'PA', label: 'Live · a messy place',
    vo: 'Now a messy one. There are four Johnstowns. It checks the likely states at the same time, answers for the most likely one, and lets you fix it with one tap. The map link is built from your own words.',
    // Fresh conversation: with the Ohio question still in the history, the model
    // reasonably picks Johnstown, OH, which is not what this line describes.
    run: async (app) => { await app.reset(); await app.type(JOHNSTOWN); await app.submit(); await app.waitAnswer(); await app.pause(800); await app.scrollThrough(4500); },
  },
  {
    id: 'trace', scene: 'phone', label: 'How this answer was made',
    vo: 'Every answer shows how it was made: the tool calls, the model in Standard mode, the tokens, the cost, and how many unverified details the fact checker removed.',
    run: async (app) => { await app.openTrace(); },
  },
  {
    id: 'photo', scene: 'phone', expect: 'PA', label: 'Live · photo',
    vo: "It can read a photo, too. This is a test sign with no people in it. It reads the street and the town, and finds the state.",
    run: async (app) => { await app.reset(); await app.attachPhoto('street-sign-pa.jpg'); await app.pause(900); await app.submit(); await app.waitAnswer(); await app.pause(800); await app.scrollThrough(3000); },
  },
  {
    id: 'spanish', scene: 'phone', expect: 'TX', label: 'Live · Spanish',
    vo: 'And it answers in the language you ask in.',
    run: async (app) => { await app.type('¿Dónde consigo naloxona gratis en Texas?'); await app.submit(); await app.waitAnswer(); await app.pause(600); await app.scrollThrough(2500); },
  },
  {
    id: 'emergency', scene: 'phone', expect: 'OH', label: 'Live · emergency',
    vo: "If it sounds like an overdose is happening right now, the Call 911 banner appears the instant you tap Ask, before the model even answers. That's enforced in code, and the answer is fixed text, never improvised.",
    say: "If it sounds like an overdose is happening right now, the call nine one one banner appears the instant you tap Ask, before the model even answers. That's enforced in code, and the answer is fixed text, never improvised.",
    run: async (app) => { await app.reset(); await app.type("my brother won't wake up, we're in Dayton"); await app.submit(); await app.waitAnswer(); await app.pause(1500); await app.scrollThrough(2500); },
  },
  {
    id: 'tooling', scene: 'diagram', label: 'Under the hood',
    vo: "Under the hood: Muse Spark 1.3 on Meta Model API, with real tool calling. It resolves the place, calls state lookup in parallel, and answers by pointing at verified records, so it never writes a phone number or an address itself. A fact checker strips anything it can't verify, and image understanding reads street signs.",
  },
  {
    id: 'standard', scene: 'code', label: 'Standard mode only',
    vo: 'And it only runs in Standard mode. Contributor mode would let Meta train on these questions, so the code refuses it, at startup and before every call.',
  },
  {
    id: 'impact', scene: 'phone', label: 'No account · nothing stored',
    vo: "No account. Nothing stored. All fifty states. And if the network or the API fails, it falls back to a clearly labeled offline answer, because the person on the other end can't wait.",
    run: async (app) => { await app.reset(); },
  },
  {
    id: 'end', scene: 'end',
    vo: 'Find naloxone in one sentence.',
  },
];
