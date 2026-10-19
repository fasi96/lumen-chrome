// Tab mode: the camera and the person outline run here, in the offscreen document, and
// each frame's square picture (an ImageBitmap) and outline go to the bubble iframe in
// the recorded page, which draws the bubble.
//
// Why not run the camera in that iframe? M2 found that Chrome checks the camera
// permission of the *web page* for an extension iframe inside it, so every site would
// ask "<site> wants to use your camera" (and sites that block the camera would break
// the bubble). The offscreen document is the extension's own page, where the one-time
// permission from the welcome page applies. BroadcastChannel reaches the iframe because
// extension frames aren't storage-partitioned.

import { Bubble, cropOf } from './bubble.js';

export const CHANNEL = 'lumen-bubble';

// The iframe is a bit bigger than the bubble: room for the wobble and the toolbar.
export const frameSize = (d) => ({ w: Math.round(d * 1.3), h: Math.round(d * 1.3) + 34 });

export async function broadcastBubble({ deviceId, look, delegate } = {}) {
  const bubble = new Bubble({ deviceId, look, delegate, ownPicture: false });
  await bubble.start();
  const channel = new BroadcastChannel(CHANNEL);
  const stats = { sent: 0, sendMs: 0 };

  // The floating window (bubble-inject.js) shows the whole camera picture, not the bubble.
  let full = false;
  channel.onmessage = ({ data: m }) => {
    if (m?.type === 'look') bubble.setLook(m.look);
    if (m?.type === 'close') bubble.stop();
    if (m?.type === 'pip') full = !!m.on;
  };

  // Each camera frame: the zoomed middle of it, resized by Chrome (createImageBitmap,
  // off the main thread), plus the outline. The page's iframe mirrors and draws it with
  // drawBubble(), on its own canvas. Pictures still being made are skipped, not queued.
  let busy = false;
  bubble.onFrame = (frame) => {
    if (busy) { stats.skipped = (stats.skipped || 0) + 1; return; }
    busy = true;
    const t0 = performance.now();
    const [x, y, side] = cropOf(frame);
    const pts = bubble.shape(), pop = bubble.pop.x, c = [...bubble.blob.c];
    const copy = frame.clone();
    const wide = full ? createImageBitmap(copy, { resizeWidth: 640, resizeHeight: Math.round((640 * frame.displayHeight) / frame.displayWidth), resizeQuality: 'medium' }) : null;
    Promise.all([createImageBitmap(copy, x, y, side, side, { resizeWidth: 320, resizeHeight: 320, resizeQuality: 'medium' }), wide])
      .then(([picture, whole]) => {
        channel.postMessage({ type: 'frame', picture, whole, pts, pop, t: t0 / 1000, mirror: true, c, R: bubble.blob.R });
        picture.close();
        whole?.close();
        stats.sent++;
      })
      .catch(() => {})
      .finally(() => { copy.close(); busy = false; });
    stats.sendMs += performance.now() - t0;
  };

  return {
    bubble,
    stats,
    stop() {
      bubble.stop();
      channel.postMessage({ type: 'stopped' });
      channel.close();
    },
  };
}
