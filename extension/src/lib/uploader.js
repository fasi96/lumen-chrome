// Shares a finished recording on the user's own share site. Runs in the offscreen
// document (it keeps going with every tab closed), step by step, each step saved in
// the recording's journal row so a closed or crashed Chrome picks up where it stopped:
//
//   1. create the share → the link exists and is copied right away
//  1b. cut ums and long pauses, if on: the share site's Whisper hears them, the video is
//      cut here (lib/cut.js) and the clean copy is what's shared; the recording stays uncut
//   2. the poster (thumb), then the hover frames (sprite + storyboard in transcript.json)
//   3. the MP4 in fixed 10 MiB parts, 3 at a time, each retried; done parts are kept
//   4. complete → the share page plays it; then the link-preview card
//   5. what was said: transcript, then title/summary/chapters, on the share site's own AI
//      (a bonus, like the pictures: the video already plays; off with ai: false)
//
// row.share = { id, url, state: 'creating'|'uploading'|'done'|'failed', pct, error,
//               uploadId, partSize, etags: {n: etag}, art: {thumb, sprite, card, storyboard}, copied,
//               ai: { state: 'done'|'none'|'failed', words, titled, error } }
// The device key is never stored here: the service worker passes it in each time.

import * as journal from './journal.js';
import { readFile } from './opfs.js';
import { api, apiRetry, PART_SIZE } from './share.js';
import { makeArt } from './art.js';
import { micSamples, transcribe, cues, describe } from './transcribe.js';
import { SR, isFiller, fillerCuts, pauseCuts, merge, remap, toSource, cutAudio, cleanupMarks } from './cleanup.js';
import { cutVideo } from './cut.js';
import { writeFile } from './opfs.js';

const PARALLEL = 3;
const running = new Map();   // recording id → promise (one upload per recording)

// conn: { url, token, owner }; report(msg) → service worker; copy(text) → clipboard.
export function shareRecording(conn, id, { report, copy, title, ai = true, clean = true } = {}) {
  if (running.has(id)) return running.get(id);
  const p = run(conn, id, { report, copy, title, ai, clean }).finally(() => running.delete(id));
  running.set(id, p);
  return p;
}

export const isSharing = (id) => running.has(id);

async function save(id, fields) {
  const row = await journal.get(id);
  return journal.update(id, { share: { ...(row?.share || {}), ...fields } });
}

// Step 1 alone: called at stop, before the MP4 is even made, so the link is ready first.
export async function createShare(conn, id, { title, codec, report, copy }) {
  const row = await journal.get(id);
  if (row?.share?.id) return row.share;
  await save(id, { state: 'creating', started: Date.now() });
  const r = await apiRetry(conn, 'POST', '/api/videos', { title, codec, source: 'chrome' }, {}, 4);
  let copied = false;
  try { copied = !!(await copy?.(r.url)); } catch { /* the review page has a Copy button */ }
  const sh = (await save(id, { id: r.id, url: r.url, state: 'uploading', pct: 0, copied, title })).share;
  report?.({ type: 'share-link', id, url: r.url, copied });
  return sh;
}

