// Which parts of a recording to cut: ums and long pauses, decided exactly as desktop
// Lumen does (lumen/share/clean/clean.py: filler_cuts, silences, merge, cleanup_marks).
// Pure functions on numbers (word times from Whisper, 16 kHz audio samples), so they
// run anywhere, and test/cleanup.test.mjs checks them without a browser.
// The cutting itself is lib/cut.js; the order of it all is in lib/uploader.js.

export const SR = 16000;
export const FILLERS = new Set([
  'um', 'umm', 'ummm', 'uh', 'uhh', 'uhm', 'uhmm', 'erm', 'er', 'err', 'ah', 'ahh', 'ahhh',
  'hmm', 'hm', 'hmmm', 'mm', 'mmm', 'mhm', 'eh', 'ehh', 'aa', 'aaa',
  'अं', 'उम', 'अम', 'हम्म', 'आ', 'आं', 'ام', 'اں', 'ہمم', 'آ',
]);
// Nudges Whisper to write hesitations out instead of tidying them away (clean.py VERBATIM).
export const VERBATIM = {
  en: 'Umm, so, uh, let me think... Hmm, okay. Uh, here\'s the thing, um, it\'s like this.',
  ur: 'اممم، تو، اہ، میں سوچتا ہوں... ہمم، ٹھیک ہے۔ اہ، بات یہ ہے کہ، امم۔',
  hi: 'उम्म, तो, अह, मैं सोचता हूँ... हम्म, ठीक है। अह, बात यह है कि, उम।',
};
const PAD_BEFORE = 0.03, PAD_AFTER = 0.06;   // around a filler word
export const PAUSE = 1.2;                     // a pause this long or longer is shortened…
const PAUSE_KEEP = 0.35;                      // …to this
const GAP = 0.2;                              // the natural gap left where an "uh" is cut out
const FRAME = 160;                            // 10 ms loudness slices

export const norm = (w) => String(w).toLowerCase().replace(/[^\p{L}\p{N}\p{M}]/gu, '');
export const isFiller = (w) => FILLERS.has(norm(w.w));

// Loudness in dB per 10 ms, and the quiet floor (10th percentile).
export function loudness(audio) {
  const n = Math.floor(audio.length / FRAME);
  const db = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = i * FRAME; k < (i + 1) * FRAME; k++) s += audio[k] * audio[k];
    db[i] = 20 * Math.log10(Math.sqrt(s / FRAME) + 1e-9);
  }
  const sorted = Float32Array.from(db).sort();
  return { db, floor: n ? sorted[Math.floor(0.1 * (n - 1))] : -90 };
}

// Whisper reliably notices a filler but often misplaces it (an "uh" 20 ms long). Real
// words are placed well, so the filler lives in the gap between the real words either
// side of it, and it's the stretch of voice in that gap. Returns [[start, end, label]].
export function fillerCuts(words, audio, total) {
  const { db, floor } = loudness(audio);
  const voiced = (k) => db[k] > floor + 12;
  const cuts = [];
  const real = words.map((w, i) => (isFiller(w) ? -1 : i)).filter((i) => i >= 0);
  const done = new Set();
  let count = 0;
  words.forEach((w, i) => {
    if (!isFiller(w)) return;
    count++;
    const prev = real.filter((j) => j < i).pop();
    const next = real.find((j) => j > i);
    const g0 = prev !== undefined ? words[prev].e : 0;
    const g1 = next !== undefined ? words[next].s : total;
    if (done.has(`${g0},${g1}`)) return;         // "uh, um" in one gap: one cut covers both
    done.add(`${g0},${g1}`);
    const f0 = Math.floor((g0 + 0.03) * 100), f1 = Math.floor((g1 - 0.03) * 100);
    const idx = [];
    for (let k = Math.max(f0, 0); k < Math.min(f1, db.length); k++) if (voiced(k)) idx.push(k);
    if (idx.length) {
      // The quiet either side of the "uh" too, back to where the real words' voices end
      // and start, leaving a natural gap between them.
      let k0 = idx[0];
      while (k0 > 0 && !voiced(k0 - 1) && idx[0] - k0 < 150) k0--;
      let k1 = idx[idx.length - 1] + 1;
      while (k1 < db.length && !voiced(k1) && k1 - idx[idx.length - 1] < 150) k1++;
      let a = Math.max(k0 / 100 + GAP / 2, idx[0] / 100 - 0.04 - 1.5);
      let b = Math.min(k1 / 100 - GAP / 2, (idx[idx.length - 1] + 1) / 100 + 0.05 + 1.5);
      a = Math.min(a, idx[0] / 100 - 0.02);
      b = Math.max(b, (idx[idx.length - 1] + 1) / 100 + 0.02);
      cuts.push([a, b, norm(w.w)]);
    } else if (w.e - w.s >= 0.12) {               // glued to a word: trust Whisper only if plausible
      cuts.push([Math.max(g0, w.s - PAD_BEFORE), Math.min(g1, w.e + PAD_AFTER), norm(w.w)]);
    }
  });
  return { cuts: cuts.filter(([a, b]) => b - a > 0.06), count };
}

