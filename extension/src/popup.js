// The toolbar popup: pick what to record, mic on/off, countdown, then Record.
// It only launches; the recording itself runs in the offscreen document, and the
// popup is switched off until it ends (a toolbar click then means "stop").

import * as journal from './lib/journal.js';
import { duration, when, label, isUnfinished } from './lib/format.js';
import { getConnection, siteName } from './lib/share.js';
import { PRESETS, PRESET_HINTS, voiceFor } from './lib/voice.js';

const $ = (id) => document.getElementById(id);
const DEFAULTS = { mode: 'tab', mic: true, micDevice: '', voices: {}, countdown: 3, bubble: false, camera: '',
  bubbleShape: 'blob', bubbleOutline: 'plain', bubbleSize: 1, bubbleFollow: 'little', share: true };
let settings;
let conn = null;   // the connected share site, if any

const HINTS = {
  tab: 'One click, no picker. Records this tab’s picture and sound.',
  screen: 'Chrome asks which tab, window or screen. On Linux, sound comes only with a tab.',
};

async function save() {
  await chrome.storage.local.set({ settings });
  render();
}

function render() {
  for (const b of document.querySelectorAll('.seg button')) b.setAttribute('aria-checked', String(b.dataset.mode === settings.mode));
  $('mode-hint').textContent = HINTS[settings.mode];
  $('mic').checked = settings.mic;
  $('mic-opts').hidden = !settings.mic;
  renderSound();
  $('bubble').checked = settings.bubble;
  $('bubble-opts').hidden = !settings.bubble;
  for (const k of ['bubbleShape', 'bubbleOutline', 'bubbleSize', 'bubbleFollow', 'camera']) $(k).value = String(settings[k]);
  $('bubble-hint').textContent = settings.mode === 'tab'
    ? 'Appears on the page you record. Drag it; hover for size, shape and outline.'
    : 'Drawn into the video, bottom-left.';
  $('countdown').checked = settings.countdown > 0;
  // Share links: the switch only shows once a share site is connected.
  $('share-row').hidden = !conn;
  $('share').checked = !!settings.share;
  $('share-hint').textContent = conn
    ? (settings.share ? `The link is copied when you stop; the video uploads to ${siteName(conn)}${settings.transcribe !== false
      ? (settings.cleanup !== false ? ', ums cut, with a transcript' : ', with a transcript') : ''}.` : 'Saved on this computer only.')
    : '';
  $('share-hint').hidden = !conn;
  $('share-link').textContent = conn ? 'Share site ✓' : 'Get share links';
}

// The Sound menu: the mic's preset, or "Custom" once it was tuned by ear.
const TUNE = '__tune';
function renderSound() {
  const { preset } = voiceFor(settings, settings.micDevice);
  const names = Object.keys(PRESETS);
  const opts = names.map((n) => new Option(n, n));
  if (!names.includes(preset)) opts.push(new Option('Custom (tuned)', preset));
  const sep = new Option('──────────', ''); sep.disabled = true;
  $('sound').replaceChildren(...opts, sep, new Option('Fine-tune by ear…', TUNE));
  $('sound').value = preset;
  $('sound-hint').textContent = PRESET_HINTS[preset] || PRESET_HINTS.Custom;
}

async function pickSound() {
  const v = $('sound').value;
  if (v === TUNE) {
    chrome.tabs.create({ url: `tuner.html?mic=${encodeURIComponent(settings.micDevice || '')}` });
    window.close();
    return;
  }
  if (!PRESETS[v]) return;
  settings.voices = { ...settings.voices, [settings.micDevice || '']: { preset: v, params: { ...PRESETS[v] } } };
  save();
}

// The mic picker. Names are only visible once the mic was allowed.
async function showMics() {
  if (!(await micAllowed())) return;
  const mics = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default');
  $('micDevice').replaceChildren(new Option('Default mic', ''),
    ...mics.map((m, i) => new Option(m.label || `Mic ${i + 1}`, m.deviceId)));
  $('micDevice').value = mics.some((m) => m.deviceId === settings.micDevice) ? settings.micDevice : '';
}

