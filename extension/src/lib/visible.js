// Is the floating camera window in what's being recorded? In a screen recording the
// bubble is drawn into the video, unless you float your camera (Picture-in-Picture) onto
// the screen being recorded: then that window is recorded and none may be drawn in.
// Chrome doesn't say which screen is shared, or where that window is (and on Wayland it
// reports the screens wrongly), so this looks: a snapshot of what the window shows (your
// camera: a lot of detail, nothing else on screen looks like it) is searched for in the
// recorded frame, both shrunk to a few thousand grey pixels, over a range of sizes, by
// normalized cross-correlation. Pure math on grey arrays: test/visible.test.mjs.

const W = 160;               // the recorded frame is compared at this width

// Grey values (0..1) of an image source drawn at w×h.
export function grey(source, w, h) {
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const g = new Float32Array(w * h);
  for (let i = 0; i < g.length; i++) g[i] = (0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]) / 255;
  return g;
}

// Best normalized cross-correlation of template t (tw×th) anywhere in image f (fw×fh),
// -1..1 (1 = the same picture), over the template pixels where mask (optional, 1/0) is 1.
// Step 1 px: the images are small.
export function bestMatch(f, fw, fh, t, tw, th, mask = null) {
  if (tw > fw || th > fh || tw < 8 || th < 6) return { score: -1 };
  // The template pixels that count, centred: per position only three sums are needed
  // (Σf, Σf², Σf·t'), since Σt' = 0.
  const offs = [], tc = [];
  let tm = 0;
  for (let j = 0; j < th; j++) for (let i = 0; i < tw; i++) if (!mask || mask[j * tw + i]) { offs.push(j * fw + i); tm += t[j * tw + i]; }
  const n = offs.length;
  if (n < 40) return { score: -1 };
  tm /= n;
  let tv = 0, k = 0;
  for (let j = 0; j < th; j++) for (let i = 0; i < tw; i++) if (!mask || mask[j * tw + i]) { const v = t[j * tw + i] - tm; tc.push(v); tv += v * v; k++; }
  if (tv < 1e-6) return { score: -1 };        // a blank page proves nothing
  const O = Int32Array.from(offs), T = Float32Array.from(tc);
  let best = { score: -1 };
  for (let y = 0; y <= fh - th; y++) {
    for (let x = 0; x <= fw - tw; x++) {
      const base = y * fw + x;
      let s1 = 0, s2 = 0, s3 = 0;
      for (let q = 0; q < n; q++) {
        const v = f[base + O[q]];
        s1 += v; s2 += v * v; s3 += v * T[q];
      }
      const fv = s2 - (s1 * s1) / n;
      const score = fv > 1e-9 ? s3 / Math.sqrt(fv * tv) : -1;
      if (score > best.score) best = { score, x, y };
    }
  }
  return best;
}

// The sizes a window can appear at in a recording, relative to its own pixels: a screen
// scaled down to fit the recording, or not (0.3 … 1.4, ~15 % apart).
export const SCALES = [1, 0.87, 0.76, 0.66, 0.57, 0.5, 0.43, 0.38, 0.33, 1.15, 1.32];

// frame: the recorded picture (VideoFrame or any image source, fw×fh device pixels);
// shot: what the window shows (ImageBitmap, in its own pixels). Returns
// { visible, score, scale }: score ≥ threshold somewhere at one of the scales.
export function findIn(frame, fw, fh, shot, { scales = SCALES, threshold = 0.8 } = {}) {
  const k = W / fw;
  const fh2 = Math.max(1, Math.round(fh * k));
  const f = grey(frame, W, fh2);
  let best = { score: -1 };
  for (const s of scales) {
    const tw = Math.round(shot.width * s * k), th = Math.round(shot.height * s * k);
    if (tw < 8 || th < 6 || tw > W || th > fh2) continue;
    const m = bestMatch(f, W, fh2, grey(shot, tw, th), tw, th);
    if (m.score > best.score) best = { ...m, scale: s };
    if (best.score >= threshold + 0.05) break;     // clearly there: no need to try other sizes
  }
  return { visible: best.score >= threshold, score: +best.score.toFixed(3), scale: best.scale };
}
