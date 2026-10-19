// The "Share links" page: connect this browser to the user's own share site with a
// code from `lumen share connect-code`, or disconnect it.

import { connect, disconnect, getConnection, saveConnection, clearConnection, siteName, api } from './lib/share.js';
import { bytes } from './lib/format.js';

const $ = (id) => document.getElementById(id);

async function show() {
  const conn = await getConnection();
  $('connected').hidden = !conn;
  $('paste').hidden = !!conn;
  $('new').hidden = !!conn;
  if (!conn) return;
  $('c-site').textContent = siteName(conn);
  $('c-name').textContent = conn.name;
  $('c-open').href = conn.url + '/dashboard';
  const { settings = {} } = await chrome.storage.local.get('settings');
  const set = async (change) => {
    const cur = (await chrome.storage.local.get('settings')).settings || {};
    await chrome.storage.local.set({ settings: { ...cur, ...change } });
  };
  const showClean = () => { $('c-clean').disabled = !$('c-ai').checked; };
  $('c-ai').checked = settings.transcribe !== false;
  $('c-clean').checked = settings.cleanup !== false;
  showClean();
  $('c-ai').onchange = () => { showClean(); set({ transcribe: $('c-ai').checked }); };
  $('c-clean').onchange = () => set({ cleanup: $('c-clean').checked });
  try {
    const info = await api(conn, 'GET', '/api/info', undefined, { timeout: 10000 });
    $('c-used').textContent = `${bytes(info.used)} of the free ${bytes(info.free)} used on your Cloudflare.`;
  } catch (e) {
    $('c-used').textContent = e.status === 401 ? 'Your share site no longer accepts this browser’s key (revoked?). Disconnect and connect again.'
      : `Couldn’t reach your share site right now (${e.message}).`;
  }
}

$('go').onclick = async () => {
  const msg = $('msg');
  msg.className = 'small';
  msg.textContent = 'Checking…';
  $('go').disabled = true;
  try {
    const conn = await connect($('code').value);
    await saveConnection(conn);
    $('code').value = '';
    msg.className = 'small ok';
    msg.textContent = 'Connected.';
    await show();
  } catch (e) {
    msg.className = 'small err';
    msg.textContent = e.message;
  } finally {
    $('go').disabled = false;
  }
};

$('disconnect').onclick = async () => {
  if (!confirm('Disconnect this browser from your share site? Videos you already shared stay.')) return;
  const conn = await getConnection();
  if (conn) await disconnect(conn);
  await clearConnection();
  await show();
};

show();
