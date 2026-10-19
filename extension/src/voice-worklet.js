// The mic's sound processing that Web Audio has no node for. Runs on the audio thread
// (AudioWorklet). Two stages sit in the chain built by lib/voice.js; the third records:
//
//   stage 'denoise'   RNNoise, the same AI noise remover desktop Lumen uses (ffmpeg's
//                     arnndn). `mix` blends it with the original, like arnndn's mix.
//   stage 'dynamics'  a de-esser (tames sharp S and T sounds), a slow leveler that
//                     brings the voice to the loudness you picked, and a limiter that keeps
//                     peaks under -1.5 dB (desktop: loudnorm I=… TP=-1.5).
//   stage 'tap'       the tuner page's sample recorder.
//
// Everything here is deterministic, so the tuner page (an OfflineAudioContext) hears
// exactly what a recording gets.

const FRAME = 480;          // RNNoise works on 10 ms frames at 48 kHz
const db = (x) => 10 ** (x / 20);

// The two stages of one chain share a little state through here (one audio thread,
// so no locking): RNNoise's "is someone talking" for the leveler. Keyed by chain id.
const links = new Map();
const link = (id) => links.get(id) || links.set(id, { vad: null }).get(id);

// RNNoise's WebAssembly (MIT wrapper, BSD-3 RNNoise, built by Shiguredo, Apache-2.0).
// It needs only three things from us; compiled once per audio thread.
let compiled = null;
class Rnnoise {
  constructor(bytes) {
    compiled ??= new WebAssembly.Module(bytes);
    let mem;
    const x = new WebAssembly.Instance(compiled, { env: {
      emscripten_memcpy_big: (dest, src, n) => { new Uint8Array(mem.buffer).copyWithin(dest, src, src + n); },
      emscripten_resize_heap: (size) => {
        try { mem.grow(Math.ceil((size - mem.buffer.byteLength) / 65536)); return 1; } catch { return 0; }
      },
      __assert_fail: () => { throw new Error('rnnoise: assertion failed'); },
    } }).exports;
    mem = x.memory;
    x.emscripten_stack_init?.();
    x.__wasm_call_ctors();
    this.x = x;
    this.state = x.rnnoise_create(0);     // 0 = the built-in model
    this.buf = x.malloc(FRAME * 4);
  }

  // Cleans `frame` (480 samples, -1..1) into `out`; returns how likely it is that the
  // frame has speech in it (0..1).
  run(frame, out) {
    let h = new Float32Array(this.x.memory.buffer, this.buf, FRAME);
    for (let i = 0; i < FRAME; i++) h[i] = frame[i] * 32767;
    const vad = this.x.rnnoise_process_frame(this.state, this.buf, this.buf);
    h = new Float32Array(this.x.memory.buffer, this.buf, FRAME);   // the heap may have grown
    for (let i = 0; i < FRAME; i++) out[i] = h[i] / 32767;
    return vad;
  }

  free() {
    if (!this.x) return;
    this.x.rnnoise_destroy(this.state);
    this.x.free(this.buf);
    this.x = null;
  }
}

// Noise removal with a fixed delay of one frame (10 ms): input collects into 480-sample
// frames, each is cleaned and blended with its own original (so the blend never smears),
// and output is read from a queue that starts one frame full of silence. It runs even
// at 0% (then the sound passes through untouched): the leveler needs its speech detector.
class Denoise {
  constructor({ wasm, mix, id }) {
    this.rn = new Rnnoise(wasm);
    this.mix = mix;
    this.id = id;
    this.link = link(id);
    this.frame = new Float32Array(FRAME);
    this.clean = new Float32Array(FRAME);
    this.n = 0;
    this.q = new Float32Array(FRAME * 4);
    this.r = 0;
    this.w = FRAME;          // = one frame of silence queued
  }

  process(inp, out) {
    const { q, frame, clean, mix } = this;
    for (let i = 0; i < inp.length; i++) {
      frame[this.n++] = inp[i];
      if (this.n === FRAME) {
        this.link.vad = this.rn.run(frame, clean);
        for (let k = 0; k < FRAME; k++) q[(this.w + k) % q.length] = mix * clean[k] + (1 - mix) * frame[k];
        this.w += FRAME;
        this.n = 0;
      }
    }
    for (let i = 0; i < out.length; i++) out[i] = q[(this.r + i) % q.length];
    this.r += out.length;
  }

