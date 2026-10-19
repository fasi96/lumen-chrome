// The face bubble: camera → square, mirrored picture → person segmenter (a few times a
// second) → Blob springs → drawn on any 2D canvas, cut to the blob, with the desktop's
// shadow and outline effects. Used by the in-page bubble (tab mode) and by the
// screen-mode compositor.
//
// Camera frames arrive through a MediaStreamTrackProcessor, so nothing depends on
// requestAnimationFrame (which never ticks in the hidden offscreen document). Each
// camera frame calls onFrame(frame); the host then calls draw().

import { Blob, personMask, head, fixedShape, smoothPolygon, Spring } from './shape.js';
import { Segmenter } from './segmenter.js';

export const SIZES = [150, 250, 350];               // small, medium, large (CSS px), as on the desktop
export const SHAPES = ['blob', 'circle', 'card'];
export const OUTLINES = ['plain', 'glow', 'rainbow'];
const ZOOM = 1.12;                                  // the camera's middle, like desktop "Normal" room
const PIC = 384;                                    // the square picture's resolution (enough for "Large" at 1×)
const SEG = 256;                                    // the segmenter's input size (its native size)

// The square, zoomed middle of a camera frame: [x, y, side] in its pixels.
export function cropOf(frame) {
  const w = frame.displayWidth, h = frame.displayHeight;
  const s = Math.min(w, h) / ZOOM;
  return [(w - s) / 2, (h - s) / 2, s];
}

export class Bubble {
  // look: { shape, outline, size (0..2) }; segHz: at most how often the person outline
  // is updated (the springs fill in between, so 10 a second looks smooth).
  // ownPicture: false when the host makes its own picture from each camera frame
  // (tab mode sends a resized bitmap to the page instead).
  constructor({ deviceId = '', look = {}, segHz = 10, delegate = 'CPU', ownPicture = true } = {}) {
    this.ownPicture = ownPicture;
    this.deviceId = deviceId;
    this.look = { shape: 'blob', outline: 'plain', size: 1, ...look };
    this.segGap = this.minGap = 1000 / segHz;
    this.useImageData = globalThis.LUMEN_SEG_IMAGEDATA ?? true;
    this.lastSeg = -Infinity;
    this.delegate = delegate;
    this.blob = new Blob({ follow: this.look.follow });
    this.mask = null;
    this.morph = new Spring(this.look.shape === 'blob' ? 0 : 1, 120, 0.7);  // 0 = follows you, 1 = fixed shape
    this.card = new Spring(this.look.shape === 'card' ? 1 : 0, 120, 0.7);   // fixed shape: 0 = circle, 1 = card
    this.pop = new Spring(0.9, 120, 1);                                      // a gentle settle in, no bounce
    this.pop.target = 1;
    this.picture = new OffscreenCanvas(PIC, PIC);
    this.pctx = this.picture.getContext('2d');
    this.small = new OffscreenCanvas(SEG, SEG);
    this.sctx = this.small.getContext('2d', { willReadFrequently: true });
    this.frames = 0;
    this.stats = { frames: 0, segments: 0, cropMs: 0, segMs: 0, shapeMs: 0, drawMs: 0, draws: 0, maskArea: 0 };
    this.onFrame = null;
    this.onEnded = null;
  }

