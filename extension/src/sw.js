// Lumen's service worker. Chrome can stop it after 30 s of quiet, so it keeps no
// recording state in variables: the live state lives in chrome.storage.session
// and the recorder (offscreen document) does the real work. This file only
// routes: popup / shortcut / toolbar click → recorder, recorder → badge.

import * as journal from './lib/journal.js';
import { getConnection } from './lib/share.js';
import { voiceFor } from './lib/voice.js';

const { newId } = journal;

const OFFSCREEN = 'offscreen.html';
const RECORDER_TAB = 'recorder.html';
const DEFAULTS = {
  mode: 'tab', mic: true, countdown: 3,
  // micDevice = deviceId ('' = Chrome's default mic); voices = { [micDevice]: { preset, params } }.
  micDevice: '', voices: {},
  // Face bubble: off by default. camera = deviceId ('' = Chrome's default camera).
  bubble: false, camera: '', bubbleShape: 'blob', bubbleOutline: 'plain', bubbleSize: 1, bubbleCorner: 'bottom-left',
  bubbleFollow: 'little',   // how much the blob leans toward you: 'little' (calm) | 'more'
  share: true,              // when a share site is connected: make a link when you stop
  transcribe: true,         // …with a transcript, title and chapters from the share site's AI
  cleanup: true,            // …and ums and long pauses cut out of the shared copy
};

// ---- live state -------------------------------------------------------------
// { id, mode, host: 'offscreen'|'tab', hostTabId?, phase: 'starting'|'countdown'|'recording'|'saving' }
const getLive = async () => (await chrome.storage.session.get('live')).live || null;
const setLive = (live) => (live ? chrome.storage.session.set({ live }) : chrome.storage.session.remove('live'));

export async function settings() {
  return { ...DEFAULTS, ...(await chrome.storage.local.get('settings')).settings };
}

// ---- toolbar look -------------------------------------------------------------
// While recording, the popup is switched off so one click on the icon means "stop".
async function showIdle() {
  await chrome.action.setBadgeText({ text: '' });
  await chrome.action.setPopup({ popup: 'popup.html' });
  await chrome.action.setTitle({ title: 'Lumen: record' });
}
async function showBusy(text, color, title) {
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
  await chrome.action.setPopup({ popup: '' });
  await chrome.action.setTitle({ title });
}

// ---- the recorder host ------------------------------------------------------
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN,
    reasons: ['USER_MEDIA', 'DISPLAY_MEDIA', 'WORKERS', 'BLOBS', 'CLIPBOARD'],
    justification: 'Records the tab or screen you chose, with your mic, saves it on this computer, and (if you connected your own share site) uploads it there and copies the link.',
  });
}

const toHost = (msg) => chrome.runtime.sendMessage({ target: 'host', ...msg });
// The uploader lives only in the offscreen document (it outlives tabs and the popup).
const toUploader = async (msg) => { await ensureOffscreen(); return chrome.runtime.sendMessage({ target: 'uploader', ...msg }); };

