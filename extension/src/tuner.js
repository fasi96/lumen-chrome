// "Fine-tune by ear": record a sample from a mic, then hear presets and sliders on it
// straight away. The preview runs the sample through the very chain a recording uses
// (lib/voice.js), faster than real time. The last sample per mic is kept in the
// extension's own storage on this computer (like desktop's tuner), so you can come back
// and tweak without recording again; "Delete sample" removes it.

import { PARAMS, PRESETS, SAMPLE_RATE, clean, voiceFor, micConstraints, prepare, render } from './lib/voice.js';
import { readFile, writeFile, deleteFile } from './lib/opfs.js';

const $ = (id) => document.getElementById(id);
const MAX_SECONDS = 30;

let settings = {};
let mic = new URLSearchParams(location.search).get('mic') || '';
let params = { ...PRESETS.Natural };
let saved = null;          // what this mic uses now, for Revert
let ctx = null;            // plays the preview, and hosts the sample tap
let wasm = null;           // RNNoise, or null (then the tuner says noise removal is off)
let ready = null;          // loading the worklet + RNNoise
let loaded = false;
let sample = null;         // AudioBuffer: the raw mic sample
let tuned = null;          // AudioBuffer: the sample through the chain
let showTuned = true;
let player = null;         // { node, startedAt, offset }
let recording = null;      // { stream, tap, chunks, n, timer }

// ---- setup ---------------------------------------------------------------------

// The audio context loads at once (worklet + RNNoise); it may only start playing after
// a click, so audio() (called from clicks) also resumes it.
function load() {
  ctx ??= new AudioContext({ sampleRate: SAMPLE_RATE });
  ready ??= prepare(ctx).then((w) => { wasm = w; });
  return ready;
}

async function audio() {
  await load();
  if (ctx.state === 'suspended') await ctx.resume();
  return ctx;
}

async function loadSettings() {
  settings = (await chrome.storage.local.get('settings')).settings || {};
  const v = voiceFor(settings, mic);
  params = { ...v.params };
  saved = { ...v.params };
}

async function listMics() {
  let allowed = false;
  try { allowed = (await navigator.permissions.query({ name: 'microphone' })).state === 'granted'; } catch { /* older Chrome */ }
  $('perm').hidden = allowed;
  if (!allowed) return;
  const mics = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default');
  $('mic').replaceChildren(new Option('Default mic', ''), ...mics.map((m, i) => new Option(m.label || `Mic ${i + 1}`, m.deviceId)));
  if (!mics.some((m) => m.deviceId === mic)) mic = '';
  $('mic').value = mic;
}

// ---- the sample ----------------------------------------------------------------

// Raw 32-bit float samples at 48 kHz, one file per mic.
const sampleFile = () => `tuner-sample-${(mic || 'default').replace(/[^\w-]/g, '_').slice(0, 100)}.f32`;

function useSample(data, note) {
  sample = new AudioBuffer({ numberOfChannels: 1, length: data.length, sampleRate: SAMPLE_RATE });
  sample.copyToChannel(data, 0);
  $('rec-note').textContent = note;
  $('rec').textContent = '● Record again';
  $('forget').hidden = false;
  for (const id of ['play', 'abT', 'abO']) $(id).disabled = false;
}

function noSample() {
  stopPlaying();
  sample = tuned = null;
  $('rec').textContent = '● Record';
  $('rec-note').textContent = 'Talk the way you would in a video, for 10–20 seconds. Include a pause so noise removal has something to work on.';
  $('forget').hidden = true;
  for (const id of ['play', 'abT', 'abO']) $(id).disabled = true;
}

async function loadSample() {
  noSample();
  const f = await readFile(sampleFile());
  if (!f?.size) return;
  const when = new Date(f.lastModified).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  useSample(new Float32Array(await f.arrayBuffer()), `Your sample from ${when}. Press Play, or record a new one.`);
  await load();
  await rerender();
}

