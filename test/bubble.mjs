// Face-bubble test (M2). A fake camera plays a short clip of a real person (a Y4M made
// from the Lumen promo footage), and in a throwaway headless Chromium it:
//
//   1. records a tab without the bubble, then with it (tab mode: the bubble is an
//      iframe in the page), checks the bubble is in the video where the iframe was,
//      that the segmenter found a person, and that the iframe is gone after stopping;
//   2. records "Screen or window" without and with the bubble (drawn into the video by
//      the offscreen compositor) and checks the bottom-left corner of the video;
//   3. measures Chrome's CPU in each case, so the bubble's cost is the difference,
//      plus the bubble code's own time per frame.
//
// Usage: npm run test:bubble   (LUMEN_KEEP=1 keeps files; LUMEN_FACE_Y4M=<file> uses
// another clip; LUMEN_BUBBLE_DELEGATE=GPU tries MediaPipe's GPU path)

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  ROOT, sleep, serveFixtures, launchWithExtension, serviceWorker, grantMedia, waitFor, startFromPopup, cpuByType,
} from './lib.mjs';

const DIST = path.join(ROOT, 'dist');
const OUT = path.join(ROOT, 'test', 'out');
const SECONDS = Number(process.env.LUMEN_SECONDS || 10);
fs.mkdirSync(OUT, { recursive: true });

// The fake camera clip. Not committed (8 MB); made from the promo footage if missing.
const Y4M = process.env.LUMEN_FACE_Y4M || path.join(ROOT, 'test', 'out', 'face.y4m');
if (!fs.existsSync(Y4M)) {
  // Any few seconds of video with one person's head and shoulders, roughly centred.
  const src = process.env.LUMEN_FACE_SOURCE || path.join(ROOT, '..', 'lumen-promo', 'assets', 'clips', 'c03-bubble.mp4');
  if (!fs.existsSync(src)) {
    console.error('The bubble test needs a short video of a person: set LUMEN_FACE_SOURCE=<video file> (or LUMEN_FACE_Y4M=<y4m>).');
    process.exit(2);
  }
  fs.mkdirSync(path.dirname(Y4M), { recursive: true });
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '1', '-t', '5', '-i', src,
    '-vf', 'crop=360:270:110:300,scale=320:240,fps=15', '-pix_fmt', 'yuv420p', Y4M]);
}

let failures = 0;
const ok = (cond, what) => { console.log(`${cond ? '  ✓' : '  ✗'} ${what}`); if (!cond) failures++; };

// One video frame as raw RGB.
function frameAt(file, t, png) {
  const p = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=width,height', '-of', 'json', file]));
  const { width, height } = p.streams[0];
  // Scaled to the stream's first size: Chrome may change the capture size mid-recording.
  const vf = ['-vf', `scale=${width}:${height}`];
  const rgb = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', ...vf, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64e6 });
  if (png) execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(t), '-i', file, '-frames:v', '1', ...vf, png]);
  return { width, height, rgb };
}

// Pixels close to the countdown's violet ring (#8b8cf6). The test page's own colours
// never get that bright in blue (its hues are at 40 % lightness).
function violetPixels(f) {
  let n = 0;
  for (let i = 0; i < f.rgb.length; i += 3) {
    if (Math.abs(f.rgb[i] - 139) < 25 && Math.abs(f.rgb[i + 1] - 140) < 25 && Math.abs(f.rgb[i + 2] - 246) < 25) n++;
  }
  return n;
}

// A PNG (from page.screenshot) as raw RGB, via ffmpeg.
function pngToRgb(png) {
  const tmp = path.join(OUT, 'shot.png');
  fs.writeFileSync(tmp, png);
  const p = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'json', tmp]));
  const rgb = execFileSync('ffmpeg', ['-v', 'error', '-i', tmp, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64e6 });
  return { width: p.streams[0].width, height: p.streams[0].height, rgb };
}