// ---- sharing ----------------------------------------------------------------------
// "Screen recording · 10 Oct 19:15", like vshare's default title.
function defaultTitle() {
  const d = new Date();
  return `Screen recording · ${d.getDate()} ${d.toLocaleString('en-GB', { month: 'short' })} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// Starts (or resumes, or retries) sharing one saved recording.
async function shareNow(id, title) {
  const conn = await getConnection();
  if (!conn) return { ok: false, error: 'No share site connected' };
  const s = await settings();
  await toUploader({ type: 'share', id, conn, title, ai: s.transcribe, clean: s.cleanup });
  return { ok: true };
}

// Shares that didn't finish (Chrome was closed, the network dropped…) carry on
// whenever the service worker starts.
async function resumeShares() {
  const conn = await getConnection();
  if (!conn) return;
  const rows = (await journal.list()).filter((r) => r.state === 'done' && r.share
    && (r.share.state === 'uploading' || r.share.state === 'creating'));
  const s = await settings();
  for (const r of rows.reverse()) await toUploader({ type: 'share', id: r.id, conn, ai: s.transcribe, clean: s.cleanup }).catch(() => {});
}

// Upload progress on the toolbar badge (only when nothing is recording).
async function showShareBadge(text, color, title) {
  if (await getLive()) return;
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
  await chrome.action.setTitle({ title });
}

// Opens the pinned fallback recorder tab and waits until it says it's ready.
async function openRecorderTab() {
  const ready = new Promise((resolve) => {
    const on = (msg) => {
      if (msg.target === 'sw' && msg.type === 'host-ready' && msg.from === 'tab') {
        chrome.runtime.onMessage.removeListener(on);
        resolve();
      }
    };
    chrome.runtime.onMessage.addListener(on);
  });
  const tab = await chrome.tabs.create({ url: RECORDER_TAB, pinned: true, active: true });
  await ready;
  return tab;
}

// ---- the in-page bubble (tab mode) -------------------------------------------
// Injected only into the tab being recorded, only after the user started recording
// it (activeTab), and removed when the recording ends.
// Returns false on pages Chrome keeps extensions out of (chrome://, extension pages,
// the Web Store): the recorder then draws the bubble into the video instead.
// pill: screen recordings, where the bubble is drawn into the video: just the
// "Show my camera" button that floats the camera over every app (bubble-inject.js);
// 'ask': first the "Show your camera while you record?" question, before the picker.
// Lumen's own pages (the review page, where the next recording often starts) can't be
// scripted, but they listen and add it themselves (lib/page-bubble.js).
async function showBubble(tabId, id, { pill = false } = {}) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url?.startsWith(chrome.runtime.getURL(''))) {
      const r = await chrome.tabs.sendMessage(tabId, { type: 'lumen-page-bubble', pill }).catch(() => null);
      if (!r?.ok) throw new Error('this Lumen page can’t show it');
    } else {
      await chrome.scripting.executeScript({ target: { tabId }, func: (p) => { window.__lumenBubblePill = p; }, args: [pill] });
      await chrome.scripting.executeScript({ target: { tabId }, files: ['bubble-inject.js'] });
    }
    const live = await getLive();
    if (live?.id === id) await setLive({ ...live, bubbleTab: tabId });
    return true;
  } catch (e) {
    console.warn('[lumen] could not add the bubble to this page, drawing it into the video:', e.message);
    return false;
  }
}

// Shows the question and waits for the answer ('float' | 'skip'; 'skip' too if it can't
// be shown or nobody answers in 30 s). The page keeps the pill afterwards.
const camAnswers = new Map();     // recording id → resolve
function askCamera(tabId, id) {
  return new Promise((resolve) => {
    const done = (a) => { camAnswers.delete(id); clearTimeout(t); resolve(a); };
    const t = setTimeout(() => done('skip'), 30000);
    camAnswers.set(id, done);
    showBubble(tabId, id, { pill: 'ask' }).then((ok) => { if (!ok) done('skip'); });
  });
}

// The big 3·2·1 overlay. Gone before the recorder starts, so it's never recorded.
async function showCountdown(tabId, id) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['countdown-inject.js'] });
    const live = await getLive();
    if (live?.id === id) await setLive({ ...live, countdownTab: tabId });
  } catch (e) {
    console.warn('[lumen] no countdown on this page (badge only):', e.message);
  }
}

async function hideCountdown(live) {
  if (live?.countdownTab) await chrome.tabs.sendMessage(live.countdownTab, { type: 'lumen-countdown', n: 0 }).catch(() => {});
}

async function hideBubble(live) {
  if (live?.bubbleTab) await chrome.tabs.sendMessage(live.bubbleTab, { type: 'lumen-bubble-remove' }).catch(() => {});
}

// The page's visible area and its pixel density, measured in the page. chrome.tabs'
// width/height can include an info bar (or lag a window resize), and tab capture pads
// any difference in shape with black bars, so the page itself is asked. null on pages
// scripts can't run on (chrome://, the Web Store): then the tab's size is used.
async function pageSize(tabId) {
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId },
      func: () => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio }) });
    return r?.result?.width ? r.result : null;
  } catch {
    return null;
  }
}

// ---- start / stop -------------------------------------------------------------
// tab: the tab the user was on when they clicked (popup) or pressed the shortcut.
export async function start(tab, overrides = {}) {
  if (await getLive()) return { ok: false, error: 'Already recording' };
  const s = { ...(await settings()), ...overrides };
  const id = newId();
  const opts = { id, mode: s.mode, mic: s.mic, countdown: s.countdown, title: tab?.title || '', codec: s.codec,
    tabSize: tab?.width ? { width: tab.width, height: tab.height } : null,
    // The mic and how it sounds (its preset or tuned settings, lib/voice.js).
    micDevice: s.micDevice, voice: voiceFor(s, s.micDevice) };
  // The recorder draws the bubble. Screen mode: into the video. Tab mode: into an
  // iframe that showBubble() puts in the page, so the tab capture records it.
  if (s.bubble) {
    opts.bubble = { deviceId: s.camera, corner: s.bubbleCorner, delegate: s.bubbleDelegate,
      look: { shape: s.bubbleShape, outline: s.bubbleOutline, size: s.bubbleSize, follow: s.bubbleFollow } };
  }
  // Share when done: only with a connected share site and the switch on.
  const share = !!(s.share && (await getConnection()));
  await setLive({ id, mode: s.mode, host: 'offscreen', phase: 'starting', tabId: tab?.id, bubbleTab: null, countdownTab: null,
    share, title: opts.title || defaultTitle() });
  await showBusy('…', '#8b8cf6', 'Lumen: starting');

  try {
    if (s.mode === 'tab') {
      // Must happen right after the user's click/shortcut on this tab.
      opts.streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
      opts.tabSize = (await pageSize(tab.id)) || opts.tabSize;
      if (s.bubble && !(await showBubble(tab.id, id))) opts.bubble.inVideo = true;
    }
    // Screen mode with the bubble: "Show your camera while you record?" on your tab first.
    // That click is what lets the page open the floating camera window (Chrome allows it
    // only from a click in a page); the picker comes after.
    if (s.mode === 'screen' && s.bubble && tab?.id) {
      const answer = await askCamera(tab.id, id);
      if (answer === 'cancel') throw new Error('cancelled');
    }
    // The 3·2·1 on the page you clicked on (screen mode too: it's where you're looking).
    if (s.countdown > 0 && tab?.id) await showCountdown(tab.id, id);
    await ensureOffscreen();
    let res = await toHost({ type: 'start', opts });

    // Screen mode: if Chrome won't show its picker for the offscreen document,
    // fall back to a pinned Lumen tab that asks for the screen itself. (M0 found
    // the offscreen path works on Chrome 152 Linux; this is the safety net.)
    if (!res?.ok && s.mode === 'screen' && !/NotAllowedError|AbortError.*cancel/i.test(res?.error || '')) {
      console.warn('[lumen] offscreen getDisplayMedia failed, trying recorder tab:', res?.error);
      await chrome.offscreen.closeDocument().catch(() => {});
      const rt = await openRecorderTab();
      await setLive({ id, mode: s.mode, host: 'tab', hostTabId: rt.id, phase: 'starting' });
      res = await toHost({ type: 'start', opts });
    }
    if (!res?.ok) throw new Error(res?.error || 'recorder did not answer');
    return { ok: true, id };
  } catch (e) {
    chrome.runtime.sendMessage({ target: 'preview', on: false }).catch(() => {});   // the floating window's camera
    await hideBubble(await getLive());
    await hideCountdown(await getLive());
    await setLive(null);
    await showIdle();
    // A cancelled picker isn't an error worth shouting about. Anything else: the popup
    // has already closed, so leave a red "!" on the icon and the reason for next time.
    if (!/NotAllowedError/.test(String(e))) {
      console.error('[lumen] start failed', e);
      await chrome.storage.session.set({ startError: 'Couldn\'t start: ' + String(e.message || e) });
      await showBusy('!', '#ef4444', 'Lumen: couldn\'t start — click for details');
      setTimeout(async () => { if (!(await getLive())) await showIdle(); }, 6000);
    }
    return { ok: false, error: String(e.message || e) };
  }
}

export async function stop() {
  const live = await getLive();
  if (!live) return { ok: false, error: 'Not recording' };
  await showBusy('…', '#6b7280', 'Lumen: saving');
  await toHost({ type: 'stop' }).catch(() => {});
  return { ok: true, id: live.id };
}

export async function toggle(tab) {
  return (await getLive()) ? stop() : start(tab);
}

// ---- events -------------------------------------------------------------------
// Toolbar click while recording (the popup is off then) = stop.
chrome.action.onClicked.addListener(() => { stop(); });

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'toggle-recording') toggle(tab);
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.target !== 'sw') return;
  (async () => {
    switch (msg.type) {
      // From the popup.
      case 'start': {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        return reply(await start(tab, msg.overrides));
      }
      case 'stop': return reply(await stop());
      case 'status': return reply({ live: await getLive() });

      // From the recorder.
      case 'tick': {
        const live = await getLive();
        if (live) await setLive({ ...live, phase: 'countdown' });
        if (live?.countdownTab) await chrome.tabs.sendMessage(live.countdownTab, { type: 'lumen-countdown', n: msg.n }).catch(() => {});
        if (!msg.n) return showBusy('…', '#8b8cf6', 'Lumen: starting… click to cancel');
        return showBusy(String(msg.n), '#8b8cf6', 'Lumen: starting… click to cancel');
      }
      case 'started': {
        const live = await getLive();
        await hideCountdown(live);          // normally gone already (tick 0)
        await setLive({ ...live, phase: 'recording', mime: msg.mime });
        return showBusy('REC', '#dc2626', 'Lumen: recording. Click (or press your Lumen shortcut) to stop');
      }
      case 'stopped': {
        const live = await getLive();
        await hideBubble(live);
        if (live) await setLive({ ...live, phase: 'saving' });
        await showBusy('…', '#6b7280', 'Lumen: saving');
        // The share link first, before the MP4 is even made: created and copied now.
        if (live?.share && live.id === msg.id) {
          const conn = await getConnection();
          const codec = /h264|avc1/.test(live.mime || '') ? 'h264' : /vp8/.test(live.mime || '') ? 'vp8' : 'vp9';
          if (conn) await toUploader({ type: 'create', id: msg.id, conn, title: live.title, codec }).catch(() => {});
        }
        return;
      }
      case 'warn':
        return console.warn('[lumen] recorder warning', msg.error);
      // The answer to "Show your camera while you record?" (from the page).
      case 'camera-answer': {
        const live = await getLive();
        // The floating window shows the camera at once, while you pick a screen.
        if (msg.answer === 'float') {
          await ensureOffscreen();
          chrome.runtime.sendMessage({ target: 'preview', on: true, deviceId: (await settings()).camera }).catch(() => {});
        }
        camAnswers.get(live?.id)?.(msg.answer);
        return;
      }
      // Screen recording with the bubble: the "Show my camera" pill on the tab you started
      // from (the bubble itself is drawn into the video).
      case 'bubble-live': {
        const live = await getLive();
        const tab = live?.tabId ? await chrome.tabs.get(live.tabId).catch(() => null) : null;
        if (!tab) return reply({ ok: false, error: 'the tab is gone' });
        const ok = await showBubble(tab.id, msg.id, { pill: true });
        return reply(ok ? { ok } : { ok, error: `Chrome doesn’t allow it on ${/^chrome-extension:/.test(tab.url || '') ? 'Lumen’s own pages' : 'this page'}` });
      }

      // From the uploader (offscreen document).
      case 'share-link':
        return showShareBadge('0%', '#8b8cf6', msg.copied ? 'Lumen: link copied, uploading…' : 'Lumen: uploading…');
      case 'clean-progress':
        return showShareBadge(`✂${Math.min(99, msg.pct)}`, '#8b8cf6', `Lumen: cutting ums and pauses ${msg.pct}%`);
      case 'upload-progress':
        return showShareBadge(`${Math.min(99, msg.pct)}%`, '#8b8cf6', `Lumen: uploading ${msg.pct}%`);
      case 'upload-done':
        await showShareBadge('✓', '#16a34a', 'Lumen: shared');
        setTimeout(async () => { if (!(await getLive())) await showIdle(); }, 5000);
        return;
      case 'upload-failed':
        await showShareBadge('!', '#ef4444', `Lumen: sharing failed — ${msg.error}. Open the recording to retry.`);
        setTimeout(async () => { if (!(await getLive())) await showIdle(); }, 8000);
        return;

      // From the recordings page.
      case 'share-now': return reply(await shareNow(msg.id));
      case 'cancelled':
        await hideCountdown(await getLive());
        await hideBubble(await getLive());
        await setLive(null);
        return showIdle();
      case 'saved':
      case 'error': {
        const live = await getLive();
        if (live && live.id !== msg.id) return; // about an older recording
        await hideBubble(live);
        await setLive(null);
        await showIdle();
        if (msg.type === 'error') console.error('[lumen] recorder error', msg.error);
        if (msg.type === 'saved' && live?.share) await shareNow(msg.id, live.title).catch(() => {});
        // Close the fallback recorder tab, then show the result.
        if (live?.host === 'tab' && live.hostTabId) chrome.tabs.remove(live.hostTabId).catch(() => {});
        if (msg.id) chrome.tabs.create({ url: `recordings.html?id=${encodeURIComponent(msg.id)}` });
        return;
      }
    }
  })();
  return ['start', 'stop', 'status', 'share-now', 'bubble-live'].includes(msg.type);
});

// Fresh browser session: nothing can be recording, so reset the toolbar.
chrome.runtime.onStartup.addListener(async () => { await setLive(null); await showIdle(); });

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await showIdle();
  // Once per profile: an unpacked copy loaded with --load-extension counts as a fresh
  // install at every browser start, and the welcome tab then got recorded by mistake.
  if (reason === 'install' && !(await chrome.storage.local.get('welcomed')).welcomed) {
    await chrome.storage.local.set({ welcomed: true });
    chrome.tabs.create({ url: 'welcome.html' });
  }
});

// The extension's settings only need to be readable by its own pages.
chrome.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});

// Every time the service worker wakes: carry on with unfinished shares.
setTimeout(() => resumeShares().catch((e) => console.warn('[lumen] resume shares:', e)), 1500);

// For the automated tests: lets them call start/stop directly.
// build: when this background script was built (scripts/build.mjs), to tell a stale one apart.
// eslint-disable-next-line no-undef
Object.assign(globalThis, { lumen: { start, stop, toggle, getLive, settings, shareNow, resumeShares, build: __LUMEN_BUILD__ } });
