// Screen recording with the face bubble: drawn into the video whichever screen is
// shared; the tab you started from gets the "Show my camera" pill; a real click on it
// floats the camera (Picture-in-Picture); while it floats the recorder looks for that
// window in the recording and only stops drawing the bubble in if it's there. Headless
// Chrome shares a fake screen, so the window is never in it here: still drawn in (the
// matcher's "found" side is test/visible.test.mjs). Stopping removes it all.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, launchWithExtension, grantMedia, serviceWorker, serveFixtures, waitFor, sleep, startFromPopup } from './lib.mjs';

process.env.LUMEN_DROP_FLAGS = [process.env.LUMEN_DROP_FLAGS, '--auto-select-tab-capture-source-by-title'].filter(Boolean).join(',');
let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); if (!cond) failed++; };
const { server, url } = await serveFixtures();
// Chrome's fake camera and fake screen draw the same green picture, which would make the
// camera window "appear" on the fake screen: the camera gets its own video here.
const cam = path.join(ROOT, 'test', 'out', 'fake-camera.y4m');
if (!fs.existsSync(cam)) {
  fs.mkdirSync(path.dirname(cam), { recursive: true });
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=15', '-t', '4', '-pix_fmt', 'yuv420p', cam]);
}
const { browser, extensionId } = await launchWithExtension(path.join(ROOT, 'dist'), { tag: 'float', extraArgs: [`--use-file-for-fake-video-capture=${cam}`] });
const off = async () => browser.targets().find((t) => t.url().endsWith('/offscreen.html'))?.asPage();
const comp = async () => (await off())?.evaluate(() => globalThis.lumenBubble && { floating: globalThis.lumenBubble.floating, drawingIn: globalThis.lumenBubble.drawingIn, ...globalThis.lumenBubble.stats });
// Clicks a button inside Lumen's iframe on `page` with a real (CDP) click.
async function clickIn(page, iframeTitle, buttonId) {
  const el = await page.waitForSelector(`iframe[title="${iframeTitle}"]`, { timeout: 8000 });
  const frame = await el.contentFrame();
  await frame.waitForSelector(`#${buttonId}`, { visible: true, timeout: 8000 });
  const box = await el.boundingBox();
  const b = await frame.evaluate((id) => { const r = document.getElementById(id).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, buttonId);
  await page.mouse.click(box.x + b.x, box.y + b.y);
}
const rowOf = async (id) => {
  const ext = await browser.newPage();
  await ext.goto(`chrome-extension://${extensionId}/recordings.html`);
  const row = await ext.evaluate(async (id) => { const db = await new Promise((r) => { const q = indexedDB.open('lumen'); q.onsuccess = () => r(q.result); }); return new Promise((r) => { db.transaction('recordings').objectStore('recordings').get(id).onsuccess = (e) => r(e.target.result); }); }, id);
  await ext.close();
  return row;
};

try {
  await grantMedia(browser, extensionId);
  const sw = await serviceWorker(browser, extensionId);
  await sw.evaluate(() => chrome.storage.local.set({ settings: { mode: 'screen', mic: false, countdown: 0, bubble: true, bubbleShape: 'blob', bubbleOutline: 'glow', bubbleSize: 1 } }));

  console.log('A. From a website: “Show my camera”');
  const page = await browser.newPage();
  await page.goto(url);
  await page.bringToFront();
  await sleep(500);
  await startFromPopup(browser, extensionId, page);
  await page.waitForSelector('iframe[title="Lumen camera button"]', { timeout: 8000 });
  const askText = await (await (await page.$('iframe[title="Lumen camera button"]')).contentFrame()).evaluate(() => document.getElementById('ask')?.innerText.split('\n')[0]);
  ok(/Show your camera while you record/.test(askText || ''), `before the picker, the tab asks: “${askText}”`);
  ok(!(await sw.evaluate(() => globalThis.lumen.getLive()))?.phase?.match(/recording/), 'and recording waits for the answer');
  await clickIn(page, 'Lumen camera button', 'ask-yes');
  const pip = await waitFor(() => page.evaluate(() => !!window.documentPictureInPicture?.window), 'floating window', 6000).catch(() => false);
  ok(pip, 'the answer’s click opened the floating camera window');
  const live = await waitFor(async () => { const l = await sw.evaluate(() => globalThis.lumen.getLive()); return l?.phase === 'recording' && l; }, 'recording', 30000);
  ok(!!live, 'then the recording started');
  await sleep(5000);
  const c1 = await comp();
  ok(c1?.floating && c1.drawingIn, `floating, but the window isn’t on the recorded (fake) screen: drawn in (${c1?.drawnIn} frames)`);
  let fl = null;
  for (const t of browser.targets()) {
    if (fl) break;
    const p = await t.page().catch(() => null);
    fl = p && p.frames().find((f) => f.url().includes('bubble.html?float'));
  }
  const drawn = fl && await fl.evaluate(() => ({ msg: document.getElementById('msg').textContent, w: document.getElementById('c').width }));
  ok(drawn && drawn.w > 0 && drawn.msg === '', `the floating window shows the camera (${JSON.stringify(drawn)})`);
  ok(await page.evaluate(() => document.title) === 'Lumen test page', 'the page’s own title is back');
  ok(!!page.frames().find((f) => f.url().includes('bubble.html?pill')), 'the question turned into the pill');
  await sw.evaluate(() => globalThis.lumen.stop());
  await waitFor(async () => !(await sw.evaluate(() => globalThis.lumen.getLive())), 'saved', 30000);
  await sleep(500);
  const rowA = await rowOf(live.id);
  ok(rowA?.bubbleMode === 'in video, can float' && rowA?.camChecks?.done >= 1 && rowA.camChecks.seen === 0,
    `journal: ${rowA?.bubbleMode}; looked for the window ${rowA?.camChecks?.done}× (seen ${rowA?.camChecks?.seen}×)`);
  ok(await page.evaluate(() => !document.querySelector('iframe[title^="Lumen camera"]') && !window.documentPictureInPicture?.window),
    'stopping takes the pill and the floating window away');

  console.log('B. From Lumen’s review page: “Just record”');
  const review = (await browser.pages()).find((p) => p.url().includes('recordings.html?id=')) || page;
  await review.bringToFront();
  await sleep(500);
  await startFromPopup(browser, extensionId, review);
  await review.waitForSelector('iframe[title="Lumen camera button"]', { timeout: 8000 });
  ok(true, `the review page (${review.url().includes('recordings.html') ? 'Lumen’s own page' : 'website'}) asks too`);
  await clickIn(review, 'Lumen camera button', 'ask-no');
  const live2 = await waitFor(async () => { const l = await sw.evaluate(() => globalThis.lumen.getLive()); return l?.phase === 'recording' && l; }, 'recording', 30000);
  await sleep(2500);
  ok(!(await review.evaluate(() => !!window.documentPictureInPicture?.window)) && (await comp())?.drawingIn, '“Just record”: no floating window, the bubble is drawn in');
  ok(!!review.frames().find((f) => f.url().includes('bubble.html?pill')), 'the pill is there for later');
  await sw.evaluate(() => globalThis.lumen.stop());
  await waitFor(async () => !(await sw.evaluate(() => globalThis.lumen.getLive())), 'saved', 30000);
  await sleep(500);
  ok(await review.evaluate(() => !document.querySelector('iframe[title^="Lumen camera"]')), 'stopping takes the pill away (Lumen’s page too)');
} catch (e) {
  console.log('✗ test crashed:', e);
  failed++;
} finally {
  await browser.close();
  server.close();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
