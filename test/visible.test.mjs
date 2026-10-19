// lib/visible.js in a real Chromium page (it needs OffscreenCanvas): the floating camera
// window's picture is found in a recorded screen at whatever size it was scaled to; it
// isn't found where it isn't (another screen, or the same picture of a different moment
// of nothing); a window half behind another still is weaker; and how long it takes.
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { ROOT, chromeBinary } from './lib.mjs';

const src = fs.readFileSync(path.join(ROOT, 'extension/src/lib/visible.js'), 'utf8').replace(/^export /gm, '');
const b = await puppeteer.launch({ executablePath: chromeBinary(), headless: true });
let failed = 0;
const ok = (c, m) => { console.log(`${c ? '  ✓' : '  ✗'} ${m}`); if (!c) failed++; };
try {
  const p = await b.newPage();
  const r = await p.evaluate(async (src) => {
    eval(src + '; globalThis.findIn = findIn;');
    let seed = 5;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    // A "camera picture": soft blobs of colour (a face, a room), lots of detail.
    const camera = (w, h) => {
      const c = new OffscreenCanvas(w, h), x = c.getContext('2d');
      x.fillStyle = '#4a3b33'; x.fillRect(0, 0, w, h);
      for (let i = 0; i < 60; i++) {
        const g = x.createRadialGradient(rnd() * w, rnd() * h, 2, rnd() * w, rnd() * h, 20 + rnd() * w / 3);
        g.addColorStop(0, `hsl(${(rnd() * 50) | 0},${(30 + rnd() * 40) | 0}%,${(30 + rnd() * 50) | 0}%)`); g.addColorStop(1, 'transparent');
        x.fillStyle = g; x.fillRect(0, 0, w, h);
      }
      return c;
    };
    // A desktop: terminal-like text on dark, a browser-like window.
    const desktop = () => {
      const c = new OffscreenCanvas(1920, 1080), x = c.getContext('2d');
      x.fillStyle = '#1e1e2e'; x.fillRect(0, 0, 1920, 1080);
      x.fillStyle = '#cdd6f4'; for (let y = 20; y < 1080; y += 18) x.fillRect(40 + rnd() * 30, y, 300 + rnd() * 900, 8);
      x.fillStyle = '#eee'; x.fillRect(1100, 100, 700, 500);
      return c;
    };
    const win = camera(600, 338);                       // the floating window (Omarchy: 600×338)
    const shot = await createImageBitmap(win);
    const screen = desktop();
    screen.getContext('2d').drawImage(win, 1250, 60, 600 * 0.75, 338 * 0.75);   // a 2560 px screen recorded at 1920
    const other = desktop();
    const behind = desktop(), bx = behind.getContext('2d');
    bx.drawImage(win, 1250, 60, 600 * 0.75, 338 * 0.75); bx.fillStyle = '#ddd'; bx.fillRect(1250, 60, 300, 260);
    const t0 = performance.now();
    const found = findIn(screen, 1920, 1080, shot);
    const t1 = performance.now();
    const notThere = findIn(other, 1920, 1080, shot);
    const t2 = performance.now();
    const half = findIn(behind, 1920, 1080, shot);
    // The window recorded at its own size (a 1920 px screen recorded as it is).
    const full = desktop(); full.getContext('2d').drawImage(win, 900, 500);
    const atOne = findIn(full, 1920, 1080, shot);
    return { found, notThere, half, atOne, msFound: Math.round(t1 - t0), msNot: Math.round(t2 - t1) };
  }, src);
  console.log('   ', JSON.stringify(r));
  ok(r.found.visible && r.found.score > 0.85, `floating window on the recorded screen (scaled to 0.75): found (${r.found.score} at ${r.found.scale}, ${r.msFound} ms)`);
  ok(r.atOne.visible && r.atOne.scale === 1, `…and at its own size (${r.atOne.score})`);
  ok(!r.notThere.visible, `not on the recorded screen: not found (best ${r.notThere.score}, ${r.msNot} ms, every size tried)`);
  ok(!r.half.visible || r.half.score < r.found.score, `half behind another window: weaker (${r.half.score})`);
  ok(r.msNot < 300, 'a full check (every size) takes under 300 ms (it runs in a worker)');
} finally {
  await b.close();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
