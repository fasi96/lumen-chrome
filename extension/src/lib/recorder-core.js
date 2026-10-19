// The recorder itself. It runs inside the hidden offscreen document (or, as a
// fallback for screen recording, inside a pinned Lumen tab). The service worker
// only tells it "start" and "stop"; everything else happens here:
//
//   1. get the picture: a tab (from a tabCapture stream id) or a screen/window
//      (Chrome's own picker, getDisplayMedia)
//   2. get the mic, and mix it with the tab's sound in one AudioContext
//   3. record with MediaRecorder in 1-second pieces, each written to disk at once
//   4. a second, mic-only recorder (for finding ums later, in M4)
//   5. on stop: turn the WebM into an MP4 and mark the recording done

import * as journal from './journal.js';
import { ChunkWriter, readFile, writeFile, deleteFile } from './opfs.js';
import { webmToMp4 } from './remux.js';
import { compositeBubble } from '../bubble/compositor.js';
import { broadcastBubble, CHANNEL } from '../bubble/broadcast.js';
import { stopPreview } from './preview.js';
import { PRESETS, SAMPLE_RATE, micConstraints, prepare as prepareVoice, buildChain } from './voice.js';

// Formats to try, best first. Each is test-started before we trust it, because
// isTypeSupported() can say yes and start() still fail on some machines.
const VIDEO_TYPES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=h264,opus',
  'video/webm',
];
const MIC_TYPE = 'audio/webm;codecs=opus';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pickRecorder(stream, types, options) {
  for (const mimeType of types) {
    if (!MediaRecorder.isTypeSupported(mimeType)) continue;
    // Test-start on a throwaway copy of the tracks, then make the real one.
    const copy = stream.clone();
    try {
      const probe = new MediaRecorder(copy, { ...options, mimeType });
      probe.start();
      probe.stop();
      return new MediaRecorder(stream, { ...options, mimeType });
    } catch { /* try the next one */ } finally {
      copy.getTracks().forEach((t) => t.stop());
    }
  }
  throw new Error('This browser can’t record any of: ' + types.join(', '));
}

// The tab's size in device pixels (size.dpr: the page's pixel density, so text stays
// sharp on HiDPI screens), scaled down to fit 1920×1080, even numbers (video encoders
// want those).
function fitTab(size) {
  if (!size?.width || !size?.height) return { width: 1920, height: 1080 };
  const dpr = size.dpr || globalThis.devicePixelRatio || 1;
  let w = size.width * dpr;
  let h = size.height * dpr;
  const k = Math.min(1, 1920 / w, 1080 / h);
  w = Math.round((w * k) / 2) * 2;
  h = Math.round((h * k) / 2) * 2;
  return { width: w, height: h };
}

export class Recorder {
  // report(msg) sends a status message to the service worker.
  constructor(report) {
    this.report = report;
    this.cancelled = false;
  }

