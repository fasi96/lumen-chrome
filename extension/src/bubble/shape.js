// The bubble's shape, after desktop Lumen's cam/blob.py (and the outline bits of
// cam/lumen_cam.py), made calmer for Chrome. Plain math, no DOM, so the in-page bubble
// and the screen-mode compositor share it.
//
// A few times a second the person segmenter marks which pixels are a person. The Blob
// keeps one radius per angle; each leans a little from a circle toward the person's
// outline, on soft springs. Coordinates are normalised to the square camera picture:
// (0,0) top-left, 1 = its side.
//
// M2 is single-person: when several people are in view, one blob reaches round them
// all (the desktop's merge/pop of separate blobs is a later step).

const TAU = Math.PI * 2;
export const N = 96;            // rays around the centre
export const GRID = 128;        // the mask is sampled at this resolution
const PAD = 0.05;               // room between the person's edge and the blob's edge
const STEPS = Array.from({ length: 72 }, (_, i) => (0.5 * i) / 71);
const MIN_AREA = 0.03;          // a person is at least this much of the picture
const BACKGROUND = 0.4;         // much smaller parts are someone in the background

const ANGLES = Float64Array.from({ length: N }, (_, i) => (TAU * i) / N);
const COS = ANGLES.map(Math.cos);
const SIN = ANGLES.map(Math.sin);

// Gaussian smoothing around a closed loop (values wrap round).
function circularSmooth(x, sigma) {
  const r = Math.ceil(3 * sigma);
  const k = [];
  let sum = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-0.5 * (i / sigma) ** 2); k.push(v); sum += v; }
  const n = x.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = -r; j <= r; j++) s += x[(i + j + n) % n] * k[j + r];
    out[i] = s / sum;
  }
  return out;
}

// ---- the mask: 256×256 confidences → one 128×128 0/1 person mask ---------------
// Joins everyone big enough (like desktop's Crowd.people, minus the per-person split),
// drops specks and people far in the background, keeps loose bits (a hand the model cut
// off its arm) that sit near someone. Returns null when nobody is there.
export function personMask(conf, size = 256) {
  const g = GRID;
  const f = size / g;
  const bin = new Uint8Array(g * g);
  for (let y = 0; y < g; y++) {
    for (let x = 0; x < g; x++) {
      let s = 0;
      for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) s += conf[(y * f + dy) * size + x * f + dx];
      bin[y * g + x] = s / (f * f) > 0.5 ? 1 : 0;
    }
  }
  // Connected parts (4-neighbour flood fill).
  const label = new Int32Array(g * g);
  const parts = [];
  const stack = [];
  for (let i = 0; i < g * g; i++) {
    if (!bin[i] || label[i]) continue;
    const id = parts.length + 1;
    let area = 0, sx = 0;
    stack.push(i);
    label[i] = id;
    while (stack.length) {
      const p = stack.pop();
      area++; sx += p % g;
      const x = p % g, y = (p / g) | 0;
      if (x > 0 && bin[p - 1] && !label[p - 1]) { label[p - 1] = id; stack.push(p - 1); }
      if (x < g - 1 && bin[p + 1] && !label[p + 1]) { label[p + 1] = id; stack.push(p + 1); }
      if (y > 0 && bin[p - g] && !label[p - g]) { label[p - g] = id; stack.push(p - g); }
      if (y < g - 1 && bin[p + g] && !label[p + g]) { label[p + g] = id; stack.push(p + g); }
    }
    parts.push({ id, area: area / (g * g), cx: sx / area / g });
  }
  if (!parts.length) return null;
  const main = parts.reduce((a, b) => (b.area > a.area ? b : a));
  if (main.area < MIN_AREA) return null;
  const keep = new Set(parts.filter((p) => p.area >= BACKGROUND * main.area
    || (p.area > 0.002 && Math.abs(p.cx - main.cx) < 0.35)).map((p) => p.id));
  const m = new Float32Array(g * g);
  for (let i = 0; i < g * g; i++) if (keep.has(label[i])) m[i] = 1;
  return m;
}