  free() {
    this.rn.free();
    links.delete(this.id);
  }
}

// De-esser + leveler + limiter.
class Dynamics {
  constructor({ deess, loudness, id }) {
    const sr = sampleRate;
    this.link = link(id);
    // De-esser: split off the highs (above ~5.5 kHz) and turn them down only while
    // they're a big share of the sound, which is what an S or T is.
    this.deess = deess / 100;
    const w = (2 * Math.PI * 5500) / sr;
    const al = Math.sin(w) / (2 * Math.SQRT1_2);
    const a0 = 1 + al;
    this.b = [(1 + Math.cos(w)) / 2 / a0, -(1 + Math.cos(w)) / a0, (1 + Math.cos(w)) / 2 / a0];
    this.a = [(-2 * Math.cos(w)) / a0, (1 - al) / a0];
    this.z = [0, 0, 0, 0];
    this.att = Math.exp(-1 / (0.0005 * sr));
    this.rel = Math.exp(-1 / (0.04 * sr));
    this.eh = 0;
    this.ef = 0;
    this.maxCut = 12 * this.deess;               // dB
    // Leveler: measures how loud the voice is (quiet gaps don't count) and moves the
    // gain slowly toward the target: quickly in the first two seconds, then gently.
    this.target = loudness;
    this.g = 0;                                  // dB
    this.ms = null;
    this.floor = null;
    this.voiced = 0;
    this.block = 128 / sr;
    this.segN = Math.round((0.2 * sr) / 128);    // blocks per 200 ms
    this.seg = (this.segN * 128) / sr;
    this.segSum = 0;
    this.segCount = 0;
    this.segVad = 0;
    // Limiter: looks 4 ms ahead, so the gain is already down when a peak arrives
    // (no clipped edges), then lets go over ~80 ms.
    this.ceil = db(-1.5);
    this.L = Math.max(1, Math.round(0.004 * sr));
    this.ring = new Float32Array(this.L);
    this.cap = this.L + 2;                       // window maximum: a deque of (index, level)
    this.dqI = new Float64Array(this.cap);
    this.dqV = new Float32Array(this.cap);
    this.head = 0;
    this.tail = 0;
    this.n = 0;
    this.lg = 1;
    this.down = 1 - Math.exp(-5 / this.L);
    this.up = 1 - Math.exp(-1 / (0.08 * sr));
  }

  limit(buf) {
    const { L, cap, ring, dqI, dqV, ceil } = this;
    for (let i = 0; i < buf.length; i++, this.n++) {
      const n = this.n;
      const x = buf[i];
      const a = Math.abs(x);
      while (this.tail !== this.head && dqV[(this.tail - 1 + cap) % cap] <= a) this.tail = (this.tail - 1 + cap) % cap;
      dqI[this.tail] = n;
      dqV[this.tail] = a;
      this.tail = (this.tail + 1) % cap;
      while (dqI[this.head] < n - L) this.head = (this.head + 1) % cap;
      const peak = dqV[this.head];               // loudest of the next L samples
      const want = peak > ceil ? ceil / peak : 1;
      this.lg += (want - this.lg) * (want < this.lg ? this.down : this.up);
      const y = ring[n % L] * this.lg;           // the sample from L ago
      ring[n % L] = x;
      buf[i] = Math.max(-ceil, Math.min(ceil, y));
    }
  }

