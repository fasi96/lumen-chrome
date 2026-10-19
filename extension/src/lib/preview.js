// The camera in the floating window from the moment you click "Show my camera", before
// Chrome's (and the desktop's) screen pickers and the countdown: the recorder only
// starts the camera once a screen is picked, so the window would sit on "Starting
// camera…" all that time. Runs in the offscreen document; the recorder stops it when its
// own camera takes over (compositor.js), or the service worker when starting fails.

import { CHANNEL } from '../bubble/broadcast.js';

let preview = null;

export async function startPreview(deviceId) {
  if (preview) return;
  const ask = (id) => navigator.mediaDevices.getUserMedia({ video: { ...(id ? { deviceId: { exact: id } } : {}), width: { ideal: 1280 }, height: { ideal: 720 } } });
  const stream = await ask(deviceId).catch(() => ask(''));
  const reader = new MediaStreamTrackProcessor({ track: stream.getVideoTracks()[0] }).readable.getReader();
  const channel = new BroadcastChannel(CHANNEL);
  const p = { stream, reader, channel, running: true };
  preview = p;
  // About 15 pictures a second, 640 px wide, like the compositor sends while floating.
  let last = 0, busy = false;
  while (p.running) {
    const { value: frame, done } = await reader.read().catch(() => ({ done: true }));
    if (done) break;
    const now = performance.now();
    if (busy || now - last < 66) { frame.close(); continue; }
    last = now;
    busy = true;
    createImageBitmap(frame, { resizeWidth: 640, resizeHeight: Math.round((640 * frame.displayHeight) / frame.displayWidth), resizeQuality: 'medium' })
      .then((whole) => { if (p.running) channel.postMessage({ type: 'frame', whole, t: now / 1000 }); whole.close(); })
      .catch(() => {})
      .finally(() => { frame.close(); busy = false; });
  }
}

export function stopPreview() {
  const p = preview;
  if (!p) return;
  preview = null;
  p.running = false;
  p.reader.cancel().catch(() => {});
  p.stream.getTracks().forEach((t) => t.stop());
  p.channel.close();
}
