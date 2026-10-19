// Screen/window mode: draws the face bubble into the recorded video itself, because a
// bubble on screen may not be in the capture (other apps, Wayland). Runs in the
// offscreen document:
//
//   screen track → MediaStreamTrackProcessor → (latest screen frame)
//   camera → Bubble → on every camera frame: screen frame + bubble → canvas
//   canvas → VideoFrame → MediaStreamTrackGenerator → the track MediaRecorder records
//
// Frames go out when the camera or the screen has a new picture (at most 30 a second),
// so the bubble keeps moving even while the screen is still and Chrome sends no new
// screen frames. No requestAnimationFrame.
//
// live (screen recordings): your camera can float over every app in a Picture-in-Picture
// window (the "Show my camera" pill, bubble-inject.js), fed from this camera over the
// BroadcastChannel. While it floats, the recorder checks every 2 s whether that window
// is in the recorded picture (lib/visible.js) and calls setCamVisible(): in it → the
// window is recorded, so the bubble isn't drawn in (never two); not (another monitor,
// behind an app) or closed → drawn in. Exactly one bubble in the video.

import { Bubble, SIZES } from './bubble.js';
import { CHANNEL } from './broadcast.js';

// look: { shape, outline, size }, corner: 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right'
export async function compositeBubble(screenTrack, { deviceId, look, corner = 'bottom-left', delegate, live = false } = {}) {
  const bubble = new Bubble({ deviceId, look, delegate });
  await bubble.start();

  const gen = new MediaStreamTrackGenerator({ kind: 'video' });
  const writer = gen.writable.getWriter();
  const screenReader = new MediaStreamTrackProcessor({ track: screenTrack }).readable.getReader();
  let screen = null;            // the latest screen frame (we own it until replaced)
  let running = true;
  const stats = { written: 0, dropped: 0, composeMs: 0, drawnIn: 0, leftOut: 0 };
  let floating = false;
  let camVisible = false;          // the floating window seen in the recording
  const drawIn = () => !(floating && camVisible);
  const channel = live ? new BroadcastChannel(CHANNEL) : null;
  if (channel) {
    channel.onmessage = ({ data: m }) => {
      if (m?.type === 'pip') { floating = !!m.on; if (!floating) camVisible = false; }
    };
    channel.postMessage({ type: 'pip-query' });   // already floating (opened before the picker)?
  }
  let pending = 0;

  let canvas, ctx;
  const t0 = performance.now();
  let lastOut = -Infinity;
  // A new frame goes out whenever the screen or the camera has a new picture, at most
  // 30 times a second: a still screen still gets a moving bubble, and a busy screen
  // isn't held back to the camera's frame rate.
  const compose = () => {
    if (!running || !screen) return;
    const c0 = performance.now();
    if (c0 - lastOut < 1000 / 30 - 3) return;
    lastOut = c0;
    const w = screen.displayWidth, h = screen.displayHeight;
    if (!canvas || canvas.width !== w || canvas.height !== h) {
      canvas = new OffscreenCanvas(w, h);
      ctx = canvas.getContext('2d', { alpha: false });
    }
    ctx.drawImage(screen, 0, 0, w, h);
    // Size: the desktop's sizes, for an 800 px tall video (scaled with the video).
    const d = SIZES[bubble.look.size ?? 1] * (h / 800);
    const inset = 0.035 * h;
    const cx = corner.endsWith('right') ? w - inset - d / 2 : inset + d / 2;
    const cy = corner.startsWith('top') ? inset + d / 2 : h - inset - d / 2;
    if (drawIn()) { bubble.draw(ctx, cx, cy, d); stats.drawnIn++; } else stats.leftOut++;
    if (pending > 2) { stats.dropped++; return; }   // the encoder is behind: skip a frame
    const frame = new VideoFrame(canvas, { timestamp: Math.round((performance.now() - t0) * 1000) });
    pending++;
    writer.write(frame).catch(() => {}).finally(() => { pending--; frame.close(); });
    stats.written++;
    stats.composeMs += performance.now() - c0;
  };
  // The floating window's picture: the whole camera frame, 640 px wide (mirrored there).
  let sending = false;
  bubble.onFrame = (frame) => {
    compose();
    if (!floating || sending) return;
    sending = true;
    const copy = frame.clone();
    createImageBitmap(copy, { resizeWidth: 640, resizeHeight: Math.round((640 * frame.displayHeight) / frame.displayWidth), resizeQuality: 'medium' })
      .then((whole) => { channel.postMessage({ type: 'frame', whole, t: performance.now() / 1000 }); whole.close(); })
      .catch(() => {})
      .finally(() => { copy.close(); sending = false; });
  };

  (async () => {
    while (running) {
      const { value, done } = await screenReader.read().catch(() => ({ done: true }));
      if (done) break;
      screen?.close();
      screen = value;
      compose();
    }
  })();

  return {
    track: gen,
    bubble,
    stats,
    get floating() { return floating; },
    get drawingIn() { return drawIn(); },
    setCamVisible(v) { camVisible = !!v; },
    // A copy of the latest screen frame, for the visibility check (the caller closes it).
    screenFrame() { try { return screen ? screen.clone() : null; } catch { return null; } },
    stop() {
      running = false;
      channel?.postMessage({ type: 'stopped' });
      channel?.close();
      bubble.stop();
      screenReader.cancel().catch(() => {});
      screen?.close();
      writer.close().catch(() => {});
      gen.stop();
    },
  };
}