  process(inp, out) {
    // 1. De-ess.
    if (this.deess > 0) {
      const { b, a, z, att, rel } = this;
      for (let i = 0; i < inp.length; i++) {
        const x = inp[i];
        const hp = b[0] * x + b[1] * z[0] + b[2] * z[1] - a[0] * z[2] - a[1] * z[3];
        z[1] = z[0]; z[0] = x; z[3] = z[2]; z[2] = hp;
        const h2 = hp * hp;
        const f2 = x * x;
        this.eh = h2 > this.eh ? att * this.eh + (1 - att) * h2 : rel * this.eh + (1 - rel) * h2;
        this.ef = f2 > this.ef ? att * this.ef + (1 - att) * f2 : rel * this.ef + (1 - rel) * f2;
        const share = this.eh / (this.ef + 1e-12);
        let g = 1;
        if (share > 0.35 && this.ef > 1e-7) {
          const over = 10 * Math.log10(share / 0.35);
          g = db(-Math.min(this.maxCut, over * 3 * this.deess));
        }
        out[i] = x - hp + hp * g;
      }
    } else {
      out.set(inp);
    }

    // 2. Level. Loudness is judged over 200 ms stretches (like loudnorm's 400 ms
    // windows), so the short dips inside words count, as they do to your ears.
    let sum = 0;
    for (let i = 0; i < out.length; i++) sum += out[i] * out[i];
    this.segSum += sum / out.length;
    this.segVad += this.link.vad ?? 0;
    if (++this.segCount === this.segN) {
      const seg = this.segSum / this.segN;
      const vad = this.segVad / this.segN;
      this.segSum = 0;
      this.segCount = 0;
      this.segVad = 0;
      const segDb = 10 * Math.log10(seg + 1e-12);
      const estDb = this.ms === null ? null : 10 * Math.log10(this.ms + 1e-12);
      // Only speech counts, so the silence before you speak (or between sentences) is
      // never mistaken for a quiet voice and turned up. Two checks must agree: the sound
      // is well above the room's noise floor (which follows quiet moments down at once
      // and creeps up 1.5 dB/s), and RNNoise thinks someone is talking. Either alone is
      // fooled: the floor by RNNoise's leftover crackle, RNNoise by steady hiss (its
      // speech score sometimes sticks high on it).
      if (this.floor === null || segDb < this.floor) this.floor = segDb;
      else this.floor += Math.min(segDb - this.floor, 1.5 * this.seg);
      const speech = segDb > this.floor + 6 && (this.link.vad === null || vad > 0.5);
      if (segDb > -60 && speech && (estDb === null || segDb > estDb - 15)) {
        this.voiced += this.seg;
        const k = 1 - Math.exp(-this.seg / (this.voiced < 2 ? 0.4 : 3));
        this.ms = this.ms === null ? seg : this.ms + k * (seg - this.ms);
      }
    }
    let g1 = this.g;
    if (this.ms !== null) {
      const want = Math.min(18, Math.max(-12, this.target - 10 * Math.log10(this.ms + 1e-12)));
      const step = (this.voiced < 2 ? 24 : 6) * this.block;      // dB per block
      g1 = this.g + Math.min(step, Math.max(-step, want - this.g));
    }
    const from = db(this.g);
    const to = db(g1);
    for (let i = 0; i < out.length; i++) out[i] *= from + ((to - from) * (i + 1)) / out.length;
    this.g = g1;

    // 3. Limit.
    this.limit(out);
  }

  free() {}
}

// The tuner's sample recorder: sends the raw mic samples to the page in 0.1 s batches
// (the exact samples a recording would process, unlike a compressed MediaRecorder file).
class Tap {
  constructor(port) {
    this.port = port;
    this.buf = new Float32Array(4800);
    this.n = 0;
  }

  process(inp, out) {
    out.fill(0);
    for (let i = 0; i < inp.length; i++) {
      this.buf[this.n++] = inp[i];
      if (this.n === this.buf.length) {
        this.port.postMessage(this.buf, [this.buf.buffer]);
        this.buf = new Float32Array(4800);
        this.n = 0;
      }
    }
  }

  free() {}
}

const zeros = new Float32Array(128);

class VoiceProcessor extends AudioWorkletProcessor {
  constructor({ processorOptions: o }) {
    super();
    this.stage = o.stage === 'denoise' ? new Denoise(o) : o.stage === 'tap' ? new Tap(this.port) : new Dynamics(o);
    this.port.onmessage = (e) => { if (e.data === 'destroy') this.destroy(); };
  }

  process(inputs, outputs) {
    const out = outputs[0][0];
    if (!this.stage || !out) return false;
    // No input connected yet (or it ended): keep time moving with silence.
    const inp = inputs[0]?.[0] || zeros.subarray(0, out.length);
    this.stage.process(inp, out);
    return true;
  }

  destroy() {
    this.stage?.free();
    this.stage = null;
  }
}

registerProcessor('lumen-voice', VoiceProcessor);
