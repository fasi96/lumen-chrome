// The recordings page (also the "review" tab that opens after you stop).
import './lib/page-bubble.js';
// Lists what's stored on this computer, plays one, downloads or deletes it, and
// recovers recordings that a crash left unfinished.

import * as journal from './lib/journal.js';
import { readFile, deleteFile, usage } from './lib/opfs.js';
import { finish } from './lib/recorder-core.js';
import { duration, bytes, when, label, isUnfinished } from './lib/format.js';
import { getConnection, siteName } from './lib/share.js';

const $ = (id) => document.getElementById(id);
let currentId = new URLSearchParams(location.search).get('id');
let liveId = null;
const urls = new Map(); // file name → object URL (revoked when the page closes)

async function objectUrl(name) {
  if (!urls.has(name)) {
    const f = await readFile(name);
    if (!f) return null;
    urls.set(name, URL.createObjectURL(f));
  }
  return urls.get(name);
}
addEventListener('unload', () => urls.forEach((u) => URL.revokeObjectURL(u)));

// "Lumen 2026-10-07 23-15-42.mp4"
function downloadName(row, ext) {
  const d = new Date(row.createdAt);
  const p = (n) => String(n).padStart(2, '0');
  return `Lumen ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}.${ext}`;
}

function button(text, cls, onclick) {
  const b = document.createElement('button');
  b.className = `btn ${cls}`;
  b.textContent = text;
  b.onclick = onclick;
  return b;
}

// A real <a download> link: Chrome saves the file without the "downloads" permission.
async function downloadLink(row, name, text, cls = '') {
  const a = document.createElement('a');
  a.className = `btn ${cls}`;
  a.textContent = text;
  a.download = downloadName(row, name.endsWith('.mic.webm') ? 'mic.webm' : name.split('.').pop());
  a.href = (await objectUrl(name)) || '#';
  a.dataset.file = name;
  return a;
}

async function remove(row) {
  if (!confirm(`Delete “${label(row)}” from this computer?`)) return;
  for (const f of Object.values(row.files || {})) if (f) await deleteFile(f);
  await journal.remove(row.id);
  if (currentId === row.id) currentId = null;
  render();
}

async function recover(row, btn) {
  btn.disabled = true;
  btn.textContent = 'Recovering…';
  await journal.update(row.id, { state: 'processing', recovered: true });
  await finish(row.id, (p) => { btn.textContent = `Recovering… ${Math.round(p * 100)}%`; });
  currentId = row.id;
  render();
}

function meta(row) {
  const parts = [when(row.createdAt), duration(row.duration ?? row.seconds)];
  const size = row.mp4Bytes || row.bytes;
  if (size) parts.push(bytes(size));
  if (row.video) parts.push(`${row.video.codec}/${row.audio?.codec || 'no sound'}, ${row.video.width}×${row.video.height}`);
  return parts.join(' · ');
}

async function actionsFor(row) {
  const out = [];
  if (isUnfinished(row, liveId)) {
    const b = button('Recover', 'primary', () => recover(row, b));
    out.push(b);
  } else if (row.state === 'done') {
    const main = row.files.mp4 || row.files.webm;
    out.push(await downloadLink(row, main, row.files.mp4 ? 'Download MP4' : 'Download WebM', 'primary'));
    if (row.files.mic) out.push(await downloadLink(row, row.files.mic, 'Mic only'));
  }
  if (row.id !== liveId) out.push(button('Delete', 'danger', () => remove(row)));
  return out;
}

async function renderReview(rows) {
  const row = rows.find((r) => r.id === currentId && r.state === 'done');
  $('review').hidden = !row;
  if (!row) return;
  const src = await objectUrl(row.files.mp4 || row.files.webm);
  if ($('player').dataset.id !== row.id) {
    $('player').src = src;
    $('player').dataset.id = row.id;
  }
  $('review-title').textContent = label(row);
  $('review-meta').textContent = meta(row) + (row.error ? ` · ${row.error}` : '');
  $('review-actions').replaceChildren(...(await actionsFor(row)));
  await renderShare(row);
}

