// Sound (lib/voice.js + voice-worklet.js) on a made-up sample, in a real Chromium:
//   room noise, then a "voice" (a 140 Hz buzz with harmonics, in syllables) over the
//   same noise, with two sharp "s" bursts, then noise again.
// For every preset it checks: nothing broken (finite, peaks under -1 dB), the voice ends
// near the loudness target, noise removal lowers the noise under the voice (Noisy room
// most), the de-esser turns the "s" bursts down, and Raw leaves the noise alone.
// Also times a 30 s render (the tuner re-renders on every slider move).
//
// LUMEN_VOICE_SAMPLE=some.wav also runs a real voice through every preset, with white
// noise added 20 dB under it, and checks how much each preset lowers the noise in the
// pauses (RNNoise is trained on speech, so a made-up buzz can't show that). The file is
// only read, never stored.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, launchWithExtension } from './lib.mjs';

let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); if (!cond) failed++; };

// Which sound a recording gets (no browser needed).
{
  const { voiceFor, PRESETS } = await import('../extension/src/lib/voice.js');
  const noisy = { preset: 'Noisy room', params: PRESETS['Noisy room'] };
  const crisp = { preset: 'Crisp', params: PRESETS.Crisp };
  ok(voiceFor({}, 'mic-a').preset === 'Natural', 'nothing set up: Natural');
  ok(voiceFor({ voices: { '': noisy } }, 'mic-a').preset === 'Noisy room', 'a mic picked by name without its own sound uses the Default mic’s (Noisy room)');
  ok(voiceFor({ voices: { '': noisy, 'mic-a': crisp } }, 'mic-a').preset === 'Crisp', 'a mic with its own sound keeps it (Crisp)');
  ok(voiceFor({ voices: { 'mic-a': crisp } }, '').preset === 'Natural', 'Default mic without a sound: Natural');
}

