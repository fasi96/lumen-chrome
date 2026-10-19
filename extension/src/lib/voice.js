// How the mic sounds: the same presets and sliders as desktop Lumen's Sound menu and
// "Fine-tune by ear" (lumen/tuner/tuner.py), built from Web Audio nodes plus our own
// worklet (voice-worklet.js) for noise removal, de-essing and loudness. The recorder
// and the tuner page both build the chain here, so what you hear in the tuner is what
// your recordings get.

// key: [min, max, step, default, label, unit, hint] (same ranges as desktop)
export const PARAMS = {
  gain:     [-12, 12, 0.5, 0, 'Input trim', 'dB', 'Turn down if the sample clips'],
  rumble:   [20, 250, 5, 80, 'Rumble cut', 'Hz', 'Removes desk thumps, fans, AC hum'],
  denoise:  [0, 100, 5, 60, 'Noise removal', '%', 'Removes hiss, fans and room noise; too much sounds robotic'],
  warmth:   [-6, 6, 0.5, 0, 'Warmth', 'dB', 'Body of the voice, around 150 Hz'],
  mud:      [-8, 0, 0.5, -2, 'Mud cut', 'dB', 'Boxy, muffled room sound, around 350 Hz'],
  presence: [-6, 8, 0.5, 2, 'Clarity', 'dB', 'Words cut through, around 3.5 kHz'],
  air:      [0, 8, 0.5, 1, 'Air', 'dB', 'Sparkle on top, above 10 kHz'],
  deess:    [0, 100, 5, 20, 'De-ess', '%', 'Tames sharp S and T sounds'],
  evenness: [0, 100, 5, 35, 'Evenness', '%', 'Compression: quiet and loud parts closer together'],
  loudness: [-24, -12, 1, -16, 'Loudness', 'LUFS', '-16 is the usual target for online video'],
};

export const PRESETS = {
  Natural:      { gain: 0, rumble: 80, denoise: 50, warmth: 0, mud: -1, presence: 1, air: 1, deess: 10, evenness: 25, loudness: -16 },
  Podcast:      { gain: 0, rumble: 90, denoise: 75, warmth: 3, mud: -3, presence: 3, air: 2, deess: 35, evenness: 60, loudness: -16 },
  Crisp:        { gain: 0, rumble: 110, denoise: 70, warmth: -1, mud: -4, presence: 5, air: 4, deess: 45, evenness: 50, loudness: -16 },
  'Noisy room': { gain: 0, rumble: 130, denoise: 100, warmth: 0, mud: -2, presence: 2, air: 0, deess: 20, evenness: 40, loudness: -16 },
  Raw:          { gain: 0, rumble: 20, denoise: 0, warmth: 0, mud: 0, presence: 0, air: 0, deess: 0, evenness: 0, loudness: -16 },
};

export const PRESET_HINTS = {
  Natural: 'Light clean-up. Sounds like you.',
  Podcast: 'Warmer and more even, like a podcast mic.',
  Crisp: 'Brighter, words stand out.',
  'Noisy room': 'Strongest noise removal, for fans and chatter.',
  Raw: 'Untouched, only brought to a steady loudness.',
  Custom: 'Tuned by ear.',
};

export const SAMPLE_RATE = 48000;   // RNNoise needs 48 kHz

export function clean(raw = {}) {
  const out = {};
  for (const [k, [lo, hi, , def]] of Object.entries(PARAMS)) {
    const v = Number(raw[k]);
    out[k] = Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def;
  }
  return out;
}

// Each mic can keep its own sound (settings.voices[deviceId], '' = "Default mic"), like
// desktop. A mic without one uses the Default mic's sound (what you set up first, in
// the tuner or the popup), and only then Natural: picking your mic by name must not
// quietly undo the sound you chose.
export function voiceFor(settings, deviceId = '') {
  const v = settings?.voices?.[deviceId || ''] || settings?.voices?.[''];
  return v?.params ? { preset: v.preset || 'Custom', params: clean(v.params) } : { preset: 'Natural', params: { ...PRESETS.Natural } };
}

// The mic request. Chrome's own noise suppression and auto gain stay off: our chain does
// that job, and the same way in the tuner. Echo cancellation stays on, so a tab playing
// through speakers isn't recorded twice. If RNNoise couldn't load, Chrome's own noise
// suppression stands in (milder), the way desktop falls back to ffmpeg's afftdn.
export function micConstraints(params, deviceId, haveDenoise) {
  return {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    channelCount: 1,
    echoCancellation: true,
    autoGainControl: false,
    noiseSuppression: params.denoise > 0 && !haveDenoise,
  };
}

