// Chrome Web Store screenshots (1280×800) and the small promo tile (440×280), from the
// real interface: the extension's pages in a headless Chromium, the demo share page,
// each framed with a one-line caption. Usage: node scripts/store-shots.mjs
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, launchWithExtension, grantMedia, serviceWorker, sleep } from '../test/lib.mjs';

const OUT = path.join(ROOT, 'docs', 'store');
const SHARE = 'https://fasi-share.fasiulrehman.workers.dev/v/D8BGAHU5a7pZ';   // the public demo link
const { browser, extensionId } = await launchWithExtension(path.join(ROOT, 'dist'), { tag: 'shots' });
const shot = async (url, w, h, { before, scale = 2 } = {}) => {
  const p = await browser.newPage();
  await p.setViewport({ width: w, height: h, deviceScaleFactor: scale });
  await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await p.goto(url, { waitUntil: 'networkidle2' });
  if (before) await before(p);
  await sleep(1200);
  const b64 = await p.screenshot({ encoding: 'base64' });
  await p.close();
  return `data:image/png;base64,${b64}`;
};
try {
  await grantMedia(browser, extensionId);
  const sw = await serviceWorker(browser, extensionId);
  // The popup as someone with a share site sees it (a made-up connection: nothing is sent).
  await sw.evaluate(() => chrome.storage.local.set({
    settings: { mode: 'tab', mic: true, bubble: true, countdown: 3, share: true, bubbleShape: 'blob', bubbleOutline: 'glow', bubbleSize: 1,
      voices: { '': { preset: 'Podcast', params: { gain: 0, rumble: 90, denoise: 75, warmth: 3, mud: -3, presence: 3, air: 2, deess: 35, evenness: 60, loudness: -16 } } } },
    share: { url: 'https://share.example-you.workers.dev', token: 'lt_x', name: 'This laptop', owner: 'You', tokenId: 'x' },
  }));
  const ext = (p) => `chrome-extension://${extensionId}/${p}`;
  const pics = {
    share: await shot(SHARE, 1440, 860, { scale: 1, before: async (p) => { await p.evaluate(() => { const v = document.getElementById('vid'); v.currentTime = 6.5; }); } }),
    popup: await shot(ext('popup.html'), 320, 560),
    sound: await shot(ext('tuner.html'), 760, 900, { scale: 1.5 }),
    connect: await shot(ext('connect.html'), 700, 820, { scale: 1.5, before: async (p) => { await sw.evaluate(() => chrome.storage.local.remove('share')); await p.reload({ waitUntil: 'networkidle2' }); } }),
  };
  const frame = async (file, title, sub, img, { w = 1280, h = 800, imgW = '74%', imgTop = 190 } = {}) => {
    const p = await browser.newPage();
    await p.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
    await p.setContent(`<!doctype html><html><head><style>
      html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;
        background:radial-gradient(1200px 600px at 20% 0%,#2a2a52 0%,#15151f 55%,#0e0e14 100%);color:#ececf3}
      .t{position:absolute;left:0;right:0;top:46px;text-align:center}
      h1{margin:0;font-size:44px;font-weight:700;letter-spacing:-.02em} h1 b{color:#8b8cf6}
      p{margin:12px 0 0;font-size:21px;color:#a9a9c2}
      img{position:absolute;left:50%;top:${imgTop}px;transform:translateX(-50%);width:${imgW};border-radius:14px;
        box-shadow:0 30px 80px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.08)}
      </style></head><body><div class="t"><h1>${title}</h1><p>${sub}</p></div><img src="${img}"></body></html>`, { waitUntil: 'load' });
    await sleep(300);
    await p.screenshot({ path: path.join(OUT, file) });
    await p.close();
  };
  await frame('screenshots/1-share.png', 'A share link <b>the moment you stop</b>', 'Video, your face in a bubble, a clickable transcript, chapters, and the ums cut out', pics.share, { imgW: '82%', imgTop: 170 });
  await frame('screenshots/2-record.png', 'Record a tab or your screen, <b>you in a bubble</b>', 'One click for this tab. Mic, camera, sound and countdown in the popup', pics.popup, { imgW: '25%', imgTop: 170 });
  await frame('screenshots/3-sound.png', 'Sound like a <b>podcast</b>, in any room', 'Presets and AI noise removal that run on your computer; or tune it by ear', pics.sound, { imgW: '58%', imgTop: 170 });
  await frame('screenshots/4-yours.png', 'Your links, <b>your Cloudflare</b>', 'No Lumen account, no Lumen server. Free up to 10 GB of videos. The MP4 always stays yours', pics.connect, { imgW: '52%', imgTop: 170 });
  // Small promo tile.
  const tile = await browser.newPage();
  await tile.setViewport({ width: 440, height: 280, deviceScaleFactor: 1 });
  const icon = fs.readFileSync(path.join(ROOT, 'extension', 'icons', 'icon128.png')).toString('base64');
  await tile.setContent(`<!doctype html><html><body style="margin:0;width:440px;height:280px;display:flex;align-items:center;gap:22px;padding:0 34px;box-sizing:border-box;
    font-family:system-ui,sans-serif;color:#ececf3;background:radial-gradient(500px 300px at 15% 10%,#33336a,#15151f 70%)">
    <img src="data:image/png;base64,${icon}" style="width:96px;height:96px">
    <div><div style="font-size:34px;font-weight:700;letter-spacing:-.02em">Lumen Recorder</div>
    <div style="font-size:17px;color:#b4b4cc;margin-top:8px;line-height:1.35">Loom-style links<br>on your own Cloudflare</div></div></body></html>`);
  await tile.screenshot({ path: path.join(OUT, 'promo-440x280.png') });
  console.log('done');
} finally {
  await browser.close();
}