async function micAllowed() {
  try { return (await navigator.permissions.query({ name: 'microphone' })).state === 'granted'; }
  catch { return false; }
}

async function showMicNotice() {
  $('mic-perm').hidden = !(settings.mic && !(await micAllowed()));
}

async function camAllowed() {
  try { return (await navigator.permissions.query({ name: 'camera' })).state === 'granted'; }
  catch { return false; }
}

// The camera picker. Names are only visible once the camera was allowed.
async function showCameras() {
  const allowed = await camAllowed();
  $('cam-perm').hidden = !(settings.bubble && !allowed);
  if (!allowed) return;
  const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  $('camera').replaceChildren(new Option('Default camera', ''),
    ...cams.map((c, i) => new Option(c.label || `Camera ${i + 1}`, c.deviceId)));
  $('camera').value = cams.some((c) => c.deviceId === settings.camera) ? settings.camera : '';
}

async function showRecordings() {
  const { live } = await chrome.runtime.sendMessage({ target: 'sw', type: 'status' });
  const rows = await journal.list();
  const unfinished = rows.filter((r) => isUnfinished(r, live?.id));
  if (unfinished.length) {
    $('unfinished').hidden = false;
    $('unfinished').innerHTML = `Lumen found ${unfinished.length === 1 ? 'an unfinished recording' : unfinished.length + ' unfinished recordings'}. <a href="recordings.html" target="_blank">Recover</a>`;
  }
  const recent = rows.filter((r) => r.state === 'done').slice(0, 3);
  $('recent-wrap').hidden = !recent.length;
  $('recent').replaceChildren(...recent.map((r) => {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `recordings.html?id=${encodeURIComponent(r.id)}`;
    a.target = '_blank';
    a.innerHTML = '<span class="t"></span><span class="dim"></span>';
    a.firstChild.textContent = label(r);
    a.lastChild.textContent = `${duration(r.duration ?? r.seconds)} · ${when(r.createdAt)}`;
    li.append(a);
    return li;
  }));
}

// Hand the start to the service worker and get out of the way at once: an open popup
// would sit on top of the 3·2·1 (and the page you're about to record). If starting
// fails, the worker puts "!" on the toolbar icon and the reason shows here next time.
function record() {
  $('record').disabled = true;
  chrome.runtime.sendMessage({ target: 'sw', type: 'start' }).catch(() => {});
  setTimeout(() => window.close(), 60);
}

async function showLastError() {
  const { startError } = await chrome.storage.session.get('startError');
  if (!startError) return;
  await chrome.storage.session.remove('startError');
  $('error').textContent = startError;
  $('error').hidden = false;
}

async function init() {
  showLastError();
  settings = { ...DEFAULTS, ...(await chrome.storage.local.get('settings')).settings };
  conn = await getConnection();
  render();
  $('share').onchange = () => { settings.share = $('share').checked; save(); };
  for (const b of document.querySelectorAll('.seg button')) b.onclick = () => { settings.mode = b.dataset.mode; save(); };
  $('mic').onchange = () => { settings.mic = $('mic').checked; save(); showMicNotice(); };
  $('micDevice').onchange = () => { settings.micDevice = $('micDevice').value; save(); };
  $('sound').onchange = pickSound;
  $('bubble').onchange = () => { settings.bubble = $('bubble').checked; save(); showCameras(); };
  $('camera').onchange = () => { settings.camera = $('camera').value; save(); };
  for (const k of ['bubbleShape', 'bubbleOutline', 'bubbleFollow']) $(k).onchange = () => { settings[k] = $(k).value; save(); };
  $('bubbleSize').onchange = () => { settings.bubbleSize = Number($('bubbleSize').value); save(); };
  $('countdown').onchange = () => { settings.countdown = $('countdown').checked ? 3 : 0; save(); };
  $('record').onclick = record;
  chrome.commands.getAll((cmds) => {
    const c = cmds.find((x) => x.name === 'toggle-recording');
    $('shortcut').textContent = c?.shortcut || 'set a shortcut';
  });
  showMicNotice();
  showMics();
  showCameras();
  showRecordings();
}

init();