async function startRecording() {
  stopPlaying();
  const c = await audio();
  let stream;
  try {
    // Exactly how a recording asks for the mic, so the sample is what the chain will get.
    stream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(params, mic, !!wasm) });
  } catch (e) {
    $('rec-note').textContent = `Couldn’t open the mic: ${e.message}`;
    return;
  }
  const src = c.createMediaStreamSource(stream);
  const tap = new AudioWorkletNode(c, 'lumen-voice', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit',
    processorOptions: { stage: 'tap' },
  });
  const sink = new GainNode(c, { gain: 0 });    // keeps the tap running; plays nothing
  src.connect(tap).connect(sink).connect(c.destination);
  recording = { stream, src, tap, sink, chunks: [], n: 0, peak: 0, started: performance.now() };
  tap.port.onmessage = (e) => {
    const r = recording;
    if (!r) return;
    r.chunks.push(e.data);
    r.n += e.data.length;
    let peak = 0;
    for (const v of e.data) peak = Math.max(peak, Math.abs(v));
    r.peak = Math.max(r.peak, peak);
    $('meter').firstChild.style.width = `${Math.min(100, Math.sqrt(peak) * 100)}%`;
    $('meter').classList.toggle('clip', peak > 0.98);
    $('secs').textContent = `${(r.n / SAMPLE_RATE).toFixed(0)} s`;
    if (r.n >= MAX_SECONDS * SAMPLE_RATE) stopRecording();
  };
  $('rec').textContent = '■ Stop';
  $('rec').classList.add('on');
  $('mic').disabled = true;
}

async function stopRecording() {
  const r = recording;
  if (!r) return;
  recording = null;
  r.stream.getTracks().forEach((t) => t.stop());
  r.src.disconnect(); r.tap.disconnect(); r.sink.disconnect();
  r.tap.port.close();
  $('rec').textContent = '● Record again';
  $('rec').classList.remove('on');
  $('mic').disabled = false;
  $('meter').firstChild.style.width = '0';
  if (r.n < SAMPLE_RATE * 2) {
    $('rec-note').textContent = 'That was very short. Record at least a few seconds.';
    return;
  }
  const data = new Float32Array(r.n);
  let at = 0;
  for (const c of r.chunks) { data.set(c, at); at += c.length; }
  useSample(data, r.peak > 0.98
    // Input trim can't undo this: it happened in the mic, before Lumen got the sound.
    ? 'Your sample hit the top of the mic’s range, so loud parts may crackle. Turn the mic’s input volume down a little in your system’s sound settings (or sit a bit further back), then record again.'
    : `Got ${(r.n / SAMPLE_RATE).toFixed(0)} seconds. Now try the presets below.`);
  writeFile(sampleFile(), data.buffer).catch(() => {});
  await rerender();
  play();
}

// ---- preview -------------------------------------------------------------------

let renderToken = 0;
async function rerender() {
  if (!sample) return;
  const token = ++renderToken;
  const out = await render(sample, params, wasm);
  if (token !== renderToken) return;     // a newer change is already rendering
  tuned = out;
  if (player && showTuned) play(position());   // swap in the new sound where you are
}

let debounce = 0;
function changed() {
  renderControls();
  clearTimeout(debounce);
  debounce = setTimeout(rerender, 120);
}

function position() {
  if (!player) return 0;
  return (player.offset + ctx.currentTime - player.startedAt) % sample.duration;
}

function stopPlaying() {
  if (!player) return;
  player.node.onended = null;
  player.node.stop();
  player = null;
  $('play').textContent = '▶ Play';
}

function play(from = 0) {
  const buf = showTuned ? tuned : sample;
  if (!buf || !ctx) return;
  if (ctx.state === 'suspended') ctx.resume();
  stopPlaying();
  const node = new AudioBufferSourceNode(ctx, { buffer: buf });
  node.connect(ctx.destination);
  node.start(0, from);
  node.onended = () => { if (player?.node === node) { player = null; $('play').textContent = '▶ Play'; } };
  player = { node, startedAt: ctx.currentTime, offset: from };
  $('play').textContent = '■ Stop';
}

function setAB(tunedOn) {
  showTuned = tunedOn;
  $('abT').classList.toggle('on', tunedOn);
  $('abO').classList.toggle('on', !tunedOn);
  if (player) play(position());
}