// In a recordings page: the recording's MP4 out of the extension's storage, as base64.
async function readMp4(id) {
  const f = await (await (await navigator.storage.getDirectory()).getFileHandle(`${id}.mp4`)).getFile();
  const bytes = new Uint8Array(await f.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// Share of pixels in a disc that are clearly brighter than the test page's dark
// background (#111) or black bars: a face, a shirt, a wall.
function brightShare(f, cx, cy, r) {
  let n = 0, bright = 0;
  for (let y = Math.max(0, Math.round(cy - r)); y < Math.min(f.height, cy + r); y++) {
    for (let x = Math.max(0, Math.round(cx - r)); x < Math.min(f.width, cx + r); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
      const i = (y * f.width + x) * 3;
      const lum = 0.299 * f.rgb[i] + 0.587 * f.rgb[i + 1] + 0.114 * f.rgb[i + 2];
      n++;
      if (lum > 50) bright++;
    }
  }
  return bright / Math.max(1, n);
}

const { server, url } = await serveFixtures();
const run = await launchWithExtension(DIST, { tag: 'bubble', fakeUi: false, extraArgs: [`--use-file-for-fake-video-capture=${Y4M}`] });
const { browser, extensionId, profile, downloads } = run;
const cdp = await browser.target().createCDPSession();
await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
const rootPid = browser.process().pid;
const results = {};

// Records for SECONDS, measuring Chrome's CPU over the middle of it.
async function record(sw, page, { mode, bubble }) {
  const base = { mode, mic: false, countdown: 0, bubble, bubbleShape: 'blob', bubbleOutline: 'glow', bubbleSize: 1,
    ...(process.env.LUMEN_BUBBLE_DELEGATE ? { bubbleDelegate: process.env.LUMEN_BUBBLE_DELEGATE } : {}) };
  await sw.evaluate((s) => chrome.storage.local.set({ settings: s }), base);
  if (mode === 'tab') {
    await startFromPopup(browser, extensionId, page);
  } else {
    const tab = await sw.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]);
    const r = await sw.evaluate((t) => globalThis.lumen.start(t), tab);
    if (!r.ok) throw new Error(`screen start failed: ${r.error}`);
  }
  const live = await waitFor(async () => { const l = await sw.evaluate(() => globalThis.lumen.getLive()); return l?.phase === 'recording' && l; }, 'recording', 30000);
  await sleep(1500);                         // let the camera and model warm up
  const c0 = cpuByType(rootPid), t0 = Date.now();
  await sleep((SECONDS - 2) * 1000);
  const c1 = cpuByType(rootPid), wall = (Date.now() - t0) / 1000;
  const cores = (c1.total - c0.total) / wall;
  const byType = Object.fromEntries(Object.keys(c1).filter((k) => k !== 'total')
    .map((k) => [k, +(((c1[k] - (c0[k] || 0)) / wall).toFixed(2))]));
  // The bubble's own numbers, from wherever it runs.
  let stats = null, iframeRect = null, error = null;
  if (bubble && mode === 'tab') {
    const frame = page.frames().find((f) => f.url().endsWith('/bubble.html'));
    const painted = frame ? await frame.evaluate(() => globalThis.lumenBubbleFrame?.frames || 0) : 0;
    const off = browser.targets().find((t) => t.url().endsWith('/offscreen.html'));
    const offPage = off && (await off.asPage());
    stats = offPage && await offPage.evaluate(() => globalThis.lumenBubble && {
      ...globalThis.lumenBubble.bubble.stats, ...globalThis.lumenBubble.stats, wallMs: performance.now() - globalThis.lumenBubble.bubble.stats.since, delegate: globalThis.lumenBubble.bubble.segmenter?.delegate,
      inferMs: globalThis.lumenBubble.bubble.segmenter?.inferMs, copyMs: globalThis.lumenBubble.bubble.segmenter?.copyMs });
    if (stats) stats.painted = painted;
    if (!stats) error = 'no bubble in the recorder';
    iframeRect = await page.evaluate(() => {
      const r = document.querySelector('iframe[title="Lumen camera bubble"]')?.getBoundingClientRect();
      return r && { x: r.x, y: r.y, w: r.width, h: r.height };
    });
  }
  if (bubble && mode === 'screen') {
    const off = browser.targets().find((t) => t.url().endsWith('/offscreen.html'));
    const offPage = off && (await off.asPage());
    stats = offPage && await offPage.evaluate(() => globalThis.lumenBubble && {
      ...globalThis.lumenBubble.bubble.stats, ...globalThis.lumenBubble.stats, wallMs: performance.now() - globalThis.lumenBubble.bubble.stats.since, delegate: globalThis.lumenBubble.bubble.segmenter?.delegate,
      inferMs: globalThis.lumenBubble.bubble.segmenter?.inferMs, copyMs: globalThis.lumenBubble.bubble.segmenter?.copyMs });
  }
  await sw.evaluate(() => globalThis.lumen.stop());
  // The review tab: read the MP4 straight out of the extension's storage.
  const review = await waitFor(async () => (await browser.pages()).find((p) => p.url().includes(`recordings.html?id=${live.id}`)), 'review tab', 30000);
  await waitFor(() => review.$('#review-actions a[data-file$=".mp4"]'), 'MP4', 30000);
  const b64 = await review.evaluate(readMp4, live.id);
  const file = path.join(OUT, `bubble-${mode}-${bubble ? 'on' : 'off'}.mp4`);
  fs.writeFileSync(file, Buffer.from(b64, 'base64'));
  await review.close();
  return { file, cores, byType, stats, iframeRect, error, wall: SECONDS };
}