// Where the head is: the centre of the top part of the mask (desktop Blob.head).
export function head(m) {
  const g = GRID;
  const rows = new Float64Array(g);
  for (let y = 0; y < g; y++) { let s = 0; for (let x = 0; x < g; x++) s += m[y * g + x]; rows[y] = s; }
  const max = Math.max(...rows);
  if (max < 1) return null;
  let top = -1, bottom = -1;
  for (let y = 0; y < g; y++) if (rows[y] > max * 0.15) { if (top < 0) top = y; bottom = y; }
  const end = top + Math.max(2, Math.floor((bottom - top) * 0.45));
  let w = 0, sx = 0, sy = 0;
  for (let y = top; y < Math.min(end, g); y++) {
    for (let x = 0; x < g; x++) { const v = m[y * g + x]; w += v; sx += x * v; sy += (y - top) * v; }
  }
  if (w < 1) return null;
  return [sx / w / g, (top + sy / w) / g + 0.06];
}

// The calm blob (M2 feedback: "simple, legible"). It starts as a clean circle and only
// leans toward the person: each ray is mostly the circle (65 %) and a little the
// person's outline (35 %, or 60 % for "follows you more"), kept within 0.85–1.2× the
// circle, smoothed around the edge and over time. A raised hand becomes a soft bulge,
// not a traced edge. With no clear person in view it simply stays a circle.
export const CIRCLE_R = 0.38;          // the circle's radius, as a fraction of the picture
export const CLAMP = [0.85, 1.2];      // how far a ray may move from the circle
export const FOLLOW = { little: 0.35, more: 0.6 };

export class Blob {
  constructor({ follow = 'little' } = {}) {
    this.R = CIRCLE_R;
    this.follow = FOLLOW[follow] ?? FOLLOW.little;
    this.r = new Float64Array(N).fill(this.R);   // a clean circle from the first frame
    this.v = new Float64Array(N);
    this.target = new Float64Array(N).fill(this.R);
    this.c = [0.5, 0.5];
    this.cv = [0, 0];
    this.t = 0;
    this.f = 0;            // how much it follows the person right now: eases 0 → 1 in ~0.6 s
    this.seen = false;     // a good mask arrived lately
    this.lastMask = null;
  }

  setFollow(name) { this.follow = FOLLOW[name] ?? FOLLOW.little; }

