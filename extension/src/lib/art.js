// Pictures for a share, made from the local recording (the same three vshare makes with
// ffmpeg and share/clean/art.py, so the share page behaves the same):
//
//   thumb   poster + fallback link preview: a frame at 1 s (or mid-way), ≤ 1280 px wide
//   sprite  hover previews over the progress bar: one JPEG grid of 160×90 frames, 10 a
//           row, 10–100 of them (one per ~2 s), plus its layout for transcript.json
//   card    the 1200×630 link preview (WhatsApp, Slack, X): a frame, darkened toward the
//           bottom, a play button, the Lumen mark, the title and "owner · 2:41"
//
// Frames are decoded with Mediabunny (WebCodecs), so this works in the hidden offscreen
// document too: no <video> element, no seeking events.

import { Input, BlobSource, CanvasSink, MP4, WEBM, MATROSKA } from 'mediabunny';

const TW = 160, TH = 90;

export async function makeArt(file, { title = 'Screen recording', meta = '', badge = '' } = {}) {
  const input = new Input({ source: new BlobSource(file), formats: [MP4, WEBM, MATROSKA] });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error('no video track');
  const d = (await input.computeDuration()) || 1;
  const w = track.displayWidth, h = track.displayHeight;

  // Poster: ffmpeg -ss min(1, d/2), scaled to ≤ 1280 wide.
  const tw = Math.min(1280, w), th = Math.round((h * tw) / w / 2) * 2;
  const big = new CanvasSink(track, { width: tw, height: th, fit: 'fill' });
  const posterFrame = await big.getCanvas(Math.min(1, d / 2)) || await big.getCanvas(0);
  const thumb = await toJpeg(posterFrame.canvas, 0.8);

  // Card frame: art.py takes it at min(1.5, d/3).
  const cardFrame = await big.getCanvas(Math.min(1.5, d / 3)) || posterFrame;
  const card = await toJpeg(drawCard(cardFrame.canvas, { title, meta, badge }), 0.88);

  // Storyboard: count frames, one every `interval` s, letterboxed into 160×90 tiles.
  const count = Math.floor(Math.min(100, Math.max(10, d / 2)));
  const interval = d / count;
  const cols = 10, rows = Math.ceil(count / cols);
  const sheet = new OffscreenCanvas(cols * TW, rows * TH);
  const sctx = sheet.getContext('2d');
  sctx.fillStyle = '#000';
  sctx.fillRect(0, 0, sheet.width, sheet.height);
  const small = new CanvasSink(track, { width: TW, height: TH, fit: 'contain' });
  const times = Array.from({ length: count }, (_, i) => Math.min(d - 0.001, i * interval));
  let i = 0;
  for await (const fr of small.canvasesAtTimestamps(times)) {
    if (fr) sctx.drawImage(fr.canvas, (i % cols) * TW, Math.floor(i / cols) * TH);
    i++;
  }
  const sprite = await toJpeg(sheet, 0.7);
  return {
    thumb, card, sprite,
    storyboard: { interval: Math.round(interval * 1000) / 1000, cols, w: TW, h: TH, count },
    duration: d, width: w, height: h,
  };
}

async function toJpeg(canvas, quality) {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type: 'image/jpeg', quality });
  return new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality));
}