// Long pauses: stretches quieter than -38 dB for PAUSE seconds or more (ffmpeg's
// silencedetect=noise=-38dB:d=1.2), shortened to PAUSE_KEEP. `audio` should be what the
// video sounds like (mic and tab mixed), so a pause with the tab still playing stays.
export function pauseCuts(audio) {
  const { db } = loudness(audio);
  const out = [];
  let start = null;
  for (let k = 0; k <= db.length; k++) {
    const quiet = k < db.length && db[k] < -38;
    if (quiet && start === null) start = k;
    if (!quiet && start !== null) {
      if ((k - start) / 100 >= PAUSE) out.push([start / 100 + PAUSE_KEEP / 2, k / 100 - PAUSE_KEEP / 2, 'pause']);
      start = null;
    }
  }
  return out;
}

export function merge(ranges) {
  const out = [];
  for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0])) {
    if (out.length && a <= out[out.length - 1][1] + 0.02) out[out.length - 1][1] = Math.max(out[out.length - 1][1], b);
    else out.push([a, b]);
  }
  return out.filter(([a, b]) => b - a > 0.05);
}

// A time in the original → in the cut video (null inside a cut).
export function remap(t, cuts) {
  let shift = 0;
  for (const [a, b] of cuts) {
    if (t >= b) shift += b - a;
    else if (t >= a) return null;
    else break;
  }
  return t - shift;
}

// A time in the cut video → in the original.
export function toSource(t, cuts) {
  for (const [a, b] of cuts) {
    if (t >= a) t += b - a;
    else break;
  }
  return t;
}

// The audio with the cuts taken out, 10 ms fades at each join (for the check pass).
export function cutAudio(audio, cuts) {
  const keeps = [];
  let pos = 0;
  for (const [a, b] of [...cuts, [audio.length / SR, null]]) {
    const seg = audio.slice(Math.floor(pos * SR), Math.floor(a * SR));
    if (seg.length > 320) for (let i = 0; i < 160; i++) { seg[i] *= i / 160; seg[seg.length - 1 - i] *= i / 160; }
    keeps.push(seg);
    if (b === null) break;
    pos = b;
  }
  const out = new Float32Array(keeps.reduce((n, s) => n + s.length, 0));
  let at = 0;
  for (const s of keeps) { out.set(s, at); at += s.length; }
  return out;
}

// Where each cut landed on the output timeline and what it removed: the share page's
// "Cleaned up" badge, progress-bar ticks and the struck-through "uh"s in the transcript.
export function cleanupMarks(cuts, what, total) {
  const marks = [];
  let shift = 0;
  for (const [c0, c1] of cuts) {
    const inside = what.filter(([w0, w1]) => w0 < c1 && w1 > c0).map(([, , l]) => l);
    const fillers = [...new Set(inside.filter((l) => l !== 'pause'))];
    marks.push({ t: +(c0 - shift).toFixed(2), kind: fillers.length ? 'filler' : 'pause',
      label: fillers.length ? fillers.join(', ') : `${(c1 - c0).toFixed(1)} s pause`, removed: +(c1 - c0).toFixed(2) });
    shift += c1 - c0;
  }
  return { fillers: marks.filter((m) => m.kind === 'filler').length, pauses: marks.filter((m) => m.kind === 'pause').length,
    seconds: +shift.toFixed(1), before: +total.toFixed(1), after: +(total - shift).toFixed(1), marks };
}
