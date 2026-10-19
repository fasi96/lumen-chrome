// Runs lib/visible.js off the recorder's main thread, where the bubble is drawn 30 times
// a second: a check takes up to ~100 ms. Gets { id, frame (VideoFrame), shot
// (ImageBitmap) }, answers { id, visible, score, scale }.
import { findIn } from './lib/visible.js';

self.onmessage = ({ data: { id, frame, shot } }) => {
  let result = { visible: false, score: -1 };
  try {
    result = findIn(frame, frame.displayWidth || frame.width, frame.displayHeight || frame.height, shot);
  } catch (e) {
    result.error = String(e.message || e);
  } finally {
    frame.close?.();
    shot.close?.();
  }
  self.postMessage({ id, ...result });
};
