// End-to-end test for share links (M3). Runs the real share worker locally with
// `wrangler dev` (../lumen/share; miniflare: R2 and D1 in a throwaway folder, nothing
// deployed) and the extension in a throwaway headless Chromium:
//
//   1. connect with a code made for a device key (like `vshare connect-code`)
//   2. record a tab ~3 s with "Share link when done" on: the link is copied, the share
//      page serves the video (206 Range, same bytes as the local MP4), thumb, card,
//      hover sprite and storyboard exist
//   3. the device key sees and deletes only its own videos (not one made with the
//      owner key)
//   4. a 3-part upload is cut off by killing Chrome; after a restart it resumes (done
//      parts kept) and completes
//   5. disconnect revokes the key on the site
//
// Usage: npm run test:share   (needs `npm ci` in ../lumen/share; LUMEN_SHARE_DIR to
// point elsewhere; LUMEN_KEEP=1 keeps the profile)

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  ROOT, sleep, serveFixtures, launchWithExtension, serviceWorker, grantMedia, waitFor, startFromPopup, clickAction,
} from './lib.mjs';

const DIST = path.join(ROOT, 'dist');
const SHARE_DIR = process.env.LUMEN_SHARE_DIR || path.join(ROOT, '..', 'lumen', 'share');
const OUT = path.join(ROOT, 'test', 'out');
fs.mkdirSync(OUT, { recursive: true });
const { startDevWorker } = await import(pathToFileURL(path.join(SHARE_DIR, 'test', 'devserver.mjs')).href);

let failures = 0;
const ok = (cond, what) => { console.log(`${cond ? '  ✓' : '  ✗'} ${what}`); if (!cond) failures++; };

// A connection code, exactly as `vshare connect-code` makes it. It points at `site`:
// the local worker behind the stand-in for Workers AI (below).
async function mintCode(w, name) {
  const r = await fetch(`${w.url}/api/tokens`, { method: 'POST', headers: { Authorization: `Bearer ${w.admin}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
  const j = await r.json();
  return { code: 'lumen1:' + Buffer.from(JSON.stringify({ u: site, t: j.token, n: name })).toString('base64url'), token: j.token, id: j.id };
}

// The journal row of a recording, read in an extension page.
const rowOf = (page, id) => page.evaluate(async (id) => {
  const db = await new Promise((r) => { const q = indexedDB.open('lumen'); q.onsuccess = () => r(q.result); });
  return new Promise((r) => { db.transaction('recordings').objectStore('recordings').get(id).onsuccess = (e) => r(e.target.result); });
}, id);

async function connectWith(browser, extensionId, code) {
  const p = await browser.newPage();
  await p.goto(`chrome-extension://${extensionId}/connect.html`);
  await p.bringToFront();
  await p.type('#code', code);
  await p.click('#go');
  await waitFor(() => p.evaluate(() => !document.getElementById('connected').hidden), 'connected', 15000)
    .catch(async (e) => { console.log('    connect page says:', await p.$eval('#msg', (m) => m.textContent)); throw e; });
  return p;
}

const w = await startDevWorker({ schema: 'fresh' });

// Workers AI only runs on Cloudflare, so a stand-in answers /api/transcribe and
// /api/complete in front of the local worker (everything else passes straight through)
// and notes what the extension sent.
const ai = { transcribe: [], complete: [], firstVerbatim: null };
const SAID = ['Hello,', 'this', 'is', 'a', 'test', 'of', 'Lumen', 'for', 'Chrome.', 'It', 'writes', 'a', 'transcript.'];
// Asked to keep hesitations (a prompt: the clean-up's listens), it hears an "um" at
// 0.8–1.2 s; in the already-cut sound (shorter than the first listen) it hears none.
const UMM = ['So,', 'um,', 'this', 'is', 'a', 'test', 'of', 'cutting.'];
// (Chrome is killed mid-upload in step 4: a request cut off half way is just dropped.)
const aiProxy = http.createServer((req, res) => proxy(req, res).catch(() => res.destroy()));
async function proxy(req, res) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const path0 = req.url.split('?')[0];
  const reply = (obj) => { res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': req.headers.origin || '*' }); res.end(JSON.stringify(obj)); };
  if (req.method === 'POST' && path0 === '/api/transcribe') {
    const rate = body.readUInt32LE(24), ch = body.readUInt16LE(22), bits = body.readUInt16LE(34);
    const seconds = (body.length - 44) / ((rate * ch * bits) / 8);
    const query = req.url.split('?')[1] || '';
    ai.transcribe.push({ riff: body.toString('ascii', 0, 4), rate, ch, bits, seconds, query, auth: req.headers.authorization, type: req.headers['content-type'] });
    if (new URLSearchParams(query).get('prompt')) {
      ai.firstVerbatim ??= seconds;
      const um = seconds > ai.firstVerbatim - 0.2;
      const said = um ? UMM : UMM.filter((x) => x !== 'um,');
      return reply({ language: 'en', duration: seconds, words: said.map((x, i) => ({ w: x, s: x === 'um,' ? 0.8 : 0.2 + i * 0.3, e: x === 'um,' ? 1.2 : 0.4 + i * 0.3 })) });
    }
    await sleep(4000);    // Whisper takes a moment: a share page opened now must wait for it
    return reply({ language: 'en', duration: seconds, words: SAID.map((x, i) => ({ w: x, s: 0.2 + i * 0.25, e: 0.4 + i * 0.25 })) });
  }
  if (req.method === 'POST' && path0 === '/api/complete') {
    ai.complete.push({ prompt: JSON.parse(body.toString()).prompt, auth: req.headers.authorization });
    return reply({ text: 'Sure! {"title": "Testing Lumen for Chrome", "summary": "A quick test of share links with a transcript.", "chapters": [{"t": 0, "title": "Intro"}, {"t": 2, "title": "Too short"}]}' });
  }
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'expect'].includes(k)) headers[k] = v;
  const r = await fetch(w.url + req.url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body, redirect: 'manual' });
  const out = {};
  r.headers.forEach((v, k) => { if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(k)) out[k] = v; });
  res.writeHead(r.status, out);
  res.end(Buffer.from(await r.arrayBuffer()));
}
await new Promise((r) => aiProxy.listen(0, '127.0.0.1', r));
const site = `http://127.0.0.1:${aiProxy.address().port}`;
const { server, url } = await serveFixtures();
// A big test MP4 (3 parts of 10 MiB), served to the extension for the resume test.
const big = path.join(w.persist, 'big.mp4');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-t', '8',
  '-vf', 'noise=alls=80:allf=t', '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '32M', '-maxrate', '32M', '-bufsize', '8M',
  '-pix_fmt', 'yuv420p', '-movflags', '+faststart', big]);
const bigServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'video/mp4', 'Access-Control-Allow-Origin': '*' });
  fs.createReadStream(big).pipe(res);
});
await new Promise((r) => bigServer.listen(0, '127.0.0.1', r));
const bigUrl = `http://127.0.0.1:${bigServer.address().port}/big.mp4`;

let run = await launchWithExtension(DIST, { tag: 'share', fakeUi: false });
const { profile, extensionId } = run;
let browser = run.browser;
const origin = `chrome-extension://${extensionId}`;

try {
  await grantMedia(browser, extensionId);
  await browser.defaultBrowserContext().overridePermissions(origin, ['microphone', 'camera', 'clipboard-read', 'clipboard-sanitized-write']);
  let sw = await serviceWorker(browser, extensionId);

  // ---- 1. connect -------------------------------------------------------------------
  console.log('1. Connect with a code');
  const first = await mintCode(w, 'Test Chrome');
  const cp = await connectWith(browser, extensionId, first.code);
  const conn = await sw.evaluate(async () => (await chrome.storage.local.get('share')).share);
  ok(conn?.url === site && conn.token === first.token && conn.name === 'Test Chrome', 'connection stored (URL + device key)');
  ok(!(await sw.evaluate(async () => JSON.stringify(await chrome.storage.sync.get(null)))).includes(first.token), 'nothing in chrome.storage.sync');
  await cp.close();

  // ---- 2. record with share on ------------------------------------------------------------
  console.log('2. Record a tab with "Share link when done"');
  await sw.evaluate(() => chrome.storage.local.set({ settings: { mode: 'tab', mic: true, countdown: 0, share: true, cleanup: false } }));
  const page = await browser.newPage();
  await page.goto(url);
  await sleep(500);
  const pop = await (async () => {
    await clickAction(browser, extensionId, page);
    const t = await waitFor(async () => browser.targets().find((x) => x.url().endsWith('/popup.html')), 'popup');
    return t.asPage();
  })();
  await pop.waitForSelector('#share-row:not([hidden])', { timeout: 5000 });
  ok(await pop.$eval('#share', (e) => e.checked), 'popup shows "Share link when done" (on)');
  await pop.click('#record');
  const live = await waitFor(async () => { const l = await sw.evaluate(() => globalThis.lumen.getLive()); return l?.phase === 'recording' && l; }, 'recording');
  await sleep(3500);
  await clickAction(browser, extensionId, page);   // stop
  const review = await waitFor(async () => (await browser.pages()).find((p) => p.url().includes(`recordings.html?id=${live.id}`)), 'review tab', 30000);
  const linkRow = await waitFor(async () => { const r = await rowOf(review, live.id); return r?.share?.url && r; }, 'share link', 30000);
  const link = linkRow.share.url;
  ok(/\/v\/[A-Za-z0-9]{12}$/.test(link), `link created at stop: ${link}`);
  await review.bringToFront();
  const clip = await review.evaluate(() => navigator.clipboard.readText().catch((e) => `ERR ${e.message}`));
  ok(clip === link, `link was copied to the clipboard (${clip === link ? 'yes' : clip})`);
  ok(linkRow.share.copied === true, 'journal says copied');
  const done = await waitFor(async () => { const r = await rowOf(review, live.id); return r?.share?.state === 'done' ? r : (r?.share?.state === 'failed' ? r : null); }, 'upload done', 60000);
  ok(done.share.state === 'done', `upload finished (${done.share.state}${done.share.error ? ': ' + done.share.error : ''})`);
  // Opened the moment the video is up, like a link pasted in chat: the transcript and the
  // AI title aren't written yet.
  const viewer = await browser.newPage();
  await viewer.goto(link);
  const early = await waitFor(() => viewer.evaluate(() => document.querySelector('.wait')?.textContent || ''), 'waiting note', 10000).catch(() => '');
  ok(/Writing the transcript/.test(early), `share page opened early says “${early || 'nothing'}”`);
  await waitFor(() => review.$('#share-url'), 'link on the review page', 10000);
  ok((await review.$eval('#share-url', (e) => e.value)) === link, 'review page shows the link with Copy');
  const vid = link.split('/v/')[1];
  const localSize = done.mp4Bytes;
  const shareHtml = await (await fetch(link)).text();
  ok(shareHtml.includes('<video') || shareHtml.includes('studio'), 'share page serves the player');
  const rng = await fetch(`${link}/video.mp4`, { headers: { Range: 'bytes=0-1023' } });
  ok(rng.status === 206 && Number(rng.headers.get('content-range')?.split('/')[1]) === localSize, `video: 206, ${rng.headers.get('content-range')} (local MP4 ${localSize} bytes)`);
  const full = Buffer.from(await (await fetch(`${link}/video.mp4`)).arrayBuffer());
  const local = Buffer.from(await review.evaluate(async (f) => {
    const file = await (await (await navigator.storage.getDirectory()).getFileHandle(f)).getFile();
    return Array.from(new Uint8Array(await file.arrayBuffer()));
  }, done.files.mp4));
  ok(full.equals(local), 'the shared video is byte-for-byte the local MP4');
  fs.writeFileSync(path.join(OUT, 'shared.mp4'), full);
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', path.join(OUT, 'shared.mp4')]));
  ok(probe.streams.some((s) => s.codec_type === 'video') && probe.streams.some((s) => s.codec_type === 'audio'), 'shared MP4 has video + audio');
  for (const [file, what] of [['thumb.jpg', 'poster'], ['card.jpg', '1200×630 card'], ['sprite.jpg', 'hover sprite']]) {
    const r = await fetch(`${link}/${file}`);
    const b = Buffer.from(await r.arrayBuffer());
    fs.writeFileSync(path.join(OUT, `shared-${file}`), b);
    ok(r.status === 200 && b[0] === 0xff && b[1] === 0xd8, `${what} (${file}) is a JPEG, ${b.length} bytes`);
  }
  const cardDims = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path.join(OUT, 'shared-card.jpg')], { encoding: 'utf8' }).trim();
  ok(cardDims === '1200,630', `card is 1200×630 (${cardDims})`);
  const tr = await (await fetch(`${link}/transcript.json`)).json();
  ok(tr.storyboard?.cols === 10 && tr.storyboard.w === 160 && tr.storyboard.count >= 10, `storyboard for hover frames: ${JSON.stringify(tr.storyboard)}`);
  ok(shareHtml.includes(`/v/${vid}/card.jpg`), 'link preview (og:image) points at the card');

  // What was said (step 5): the mic goes to the share site's Whisper, the transcript to
  // transcript.json, then a title and summary from its LLM.
  const said = await waitFor(async () => { const r = await rowOf(review, live.id); return r?.share?.ai && r; }, 'transcript step', 30000);
  ok(said.share.ai.state === 'done' && said.share.ai.titled, `transcript and title written (${JSON.stringify(said.share.ai)})`);
  const t0 = ai.transcribe[0] || {};
  ok(ai.transcribe.length === 1 && t0.riff === 'RIFF' && t0.rate === 16000 && t0.ch === 1 && t0.bits === 16 && t0.type === 'audio/wav',
    `mic sent once as a 16 kHz mono WAV (${ai.transcribe.length} call, ${t0.rate} Hz, ${t0.bits}-bit)`);
  ok(Math.abs((t0.seconds || 0) - (done.duration || 0)) < 1.5, `…the whole recording: ${t0.seconds?.toFixed(1)} s of audio for ${done.duration?.toFixed(1)} s of video`);
  ok(t0.query === '' && t0.auth === `Bearer ${first.token}`, 'with the device key, no language given (Whisper finds it)');
  const tr2 = await (await fetch(`${link}/transcript.json`)).json();
  ok(tr2.lang === 'en' && tr2.cues?.length >= 2 && tr2.words?.length === SAID.length && tr2.storyboard?.cols === 10,
    `transcript.json: ${tr2.cues?.length} lines, ${tr2.words?.length} words, hover storyboard kept`);
  ok(tr2.cues?.[0]?.text.startsWith('Hello, this is a test') && tr2.summary?.startsWith('A quick test'), `first line: “${tr2.cues?.[0]?.text}”, summary saved`);
  ok(!tr2.chapters, 'no chapters for a short recording (the model suggested two anyway)');
  ok(/\[0s\] Hello, this is a test/.test(ai.complete[0]?.prompt || ''), 'title prompt carries the timestamped transcript');
  const vrow = (await (await fetch(`${w.url}/api/videos`, { headers: { Authorization: `Bearer ${first.token}` } })).json()).videos.find((x) => x.id === vid);
  ok(vrow?.title === 'Testing Lumen for Chrome', `share renamed from the tab’s title to “${vrow?.title}”`);
  ok(said.title === 'Testing Lumen for Chrome', 'the recording is renamed in Lumen too');
  ok((await (await fetch(link)).text()).includes('Testing Lumen for Chrome'), 'share page shows the new title');
  const filled = await waitFor(() => viewer.evaluate(() => document.querySelectorAll('.line').length && document.querySelector('.head h1').textContent === 'Testing Lumen for Chrome'
    && document.querySelector('.summary')?.textContent.startsWith('A quick test') && document.querySelectorAll('.line').length), 'page filled in', 20000).catch(() => 0);
  ok(filled >= 2, `…and the page opened early filled in by itself: ${filled} lines, the new title and summary, no reload`);
  ok((await fetch(`${link}/transcript.json`)).headers.get('cache-control') === 'no-cache', 'transcript.json is never served stale (no-cache)');
  await viewer.close();

  // ---- 2b. ums cut out of the shared copy ---------------------------------------------
  console.log('2b. Cut ums and long pauses (the shared copy; the recording stays uncut)');
  await sw.evaluate(() => chrome.storage.local.set({ settings: { mode: 'tab', mic: true, countdown: 0, share: true, cleanup: true } }));
  ai.transcribe.length = 0;
  ai.firstVerbatim = null;
  await page.bringToFront();
  await startFromPopup(browser, extensionId, page);
  const live2 = await waitFor(async () => { const l = await sw.evaluate(() => globalThis.lumen.getLive()); return l?.phase === 'recording' && l; }, 'recording', 20000);
  await sleep(3500);
  await clickAction(browser, extensionId, page);
  const cleanRow = await waitFor(async () => { const r = await rowOf(review, live2.id); return (r?.share?.state === 'done' && r?.share?.ai) || r?.share?.state === 'failed' ? r : null; }, 'clean share done', 90000);
  const cl = cleanRow.share.clean || {};
  ok(cl.state === 'done' && cleanRow.files?.clean, `ums cut before uploading (${cl.state}${cl.error ? ': ' + cl.error : ''})`);
  const prompts = ai.transcribe.filter((t) => new URLSearchParams(t.query).get('prompt'));
  ok(ai.transcribe.length === 3 && prompts.length === 2 && /language=en/.test(prompts[0].query),
    `listened 3 times: language, then verbatim (prompt) twice, the 2nd the cut sound (${ai.transcribe.map((t) => t.seconds.toFixed(1) + ' s').join(', ')})`);
  const link2 = cleanRow.share.url;
  const shared2 = Buffer.from(await (await fetch(`${link2}/video.mp4`)).arrayBuffer());
  fs.writeFileSync(path.join(OUT, 'shared-clean.mp4'), shared2);
  const pr2 = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', path.join(OUT, 'shared-clean.mp4')]));
  const cutDur = Number(pr2.format.duration);
  const removed = cl.cleanup?.seconds || 0;
  ok(Math.abs(cleanRow.duration - removed - cutDur) < 0.3 && removed > 0.3,
    `shared video is ${cutDur.toFixed(2)} s: the ${cleanRow.duration?.toFixed(2)} s recording minus ${removed} s cut`);
  ok(pr2.streams.some((x) => x.codec_type === 'video') && pr2.streams.some((x) => x.codec_type === 'audio'), 'cut video has video + audio');
  const dec2 = execFileSync('ffmpeg', ['-v', 'error', '-i', path.join(OUT, 'shared-clean.mp4'), '-f', 'null', '-'], { encoding: 'utf8' });
  ok(!dec2.trim(), 'cut video decodes with no errors');
  const localOrig = await review.evaluate(async (f) => (await (await (await navigator.storage.getDirectory()).getFileHandle(f)).getFile()).size, cleanRow.files.mp4);
  ok(localOrig === cleanRow.mp4Bytes, 'the recording on this computer is still the uncut one');
  const tr3 = await (await fetch(`${link2}/transcript.json`)).json();
  ok(tr3.cleanup?.fillers === 1 && tr3.cleanup.marks?.[0]?.label === 'um' && !tr3.words?.some((x) => /^um/i.test(x.w)),
    `transcript: “Cleaned up” marks (${tr3.cleanup?.fillers} um at ${tr3.cleanup?.marks?.[0]?.t} s), no “um” in the words`);
  const v2 = await browser.newPage();
  await v2.goto(link2);
  const badge2 = await waitFor(() => v2.evaluate(() => { const b = document.querySelector('.clean'); return b && !b.hidden && b.textContent; }), 'clean badge', 15000).catch(() => '');
  ok(/1 um removed/.test(badge2), `share page badge: “${badge2}”`);
  await v2.close();

  // ---- 3. the device key's limits ------------------------------------------------------------
  console.log('3. The device key only touches its own videos');
  const A = { Authorization: `Bearer ${w.admin}`, 'Content-Type': 'application/json' };
  const D = { Authorization: `Bearer ${first.token}` };
  const owners = await (await fetch(`${w.url}/api/videos`, { method: 'POST', headers: A, body: JSON.stringify({ title: 'Owner video' }) })).json();
  const mine = await (await fetch(`${w.url}/api/videos`, { headers: D })).json();
  ok(mine.videos.length === 2 && mine.videos.some((x) => x.id === vid) && mine.videos.every((x) => x.source === 'chrome'), 'device lists only the videos it shared (2, source chrome)');
  ok((await fetch(`${w.url}/api/videos/${owners.id}`, { method: 'DELETE', headers: D })).status === 404, 'device can’t delete a video made with the owner key');
  ok((await (await fetch(`${w.url}/api/videos`, { headers: A })).json()).videos.length === 3, 'owner key sees all three');

  // ---- 4. resume after Chrome is killed mid-upload ----------------------------------------------
  console.log('4. A 3-part upload survives Chrome being killed');
  const bigId = await review.evaluate(async (src) => {
    const id = 'big-' + Date.now();
    const data = await (await fetch(src)).arrayBuffer();
    const h = await (await navigator.storage.getDirectory()).getFileHandle(`${id}.mp4`, { create: true });
    const wr = await h.createWritable(); await wr.write(data); await wr.close();
    const db = await new Promise((r) => { const q = indexedDB.open('lumen'); q.onsuccess = () => r(q.result); });
    await new Promise((r) => { const t = db.transaction('recordings', 'readwrite');
      t.objectStore('recordings').put({ id, createdAt: Date.now(), mode: 'tab', title: 'Big upload', state: 'done',
        files: { webm: null, mic: null, mp4: `${id}.mp4` }, duration: 8, mp4Bytes: data.byteLength,
        video: { codec: 'avc', width: 1280, height: 720 } });
      t.oncomplete = r; });
    return id;
  }, bigUrl);
  const bigSize = fs.statSync(big).size;
  ok(bigSize > 20 * 1024 * 1024, `test file is ${(bigSize / 1048576).toFixed(1)} MiB (${Math.ceil(bigSize / 10485760)} parts)`);
  // Slow the offscreen document's uploads down so we can cut in the middle.
  await sw.evaluate((id) => globalThis.lumen.shareNow(id), bigId);
  const off = await waitFor(async () => browser.targets().find((t) => t.url().endsWith('/offscreen.html')), 'offscreen');
  const offCdp = await off.createCDPSession();
  await offCdp.send('Network.enable');
  await offCdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: 3 * 1024 * 1024 });
  const partial = await waitFor(async () => { const r = await rowOf(review, bigId); return r?.share?.etags && Object.keys(r.share.etags).length >= 1 ? r : null; }, 'first part', 60000);
  const keptEtag = Object.entries(partial.share.etags)[0];
  ok(Object.keys(partial.share.etags).length < 3, `cut off after ${Object.keys(partial.share.etags).length} of 3 parts`);
  process.kill(browser.process().pid, 'SIGKILL');
  await sleep(1500);
  run = await launchWithExtension(DIST, { tag: 'share', fakeUi: false, profile });
  browser = run.browser;
  sw = await serviceWorker(browser, extensionId);
  const lib = await browser.newPage();
  await lib.goto(`${origin}/recordings.html`);
  const resumed = await waitFor(async () => { const r = await rowOf(lib, bigId); return r?.share?.state === 'done' || r?.share?.state === 'failed' ? r : null; }, 'resumed upload', 90000);
  ok(resumed.share.state === 'done', `resumed and finished after the restart (${resumed.share.state}${resumed.share.error ? ': ' + resumed.share.error : ''})`);
  ok(resumed.share.resumed >= 1 && resumed.share.etags[keptEtag[0]] === keptEtag[1], `part ${keptEtag[0]} wasn’t sent again (same ETag), resumed ${resumed.share.resumed}×`);
  const bigRng = await fetch(`${resumed.share.url}/video.mp4`, { headers: { Range: 'bytes=0-0' } });
  ok(bigRng.status === 206 && Number(bigRng.headers.get('content-range')?.split('/')[1]) === bigSize, `the whole file arrived (${bigRng.headers.get('content-range')})`);

  // ---- 5. disconnect ------------------------------------------------------------------------------
  console.log('5. Disconnect');
  const cp2 = await browser.newPage();
  await cp2.goto(`${origin}/connect.html`);
  await cp2.bringToFront();
  cp2.on('dialog', (d) => d.accept());
  await waitFor(() => cp2.evaluate(() => !document.getElementById('connected').hidden), 'connected view');
  await cp2.click('#disconnect');
  await waitFor(() => cp2.evaluate(() => !document.getElementById('paste').hidden), 'disconnected view');
  ok(!(await sw.evaluate(async () => (await chrome.storage.local.get('share')).share)), 'connection forgotten in the extension');
  ok((await fetch(`${w.url}/api/info`, { headers: D })).status === 401, 'the device key no longer works on the site (revoked)');
  await browser.close();
} catch (e) {
  failures++;
  console.error('✗ test crashed:', e);
  console.error(w.log().slice(-1500));
  try { await browser.close(); } catch { /* gone */ }
} finally {
  server.close();
  bigServer.close();
  aiProxy.close();
  await w.stop();
  if (process.env.LUMEN_KEEP) console.log(`profile kept: ${profile}`);
  else fs.rmSync(profile, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