function fmtDur(s) {
  s = Math.round(s || 0);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

async function run(conn, id, { report, copy, title, ai, clean }) {
  const progress = (pct) => report?.({ type: 'upload-progress', id, pct });
  try {
    let row = await journal.get(id);
    if (!row) throw new Error('recording not found');
    let sh = row.share?.id ? row.share
      : await createShare(conn, id, { title: title || row.title || 'Screen recording', codec: row.video?.codec, report, copy });
    if (sh.state === 'done') return sh;
    if (row.state !== 'done' || !row.files?.mp4) throw new Error('the MP4 isn’t ready (only finished MP4 recordings can be shared)');
    let file = await readFile(row.files.mp4);
    if (!file) throw new Error('the recording file is missing');
    const vid = sh.id;
    const art = sh.art || {};
    await save(id, { state: 'uploading', error: null });

    // 1b. Ums and long pauses out first, so the shared video is the clean one.
    if (ai && clean && row.files?.mic && !sh.clean) {
      try {
        await cleanUp(conn, id, file, report);
      } catch (e) {
        console.warn('[lumen] clean-up skipped:', e);
        await save(id, { clean: { state: 'failed', error: String(e.message || e) }, cleaning: null });
      }
      row = await journal.get(id);
      sh = row.share;
    }
    let dur = row.duration;
    const fillers = sh.clean?.cleanup?.fillers || 0;
    const badge = fillers ? `${fillers} um${fillers === 1 ? '' : 's'} removed` : '';
    if (sh.clean?.file) {
      const cf = await readFile(sh.clean.file);
      if (cf) { file = cf; dur = sh.clean.duration || dur; }
    }

    // 2. Poster and hover frames (a bonus: never block the video on them).
    let pics = null;
    if (!art.thumb || !art.sprite || !art.card) {
      try {
        const owner = conn.owner || '';
        const d = fmtDur(dur);
        pics = await makeArt(file, { title: sh.title || row.title || 'Screen recording', meta: owner ? `${owner}  ·  ${d}` : d, badge });
      } catch (e) {
        console.warn('[lumen] share pictures skipped:', e);
      }
    }
    if (pics && !art.thumb) {
      await apiRetry(conn, 'PUT', `/api/videos/${vid}/thumb`, pics.thumb, { type: 'image/jpeg' });
      art.thumb = true;
      await save(id, { art });
    }
    // The share page waits for a transcript marked pending (the link is opened before
    // step 5 is done), so it says "Writing the transcript…" instead of showing none.
    const pending = !!(ai && row.files?.mic && !row.share?.ai);
    if (pics && !art.sprite) {
      await apiRetry(conn, 'PUT', `/api/videos/${vid}/sprite`, pics.sprite, { type: 'image/jpeg' });
      await apiRetry(conn, 'PUT', `/api/videos/${vid}/transcript`, JSON.stringify({ storyboard: pics.storyboard, ...(pending ? { pending } : {}) }), { type: 'application/json' });
      art.sprite = true;
      art.storyboard = pics.storyboard;   // kept: the transcript step writes transcript.json again
      await save(id, { art });
    } else if (pending && !art.pending) {
      await apiRetry(conn, 'PUT', `/api/videos/${vid}/transcript`, JSON.stringify({ ...(art.storyboard ? { storyboard: art.storyboard } : {}), pending }), { type: 'application/json' });
    }
    if (pending) { art.pending = true; await save(id, { art }); }

    // 3. The video, in equal 10 MiB parts (R2 requires that), resumable.
    const size = file.size;
    const count = Math.max(1, Math.ceil(size / PART_SIZE));
    row = await journal.get(id);
    sh = row.share;
    let uploadId = sh.uploadId;
    let etags = sh.etags || {};
    if (!uploadId || sh.partSize !== PART_SIZE || sh.size !== size) {
      uploadId = (await apiRetry(conn, 'POST', `/api/videos/${vid}/mpu`)).uploadId;
      etags = {};
      await save(id, { uploadId, partSize: PART_SIZE, size, etags });
    } else if (Object.keys(etags).length) {
      await save(id, { resumed: (sh.resumed || 0) + 1 });
    }
    const up = encodeURIComponent(uploadId);
    const done = () => Object.keys(etags).length;
    const bytesDone = () => Object.keys(etags).reduce((a, n) => a + Math.min(PART_SIZE, size - (n - 1) * PART_SIZE), 0);
    progress(Math.round((bytesDone() / size) * 100));
    const todo = Array.from({ length: count }, (_, i) => i + 1).filter((n) => !etags[n]);
    let saving = Promise.resolve();
    const worker = async () => {
      while (todo.length) {
        const n = todo.shift();
        const part = file.slice((n - 1) * PART_SIZE, Math.min(size, n * PART_SIZE));
        const r = await apiRetry(conn, 'PUT', `/api/videos/${vid}/mpu/${up}/${n}`, part, { timeout: 300000 });
        etags[n] = r.etag;
        // Saved after every part: that's what makes a restart skip it.
        saving = saving.then(() => save(id, { etags: { ...etags }, pct: Math.round((bytesDone() / size) * 95) }));
        await saving;
        progress(Math.round((bytesDone() / size) * 95));
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, todo.length) }, worker));
    if (done() !== count) throw new Error('some parts didn’t upload');

    // 4. Complete; if the share site no longer knows this upload (too old), start over once.
    const parts = Object.entries(etags).map(([n, etag]) => ({ partNumber: Number(n), etag })).sort((a, b) => a.partNumber - b.partNumber);
    const meta = { parts, duration: dur || pics?.duration || null, width: row.video?.width || pics?.width || null,
      height: row.video?.height || pics?.height || null, codec: row.video?.codec || null };
    try {
      await apiRetry(conn, 'POST', `/api/videos/${vid}/mpu/${up}/complete`, meta);
    } catch (e) {
      if (e.status && e.status < 500 && !sh.restarted) {
        await save(id, { uploadId: null, etags: {}, restarted: true });
        return run(conn, id, { report, copy, title, ai, clean });
      }
      throw e;
    }
    await save(id, { state: 'done', pct: 100, doneAt: Date.now() });
    progress(100);

    // The link-preview card last, like vshare (the video already plays).
    if (pics && !art.card) {
      try {
        await apiRetry(conn, 'PUT', `/api/videos/${vid}/card`, pics.card, { type: 'image/jpeg' }, 3);
        art.card = true;
        await save(id, { art });
      } catch (e) {
        console.warn('[lumen] card skipped:', e);
      }
    }
    if (ai && row.files?.mic && !(await journal.get(id)).share.ai) {
      try {
        await whatWasSaid(conn, id, vid, file, art, dur, badge);
      } catch (e) {
        console.warn('[lumen] transcript skipped:', e);
        await save(id, { ai: { state: 'failed', error: String(e.message || e) } });
        await notPending(conn, vid, art);
      }
    }
    const final = (await journal.get(id)).share;
    report?.({ type: 'upload-done', id, url: final.url });
    return final;
  } catch (e) {
    const msg = String(e.message || e);
    // A 401 means the key was revoked: say so plainly.
    await save(id, { state: 'failed', error: e.status === 401 ? 'The share site no longer accepts this computer (disconnected?). Connect again.' : msg });
    report?.({ type: 'upload-failed', id, error: msg });
    throw e;
  }
}