// ---- the link-preview card (a port of art.py's card) ---------------------------------
export function drawCard(frame, { title, meta = '', badge = '' }) {
  const W = 1200, H = 630;
  const c = new OffscreenCanvas(W, H);
  const g = c.getContext('2d');
  // Cover-fit the frame.
  const s = Math.max(W / frame.width, H / frame.height);
  const fw = frame.width * s, fh = frame.height * s;
  g.drawImage(frame, (W - fw) / 2, (H - fh) / 2, fw, fh);

  // Blur and darken toward the bottom, so the title reads over busy screens.
  const soft = new OffscreenCanvas(W, H);
  const sg = soft.getContext('2d');
  sg.filter = 'blur(10px)';
  sg.drawImage(c, 0, 0);
  sg.filter = 'none';
  sg.fillStyle = 'rgba(8,9,12,0.82)';
  sg.fillRect(0, 0, W, H);
  sg.globalCompositeOperation = 'destination-in';
  const grad = sg.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(0.35, 'rgba(0,0,0,0)');
  grad.addColorStop(0.75, 'rgba(0,0,0,1)');
  grad.addColorStop(1, 'rgba(0,0,0,1)');
  sg.fillStyle = grad;
  sg.fillRect(0, 0, W, H);
  g.drawImage(soft, 0, 0);
  g.fillStyle = 'rgba(8,9,12,0.22)';
  g.fillRect(0, 0, W, H);

  // Play button with a soft shadow.
  const cx = W / 2, cy = Math.round(H * 0.40), r = 58;
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.45)';
  g.shadowBlur = 28;
  g.shadowOffsetY = 10;
  g.fillStyle = 'rgba(255,255,255,0.94)';
  g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
  g.restore();
  g.fillStyle = 'rgb(20,21,24)';
  g.beginPath(); g.moveTo(cx - 16, cy - 26); g.lineTo(cx - 16, cy + 26); g.lineTo(cx + 28, cy); g.closePath(); g.fill();

  // Product mark, top-left.
  const font = (wgt, px) => `${wgt} ${px}px "Noto Sans", system-ui, -apple-system, "Segoe UI", sans-serif`;
  g.font = font(700, 28);
  const ww = g.measureText('Lumen').width;
  g.fillStyle = 'rgba(8,9,12,0.75)';
  roundRect(g, 40, 38, 70 + ww, 56, 28); g.fill();
  g.fillStyle = 'rgb(139,140,246)';
  roundRect(g, 50, 46, 40, 40, 11); g.fill();
  sparkle(g, 70, 66, 12);
  g.fillStyle = 'rgb(245,246,248)';
  g.textBaseline = 'top';
  g.fillText('Lumen', 100, 50);

  // Title (two lines at most, with an ellipsis), then the facts line.
  const pad = 64;
  g.font = font(700, 54);
  const lines = wrap(g, title, W - 2 * pad, 2);
  let y = H - pad - 34 - lines.length * 66;
  g.fillStyle = 'rgb(245,246,248)';
  for (const ln of lines) { g.fillText(ln, pad, y); y += 66; }
  y += 10;
  let x = pad;
  if (badge) {
    g.font = font(700, 24);
    const bw = g.measureText(badge).width + 60;
    g.fillStyle = 'rgba(139,140,246,0.92)';
    roundRect(g, x, y - 2, bw, 40, 20); g.fill();
    sparkle(g, x + 24, y + 18, 9);
    g.fillStyle = '#fff';
    g.fillText(badge, x + 42, y + 6);
    x += bw + 16;
  }
  if (meta) {
    g.font = font(400, 28);
    g.fillStyle = 'rgb(200,203,208)';
    g.fillText(meta, x, y + 3);
  }
  return c;
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}

// Four-point star, like the ✦ mark.
function sparkle(g, cx, cy, r) {
  const k = r * 0.28;
  g.fillStyle = '#fff';
  g.beginPath();
  for (const [x, y] of [[cx, cy - r], [cx + k, cy - k], [cx + r, cy], [cx + k, cy + k], [cx, cy + r], [cx - k, cy + k], [cx - r, cy], [cx - k, cy - k]]) g.lineTo(x, y);
  g.closePath();
  g.fill();
}

function wrap(g, text, width, maxLines) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const out = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (g.measureText(t).width <= width) { cur = t; continue; }
    if (cur) out.push(cur);
    cur = w;
    if (out.length === maxLines) break;
  }
  if (out.length < maxLines && cur) out.push(cur);
  if (out.length === maxLines && out.join(' ') !== words.join(' ')) {
    let last = out[maxLines - 1];
    while (last && g.measureText(`${last}…`).width > width) last = last.slice(0, -1);
    out[maxLines - 1] = `${last.trimEnd()}…`;
  }
  return out.length ? out : [''];
}
