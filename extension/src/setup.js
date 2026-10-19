// The "Set up my share site" wizard (see lib/cfsetup.js for what it does on Cloudflare).
// The API token lives only in this page's memory and is dropped at the end; the owner
// key is shown once and not kept; only the device key is stored (chrome.storage.local).

import { CloudflareSetup, TOKEN_PERMISSIONS, tokenTemplateUrl, R2_DASHBOARD } from './lib/cfsetup.js';
import { saveConnection } from './lib/share.js';

const $ = (id) => document.getElementById(id);
const STEPS = [
  ['subdomain', 'Your workers.dev address'],
  ['bucket', 'Video storage (R2)'],
  ['database', 'Database (D1)'],
  ['schema', 'Database tables'],
  ['worker', 'Publishing your share site'],
  ['workersdev', 'Switching on its address'],
  ['wait', 'Waiting for it to answer (a new address can take a few minutes)'],
  ['device', 'Connecting this browser'],
];

let setup = null;        // CloudflareSetup, holds the API token in memory
let accounts = [];

$('perms').innerHTML = TOKEN_PERMISSIONS.map((p) => `<span class="perm">${p.label}</span>`).join(' ');
$('token-link').href = tokenTemplateUrl();
$('r2-link').href = $('r2-open').href = R2_DASHBOARD;

$('check').onclick = async () => {
  const msg = $('t-msg');
  const token = $('token').value.trim();
  if (!token) { msg.className = 'small err'; msg.textContent = 'Paste the token first.'; return; }
  // Chrome's permission prompt for api.cloudflare.com (needs this click).
  const granted = await chrome.permissions.request({ origins: ['https://api.cloudflare.com/*'] }).catch(() => false);
  if (!granted) { msg.className = 'small err'; msg.textContent = 'Lumen needs that permission to set up your site.'; return; }
  msg.className = 'small'; msg.textContent = 'Checking the token…';
  try {
    setup = new CloudflareSetup(token);
    accounts = await setup.accounts();
    $('account').replaceChildren(...accounts.map((a) => new Option(a.name, a.id)));
    $('acct-wrap').hidden = accounts.length < 2;
    $('token').value = '';
    msg.className = 'small ok'; msg.textContent = 'Token works.';
    $('s-opts').hidden = false;
  } catch (e) {
    setup = null;
    msg.className = 'small err'; msg.textContent = `${e.message}. Check the permissions listed above.`;
  }
};

function paint(id, state, detail) {
  const li = $('steps').querySelector(`[data-id="${id}"]`);
  if (!li) return;
  li.className = state;
  li.querySelector('.detail').textContent = state === 'fail' ? detail || '' : (typeof detail === 'string' ? detail : '');
}

async function go() {
  $('s-run').hidden = false;
  $('r2-fix').hidden = $('retry-row').hidden = true;
  $('create').disabled = true;
  $('steps').replaceChildren(...STEPS.map(([id, text]) => {
    const li = document.createElement('li');
    li.dataset.id = id;
    li.className = 'todo';
    li.innerHTML = '<span class="ic"></span><span class="t"></span> <span class="detail"></span>';
    li.querySelector('.t').textContent = text;
    return li;
  }));
  const account = $('account').value || accounts[0].id;
  const done = (await chrome.storage.local.get('setupProgress')).setupProgress;
  try {
    const [index, player, schema] = await Promise.all(['worker/index.js.txt', 'worker/player.js.txt', 'worker/schema.sql']
      .map(async (f) => { const r = await fetch(chrome.runtime.getURL(f)); if (!r.ok) throw new Error('this build has no share-site code (see README)'); return r.text(); }));
    const res = await setup.run({
      account,
      sources: { 'index.js': index, 'player.js': player },
      schemaSql: schema,
      owner: $('owner').value.trim(),
      deviceName: 'Lumen for Chrome',
      done: done?.account === account ? done : {},
      progress: paint,
      saveDone: (d) => chrome.storage.local.set({ setupProgress: { ...d, account } }),   // names only, no secrets
      askSubdomain: () => new Promise((resolve) => {
        $('ask-sub').hidden = false;
        $('sub-go').onclick = () => { $('ask-sub').hidden = true; resolve($('sub').value.trim().toLowerCase()); };
      }),
    });
    await saveConnection({ url: res.url, token: res.device.token, name: res.device.name, tokenId: res.device.id,
      owner: res.owner || '', connectedAt: Date.now(), setupBy: 'wizard' });
    await chrome.storage.local.remove('setupProgress');
    setup = null;                                            // forget the API token
    await chrome.permissions.remove({ origins: ['https://api.cloudflare.com/*'] }).catch(() => {});
    $('d-url').href = res.url; $('d-url').textContent = res.url;
    $('d-admin').textContent = res.admin;
    $('d-copy').onclick = async (e) => { await navigator.clipboard.writeText(res.admin); e.target.textContent = 'Copied'; };
    // The dashboard signs in with a form post of the key (never in a URL).
    $('d-dash').onclick = (e) => {
      e.preventDefault();
      const f = document.createElement('form');
      f.method = 'POST'; f.action = `${res.url}/dashboard/login`; f.target = '_blank';
      const i = document.createElement('input'); i.type = 'hidden'; i.name = 'key'; i.value = res.admin;
      f.append(i); document.body.append(f); f.submit(); f.remove();
    };
    $('s-done').hidden = false;
    $('s-done').scrollIntoView({ behavior: 'smooth' });
  } catch (e) {
    if (e.step === 'r2' || e.step === 'bucket' && /R2/.test(e.message)) $('r2-fix').hidden = false;
    else $('retry-row').hidden = false;
  } finally {
    $('create').disabled = false;
  }
}

$('create').onclick = go;
$('retry').onclick = go;
$('retry2').onclick = go;
