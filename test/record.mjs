// End-to-end test for Lumen for Chrome (M1). Builds nothing itself: run
// `npm test`, which builds dist/ first. In a throwaway headless Chromium profile it:
//
//   1. records a test page through the real popup ("This tab", mic on, fake mic),
//      stops with a toolbar click, downloads the MP4 from the review tab;
//   2. records "Screen or window" (Chrome's picker auto-selects the test tab);
//   2b. countdown + H.264 + closing the recorded tab; 2c. cancel during the countdown;
//   3. starts another tab recording, kills Chrome mid-recording, reopens the same
//      profile and recovers it from the recordings page;
//
// and checks every file with ffprobe/ffmpeg: real duration, video + audio streams,
// decodes without errors. Nothing plays through your speakers.
//
// Usage: npm test   (or: node test/record.mjs after `npm run build`)
//        LUMEN_HEADFUL=1 npm test   to watch it in a window
//        LUMEN_KEEP=1 npm test      to keep the profile and files (printed at the end)
//        LUMEN_SECONDS=60 npm test  for longer recordings

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { ROOT, sleep, serveFixtures, launchWithExtension, serviceWorker, clickAction, grantMedia, waitFor } from './lib.mjs';

const DIST = path.join(ROOT, 'dist');
const RECORD_SECONDS = Number(process.env.LUMEN_SECONDS || 3.5); // length of each test recording
if (!fs.existsSync(path.join(DIST, 'manifest.json'))) throw new Error('dist/ missing: run `npm run build` first');

