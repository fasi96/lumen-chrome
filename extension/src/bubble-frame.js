// The in-page face bubble (tab mode). bubble-inject.js puts this page in an iframe in
// the tab being recorded, so whatever it shows is part of the page and gets recorded.
// It doesn't touch the camera: the offscreen recorder sends each frame's picture and
// outline here over a BroadcastChannel (see bubble/broadcast.js for why). This page
// draws the bubble, lets you drag it, and has the hover toolbar (hidden while
// recording, so it never ends up in the video, as on the desktop).

import { SIZES, SHAPES, OUTLINES, drawBubble } from './bubble/bubble.js';
import { Spring } from './bubble/shape.js';
import { CHANNEL, frameSize } from './bubble/broadcast.js';

const $ = (id) => document.getElementById(id);
const canvas = $('c');
const ctx = canvas.getContext('2d');
const SIZE_NAMES = ['S', 'M', 'L'];
const label = (s) => s[0].toUpperCase() + s.slice(1);
const channel = new BroadcastChannel(CHANNEL);

// Tell the content script in the page (our parent) what to do with the iframe.
const toPage = (msg) => parent.postMessage({ lumenBubble: true, ...msg }, '*');

async function saveSettings(change) {
  const { settings = {} } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...settings, ...change } });
}

async function main() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  const look = { shape: settings.bubbleShape || 'blob', outline: settings.bubbleOutline || 'plain', size: settings.bubbleSize ?? 1 };
  toPage({ type: 'size', ...frameSize(SIZES[look.size]) });
  const d = new Spring(SIZES[look.size], 210, 1);   // the size, smoothly

  const showLook = () => {
    $('size').textContent = SIZE_NAMES[look.size];
    $('shape').textContent = label(look.shape);
    $('outline').textContent = label(look.outline);
  };
  const change = (key, value, settingName) => {
    look[key] = value;
    channel.postMessage({ type: 'look', look: { [key]: value } });
    saveSettings({ [settingName]: value });
    showLook();
  };
  const cycle = (list, v) => list[(list.indexOf(v) + 1) % list.length];
  showLook();
  $('size').onclick = () => {
    change('size', (look.size + 1) % SIZES.length, 'bubbleSize');
    d.target = SIZES[look.size];
    toPage({ type: 'size', ...frameSize(SIZES[look.size]) });
  };
  $('shape').onclick = () => change('shape', cycle(SHAPES, look.shape), 'bubbleShape');
  $('outline').onclick = () => change('outline', cycle(OUTLINES, look.outline), 'bubbleOutline');
  $('close').onclick = async () => {
    channel.postMessage({ type: 'close' });     // the camera goes off
    await saveSettings({ bubble: false });       // closing it turns the setting off
    toPage({ type: 'remove' });
  };

  // Drag: screen coordinates stay put while the iframe moves under the pointer.
  let drag = null;
  canvas.onpointerdown = (e) => { drag = [e.screenX, e.screenY]; canvas.setPointerCapture(e.pointerId); canvas.classList.add('dragging'); };
  canvas.onpointermove = (e) => {
    if (!drag) return;
    toPage({ type: 'move', dx: e.screenX - drag[0], dy: e.screenY - drag[1] });
    drag = [e.screenX, e.screenY];
  };
  canvas.onpointerup = canvas.onpointercancel = () => { drag = null; canvas.classList.remove('dragging'); };
  document.body.onpointerenter = () => document.body.classList.add('hover');
  document.body.onpointerleave = () => document.body.classList.remove('hover');

  // Hide the toolbar while recording.
  const showRecording = (live) => document.body.classList.toggle('recording', live?.phase === 'recording');
  showRecording((await chrome.storage.session.get('live')).live);
  chrome.storage.onChanged.addListener((ch, area) => { if (area === 'session' && 'live' in ch) showRecording(ch.live.newValue); });

  // Draw each frame from the recorder.
  const stats = { frames: 0 };
  globalThis.lumenBubbleFrame = stats;           // for the tests
  let last = performance.now();
  let barTop = -1;
  channel.onmessage = ({ data: m }) => {
    if (m?.type !== 'frame') return;
    const now = performance.now();
    d.step((now - last) / 1000);
    last = now;
    const dpr = devicePixelRatio || 1;
    const W = innerWidth, H = innerHeight;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Centred in the square part above the toolbar.
    drawBubble(ctx, { picture: m.picture, pts: m.pts, pop: m.pop, cx: W / 2, cy: W / 2, d: d.x, outline: look.outline, t: m.t, mirror: m.mirror });
    m.picture.close();
    m.whole?.close();                            // only the floating window uses it
    // Keep the toolbar just under the bubble, wherever its edge is right now.
    let bottom = 0;
    for (const [, y] of m.pts) bottom = Math.max(bottom, y);
    const top = Math.round(W / 2 + (bottom - 0.5) * d.x * Math.max(0, m.pop) + 10);
    if (Math.abs(top - barTop) > 3) { barTop = Math.min(top, H - 30); $('bar').style.top = `${barTop}px`; }
    stats.frames++;
    if (m.c && m.R) {
      // For the tests: how round the first frames are, and how far any ray strays
      // from the circle (as a multiple of its radius).
      let lo = Infinity, hi = 0;
      for (const [x, y] of m.pts) { const r = Math.hypot(x - m.c[0], y - m.c[1]) / m.R; lo = Math.min(lo, r); hi = Math.max(hi, r); }
      if (stats.frames <= 5) (stats.first ??= []).push([+lo.toFixed(3), +hi.toFixed(3)]);
      stats.minRatio = Math.min(stats.minRatio ?? Infinity, lo);
      stats.maxRatio = Math.max(stats.maxRatio ?? 0, hi);
    }
    $('msg').textContent = '';
  };
  $('msg').textContent = 'Starting camera…';
}