let wasmBytes = null;
async function rnnoiseBytes() {
  if (!wasmBytes) {
    // The SIMD build is ~2x faster; nearly every Chrome has SIMD.
    const simd = WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3,
      2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));
    const res = await fetch(chrome.runtime.getURL(`audio/${simd ? 'rnnoise_simd' : 'rnnoise'}.wasm`));
    if (!res.ok) throw new Error(`rnnoise.wasm: ${res.status}`);
    wasmBytes = await res.arrayBuffer();
  }
  return wasmBytes;
}

// Loads the worklet into an audio context. Returns RNNoise's bytes, or null when noise
// removal isn't available (then micConstraints asks Chrome for its own).
export async function prepare(ctx) {
  await ctx.audioWorklet.addModule(chrome.runtime.getURL('voice-worklet.js'));
  try { return await rnnoiseBytes(); } catch { return null; }
}

const dB = (x) => 10 ** (x / 20);

// Builds the chain after `input` and returns its last node (mono). Order as on desktop:
// trim → rumble cut → noise removal → EQ → evenness → de-ess → loudness → limiter.
export function buildChain(ctx, input, params, wasm) {
  const p = clean(params);
  const nodes = [];
  let last = input;
  const add = (node) => { last.connect(node); last = node; nodes.push(node); return node; };
  // The trim also folds a stereo mic down to one channel.
  add(new GainNode(ctx, { gain: dB(p.gain), channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' }));
  add(new BiquadFilterNode(ctx, { type: 'highpass', frequency: Math.max(p.rumble, 20), Q: Math.SQRT1_2 }));
  const worklet = (opts) => new AudioWorkletNode(ctx, 'lumen-voice', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit',
    processorOptions: opts,
  });
  // RNNoise runs even at 0% noise removal (the sound then passes untouched): the leveler
  // uses its speech detector. `id` pairs the two worklet stages of this chain.
  const id = Math.random().toString(36).slice(2);
  if (wasm) add(worklet({ stage: 'denoise', wasm, mix: p.denoise / 100, id }));
  if (p.warmth) add(new BiquadFilterNode(ctx, { type: 'peaking', frequency: 150, Q: 0.8, gain: p.warmth }));
  if (p.mud) add(new BiquadFilterNode(ctx, { type: 'peaking', frequency: 350, Q: 1.2, gain: p.mud }));
  if (p.presence) add(new BiquadFilterNode(ctx, { type: 'peaking', frequency: 3500, Q: 0.9, gain: p.presence }));
  if (p.air) add(new BiquadFilterNode(ctx, { type: 'highshelf', frequency: 10000, gain: p.air }));
  if (p.evenness > 0) {
    const e = p.evenness / 100;
    const threshold = -12 - 20 * e;
    const ratio = 1.5 + 4.5 * e;
    add(new DynamicsCompressorNode(ctx, { threshold, ratio, attack: 0.005, release: 0.08, knee: 4 }));
    // Web Audio's compressor also turns everything up ("makeup gain", spec: 0.6 × what
    // it takes off a 0 dB signal). Undo that: it would raise the room noise before you
    // speak, and the leveler sets the loudness anyway.
    add(new GainNode(ctx, { gain: dB(0.6 * threshold * (1 - 1 / ratio)) }));
  }
  // De-ess, loudness, and a limiter that keeps peaks under -1.5 dB (desktop's TP=-1.5).
  add(worklet({ stage: 'dynamics', deess: p.deess, loudness: p.loudness, id }));
  return {
    output: last,
    denoise: !!wasm,    // false: RNNoise didn't load (Chrome's own noise suppression instead)
    // Frees RNNoise's memory on the audio thread.
    dispose() {
      for (const n of nodes) {
        n.disconnect();
        if (n instanceof AudioWorkletNode) n.port.postMessage('destroy');
      }
    },
  };
}

// The tuner's preview: runs a recorded sample through the chain, faster than real time.
export async function render(sample, params, wasm) {
  const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: sample.length, sampleRate: SAMPLE_RATE });
  await ctx.audioWorklet.addModule(chrome.runtime.getURL('voice-worklet.js'));
  const src = new AudioBufferSourceNode(ctx, { buffer: sample });
  buildChain(ctx, src, params, wasm).output.connect(ctx.destination);
  src.start();
  return ctx.startRendering();
}