  setLook(look) {
    Object.assign(this.look, look);
    if (look.follow) this.blob.setFollow(look.follow);
    this.morph.target = this.look.shape === 'blob' ? 0 : 1;
    if (this.look.shape !== 'blob') this.card.target = this.look.shape === 'card' ? 1 : 0;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        ...(this.deviceId ? { deviceId: { exact: this.deviceId } } : {}),
        // 24 fps is plenty for a bubble and keeps its cost down (Chrome drops the extra frames).
        width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 24 },
      },
    });
    this.track = this.stream.getVideoTracks()[0];
    this.segmenter = await Segmenter.create(this.delegate);
    this.reader = new MediaStreamTrackProcessor({ track: this.track }).readable.getReader();
    this.running = true;
    this.stats.since = performance.now();
    this.loop();
    return this;
  }

  async loop() {
    let last = performance.now();
    while (this.running) {
      const { value: frame, done } = await this.reader.read().catch(() => ({ done: true }));
      if (done || !frame) break;
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;
      try {
        this.ingest(frame, dt);
        this.onFrame?.(frame);       // the host may use (or clone) the frame now
      } finally {
        frame.close();
      }
    }
    this.running = false;
    this.onEnded?.();
  }

  // One camera frame: crop + mirror into the picture, segment now and then, step the springs.
  ingest(frame, dt) {
    const t0 = performance.now();
    const w = frame.displayWidth, h = frame.displayHeight;
    const s = Math.min(w, h) / ZOOM;
    if (this.ownPicture) {
      this.pctx.setTransform(-1, 0, 0, 1, PIC, 0);        // a mirror, like every video call
      this.pctx.drawImage(frame, (w - s) / 2, (h - s) / 2, s, s, 0, 0, PIC, PIC);
    }
    const t1 = performance.now();
    this.stats.cropMs += t1 - t0;

    this.frames++;
    if (t1 - this.lastSeg >= this.segGap * 0.9 && this.look.shape === 'blob') {
      this.lastSeg = t1;
      // Straight from the camera frame (not from the picture, which may live on the
      // GPU and would have to be read back).
      this.sctx.setTransform(-1, 0, 0, 1, SEG, 0);
      this.sctx.drawImage(frame, (w - s) / 2, (h - s) / 2, s, s, 0, 0, SEG, SEG);
      // Plain pixels (ImageData), not a canvas: MediaPipe then skips its WebGL upload
      // path, which is slow when Chrome renders in software.
      const m = this.segmenter.run(this.useImageData ? this.sctx.getImageData(0, 0, SEG, SEG) : this.small);
      this.mask = m ? personMask(m.data, m.width) : null;
      if (this.mask) {
        let a = 0;
        for (const v of this.mask) a += v;
        a /= this.mask.length;
        // No clear head, or "person" everywhere (a noisy mask): stay a circle.
        if (a > 0.9 || !head(this.mask)) this.mask = null;
      }
      const t2 = performance.now();
      this.stats.segMs += t2 - t1;
      this.stats.segments++;
      let area = 0;
      if (this.mask) for (const v of this.mask) area += v;
      this.stats.maskArea = area / this.mask?.length || 0;
      // Keep the model to about 10 % of one core: on a slow machine it runs less
      // often (down to 4 times a second) and the springs smooth over the gaps.
      this.segCost = this.segCost == null ? t2 - t1 : this.segCost * 0.8 + (t2 - t1) * 0.2;
      this.segGap = Math.min(250, Math.max(this.minGap, this.segCost / 0.1));
    }
    const t3 = performance.now();
    this.blob.update(this.look.shape === 'blob' ? this.mask : null, dt);
    this.morph.step(dt);
    this.card.step(dt);
    this.pop.step(dt);
    this.stats.shapeMs += performance.now() - t3;
    this.stats.frames++;
  }

  // The current outline, normalised to the picture (morph to circle/card applied).
  shape() {
    const m = Math.min(1, Math.max(0, this.morph.x));
    let pts = this.blob.outline();
    if (m > 0.001) {
      const fixed = fixedShape(Math.min(1, Math.max(0, this.card.x)));
      pts = pts.map((p, i) => [p[0] * (1 - m) + fixed[i][0] * m, p[1] * (1 - m) + fixed[i][1] * m]);
    }
    return pts;
  }

  // Draws the bubble on ctx at (cx, cy) with diameter d (see drawBubble).
  draw(ctx, cx, cy, d, t = performance.now() / 1000) {
    const t0 = performance.now();
    drawBubble(ctx, { picture: this.picture, pts: this.shape(), pop: this.pop.x, cx, cy, d, outline: this.look.outline, t });
    this.stats.drawMs += performance.now() - t0;
    this.stats.draws++;
  }

  stop() {
    this.running = false;
    this.reader?.cancel().catch(() => {});
    this.stream?.getTracks().forEach((t) => t.stop());
    this.segmenter?.close();
  }
}