// Inside the floating window (bubble-inject.js): the whole camera picture, mirrored,
// filling the window; "Back to the page" on hover. The window's size and place are the
// desktop's to manage (drag its edge to resize).
function floatMain() {
  document.body.classList.add('float');
  // "I'm open", until the camera's pictures arrive: the window can open before the
  // recorder (from the question asked before Chrome's picker).
  let lastFrame = 0;
  const hello = () => { if (performance.now() - lastFrame > 1000) channel.postMessage({ type: 'pip', on: true }); };
  hello();
  setInterval(hello, 1000);
  addEventListener('pagehide', () => channel.postMessage({ type: 'pip', on: false }));
  document.body.onpointerenter = () => document.body.classList.add('hover');
  document.body.onpointerleave = () => document.body.classList.remove('hover');
  $('back').onclick = () => parent.postMessage({ lumenBubble: true, type: 'unfloat' }, '*');
  channel.onmessage = ({ data: m }) => {
    // The recorder looks for this window in the recording: what it shows, at its size.
    if (m?.type === 'pip-query') { channel.postMessage({ type: 'pip', on: true }); return; }
    if (m?.type === 'snap-req') {
      createImageBitmap(canvas).then((shot) => { channel.postMessage({ type: 'snap', n: m.n, shot }); shot.close(); }).catch(() => {});
      return;
    }
    if (m?.type !== 'frame') return;
    lastFrame = performance.now();
    const pic = m.whole || m.picture;
    if (!pic) return;
    const dpr = devicePixelRatio || 1;
    const W = innerWidth, H = innerHeight;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
    }
    // Cover: fill the window, cropping the picture's edges, mirrored like a mirror.
    const k = Math.max(canvas.width / pic.width, canvas.height / pic.height);
    const w = pic.width * k, h = pic.height * k;
    ctx.setTransform(-1, 0, 0, 1, canvas.width, 0);
    ctx.drawImage(pic, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
    m.picture?.close();
    m.whole?.close();
    $('msg').textContent = '';
  };
  $('msg').textContent = 'Starting camera…';
}

// Screen recordings: the bubble is drawn into the video, and the page only gets this
// button. It shows for the first seconds, then fades (it's on the screen being recorded)
// and comes back on hover. Clicked, the camera floats over every app.
function pillMain() {
  document.body.classList.add('pill', 'hint');
  setTimeout(() => document.body.classList.remove('hint'), 10000);
  document.body.onpointerenter = () => document.body.classList.add('hover');
  document.body.onpointerleave = () => document.body.classList.remove('hover');
  $('float').onclick = () => toPage({ type: 'float' });
}

// Screen recordings, before Chrome's picker: "Show your camera while you record?".
function askMain() {
  document.body.classList.add('ask');
  const answer = (a) => toPage({ type: 'answer', answer: a });
  $('ask-yes').onclick = () => answer('float');
  $('ask-no').onclick = () => answer('skip');
  $('ask-yes').focus();
}

const mode = new URLSearchParams(location.search);
if (mode.has('float')) floatMain();
else if (mode.has('pill')) pillMain();
else if (mode.has('ask')) askMain();
else main();