let failures = 0;
const ok = (cond, what) => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${what}`);
  if (!cond) failures++;
};

// ffprobe + a full decode. Returns a summary or throws.
function probe(file) {
  const j = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]));
  const v = j.streams.find((s) => s.codec_type === 'video');
  const a = j.streams.find((s) => s.codec_type === 'audio');
  // Decode every frame of every stream; the decoders report any damage on stderr.
  const dec = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file]);
  const decodeErrors = dec.status === 0 ? dec.stderr.toString() : `exit ${dec.status}: ${dec.stderr}`;
  const vol = spawnSync('ffmpeg', ['-v', 'info', '-i', file, '-af', 'volumedetect', '-vn', '-f', 'null', '-']).stderr.toString();
  const meanVolume = Number((vol.match(/mean_volume: (-?[\d.]+) dB/) || [])[1] ?? -Infinity);
  return {
    meanVolume,
    format: j.format.format_name, duration: Number(j.format.duration), size: Number(j.format.size),
    video: v && `${v.codec_name} ${v.width}x${v.height}`, audio: a && `${a.codec_name} ${a.sample_rate}Hz`,
    decodeErrors: decodeErrors.trim(),
  };
}

// Black bars down the sides or along the top/bottom (tab capture pads a shape mismatch
// with black). Returns the bar widths in pixels, from ffmpeg's cropdetect.
function bars(file) {
  const out = spawnSync('ffmpeg', ['-ss', '1', '-i', file, '-frames:v', '5', '-vf', 'cropdetect=limit=8:round=2', '-f', 'null', '-']).stderr.toString();
  const m = [...out.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)].pop();
  const j = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=width,height', '-of', 'json', file])).streams[0];
  return m ? { sides: j.width - Number(m[1]), topBottom: j.height - Number(m[2]) } : { sides: 0, topBottom: 0 };
}

function checkFile(file, { expectAudio = true, minDuration = RECORD_SECONDS - 1.2 } = {}) {
  const p = probe(file);
  console.log(`    ${path.basename(file)}: ${JSON.stringify(p)}`);
  ok(p.size > 10_000, 'file is not empty');
  ok(/mp4|mov/.test(p.format), 'container is MP4');
  ok(p.duration >= minDuration && p.duration < RECORD_SECONDS + 5, `duration ${p.duration.toFixed(2)} s is about right`);
  ok(!!p.video, 'has a video stream');
  if (expectAudio) ok(!!p.audio, 'has an audio stream');
  ok(!p.decodeErrors, 'decodes with no errors');
  if (expectAudio) ok(p.meanVolume > -50, `audio is not silent (mean ${p.meanVolume} dB)`);
  return p;
}

// Waits for the review tab for `id`, clicks "Download MP4", returns the saved path.
async function downloadFromReview(browser, cdp, downloads, id) {
  const page = await waitFor(async () => (await browser.pages()).find((p) => p.url().includes(`recordings.html?id=${id}`)), 'review tab', 30000);
  const link = await waitFor(() => page.$('#review-actions a[data-file$=".mp4"]'), 'Download MP4 button', 30000)
    .catch(async (e) => {
      console.log('    page says:', (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 600));
      throw e;
    });
  const before = new Set(fs.readdirSync(downloads));
  await link.click();
  const file = await waitFor(async () => {
    const f = fs.readdirSync(downloads).find((n) => !before.has(n) && n.endsWith('.mp4'));
    return f && path.join(downloads, f);
  }, 'downloaded file', 20000);
  await sleep(500); // let Chrome finish renaming/closing it
  return { file, page };
}

async function liveState(sw) {
  return sw.evaluate(() => globalThis.lumen.getLive());
}

const { server, url } = await serveFixtures();
let run = await launchWithExtension(DIST, { tag: 'm1', fakeUi: false });
const { profile, downloads, extensionId } = run;
const allowDownloads = async (browser) => {
  const cdp = await browser.target().createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true });
  if (process.env.LUMEN_DEBUG) {
    cdp.on('Browser.downloadWillBegin', (e) => console.log('    download begins:', e.suggestedFilename));
    cdp.on('Browser.downloadProgress', (e) => e.state !== 'inProgress' && console.log('    download', e.state));
  }
  return cdp;
};

try {
  let { browser } = run;
  let cdp = await allowDownloads(browser);
  await grantMedia(browser, extensionId); // = the user clicked "Allow microphone" on the welcome page
  let sw = await serviceWorker(browser, extensionId);
  await sw.evaluate(() => chrome.storage.local.set({ settings: { mode: 'tab', mic: true, countdown: 0 } }));
  const page = await browser.newPage();
  await page.goto(url);
  await sleep(500);

  // ---- 1. Tab recording through the popup ---------------------------------------
  console.log('1. Record this tab (popup → Start, toolbar click → stop)');
  await clickAction(browser, extensionId, page);
  const popupTarget = await waitFor(async () => browser.targets().find((t) => t.url().endsWith('/popup.html')), 'popup');
  const popup = await popupTarget.asPage();
  await popup.waitForSelector('#record');
  await popup.click('#record');
  const live = await waitFor(async () => { const l = await liveState(sw); return l?.phase === 'recording' && l; }, 'recording to start');
  ok(true, `recording started (${live.mime})`);
  await sleep(RECORD_SECONDS * 1000);
  await clickAction(browser, extensionId, page); // popup is off while recording → this is "stop"
  const r1 = await downloadFromReview(browser, cdp, downloads, live.id);
  checkFile(r1.file);
  const b1 = bars(r1.file);
  ok(b1.sides <= 4 && b1.topBottom <= 4, `no black bars around the tab (sides ${b1.sides} px, top/bottom ${b1.topBottom} px)`);
  const row1 = await r1.page.evaluate(async (id) => {
    const db = await new Promise((r) => { const q = indexedDB.open('lumen'); q.onsuccess = () => r(q.result); });
    return new Promise((r) => { db.transaction('recordings').objectStore('recordings').get(id).onsuccess = (e) => r(e.target.result); });
  }, live.id);
  ok(row1.state === 'done' && !row1.error, `journal row is done (${row1.video?.codec}/${row1.audio?.codec}, MP4 remux took ${row1.remuxMs} ms)`);
  ok(row1.title === 'Lumen test page', `recording is named after the tab (“${row1.title}”)`);
  ok(!!row1.files.mic, 'a mic-only side recording was saved');
  ok(row1.sound === 'Natural', `the mic went through Sound (${row1.sound})`);
  ok(!(await liveState(sw)), 'toolbar is back to idle');
  const cmd = (await sw.evaluate(() => chrome.commands.getAll())).find((c) => c.name === 'toggle-recording');
  ok(cmd?.shortcut === 'Alt+Shift+S', `start/stop shortcut is registered (${cmd?.shortcut || 'none'})`);

  // ---- 2. Screen/window recording (getDisplayMedia in the offscreen document) ----
  console.log('2. Record "Screen or window" (picker auto-selects the test tab)');
  const tab = await sw.evaluate(async () => (await chrome.tabs.query({ title: 'Lumen test page' }))[0]);
  const res2 = await sw.evaluate((tab) => globalThis.lumen.start(tab, { mode: 'screen', countdown: 0 }), tab);
  ok(res2.ok, `screen recording started${res2.ok ? '' : ': ' + res2.error}`);
  if (res2.ok) {
    await waitFor(async () => (await liveState(sw))?.phase === 'recording', 'screen recording');
    const host = (await liveState(sw)).host;
    ok(host === 'offscreen', `recorded from the ${host} host (no fallback tab needed)`);
    await sleep(RECORD_SECONDS * 1000);
    await sw.evaluate(() => globalThis.lumen.stop());
    const r2 = await downloadFromReview(browser, cdp, downloads, res2.id);
    checkFile(r2.file);
  }

  // ---- 2b. Countdown on the badge, and Chrome ending the capture ----------------
  console.log('2b. 3-2-1 countdown on the badge; closing the recorded tab stops and saves');
  const page2 = await browser.newPage();
  await page2.goto(url);
  await sleep(300);
  // Also: the hidden "h264" codec setting, mic off (tab sound only).
  await sw.evaluate(() => chrome.storage.local.set({ settings: { mode: 'tab', mic: false, countdown: 2, codec: 'h264' } }));
  // Tab capture needs a real click on the tab's toolbar button first (M0).
  await clickAction(browser, extensionId, page2);
  const popup2 = await (await waitFor(async () => browser.targets().find((t) => t.url().endsWith('/popup.html')), 'popup')).asPage();
  await popup2.waitForSelector('#record');
  const badges = new Set();
  await popup2.click('#record');
  const res3 = await waitFor(() => liveState(sw), 'recording to begin');
  await waitFor(async () => {
    badges.add(await sw.evaluate(() => chrome.action.getBadgeText({})));
    return (await liveState(sw))?.phase === 'recording';
  }, 'countdown to finish', 10000);
  badges.add(await sw.evaluate(() => chrome.action.getBadgeText({})));
  ok(badges.has('2') && badges.has('1') && badges.has('REC'), `badge showed ${[...badges].join(' → ')}`);
  ok((await sw.evaluate(() => chrome.action.getPopup({}))) === '', 'popup is off while recording (toolbar click = stop)');
  await sleep(2500);
  await page2.close(); // the captured tab goes away → its track ends → Lumen stops and saves
  const r4 = await downloadFromReview(browser, cdp, downloads, res3.id);
  const p4 = checkFile(r4.file, { minDuration: 1.5 });
  ok(/^h264/.test(p4.video), 'H.264 recording remuxed into MP4 as H.264');
  ok((await sw.evaluate(() => chrome.action.getPopup({}))).endsWith('popup.html'), 'popup is back after saving');

  // ---- 2c. A click during the countdown cancels -----------------------------------
  console.log('2c. Clicking ✦ during the countdown cancels (nothing is saved)');
  await sw.evaluate(() => chrome.storage.local.set({ settings: { mode: 'tab', mic: true, countdown: 3 } }));
  await page.bringToFront();
  await clickAction(browser, extensionId, page);
  const popup5 = await (await waitFor(async () => browser.targets().find((t) => t.url().endsWith('/popup.html')), 'popup')).asPage();
  await popup5.waitForSelector('#record');
  await popup5.click('#record');
  await waitFor(async () => (await liveState(sw))?.phase === 'countdown', 'countdown');
  const rowsBefore = await sw.evaluate(() => chrome.storage.session.get('live'));
  await clickAction(browser, extensionId, page); // popup is off during the countdown → stop = cancel
  await waitFor(async () => !(await liveState(sw)), 'cancel to finish', 8000);
  ok(true, 'cancelled; toolbar back to idle');
  await sleep(1500);
  const opened = (await browser.pages()).some((p) => p.url().includes(`recordings.html?id=${rowsBefore.live.id}`));
  ok(!opened, 'no review tab opened for the cancelled recording');

  // ---- 3. Crash mid-recording, then recover ---------------------------------------
  console.log('3. Kill Chrome mid-recording, reopen, Recover');
  await sw.evaluate(() => chrome.storage.local.set({ settings: { mode: 'tab', mic: true, countdown: 0 } }));
  await page.bringToFront();
  await clickAction(browser, extensionId, page);
  const popup3 = await (await waitFor(async () => browser.targets().find((t) => t.url().endsWith('/popup.html')), 'popup')).asPage();
  await popup3.waitForSelector('#record');
  await popup3.click('#record');
  const live3 = await waitFor(async () => { const l = await liveState(sw); return l?.phase === 'recording' && l; }, 'recording to start');
  await sleep(RECORD_SECONDS * 1000);
  const pid = browser.process().pid;
  process.kill(pid, 'SIGKILL');               // by PID: only this test's Chromium
  await sleep(1500);

  run = await launchWithExtension(DIST, { tag: 'm1', fakeUi: false, profile });
  browser = run.browser;
  ok(run.extensionId === extensionId, 'same extension id after restart');
  cdp = await allowDownloads(browser);
  const lib = await browser.newPage();
  if (process.env.LUMEN_DEBUG) {
    lib.on('console', (m) => console.log('    [page]', m.text()));
    lib.on('pageerror', (e) => console.log('    [page error]', e.message));
    lib.on('dialog', (d) => { console.log('    [dialog]', d.message()); d.dismiss(); });
  }
  await lib.goto(`chrome-extension://${extensionId}/recordings.html`);
  // Puppeteer's clicks wait for a painted frame; a background tab never paints.
  await lib.bringToFront();
  const item = await waitFor(() => lib.$(`li[data-id="${live3.id}"][data-state="recording"]`), 'unfinished row');
  ok(!!item, 'recordings page lists the unfinished recording');
  const before = new Set(fs.readdirSync(downloads));
  await (await item.$('button.primary')).click(); // "Recover"
  const link = await waitFor(() => lib.$('#review-actions a[data-file$=".mp4"]'), 'recovered MP4', 30000);
  await link.click();
  const f3 = await waitFor(async () => {
    const f = fs.readdirSync(downloads).find((n) => !before.has(n) && n.endsWith('.mp4'));
    return f && path.join(downloads, f);
  }, 'downloaded recovered file');
  await sleep(500);
  // The last second or so may be lost in a crash; anything over ~1.5 s is a pass.
  checkFile(f3, { minDuration: 1.5 });
  await browser.close();
} catch (e) {
  failures++;
  console.error('✗ test crashed:', e);
  try { await run.browser.close(); } catch { /* already gone */ }
} finally {
  server.close();
  if (process.env.LUMEN_KEEP) console.log(`profile kept: ${profile}`);
  else fs.rmSync(profile, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