// ---- controls ------------------------------------------------------------------

const same = (a, b) => Object.keys(PARAMS).every((k) => Number(a[k]) === Number(b[k]));
const presetName = (p) => Object.keys(PRESETS).find((n) => same(PRESETS[n], p)) || null;

function buildControls() {
  $('presets').replaceChildren(...Object.keys(PRESETS).map((name) => {
    const b = document.createElement('button');
    b.textContent = name;
    b.onclick = () => { params = { ...PRESETS[name] }; changed(); };
    return b;
  }));
  $('sliders').replaceChildren(...Object.entries(PARAMS).map(([k, [lo, hi, step, , label, unit, hint]]) => {
    const el = document.createElement('label');
    el.className = 'slider';
    el.dataset.key = k;
    el.innerHTML = '<div class="top"><b></b><span></span></div><input type="range"><div class="hint"></div>';
    el.querySelector('b').textContent = label;
    el.querySelector('.hint').textContent = hint;
    const input = el.querySelector('input');
    Object.assign(input, { min: lo, max: hi, step });
    input.oninput = () => { params[k] = Number(input.value); changed(); };
    el.dataset.unit = unit;
    return el;
  }));
}

function renderControls() {
  const name = presetName(params);
  for (const b of $('presets').children) b.classList.toggle('on', b.textContent === name);
  for (const el of $('sliders').children) {
    const k = el.dataset.key;
    el.querySelector('input').value = params[k];
    const v = params[k];
    el.querySelector('span').textContent = `${v > 0 && el.dataset.unit === 'dB' ? '+' : ''}${v} ${el.dataset.unit}`;
  }
  const dn = $('sliders').querySelector('[data-key="denoise"]');
  const missing = loaded && !wasm;
  dn.classList.toggle('off', missing);
  dn.querySelector('.hint').textContent = missing
    ? 'Lumen’s noise remover couldn’t load here, so Chrome’s own (milder) is used' : PARAMS.denoise[6];
  $('revert').disabled = same(params, saved);
}

async function save() {
  settings = (await chrome.storage.local.get('settings')).settings || {};
  const preset = presetName(params) || 'Custom';
  settings.voices = { ...(settings.voices || {}), [mic]: { preset, params: clean(params) } };
  settings.micDevice = mic;     // the mic you tuned is the one you'll record with
  await chrome.storage.local.set({ settings });
  saved = { ...params };
  $('msg').className = 'small ok';
  $('msg').textContent = `✓ Your recordings with ${$('mic').selectedOptions[0]?.textContent || 'this mic'} will sound like this${preset === 'Custom' ? '' : ` (${preset})`}.`;
  renderControls();
}

async function init() {
  await loadSettings();
  await listMics();
  await loadSettings();          // the mic may have fallen back to the default
  buildControls();
  renderControls();
  $('rec').onclick = () => (recording ? stopRecording() : startRecording());
  $('mic').onchange = async () => {
    mic = $('mic').value;
    $('msg').textContent = '';
    await loadSettings();
    renderControls();
    await loadSample();
  };
  $('forget').onclick = async (e) => {
    e.preventDefault();
    await deleteFile(sampleFile());
    noSample();
  };
  $('play').onclick = () => (player ? stopPlaying() : play());
  $('abT').onclick = () => setAB(true);
  $('abO').onclick = () => setAB(false);
  $('revert').onclick = () => { params = { ...saved }; changed(); };
  $('save').onclick = save;
  addEventListener('keydown', (e) => {
    if (e.target.closest('select, input[type=text]') || !sample) return;
    if (e.code === 'Space') { e.preventDefault(); player ? stopPlaying() : play(); }
    if (e.key === 'b' || e.key === 'B') setAB(!showTuned);
  });
  // Before Record, so the noise-removal row knows whether RNNoise is there.
  load().catch(() => {}).finally(() => { loaded = true; renderControls(); });
  loadSample().catch(() => {});
}

init();

// For the automated test (test/voice.mjs): render presets on a made-up sample.
globalThis.lumenVoice = { PRESETS, render, wasm: () => load().then(() => wasm) };