// The share link under the player: the link + Copy, and how the upload is going.
async function renderShare(row) {
  const el = $('review-share');
  const conn = await getConnection();
  const sh = row.share;
  el.hidden = false;
  if (!sh) {
    if (!conn) {
      el.innerHTML = '<span class="small dim">Want a link to send? <a href="connect.html">Connect your own share site</a> (free on your Cloudflare).</span>';
    } else if (row.files?.mp4) {
      el.replaceChildren(button('Get a share link', 'primary', async (e) => {
        e.target.disabled = true;
        e.target.textContent = 'Making the link…';
        await chrome.runtime.sendMessage({ target: 'sw', type: 'share-now', id: row.id });
        setTimeout(render, 800);
      }));
    } else {
      el.hidden = true;
    }
    return;
  }
  const kids = [];
  if (sh.url) {
    const input = document.createElement('input');
    input.readOnly = true;
    input.value = sh.url;
    input.id = 'share-url';
    input.onfocus = () => input.select();
    kids.push(input, button('Copy link', '', async (e) => {
      await navigator.clipboard.writeText(sh.url).catch(() => { input.select(); document.execCommand('copy'); });
      e.target.textContent = 'Copied';
    }));
    const open = document.createElement('a');
    open.className = 'btn';
    open.href = sh.url;
    open.target = '_blank';
    open.textContent = 'Open';
    kids.push(open);
  }
  const st = document.createElement('span');
  st.className = 'status';
  st.id = 'share-status';
  const c = sh.clean?.cleanup;
  const cut = c ? [c.fillers && `${c.fillers} um${c.fillers === 1 ? '' : 's'}`, c.pauses && `${c.pauses} pause${c.pauses === 1 ? '' : 's'}`].filter(Boolean).join(' and ') : '';
  if (sh.state === 'done') { st.textContent = `Shared ✓${cut ? ` · ${cut} cut (${c.seconds} s shorter; this copy is uncut)` : ''}`; st.classList.add('ok'); }
  else if (sh.state === 'failed') {
    st.textContent = `Upload stopped: ${sh.error || 'unknown error'}`;
    st.classList.add('err');
    if (conn) kids.push(button('Retry', 'primary', async () => { await chrome.runtime.sendMessage({ target: 'sw', type: 'share-now', id: row.id }); setTimeout(render, 800); }));
  } else if (sh.state === 'creating') st.textContent = 'Making the link…';
  else if (sh.cleaning) {
    st.textContent = `${sh.copied ? 'Link copied. ' : ''}${sh.cleaning.step === 'listening' ? 'Listening for ums and pauses…'
      : `Cutting ums and pauses ${sh.cleaning.pct}%…`} · then it uploads`;
  } else st.textContent = `${sh.copied ? 'Link copied. ' : ''}Uploading ${sh.pct || 0}% · the link works as soon as it’s done`;
  kids.push(st);
  el.replaceChildren(...kids);
}

async function render() {
  const status = await chrome.runtime.sendMessage({ target: 'sw', type: 'status' }).catch(() => null);
  liveId = status?.live?.id ?? null;
  const rows = await journal.list();
  await renderReview(rows);
  $('empty').hidden = rows.length > 0;
  const items = [];
  for (const row of rows) {
    const li = document.createElement('li');
    li.className = 'card' + (row.id === currentId ? ' current' : '');
    li.dataset.id = row.id;
    li.dataset.state = row.state;
    const info = document.createElement('div');
    info.className = 'info';
    info.innerHTML = '<div class="title"></div><div class="small dim"></div>';
    info.firstChild.textContent = label(row);
    info.lastChild.textContent = meta(row);
    const badge = (text, cls) => { const s = document.createElement('span'); s.className = `badge ${cls}`; s.textContent = text; info.firstChild.append(s); };
    if (row.id === liveId) badge('recording now', 'warn');
    else if (isUnfinished(row, liveId)) badge('unfinished', 'warn');
    else if (row.state === 'failed' || row.error) badge(row.state === 'failed' ? 'failed' : 'WebM only', 'err');
    if (row.recovered) badge('recovered', '');
    if (row.share?.state === 'done') badge('shared', 'ok');
    else if (row.share?.state === 'failed') badge('upload stopped', 'err');
    else if (row.share) badge(`uploading ${row.share.pct || 0}%`, '');
    info.onclick = () => { if (row.state === 'done') { currentId = row.id; history.replaceState(null, '', `?id=${row.id}`); render(); } };
    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.append(...(await actionsFor(row)));
    li.append(info, actions);
    items.push(li);
  }
  $('list').replaceChildren(...items);
  const u = await usage();
  $('usage').textContent = `${bytes(u.usage)} used`;
  const conn = await getConnection();
  $('site').innerHTML = conn ? 'Share links go to <b></b> (<a href="connect.html">change</a>).' : '<a href="connect.html">Connect your share site</a> to get links.';
  if (conn) $('site').querySelector('b').textContent = siteName(conn);
  // While something is being recorded, saved or uploaded, refresh every 2 s.
  clearTimeout(render.timer);
  if (rows.some((r) => r.id === liveId || (r.state === 'processing' && !isUnfinished(r, liveId))
    || (r.share && (r.share.state === 'uploading' || r.share.state === 'creating')))) render.timer = setTimeout(render, 2000);
}

render();