const { browser, extensionId } = await launchWithExtension(path.join(ROOT, 'dist'), { tag: 'voice' });
try {
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${extensionId}/tuner.html`);
  await page.waitForFunction(() => globalThis.lumenVoice);
  const sampleFile = process.env.LUMEN_VOICE_SAMPLE;
  const r = await page.evaluate(async function () {
    const SR = 48000;
    const { PRESETS, render } = globalThis.lumenVoice;
    const wasm = await globalThis.lumenVoice.wasm();
    // mulberry32: repeatable noise that is properly random (a plain LCG has a pattern
    // that RNNoise's speech detector half-believes).
    let seed = 1;
    const rnd = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
    };
    const make = (seconds) => {
      const n = SR * seconds;
      const ctx = new OfflineAudioContext(1, n, SR);
      const buf = ctx.createBuffer(1, n, SR);
      const d = buf.getChannelData(0);
      const noiseAmp = 10 ** (-42 / 20) * Math.sqrt(3);        // white noise at -42 dBFS RMS
      let hp = 0, prev = 0;
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        let v = rnd() * noiseAmp;
        if (t >= 1 && t < seconds - 1) {
          const syll = 0.5 - 0.5 * Math.cos(2 * Math.PI * 4 * t);  // 4 syllables a second
          let voice = 0;
          for (let h = 1; h <= 12; h++) voice += Math.sin(2 * Math.PI * 140 * h * t) / h;
          v += voice * 0.05 * syll;
          // "s": high-passed noise, loud, 150 ms, at 3.0 s and 4.0 s
          if ((t >= 3 && t < 3.15) || (t >= 4 && t < 4.15)) {
            const x = rnd(); hp = 0.6 * (hp + x - prev); prev = x;
            v += hp * 0.25;
          }
        }
        d[i] = v;
      }
      return buf;
    };
    const rms = (d, a, b) => { const i0 = Math.round(a * SR), i1 = Math.min(d.length, Math.round(b * SR)); let s = 0; for (let i = i0; i < i1; i++) s += d[i] * d[i]; return 10 * Math.log10(s / (i1 - i0) + 1e-20); };
    // Energy above ~6 kHz in a window (a first-difference filter is enough to compare).
    const highs = (d, a, b) => { const i0 = Math.round(a * SR) + 1, i1 = Math.round(b * SR); let s = 0; for (let i = i0; i < i1; i++) { const x = d[i] - d[i - 1]; s += x * x; } return 10 * Math.log10(s / (i1 - i0) + 1e-20); };
    // 1 s of room, 11 s of voice (the leveler settles), 1 s of room.
    const sample = make(13);
    const input = sample.getChannelData(0);
    const out = { wasm: !!wasm, input: { voice: rms(input, 9, 11.5), noise: rms(input, 12.2, 13) }, presets: {} };
    for (const [name, p] of Object.entries(PRESETS)) {
      const res = (await render(sample, p, wasm)).getChannelData(0);
      let peak = 0, finite = true;
      for (const v of res) { if (!Number.isFinite(v)) finite = false; peak = Math.max(peak, Math.abs(v)); }
      out.presets[name] = { finite, peakDb: 20 * Math.log10(peak), voice: rms(res, 9, 11.5), noise: rms(res, 12.2, 13),
        sDb: highs(res, 3.0, 3.15) - highs(res, 2.5, 2.65) };
      if (name === 'Crisp') {
        const noDeess = (await render(sample, { ...p, deess: 0 }, wasm)).getChannelData(0);
        out.presets[name].sDbNoDeess = highs(noDeess, 3.0, 3.15) - highs(noDeess, 2.5, 2.65);
      }
    }
    // Room noise alone, 8 s: the leveler must leave it as it is (nobody's talking).
    const room = make(8);
    const rd = room.getChannelData(0);
    for (let i = SR; i < rd.length; i++) rd[i] = rnd() * 10 ** (-40 / 20) * Math.sqrt(3);
    out.room = { input: rms(rd, 4, 8), presets: {} };
    for (const [name, p] of Object.entries(PRESETS)) {
      const lvl = async (q) => rms((await render(room, q, wasm)).getChannelData(0), 4, 8);
      out.room.presets[name] = { on: await lvl(p), off: await lvl({ ...p, denoise: 0 }), denoise: p.denoise };
    }

    const SAMPLE = arguments[0];
    if (SAMPLE) {
      const bytes = Uint8Array.from(atob(SAMPLE), (c) => c.charCodeAt(0));
      const dec = await new AudioContext({ sampleRate: SR }).decodeAudioData(bytes.buffer);
      const n = dec.length;
      const W = SR / 10;                                     // 100 ms windows
      const winDb = (d, w) => rms(d, (w * W) / SR, ((w + 1) * W) / SR);
      const speech = new Float32Array(dec.getChannelData(0));
      const wins = Math.floor(n / W);
      const LOOPS = 3;                    // played 3 times; measured on the last, once settled
      const lastW = (w) => w + (LOOPS - 1) * wins;
      const lv = Array.from({ length: wins }, (_, w) => winDb(speech, w));
      const top = Math.max(...lv);
      const voicedW = lv.map((v, w) => (v > top - 15 ? w : -1)).filter((w) => w >= 0);
      // Pauses: the quietest tenth of the windows, if they're well under the voice.
      const cut = [...lv].sort((a, b) => a - b)[Math.floor(wins / 10)];
      const pauseW = lv.map((v, w) => (v <= cut && v < top - 20 ? w : -1)).filter((w) => w >= 0);
      const voicedDb = 10 * Math.log10(voicedW.reduce((a, w) => a + 10 ** (lv[w] / 10), 0) / voicedW.length);
      const k = 10 ** ((-26 - voicedDb) / 20);
      const total = wins * W * LOOPS;
      const ctx = new OfflineAudioContext(1, total, SR);
      const buf = ctx.createBuffer(1, total, SR);
      const d = buf.getChannelData(0);
      const noiseAmp = 10 ** (-46 / 20) * Math.sqrt(3);
      for (let i = 0; i < total; i++) d[i] = speech[i % (wins * W)] * k + rnd() * noiseAmp;
      const level = (res, ws) => 10 * Math.log10(ws.reduce((a, w) => a + 10 ** (winDb(res, lastW(w)) / 10), 0) / ws.length);
      out.real = { seconds: n / SR, voicedWindows: voicedW.length, pauseWindows: pauseW.length,
        input: level(d, voicedW) - level(d, pauseW), presets: {} };
      // Each preset with and without its noise removal, so only that differs.
      for (const [name, p] of Object.entries(PRESETS)) {
        const run = async (q) => { const res = (await render(buf, q, wasm)).getChannelData(0); return { voice: level(res, voicedW), gap: level(res, voicedW) - level(res, pauseW) }; };
        const on = await run(p);
        const off = await run({ ...p, denoise: 0 });
        out.real.presets[name] = { on: on.gap, off: off.gap, voice: on.voice };
      }
    }
    const long = make(30);
    const t0 = performance.now();
    await render(long, PRESETS.Podcast, wasm);
    out.render30Ms = Math.round(performance.now() - t0);
    return out;
  }, sampleFile ? fs.readFileSync(sampleFile).toString('base64') : '');

  console.log(`input: voice ${r.input.voice.toFixed(1)} dB, noise ${r.input.noise.toFixed(1)} dB`);
  ok(r.wasm, 'RNNoise loaded in the extension');
  const inSnr = r.input.voice - r.input.noise;
  for (const [name, p] of Object.entries(r.presets)) {
    const snr = p.voice - p.noise;
    console.log(`${name}: voice ${p.voice.toFixed(1)} dB, noise ${p.noise.toFixed(1)} dB (gap ${snr.toFixed(1)} dB, input ${inSnr.toFixed(1)}), peak ${p.peakDb.toFixed(1)} dB, s ${p.sDb.toFixed(1)} dB`);
    ok(p.finite, `${name}: output is finite`);
    ok(p.peakDb < -1, `${name}: peaks stay under -1 dB`);
    // (Loudness on the made-up buzz only for Raw: noise removal treats the buzz as part
    // noise. The real-voice run checks every preset.)
    if (name === 'Raw') ok(Math.abs(p.voice - -16) < 4, `${name}: voice within 4 dB of the -16 target`);
  }
  const gap = (n) => r.presets[n].voice - r.presets[n].noise;
  {
    const rp = r.room.presets;
    console.log(`room noise alone (${r.room.input.toFixed(1)} dB): ` + Object.entries(rp).map(([n, v]) => `${n} ${v.on.toFixed(1)} (${(v.on - v.off).toFixed(1)} from noise removal)`).join(', '));
    ok(Math.abs(rp.Raw.on - r.room.input) < 1.5, 'room noise alone, Raw: left at its level');
    // (How much noise removal takes off plain white noise isn't checked: RNNoise's speech
    // detector sometimes sticks on it, and then it keeps the hiss. Real voices: below.)
    ok(Object.values(rp).every((v) => v.on < r.room.input + 1.5), 'room noise alone: no preset turns it up (nobody is talking)');
  }
  ok(Math.abs(gap('Raw') - inSnr) < 3, 'Raw: noise left as it was (relative to the voice)');
  // More noise removal, less noise: Raw (0) < Natural (50) < Crisp (70) < Podcast (75) < Noisy room (100).
  const order = ['Raw', 'Natural', 'Crisp', 'Podcast', 'Noisy room'];
  ok(order.every((n, i) => i === 0 || gap(n) > gap(order[i - 1])), `noise goes down as noise removal goes up (${order.map((n) => gap(n).toFixed(1)).join(' < ')} dB)`);
  if (r.real) {
    const g = r.real.presets;
    const cut = (n) => g[n].on - g[n].off;
    console.log(`real voice (${r.real.seconds.toFixed(1)} s, ${r.real.voicedWindows} voiced / ${r.real.pauseWindows} pause windows): `
      + `voice-to-pause gap ${r.real.input.toFixed(1)} dB in the input, ${g.Raw.on.toFixed(1)} after Raw; noise removal lowers the pauses by `
      + order.slice(1).map((n) => `${n} ${cut(n).toFixed(1)}`).join(', ') + ' dB');
    console.log(`real voice loudness (target -16): ${order.map((n) => `${n} ${g[n].voice.toFixed(1)}`).join(', ')} dB`);
    ok(order.every((n) => Math.abs(g[n].voice - -16) < 3), 'real voice: every preset within 3 dB of the loudness target');
    ok(Math.abs(g.Raw.on - r.real.input) < 3, 'real voice, Raw: pauses not turned up (the leveler leaves silence alone)');
    ok(cut('Noisy room') > 15, 'real voice, Noisy room: noise removal makes the pauses at least 15 dB quieter');
    ok(order.slice(2).every((n, i) => cut(n) >= cut(order[i + 1]) - 1), 'real voice: more noise removal, quieter pauses');
  }
  const c = r.presets.Crisp;
  ok(c.sDb < c.sDbNoDeess - 2, `De-ess (Crisp): "s" bursts ${(c.sDbNoDeess - c.sDb).toFixed(1)} dB softer than with de-ess off`);
  console.log(`30 s sample renders in ${r.render30Ms} ms`);
  ok(r.render30Ms < 3000, '30 s preview renders in under 3 s');
} finally {
  await browser.close();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall voice checks passed');
process.exit(failed ? 1 : 0);
