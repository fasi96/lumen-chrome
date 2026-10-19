// Shared helpers for the automated tests: a tiny static server for the test page,
// and a Chromium launcher with a throwaway profile and fake camera/mic/screen.
// Your real Chrome profile is never touched.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Serves test/fixtures on 127.0.0.1 (a random free port).
export async function serveFixtures() {
  const dir = path.join(ROOT, 'test', 'fixtures');
  const server = http.createServer((req, res) => {
    const file = path.join(dir, path.normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^\/+/, '') || 'page.html');
    if (!file.startsWith(dir) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html' : 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}/page.html` };
}

// Finds a Chromium build that still accepts unpacked extensions over CDP.
export function chromeBinary() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  for (const p of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome']) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('No Chromium/Chrome found. Set CHROME_BIN.');
}

// The scratch profile lives under $LUMEN_TEST_TMP (default: the OS temp dir).
export function tempProfile(tag) {
  const base = process.env.LUMEN_TEST_TMP || (fs.existsSync('/tmp/claude-1000') ? '/tmp/claude-1000' : os.tmpdir());
  return fs.mkdtempSync(path.join(base, `lumen-chrome-${tag}-`));
}

// Launches Chromium with the extension loaded. `headless` defaults to true
// (set LUMEN_HEADFUL=1 to watch). Returns { browser, extensionId, profile, downloads }.
// fakeUi: auto-accept every media prompt. It must be OFF for tab capture: with it,
// Chrome skips the code that turns a tabCapture stream id into a tab and getUserMedia
// fails with NotFoundError (found in M0). Screen picking then relies on the
// --auto-select-* flags instead. Pass `profile` to reopen an existing profile.
export async function launchWithExtension(extDir, { tag = 'test', extraArgs = [], fakeUi = true, profile } = {}) {
  profile ??= tempProfile(tag);
  const downloads = path.join(profile, 'Downloads');
  fs.mkdirSync(downloads, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: chromeBinary(),
    headless: process.env.LUMEN_HEADFUL ? false : true,
    pipe: true,                 // needed for Extensions.loadUnpacked over CDP
    dumpio: !!process.env.LUMEN_DUMPIO,
    // Puppeteer mutes headless Chrome, which also silences tab capture. Instead we
    // keep audio flowing inside Chrome but send nothing to the speakers.
    ignoreDefaultArgs: ['--mute-audio'],
    enableExtensions: true,
    userDataDir: profile,
    defaultViewport: null,      // pages fill the window, as for a real user
    args: [
      '--enable-unsafe-extension-debugging',
      fakeUi && '--use-fake-ui-for-media-stream', // say yes to camera/mic/screen prompts
      '--use-fake-device-for-media-stream',    // a fake camera + a beeping fake mic
      '--auto-select-desktop-capture-source=Entire screen',
      '--auto-select-tab-capture-source-by-title=Lumen test page',
      '--auto-accept-this-tab-capture',
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=1280,800',
      '--disable-audio-output',                 // fake audio sink: tests make no sound
      ...extraArgs,
      ...(process.env.LUMEN_CHROME_ARGS || '').split(' ').filter(Boolean),   // e.g. GPU flags to try
    ].filter((a) => a && !(process.env.LUMEN_DROP_FLAGS || '').split(',').some((d) => d && a.startsWith(d))),
  });
  const extensionId = await browser.installExtension(extDir);
  // A new install opens the welcome tab (once per profile, a moment later); close it like
  // a user would, so it can't come to the front while a test records the page it's on.
  const t0 = Date.now();
  while (Date.now() - t0 < 4000) {
    const t = browser.targets().find((x) => x.url().endsWith('/welcome.html'));
    if (t) { await (await t.asPage()).close().catch(() => {}); break; }
    await sleep(100);
  }
  return { browser, extensionId, profile, downloads };
}

// The extension's service worker as a puppeteer WebWorker (for evaluate()).
export async function serviceWorker(browser, extensionId) {
  const t = await browser.waitForTarget(
    (t) => t.type() === 'service_worker' && t.url().startsWith(`chrome-extension://${extensionId}/`),
    { timeout: 10000 });
  return t.worker();
}

// Clicks the extension's toolbar button for `page` (opens the popup, or fires
// action.onClicked when there is no popup). This counts as a real user invocation,
// so tabCapture and activeTab work.
export async function clickAction(browser, extensionId, page) {
  const ext = (await browser.extensions()).get(extensionId);
  await page.triggerExtensionAction(ext);
}

// Grants mic/camera to the extension's origin, as if the user had clicked "Allow"
// on the welcome page. (The offscreen document can't show that prompt itself.)
export async function grantMedia(browser, extensionId) {
  await browser.defaultBrowserContext().overridePermissions(`chrome-extension://${extensionId}`, ['microphone', 'camera']);
}

// Polls fn() until it returns something truthy.
export async function waitFor(fn, what, ms = 20000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

// Clicks ✦ on `page`, then "Start recording" in the real popup.
export async function startFromPopup(browser, extensionId, page) {
  await page.bringToFront();
  await clickAction(browser, extensionId, page);
  const t = await waitFor(async () => browser.targets().find((x) => x.url().endsWith('/popup.html')), 'popup');
  const popup = await t.asPage();
  await popup.waitForSelector('#record');
  await popup.click('#record');
}

// CPU seconds used so far by a process and all its children (Linux /proc), in total
// and by Chrome process type (browser, renderer, gpu-process, utility…).
export function cpuByType(rootPid) {
  const out = { total: 0 };
  for (const [pid, sec] of cpuTree(rootPid)) {
    let type = 'browser';
    try { type = (fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').match(/--type=([\w-]+)/) || [])[1] || 'browser'; } catch { /* gone */ }
    out[type] = (out[type] || 0) + sec;
    out.total += sec;
  }
  return out;
}

export function cpuSeconds(rootPid) {
  return cpuByType(rootPid).total;
}

function cpuTree(rootPid) {
  const kids = new Map();
  const stat = new Map();
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const s = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
      const f = s.slice(s.lastIndexOf(')') + 2).split(' ');   // fields after "(name)"
      const ppid = Number(f[1]);
      stat.set(Number(d), (Number(f[11]) + Number(f[12])) / 100);   // utime + stime, in clock ticks
      if (!kids.has(ppid)) kids.set(ppid, []);
      kids.get(ppid).push(Number(d));
    } catch { /* process ended */ }
  }
  const out = [];
  const todo = [rootPid];
  while (todo.length) {
    const p = todo.pop();
    out.push([p, stat.get(p) || 0]);
    todo.push(...(kids.get(p) || []));
  }
  return out;
}