  // Where each ray would reach for this mask: the person's outermost pixel + padding,
  // smoothed strongly round the edge, blended with the circle and clamped.
  targets(m) {
    const g = GRID;
    const reach = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      reach[i] = this.R;   // a ray that sees nobody stays on the circle
      for (let s = STEPS.length - 1; s >= 0; s--) {
        const x = this.c[0] + COS[i] * STEPS[s];
        const y = this.c[1] + SIN[i] * STEPS[s];
        if (x < 0 || x >= 1 || y < 0 || y >= 1) continue;
        if (m[((y * g) | 0) * g + ((x * g) | 0)] > 0.5) { reach[i] = STEPS[s] + PAD; break; }
      }
    }
    const sm = circularSmooth(reach, 5);          // ~19°: a hand is a bulge, a finger is nothing
    const out = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const r = this.R + (sm[i] - this.R) * this.follow;
      out[i] = Math.min(this.R * CLAMP[1], Math.max(this.R * CLAMP[0], r));
    }
    return out;
  }

  // One physics step. mask: a personMask() or null (nobody there / too noisy).
  update(mask, dt) {
    dt = Math.min(dt, 1 / 20);
    this.t += dt;
    const fresh = mask && mask !== this.lastMask;
    this.lastMask = mask;
    this.seen = !!mask;
    // Follow the person only while there is one; ease in and out (~0.6 s).
    this.f += ((this.seen ? 1 : 0) - this.f) * Math.min(1, dt / 0.2);
    if (fresh) this.target = this.targets(mask);
    if (!this.seen) this.target.fill(this.R);
    // The centre leans a little toward the head; it never wanders off.
    const h = mask ? head(mask) : null;
    const ct = [0.5, 0.5];
    if (h) for (let j = 0; j < 2; j++) ct[j] = 0.5 + Math.max(-0.12, Math.min(0.12, (h[j] - 0.5) * 0.3)) * this.f;
    let k = 12;
    for (let j = 0; j < 2; j++) {
      this.cv[j] += (k * (ct[j] - this.c[j]) - 2 * Math.sqrt(k) * this.cv[j]) * dt;
      this.c[j] += this.cv[j] * dt;
    }
    // Soft, well-damped springs toward circle + f × (target − circle): no jitter.
    k = 60;
    const damp = 2 * 0.85 * Math.sqrt(k);
    for (let i = 0; i < N; i++) {
      const goal = this.R + (this.target[i] - this.R) * this.f;
      this.v[i] += (k * (goal - this.r[i]) - damp * this.v[i]) * dt;
      this.r[i] = Math.min(this.R * CLAMP[1], Math.max(this.R * CLAMP[0], this.r[i] + this.v[i] * dt));
      // Never past the picture's edge: squeeze softly instead.
      const m = 0.02;
      const bx = COS[i] > 0 ? (1 - m - this.c[0]) / COS[i] : COS[i] < 0 ? (m - this.c[0]) / COS[i] : Infinity;
      const by = SIN[i] > 0 ? (1 - m - this.c[1]) / SIN[i] : SIN[i] < 0 ? (m - this.c[1]) / SIN[i] : Infinity;
      const edge = Math.min(bx, by);
      if (this.r[i] > edge - 0.03) this.r[i] = edge - 0.03 * Math.exp(-(this.r[i] - edge + 0.03) / 0.03);
    }
  }

  // The outline (N points), with a very slow, small breathing on top.
  outline() {
    const t = this.t;
    const pts = new Array(N);
    for (let i = 0; i < N; i++) {
      const a = ANGLES[i];
      const wob = 0.003 * (Math.sin(2 * a + 0.8 * t) + 0.6 * Math.sin(3 * a - 0.6 * t + 1));
      const r = this.r[i] + wob;
      pts[i] = [this.c[0] + COS[i] * r, this.c[1] + SIN[i] * r];
    }
    return pts;
  }
}

// The fixed shapes, blended by `card` (0 = circle, 1 = portrait card).
export function fixedShape(card) {
  return Array.from({ length: N }, (_, i) => {
    const ca = COS[i], sa = SIN[i];
    const sq = (Math.abs(ca / 0.36) ** 7 + Math.abs(sa / 0.46) ** 7) ** (-1 / 7);   // a portrait superellipse
    const r = 0.44 * (1 - card) + sq * card;
    return [0.5 + ca * r, 0.5 + sa * r];
  });
}

// Closed Catmull-Rom through pts, so the edge is round rather than faceted.
export function smoothPolygon(pts, sub = 3) {
  const n = pts.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    for (let k = 0; k < sub; k++) {
      const s = k / sub, s2 = s * s, s3 = s2 * s;
      out.push([0, 1].map((j) => 0.5 * (2 * p1[j] + (-p0[j] + p2[j]) * s
        + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * s2 + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * s3)));
    }
  }
  return out;
}

// A critically damped-ish spring for one number (sizes, shape morphs, pop in/out).
export class Spring {
  constructor(value, k = 120, ratio = 0.8) { this.x = value; this.target = value; this.v = 0; this.k = k; this.ratio = ratio; }
  step(dt) {
    dt = Math.min(dt, 1 / 20);
    this.v += (this.k * (this.target - this.x) - 2 * this.ratio * Math.sqrt(this.k) * this.v) * dt;
    this.x += this.v * dt;
    return this.x;
  }
}