// 5. The transcript (clickable lines and captions on the share page), then a title,
// summary and chapters from it. The title replaces the tab's title (it's usually just
// the page name); the link-preview card is redrawn with it.
async function whatWasSaid(conn, id, vid, file, art, dur, badge) {
  const row = await journal.get(id);
  // Already heard while cutting (1b): those words, on the cut video's timeline.
  let said = row.share?.said || null;
  if (!said) {
    const mic = await readFile(row.files.mic);
    said = mic && (await transcribe(conn, await micSamples(mic)));
  }
  const cleanup = row.share?.clean?.cleanup;
  if (!said) {
    await save(id, { ai: { state: 'none' } });
    await notPending(conn, vid, art);
    return;
  }
  // The lines go up at once (still pending: the page shows them and waits for the title).
  const lines = cues(said.words);
  const doc = { lang: said.lang, cues: lines, words: said.words, ...(cleanup ? { cleanup } : {}), ...(art.storyboard ? { storyboard: art.storyboard } : {}) };
  await apiRetry(conn, 'PUT', `/api/videos/${vid}/transcript`, JSON.stringify({ ...doc, pending: true }), { type: 'application/json' });
  await save(id, { ai: { state: 'done', words: said.words.length } });

  const meta = await describe(conn, lines, dur || lines[lines.length - 1].e, said.lang).catch(() => ({}));
  if (meta.title) await apiRetry(conn, 'PATCH', `/api/videos/${vid}`, { title: meta.title, summary: meta.summary || '' });
  // Final: no longer pending; the title rides along so a page that waited can show it.
  await apiRetry(conn, 'PUT', `/api/videos/${vid}/transcript`, JSON.stringify({ ...doc, ...meta.chapters ? { chapters: meta.chapters } : {},
    ...meta.summary ? { summary: meta.summary } : {}, ...meta.title ? { title: meta.title } : {} }), { type: 'application/json' });
  if (!meta.title) return;
  await journal.update(id, { title: meta.title });
  await save(id, { title: meta.title, ai: { state: 'done', words: said.words.length, titled: true } });
  try {
    const pics = await makeArt(file, { title: meta.title, meta: conn.owner ? `${conn.owner}  ·  ${fmtDur(dur)}` : fmtDur(dur), badge });
    await apiRetry(conn, 'PUT', `/api/videos/${vid}/card`, pics.card, { type: 'image/jpeg' }, 3);
  } catch (e) {
    console.warn('[lumen] card with the new title skipped:', e);
  }
}