// Draws a bubble: soft shadow, the picture cut to the outline, the outline effect.
// pts: the outline normalised to the square picture; pop: 0..1 (pops in); d: the
// picture's diameter in canvas px. A plain function, so the in-page iframe (which gets
// the picture and outline from the recorder) draws exactly what the compositor draws.
export function drawBubble(ctx, { picture, pts, pop, cx, cy, d, outline, t, mirror = false }) {
  pop = Math.max(0, pop);
  if (pop < 0.01) return;
  const k = d * pop;
  const poly = smoothPolygon(pts.map(([x, y]) => [cx + (x - 0.5) * k, cy + (y - 0.5) * k]), 3);
  const u = d / 250;                       // line widths were tuned at the medium size
  const path = (dx = 0, dy = 0) => {
    ctx.beginPath();
    ctx.moveTo(poly[0][0] + dx, poly[0][1] + dy);
    for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i][0] + dx, poly[i][1] + dy);
    ctx.closePath();
  };
  ctx.save();
  // Soft shadow: a few widening, fading strokes under the bubble.
  for (const [width, alpha] of [[22, 0.05], [14, 0.07], [7, 0.09]]) {
    path(0, 6 * u);
    ctx.fillStyle = ctx.strokeStyle = `rgba(0,0,0,${alpha * pop})`;
    ctx.lineWidth = width * u;
    ctx.fill();
    ctx.stroke();
  }
  // The picture, cut to the shape.
  ctx.save();
  path();
  ctx.clip();
  ctx.imageSmoothingQuality = 'medium';
  if (mirror) {                            // a picture that isn't mirrored yet
    ctx.translate(2 * cx, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(picture, cx - k / 2, cy - k / 2, k, k);
  ctx.restore();
  drawOutline(ctx, poly, outline, t, pop, u);
  ctx.restore();
}

function drawOutline(ctx, poly, fx, t, pop, u) {
  const line = (pts) => {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
  };
  if (fx === 'plain') {
    line(poly);
    ctx.strokeStyle = `rgba(255,255,255,${0.14 * pop})`;
    ctx.lineWidth = Math.max(1, 1.2 * u);
    ctx.stroke();
    return;
  }
  let cx = 0, cy = 0;
  for (const [x, y] of poly) { cx += x; cy += y; }
  cx /= poly.length; cy /= poly.length;
  if (fx === 'glow') {
    // A bright rim with a slow ripple running around it.
    const q = poly.map(([x, y]) => {
      const w = 1 + 0.018 * Math.sin(9 * Math.atan2(y - cy, x - cx) + 4 * t);
      return [cx + (x - cx) * w, cy + (y - cy) * w];
    });
    for (const [width, alpha] of [[12, 0.06], [7, 0.12], [3.5, 0.35], [1.6, 0.95]]) {
      line(q);
      ctx.strokeStyle = `rgba(230,247,255,${alpha * pop})`;
      ctx.lineWidth = width * u;
      ctx.stroke();
    }
  } else if (fx === 'rainbow') {
    // Hue runs round the edge and slowly turns (one conic gradient, not 96 strokes).
    const g = ctx.createConicGradient((t * 0.15 % 1) * Math.PI * 2, cx, cy);
    for (let i = 0; i <= 12; i++) g.addColorStop(i / 12, `hsl(${i * 30} 100% 62%)`);
    ctx.strokeStyle = g;
    ctx.lineJoin = ctx.lineCap = 'round';
    for (const [width, alpha] of [[9, 0.25], [3.5, 1]]) {
      line(poly);
      ctx.globalAlpha = alpha * pop;
      ctx.lineWidth = width * u;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
}
