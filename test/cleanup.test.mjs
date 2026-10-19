// The cut decisions (lib/cleanup.js) on made-up words and sound, without a browser:
// an "um" between two words is cut from where one voice ends to where the next starts,
// leaving a natural gap; a long pause is shortened to 0.35 s; times map both ways.

import { SR, fillerCuts, pauseCuts, merge, remap, toSource, cutAudio, cleanupMarks, isFiller } from '../extension/src/lib/cleanup.js';

let failed = 0;
const ok = (c, m) => { console.log(`${c ? '  ✓' : '  ✗'} ${m}`); if (!c) failed++; };

// 6 s of sound: voice 0.5–1.5 s ("so"), "um" voice 2.0–2.4 s, voice 3.0–4.0 s ("this is"),
// then silence 4.0–6.0 s (a 2 s pause). Room noise at -60 dB under it all.
const audio = new Float32Array(6 * SR);
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32) * 2 - 1;
for (let i = 0; i < audio.length; i++) {
  const t = i / SR;
  const voice = (t >= 0.5 && t < 1.5) || (t >= 2.0 && t < 2.4) || (t >= 3.0 && t < 4.0);
  audio[i] = rnd() * 0.001 + (voice ? 0.2 * Math.sin(2 * Math.PI * 180 * t) : 0);
}
const words = [
  { w: 'So,', s: 0.5, e: 1.5 }, { w: 'um,', s: 2.1, e: 2.12 },     // Whisper misplaces the "um" (20 ms)
  { w: 'this', s: 3.0, e: 3.4 }, { w: 'is', s: 3.5, e: 4.0 },
];
ok(isFiller(words[1]) && !isFiller(words[0]), 'knows "um," is a filler and "So," isn’t');
const f = fillerCuts(words, audio, 6);
const [a, b] = f.cuts[0] || [];
console.log(`    um cut: ${a?.toFixed(2)}–${b?.toFixed(2)} s`);
ok(f.cuts.length === 1 && a > 1.5 && a < 2.0 && b > 2.4 && b < 3.0, 'the "um" is cut from its whole stretch of voice, inside the gap between the words');
ok(a >= 1.5 + 0.09 && b <= 3.0 - 0.09, 'a natural gap is left either side (0.1 s of the 0.2 s)');
const p = pauseCuts(audio);
console.log(`    pauses: ${JSON.stringify(p.map(([x, y]) => [+x.toFixed(2), +y.toFixed(2)]))}`);
ok(p.some(([x, y]) => Math.abs(x - 4.175) < 0.03 && Math.abs(y - 5.825) < 0.03), 'the 2 s pause at the end is shortened to 0.35 s');
const cuts = merge([...f.cuts, ...p]);
ok(cuts.length >= 2 && cuts.every((c, i) => i === 0 || c[0] > cuts[i - 1][1]), `cuts merged and in order (${cuts.length})`);
ok(remap(3.2, cuts) !== null && Math.abs(toSource(remap(3.2, cuts), cuts) - 3.2) < 1e-9, 'times map to the cut video and back');
ok(remap((a + b) / 2, cuts) === null, 'a time inside a cut has no place in the cut video');
const out = cutAudio(audio, cuts);
const removed = cuts.reduce((s, [x, y]) => s + y - x, 0);
ok(Math.abs(out.length / SR - (6 - removed)) < 0.01, `cut sound is ${(out.length / SR).toFixed(2)} s (6 s − ${removed.toFixed(2)} s cut)`);
const marks = cleanupMarks(cuts, [...f.cuts, ...p], 6);
ok(marks.fillers === 1 && marks.pauses >= 1 && marks.marks[0].label === 'um', `marks for the share page: ${marks.fillers} um, ${marks.pauses} pause, ${marks.seconds} s`);
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