// 1b. Hear the recording (mic, verbatim: ums kept), find the ums (in the gaps between
// real words) and the long pauses (in the video's own sound: mic and tab), listen once
// more to the cut sound for any "uh" still audible, then cut the video. The clean copy
// is kept next to the recording (row.files.clean) and shared; the words, already on the
// cut video's timeline, go to the transcript step. Nothing to cut: the video as it is.
async function cleanUp(conn, id, file, report) {
  const row = await journal.get(id);
  // For the badge, and the review page ("Listening for ums…", "Cutting… 40%").
  let shown = -10;
  const progress = (pct, step = 'cutting') => {
    report?.({ type: 'clean-progress', id, pct });
    if (pct - shown >= 5 || step === 'listening') { shown = pct; save(id, { cleaning: { step, pct } }).catch(() => {}); }
  };
  progress(0, 'listening');
  const micFile = await readFile(row.files.mic);
  if (!micFile) return save(id, { clean: { state: 'none' }, cleaning: null });
  const mic = await micSamples(micFile);
  const first = await transcribe(conn, mic, { verbatim: true });
  if (!first) return save(id, { clean: { state: 'none' }, cleaning: null });
  const total = row.duration || mic.length / SR;
  let what = fillerCuts(first.words, mic, total).cuts;
  try { what = what.concat(pauseCuts(await micSamples(file))); } catch (e) { console.warn('[lumen] pauses not checked:', e); }
  let cuts = merge(what);
  let words = first.words;
  if (cuts.length) {
    let out = cutAudio(mic, cuts);
    let again = await transcribe(conn, out, { verbatim: true, lang: first.lang });
    const more = again ? fillerCuts(again.words, out, out.length / SR).cuts : [];
    if (more.length) {
      what = what.concat(more.map(([a, b, l]) => [toSource(a, cuts), toSource(b, cuts), l]));
      cuts = merge(what);
      out = cutAudio(mic, cuts);
      again = await transcribe(conn, out, { verbatim: true, lang: first.lang });
    }
    // The transcript's words from the last listen (on the cut timeline), or moved there.
    words = again ? again.words : first.words.map((w) => ({ ...w, s: remap(w.s, cuts), e: remap(w.e, cuts) })).filter((w) => w.s !== null && w.e !== null);
  }
  const said = { lang: first.lang, words: words.filter((w) => !isFiller(w)) };
  if (!cuts.length) return save(id, { clean: { state: 'none' }, said, cleaning: null });
  const { blob, duration } = await cutVideo(file, cuts, { onProgress: (p) => progress(Math.round(p * 100)) });
  const name = `${id}.clean.mp4`;
  await writeFile(name, blob);
  const cleanup = cleanupMarks(cuts, what, total);
  await journal.update(id, { files: { ...row.files, clean: name }, cleanup: { fillers: cleanup.fillers, pauses: cleanup.pauses, seconds: cleanup.seconds } });
  await save(id, { clean: { state: 'done', file: name, duration, bytes: blob.size, cleanup }, said, cleaning: null });
}

// The share page stops waiting: transcript.json without the pending mark (best effort).
async function notPending(conn, vid, art) {
  if (!art.pending) return;
  await apiRetry(conn, 'PUT', `/api/videos/${vid}/transcript`, JSON.stringify(art.storyboard ? { storyboard: art.storyboard } : {}),
    { type: 'application/json' }, 3).catch(() => {});
}

// Recordings whose share didn't finish (Chrome closed, offline…), oldest first.
export async function pendingShares() {
  const rows = await journal.list();
  return rows.filter((r) => r.share && (r.share.state === 'uploading' || r.share.state === 'creating') && r.state === 'done').reverse();
}

export { api };
