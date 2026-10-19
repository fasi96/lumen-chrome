// Builds the unpacked extension into dist/: copies the static files from
// extension/ and bundles each script in extension/src with esbuild (so Mediabunny
// from node_modules ends up inside the package; MV3 forbids loading code from the web).
// Usage: node scripts/build.mjs [--watch]

import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'extension');
const out = path.join(root, 'dist');

fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(src, out, { recursive: true, filter: (p) => !p.startsWith(path.join(src, 'src')) && !p.endsWith('.svg') });

// Dev builds: Chrome keeps running a cached copy of an unpacked extension's service
// worker across restarts (found 2026-10-10: new pages, old background script, even with
// a new version number). So every dev build names the worker sw-<n>.js, which Chrome
// can't match to a cached copy, and gets its own version plus a stamp the running worker
// reports (lumen.build). LUMEN_RELEASE=1 keeps sw.js and the manifest's version (Web Store).
const BUILD = new Date().toISOString().slice(0, 16).replace('T', ' ');
const N = Math.floor((Date.now() - Date.UTC(2026, 0, 1)) / 60000) % 65535;
// (--watch keeps sw.js: it rebuilds in place; reload the extension by hand there.)
const SW = process.env.LUMEN_RELEASE || process.argv.includes('--watch') ? 'sw.js' : `sw-${N}.js`;
if (SW !== 'sw.js') {
  const f = path.join(out, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(f, 'utf8'));
  m.version = `${m.version.split('.').slice(0, 3).join('.')}.${N}`;
  m.version_name = `${m.version} (dev ${BUILD})`;
  m.background.service_worker = SW;
  fs.writeFileSync(f, JSON.stringify(m, null, 2));
}

const common = {
  define: { __LUMEN_BUILD__: JSON.stringify(BUILD) },
  bundle: true,
  target: 'chrome116',
  outdir: out,
  legalComments: 'inline',  // keep Mediabunny's MPL-2.0 header in the output
  logLevel: 'warning',
};
const pages = ['popup', 'offscreen', 'recorder', 'recordings', 'welcome', 'opfs-worker', 'bubble-frame', 'connect', 'setup', 'tuner', 'visible-worker']
  .map((n) => path.join(src, 'src', `${n}.js`));

// Everything is an ES module; shared code (Mediabunny) goes into one chunks/ file
// instead of being copied into every page.
const builds = [
  { ...common, entryPoints: [path.join(src, 'src', 'sw.js'), ...pages], format: 'esm',
    splitting: true, chunkNames: 'chunks/[name]-[hash]' },
  // Injected into web pages with chrome.scripting, so they must be classic scripts.
  { ...common, entryPoints: [path.join(src, 'src', 'bubble-inject.js'), path.join(src, 'src', 'countdown-inject.js')], format: 'iife' },
  // The audio worklet is loaded on its own (audioWorklet.addModule), so it can't share chunks.
  { ...common, entryPoints: [path.join(src, 'src', 'voice-worklet.js')], format: 'iife' },
];

// The share site's worker, for the "Set up my share site" wizard: copied as plain text
// from Lumen's share/ folder (../lumen/share, or $LUMEN_SHARE_DIR). It is uploaded to the
// user's own Cloudflare, never run in the extension (hence .txt, not .js).
const shareDir = process.env.LUMEN_SHARE_DIR || path.join(root, '..', 'lumen', 'share');
if (fs.existsSync(path.join(shareDir, 'src', 'index.js'))) {
  fs.mkdirSync(path.join(out, 'worker'), { recursive: true });
  fs.copyFileSync(path.join(shareDir, 'src', 'index.js'), path.join(out, 'worker', 'index.js.txt'));
  fs.copyFileSync(path.join(shareDir, 'src', 'player.js'), path.join(out, 'worker', 'player.js.txt'));
  fs.copyFileSync(path.join(shareDir, 'schema.sql'), path.join(out, 'worker', 'schema.sql'));
  let commit = '';
  try { commit = (await import('node:child_process')).execFileSync('git', ['-C', shareDir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* not a git checkout */ }
  fs.writeFileSync(path.join(out, 'worker', 'meta.json'), JSON.stringify({ from: 'lumen/share', commit, built: new Date().toISOString() }, null, 2));
} else {
  console.warn(`warning: ${shareDir} not found — the share-site setup wizard won't have a worker to upload`);
}

// MediaPipe's wasm runtime (13 MB) comes from node_modules, so it isn't kept in git.
const vision = path.join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
for (const f of ['vision_wasm_internal.js', 'vision_wasm_internal.wasm']) {
  fs.copyFileSync(path.join(vision, f), path.join(out, 'vision', f));
}

// RNNoise for the mic's noise removal (lib/voice.js), from node_modules too.
const rnnoise = path.join(root, 'node_modules', '@sapphi-red', 'web-noise-suppressor', 'dist');
fs.mkdirSync(path.join(out, 'audio'), { recursive: true });
for (const f of ['rnnoise.wasm', 'rnnoise_simd.wasm']) fs.copyFileSync(path.join(rnnoise, f), path.join(out, 'audio', f));

if (process.argv.includes('--watch')) {
  for (const b of builds) await (await esbuild.context(b)).watch();
  console.log('watching extension/src …');
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
  if (SW !== 'sw.js') fs.renameSync(path.join(out, 'sw.js'), path.join(out, SW));
  console.log(`built ${path.relative(process.cwd(), out) || 'dist'}/ (${SW}, ${BUILD})`);
}