try {
  await grantMedia(browser, extensionId);        // = "Allow microphone" + "Allow camera" on the welcome page
  const sw = await serviceWorker(browser, extensionId);
  const page = await browser.newPage();
  await page.goto(url);
  await sleep(500);

  // ---- 0. The 3·2·1 overlay, and how the bubble starts ------------------------------
  console.log('0. Countdown overlay (tab mode, bubble on) and a calm start');
  await sw.evaluate(() => chrome.storage.local.set({ settings: { mode: 'tab', mic: false, countdown: 3, bubble: true, bubbleShape: 'blob', bubbleOutline: 'plain' } }));
  await startFromPopup(browser, extensionId, page);
  const seen = new Set();
  let violetDuring = 0;
  await waitFor(async () => {
    const n = await page.evaluate(() => document.getElementById('lumen-countdown')?.shadowRoot.getElementById('n').textContent);
    if (n) {
      if (!seen.has(n) && /^\d$/.test(n)) {
        seen.add(n);
        // Prove the detector below sees the overlay when it IS there.
        const shot = await page.screenshot({ type: 'png' });
        fs.writeFileSync(path.join(OUT, 'countdown.png'), shot);
        violetDuring = Math.max(violetDuring, violetPixels(pngToRgb(shot)));
      }
    }
    return (await sw.evaluate(() => globalThis.lumen.getLive()))?.phase === 'recording';
  }, 'countdown to finish', 20000);
  const overlayGone = await page.evaluate(() => !document.getElementById('lumen-countdown'));
  ok(['3', '2', '1'].every((n) => seen.has(n)), `big overlay counted ${[...seen].join(' · ')} on the page`);
  ok(overlayGone, 'overlay removed before recording started');
  await sleep(3000);
  const frameCalm = page.frames().find((f) => f.url().endsWith('/bubble.html'));
  const calm = await frameCalm.evaluate(() => globalThis.lumenBubbleFrame);
  await sw.evaluate(() => globalThis.lumen.stop());
  const live0 = (await waitFor(async () => (await browser.pages()).find((p) => p.url().includes('recordings.html?id=')), 'review', 30000));
  const id0 = new URL(live0.url()).searchParams.get('id');
  await waitFor(() => live0.$('#review-actions a[data-file$=".mp4"]'), 'MP4', 30000);
  const f0 = path.join(OUT, 'countdown-recording.mp4');
  fs.writeFileSync(f0, Buffer.from(await live0.evaluate(readMp4, id0), 'base64'));
  await live0.close();
  let violetRec = 0;
  for (const t of [0, 0.2, 0.5]) violetRec = Math.max(violetRec, violetPixels(frameAt(f0, t)));
  ok(violetDuring > 2000 && violetRec < 50, `overlay not in the video (its violet ring: ${violetDuring} px on screen, ${violetRec} px in the first frames)`);
  // The first frame is a circle (only the slow ±1 % breathing); then it eases into
  // the person's shape, a little more each frame, never jumping.
  const first = calm?.first || [];
  const round = first.length && first[0][1] - first[0][0] < 0.03;
  const gradual = first.every((r, i) => !i || Math.abs((r[1] - r[0]) - (first[i - 1][1] - first[i - 1][0])) < 0.04);
  ok(round && gradual, `bubble starts as a clean circle and eases in (rays as × radius, first frames: ${JSON.stringify(first)})`);
  ok(calm?.minRatio >= 0.8 && calm?.maxRatio <= 1.25,
    `shape stays near the circle: rays ${calm?.minRatio?.toFixed(2)}–${calm?.maxRatio?.toFixed(2)} × its radius (clamp 0.85–1.2, plus edge/wobble)`);

  // ---- 1. Tab mode --------------------------------------------------------------
  console.log('1. Tab mode: in-page bubble');
  const tabOff = await record(sw, page, { mode: 'tab', bubble: false });
  const tabOn = await record(sw, page, { mode: 'tab', bubble: true });
  results.tab = { cpuOff: tabOff.cores, cpuOn: tabOn.cores, byTypeOff: tabOff.byType, byTypeOn: tabOn.byType, stats: tabOn.stats };
  ok(!tabOn.error, `bubble running in the recorder${tabOn.error ? ': ' + tabOn.error : ''}`);
  ok(tabOn.stats?.painted > 30, `the page's bubble iframe painted ${tabOn.stats?.painted} frames sent by the recorder`);
  ok(!!tabOn.iframeRect, `bubble iframe was in the page (${JSON.stringify(tabOn.iframeRect)})`);
  ok(tabOn.stats?.segments > 10, `segmenter ran ${tabOn.stats?.segments} times (${tabOn.stats?.delegate})`);
  ok(tabOn.stats?.maskArea > 0.05, `person mask is not empty (${((tabOn.stats?.maskArea || 0) * 100).toFixed(1)} % of the picture)`);
  if (tabOn.iframeRect) {
    const r = tabOn.iframeRect;
    const cx = r.x + r.w / 2, cy = r.y + r.w / 2;     // the bubble sits in the square part of the iframe
    const fOn = frameAt(tabOn.file, 3, path.join(OUT, 'bubble-tab-on.png'));
    const fOff = frameAt(tabOff.file, 3, path.join(OUT, 'bubble-tab-off.png'));
    const on = brightShare(fOn, cx, cy, 250 / 2);
    const off = brightShare(fOff, cx, cy, 250 / 2);
    const control = brightShare(fOn, fOn.width - cx, cy, 250 / 2);
    ok(on > 0.2 && off < 0.05, `bubble is in the video: ${(on * 100).toFixed(0)} % bright where the bubble is, ${(off * 100).toFixed(0)} % without it`);
    ok(control < 0.1, `rest of the page unchanged (${(control * 100).toFixed(0)} % bright in the opposite corner)`);
  }
  const gone = await page.evaluate(() => !document.querySelector('iframe[title="Lumen camera bubble"]'));
  ok(gone, 'bubble removed from the page after stopping');

  // ---- 2. Screen mode --------------------------------------------------------------
  console.log('2. Screen mode: bubble composited into the video');
  const scrOff = await record(sw, page, { mode: 'screen', bubble: false });
  const scrOn = await record(sw, page, { mode: 'screen', bubble: true });
  results.screen = { cpuOff: scrOff.cores, cpuOn: scrOn.cores, byTypeOff: scrOff.byType, byTypeOn: scrOn.byType, stats: scrOn.stats };
  ok(scrOn.stats?.written > 30, `compositor wrote ${scrOn.stats?.written} frames (${scrOn.stats?.dropped} dropped)`);
  ok(scrOn.stats?.maskArea > 0.05, `person mask is not empty (${((scrOn.stats?.maskArea || 0) * 100).toFixed(1)} %)`);
  const sOn = frameAt(scrOn.file, 3, path.join(OUT, 'bubble-screen-on.png'));
  const sOff = frameAt(scrOff.file, 3, path.join(OUT, 'bubble-screen-off.png'));
  const h = sOn.height, d = 250 * (h / 800), inset = 0.035 * h;
  const cx = inset + d / 2, cy = h - inset - d / 2;
  const on = brightShare(sOn, cx, cy, d / 2), off = brightShare(sOff, cx, cy, d / 2);
  ok(on > 0.2 && off < 0.05, `bubble is bottom-left in the video: ${(on * 100).toFixed(0)} % bright there, ${(off * 100).toFixed(0)} % without it`);

  // ---- 2a. Screen mode countdown: on the current tab too --------------------------------
  console.log('2a. Screen mode: the countdown shows on the current tab');
  await sw.evaluate(() => chrome.storage.local.set({ settings: { mode: 'screen', mic: false, countdown: 2, bubble: false } }));
  await startFromPopup(browser, extensionId, page);
  const seenScreen = new Set();
  await waitFor(async () => {
    const n = await page.evaluate(() => document.getElementById('lumen-countdown')?.shadowRoot.getElementById('n').textContent);
    if (n) seenScreen.add(n);
    return (await sw.evaluate(() => globalThis.lumen.getLive()))?.phase === 'recording';
  }, 'screen countdown', 20000);
  ok(seenScreen.has('2') && seenScreen.has('1') && await page.evaluate(() => !document.getElementById('lumen-countdown')),
    `screen mode: overlay counted ${[...seenScreen].join(' · ')} and went away`);
  await sw.evaluate(() => globalThis.lumen.stop());
  const rv = await waitFor(async () => (await browser.pages()).find((p) => p.url().includes('recordings.html?id=')), 'review', 30000);
  await rv.close();

  // ---- 2b. The toolbar (only before recording starts, i.e. during the countdown) ---------
  console.log('2b. Toolbar during the countdown: change shape, then close the bubble');
  await sw.evaluate(() => chrome.storage.local.set({ settings: { mode: 'tab', mic: false, countdown: 3, bubble: true, bubbleShape: 'blob' } }));
  await startFromPopup(browser, extensionId, page);
  const frameEl = await waitFor(() => page.$('iframe[title="Lumen camera bubble"]'), 'bubble iframe');
  const frame = await waitFor(async () => page.frames().find((f) => f.url().endsWith('/bubble.html')), 'bubble frame');
  await waitFor(() => frame.evaluate(() => globalThis.lumenBubbleFrame?.frames > 3), 'first bubble frames', 15000);
  const box = await frameEl.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);      // hover shows the toolbar
  await sleep(300);
  await frame.click('#shape');
  await sleep(400);
  const shapeNow = await sw.evaluate(async () => (await chrome.storage.local.get('settings')).settings.bubbleShape);
  const offLook = await (await browser.targets().find((t) => t.url().endsWith('/offscreen.html')).asPage())
    .evaluate(() => globalThis.lumenBubble?.bubble.look.shape);
  ok(shapeNow === 'circle' && offLook === 'circle', `shape button: setting = ${shapeNow}, recorder draws ${offLook}`);
  await frame.click('#close');
  await sleep(600);
  const removed = await page.evaluate(() => !document.querySelector('iframe[title="Lumen camera bubble"]'));
  const bubbleSetting = await sw.evaluate(async () => (await chrome.storage.local.get('settings')).settings.bubble);
  const camOff = await (await browser.targets().find((t) => t.url().endsWith('/offscreen.html')).asPage())
    .evaluate(() => globalThis.lumenBubble && !globalThis.lumenBubble.bubble.running);
  ok(removed && bubbleSetting === false && camOff, `✕ closes it: iframe gone ${removed}, setting off ${bubbleSetting === false}, camera stopped ${camOff}`);
  await waitFor(async () => (await sw.evaluate(() => globalThis.lumen.getLive()))?.phase === 'recording', 'recording', 15000);
  await sw.evaluate(() => globalThis.lumen.stop());
  await waitFor(async () => !(await sw.evaluate(() => globalThis.lumen.getLive())), 'saved', 30000);

  // ---- 3. CPU --------------------------------------------------------------------------
  console.log('3. CPU (all Chrome processes, in cores; 1.00 = one core busy)');
  for (const [k, v] of Object.entries(results)) {
    const s = v.stats || {};
    const perFrame = s.frames ? (s.cropMs + s.segMs + s.shapeMs) / s.frames : 0;
    const drawPer = s.draws ? s.drawMs / s.draws : 0;
    const segPer = s.segments ? s.segMs / s.segments : 0;
    v.bubbleCores = v.cpuOn - v.cpuOff;
    // The bubble's own work on the recorder's main thread, as a share of one core.
    v.ownCore = (s.cropMs + s.segMs + s.shapeMs + s.drawMs + (s.sendMs || 0) + (s.composeMs || 0) - (s.composeMs ? s.drawMs : 0)) / s.wallMs;
    v.fps = s.frames / (s.wallMs / 1000);
    v.segPerSec = s.segments / (s.wallMs / 1000);
    console.log(`    ${k}: bubble's own work ${(v.ownCore * 100).toFixed(1)} % of one core at ${v.fps.toFixed(1)} camera fps, `
      + `outline updated ${v.segPerSec.toFixed(1)}×/s`);
    console.log(`      all Chrome: without ${v.cpuOff.toFixed(2)}, with ${v.cpuOn.toFixed(2)} → bubble ≈ ${(v.bubbleCores * 100).toFixed(0)} % of a core`
      + ` | own JS per camera frame ${perFrame.toFixed(1)} ms (segment ${segPer.toFixed(1)} ms × ${s.segments}/${s.frames} frames), draw ${drawPer.toFixed(1)} ms`
      + (s.composeMs ? `, compose ${(s.composeMs / s.written).toFixed(1)} ms` : '')
      + (s.sendMs ? `, render+send to page ${(s.sendMs / s.sent).toFixed(1)} ms (${s.skipped || 0} skipped)` : '')
      + ` | model ${(s.inferMs / s.segments).toFixed(1)} ms, mask copy ${(s.copyMs / s.segments).toFixed(1)} ms`);
    console.log(`      by process, without: ${JSON.stringify(v.byTypeOff)}\n      by process, with:    ${JSON.stringify(v.byTypeOn)}`);
  }
  fs.writeFileSync(path.join(OUT, 'bubble-results.json'), JSON.stringify(results, null, 2));
} catch (e) {
  failures++;
  console.error('✗ test crashed:', e);
} finally {
  await browser.close().catch(() => {});
  server.close();
  if (process.env.LUMEN_KEEP) console.log(`profile kept: ${profile}`);
  else fs.rmSync(profile, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