  // opts: { id, mode: 'tab'|'screen', streamId?, tabSize?, mic: bool, countdown: seconds, title, codec?,
  //         bubble?: { deviceId, look: { shape, outline, size }, corner, inVideo? } }
  async start(opts) {
    this.opts = opts;
    const { id } = opts;

    // 1. The picture (and the tab's sound).
    if (opts.mode === 'tab') {
      // Tab capture always fills the max size you ask for, adding black bars when
      // the shapes differ (M0). So ask for the tab's own shape, at most 1080p.
      const { width, height } = fitTab(opts.tabSize);
      this.capture = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: opts.streamId } },
        video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: opts.streamId,
          maxWidth: width, maxHeight: height, minWidth: width, minHeight: height, maxFrameRate: 30 } },
      });
    } else {
      // Chrome's picker: tab, window or whole screen. On Linux the sound comes
      // only with a tab; whole-screen system audio is Windows/ChromeOS only.
      this.capture = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30, width: { max: 1920 }, height: { max: 1080 } },
        audio: true,
        systemAudio: 'include',
        selfBrowserSurface: 'exclude',
      });
    }
    const source = this.capture.getVideoTracks()[0];
    // Chrome's own "Stop sharing" button (or closing the tab) ends the track.
    source.addEventListener('ended', () => this.stop('source ended'));

    // The face bubble. Tab mode: drawn here, sent to the bubble iframe in the page
    // (bubble/broadcast.js), so the tab capture records it with the page. Screen/window
    // mode: drawn into the video right here, whichever screen or window is shared;
    // your tab gets a "Show my camera" pill that floats the camera over every app, and
    // while it floats the recorder looks for that window in the recording (watchCam).
    let video = source;
    this.bubbleWarning = null;
    if (opts.bubble) {
      try {
        if (opts.mode === 'tab' && !opts.bubble.inVideo) {
          this.compositor = await broadcastBubble(opts.bubble);
          this.bubbleMode = 'in page';
        } else {
          const live = opts.mode === 'screen';
          stopPreview();          // the camera the floating window showed until now
          this.compositor = await compositeBubble(source, { ...opts.bubble, live });
          video = this.compositor.track;
          this.bubbleMode = 'in video';
          if (live) {
            const ans = await this.report({ type: 'bubble-live', id });
            if (ans?.ok) this.bubbleMode = 'in video, can float';
            else this.bubbleWarning = `no “Show my camera” button: ${ans?.error || 'the page doesn’t allow it'}`;
            this.watchCam();
          }
        }
        globalThis.lumenBubble = this.compositor;     // for the tests' CPU/mask stats
      } catch (e) {
        this.bubbleWarning = `${e.name}: ${e.message}`;
        this.report({ type: 'warn', id, error: `face bubble off: ${this.bubbleWarning}` });
      }
    }

    // One AudioContext mixes everything into a single track. 48 kHz: what RNNoise needs.
    this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    await this.ctx.resume(); // starts "suspended" when there was no click here
    const mix = this.ctx.createMediaStreamDestination();

    // 2. Mic (optional), through the Sound chain (lib/voice.js). Permission was granted
    // once on the welcome page; the offscreen document can't ask for it itself.
    this.micWarning = null;
    let voiceOut = null;
    if (opts.mic) {
      const params = opts.voice?.params || PRESETS.Natural;
      let wasm = null;
      let chain = true;
      try { wasm = await prepareVoice(this.ctx); } catch (e) {
        chain = false;
        this.report({ type: 'warn', id, error: `sound settings off: ${e.message}` });
      }
      // Without the chain, Chrome's own clean-up does the job (as before Sound existed).
      const ask = (deviceId) => navigator.mediaDevices.getUserMedia({ audio: chain
        ? micConstraints(params, deviceId, !!wasm)
        : { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      try {
        try {
          this.mic = await ask(opts.micDevice);
        } catch (e) {
          // The chosen mic is unplugged: use the default one, like desktop Lumen.
          if (!opts.micDevice || !['OverconstrainedError', 'NotFoundError'].includes(e.name)) throw e;
          this.mic = await ask('');
        }
      } catch (e) {
        this.micWarning = `${e.name}: ${e.message}`;
      }
      if (this.mic) {
        const src = this.ctx.createMediaStreamSource(this.mic);
        if (chain) {
          try { this.voice = buildChain(this.ctx, src, params, wasm); } catch (e) {
            this.report({ type: 'warn', id, error: `sound settings off: ${e.message}` });
          }
        }
        voiceOut = this.voice ? this.voice.output : src;
      }
    }
    let sources = 0;
    if (this.capture.getAudioTracks().length) {
      const tab = this.ctx.createMediaStreamSource(this.capture);
      tab.connect(mix);
      // Tab capture silences the tab for the user; play it back so they still hear it.
      if (opts.mode === 'tab') tab.connect(this.ctx.destination);
      sources++;
    }
    if (voiceOut) {
      voiceOut.connect(mix);
      sources++;
    }
    const tracks = [video, ...(sources ? mix.stream.getAudioTracks() : [])];
    this.stream = new MediaStream(tracks);

    // 3. Recorders. 1 s keyframes keep seeking smooth on mostly-still screens.
    // codec 'h264' (not in the UI yet) records H.264 in WebM first, which M0 found
    // works on Linux Chrome and remuxes to an MP4 that Safari/iPhone can play.
    const types = opts.codec === 'h264' ? [VIDEO_TYPES[2], ...VIDEO_TYPES] : VIDEO_TYPES;
    this.rec = pickRecorder(this.stream, types, {
      videoBitsPerSecond: 5_000_000, audioBitsPerSecond: 128_000, videoKeyFrameIntervalDuration: 1000,
    });
    // The mic-only copy gets the cleaned-up voice too.
    if (voiceOut) {
      const micOnly = this.ctx.createMediaStreamDestination();
      voiceOut.connect(micOnly);
      this.micRec = pickRecorder(micOnly.stream, [MIC_TYPE], { audioBitsPerSecond: 48_000 });
    }

    const files = { webm: `${id}.webm`, mic: this.micRec ? `${id}.mic.webm` : null, mp4: null };
    this.writer = new ChunkWriter();
    await this.writer.open(files.webm);
    if (files.mic) await this.writer.open(files.mic);
    this.files = files;

    // Optional 3-2-1, shown on the toolbar badge. Nothing is recorded yet.
    for (let n = opts.countdown || 0; n > 0 && !this.cancelled; n--) {
      this.report({ type: 'tick', id, n });
      await sleep(1000);
    }
    if (opts.countdown > 0 && !this.cancelled) {
      // "0" removes the on-page countdown; give the page a moment to repaint without
      // it before recording, so the overlay is never in the video.
      this.report({ type: 'tick', id, n: 0 });
      await sleep(350);
    }
    if (this.cancelled) return this.cancel();

    await journal.put({
      id, createdAt: Date.now(), mode: opts.mode, title: opts.title || '', mime: this.rec.mimeType,
      state: 'recording', bytes: 0, chunks: 0, files, micWarning: this.micWarning,
      // Which Sound the mic went through ('Natural', 'Custom'…), or why it didn't.
      sound: !this.mic ? null : this.voice ? `${opts.voice?.preset || 'Natural'}${this.voice.denoise ? '' : ', Chrome noise suppression'}` : 'off',
      bubble: opts.bubble ? opts.bubble.look : null, bubbleWarning: this.bubbleWarning, bubbleMode: this.bubbleMode || null,
      surface: opts.mode === 'screen' ? source.getSettings().displaySurface || null : 'tab',   // what Chrome's picker shared
      size: `${source.getSettings().width}x${source.getSettings().height}`,
    });

    // Every second a piece arrives; write it to disk straight away. Pieces are
    // chained so they land in order even if a write is slow.
    let chain = Promise.resolve();
    let chunks = 0;
    let lastJournal = 0;
    const save = (name, blob, isMain) => {
      chain = chain.then(async () => {
        if (!blob.size) return;
        const size = await this.writer.append(name, await blob.arrayBuffer());
        if (isMain) {
          chunks++;
          if (Date.now() - lastJournal > 2000) { // keep the journal roughly current
            lastJournal = Date.now();
            await journal.update(id, { bytes: size, chunks, lastFlushAt: lastJournal });
          }
        }
      }).catch((e) => this.report({ type: 'warn', id, error: `disk write failed: ${e.message}` }));
    };
    this.rec.ondataavailable = (e) => save(files.webm, e.data, true);
    if (this.micRec) this.micRec.ondataavailable = (e) => save(files.mic, e.data, false);
    this.drained = () => chain;

    this.stopped = Promise.all([this.rec, this.micRec].filter(Boolean)
      .map((r) => new Promise((res) => r.addEventListener('stop', res, { once: true }))));
    this.rec.start(1000);
    this.micRec?.start(1000);
    this.startedAt = Date.now();
    this.report({ type: 'started', id, mime: this.rec.mimeType, micWarning: this.micWarning });
  }

  // Stops recording, then remuxes. Safe to call twice (button + track ended).
  async stop(reason = 'user') {
    if (this.stopping) return this.stopping;
    if (!this.rec || this.rec.state === 'inactive') {
      this.cancelled = true; // still counting down, or never started
      return;
    }
    this.stopping = (async () => {
      const { id } = this.opts;
      this.report({ type: 'stopped', id, reason });
      this.rec.stop();
      if (this.micRec?.state !== 'inactive') this.micRec?.stop();
      await this.stopped;
      await this.drained();
      const bytes = await this.writer.close(this.files.webm);
      if (this.files.mic) await this.writer.close(this.files.mic);
      this.cleanup();
      await journal.update(id, { state: 'processing', bytes, stoppedAt: Date.now(),
        seconds: (Date.now() - this.startedAt) / 1000,
        ...(this.camChecks ? { camChecks: this.camChecks, bubbleStats: { drawnIn: this.compositor?.stats?.drawnIn, leftOut: this.compositor?.stats?.leftOut } } : {}) });
      await finish(id, (p) => this.report({ type: 'progress', id, p }));
      this.report({ type: 'saved', id, row: await journal.get(id) });
    })().catch(async (e) => {
      await journal.update(this.opts.id, { state: 'failed', error: String(e) }).catch(() => {});
      this.report({ type: 'error', id: this.opts.id, error: String(e) });
    });
    return this.stopping;
  }

  // Stopped during the countdown: nothing was recorded, so leave nothing behind.
  async cancel() {
    await this.writer.close(this.files.webm);
    if (this.files.mic) await this.writer.close(this.files.mic);
    this.cleanup();
    for (const f of [this.files.webm, this.files.mic]) if (f) await deleteFile(f);
    this.report({ type: 'cancelled', id: this.opts.id });
  }

  // While the camera floats: every 2 s the window's picture (it answers on the bubble's
  // BroadcastChannel) is looked for in the latest recorded frame, in a worker
  // (lib/visible.js). Seen → the compositor stops drawing the bubble in. Flips only when
  // sure: seen at 0.8 or better, lost below 0.7.
  watchCam() {
    this.visibleWorker = new Worker('visible-worker.js', { type: 'module' });
    this.camChecks = { done: 0, seen: 0, last: null };
    const channel = new BroadcastChannel(CHANNEL);
    this.camChannel = channel;
    let seq = 0;
    const snap = () => new Promise((resolve) => {
      const n = ++seq;
      const t = setTimeout(() => resolve(null), 1500);
      channel.onmessage = ({ data: m }) => { if (m?.type === 'snap' && m.n === n) { clearTimeout(t); resolve(m.shot); } };
      channel.postMessage({ type: 'snap-req', n });
    });
    const find = (frame, shot) => new Promise((resolve) => {
      const n = ++seq;
      this.visibleWorker.onmessage = ({ data }) => { if (data.id === n) resolve(data); };
      this.visibleWorker.postMessage({ id: n, frame, shot }, [frame, shot]);
    });
    let seen = false;
    const check = async () => {
      if (!this.visibleWorker) return;
      try {
        if (this.compositor?.floating) {
          const shot = await snap();
          const frame = this.compositor.screenFrame();
          if (shot && frame) {
            const r = await find(frame, shot);
            seen = seen ? r.score >= 0.7 : r.score >= 0.8;
            this.camChecks.last = { score: r.score, scale: r.scale, seen };
          } else {
            shot?.close?.();
            frame?.close();
            seen = false;
            this.camChecks.last = { seen: false, why: shot ? 'no screen frame' : 'the window didn’t answer' };
          }
          this.camChecks.done++;
          if (seen) this.camChecks.seen++;
        } else {
          seen = false;
        }
        this.compositor?.setCamVisible(seen);
      } catch (e) {
        this.camChecks.last = { error: String(e.message || e) };
      }
      if (this.visibleWorker) this.camTimer = setTimeout(check, 2000);
    };
    check();
  }

  cleanup() {
    clearTimeout(this.camTimer);
    this.visibleWorker?.terminate();
    this.visibleWorker = null;
    this.camChannel?.close();
    this.compositor?.stop();
    for (const s of [this.capture, this.mic]) s?.getTracks().forEach((t) => t.stop());
    this.voice?.dispose();
    this.ctx?.close().catch(() => {});
    this.writer?.terminate();
  }
}

// After recording (or when recovering one after a crash): WebM → MP4 next to it.
// If the remux fails, the WebM stays downloadable and the row says why.
export async function finish(id, onProgress) {
  const row = await journal.get(id);
  const webm = await readFile(row.files.webm);
  if (!webm || !webm.size) throw new Error('the recording file is empty');
  try {
    const t0 = performance.now();
    const out = await webmToMp4(webm, onProgress);
    const remuxMs = Math.round(performance.now() - t0);
    const mp4 = `${id}.mp4`;
    await writeFile(mp4, out.blob);
    return journal.update(id, {
      state: 'done', files: { ...row.files, mp4 }, duration: out.duration,
      mp4Bytes: out.blob.size, video: out.video, audio: out.audio, error: null, remuxMs,
    });
  } catch (e) {
    return journal.update(id, { state: 'done', duration: null, error: `MP4 failed, WebM kept: ${e.message}` });
  }
}
