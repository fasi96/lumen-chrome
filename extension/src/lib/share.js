// Talking to the user's own Lumen share site (a Cloudflare worker in their account).
// There is no Lumen server in between, ever: the extension holds the site's address
// and a device key (made by `vshare connect-code` or the setup wizard), kept in
// chrome.storage.local (this computer only, never synced, readable only by Lumen's own
// pages). The device key may create shares and manage only the videos it made.

export const PART_SIZE = 10 * 1024 * 1024;   // R2 wants equal parts (≥ 5 MiB) except the last

// ---- the connection code ----------------------------------------------------------
// "lumen1:" + base64url({"u": site URL, "t": device key, "n": device name}).
export function parseCode(text) {
  const s = String(text || '').trim().replace(/^lumen1:/, '');
  let j;
  try {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    j = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64 + '='.repeat((4 - b64.length % 4) % 4)), (c) => c.charCodeAt(0))));
  } catch {
    throw new Error('That doesn’t look like a Lumen connection code. Copy the whole line, starting with lumen1:');
  }
  let url;
  try { url = new URL(j.u); } catch { throw new Error('The code has no valid site address.'); }
  // https only, except a local test worker on this computer.
  const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('The share site must use https://');
  if (!/^lt_[A-Za-z0-9]{12}_[A-Za-z0-9]{32}$/.test(j.t || '')) throw new Error('The code has no valid device key.');
  return { url: url.origin, token: j.t, name: String(j.n || 'Lumen for Chrome').slice(0, 60) };
}

// ---- stored connection (pages and the service worker; not the offscreen document) ----
export async function getConnection() {
  return (await chrome.storage.local.get('share')).share || null;
}

export async function saveConnection(conn) {
  await chrome.storage.local.set({ share: conn });
}

export async function clearConnection() {
  await chrome.storage.local.remove('share');
}

// ---- the API ---------------------------------------------------------------------
export class ShareError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

// One call with a timeout. body: object (JSON), Blob/ArrayBuffer (raw), or undefined.
export async function api(conn, method, path, body, { type, timeout = 60000 } = {}) {
  const headers = { Authorization: `Bearer ${conn.token}` };
  let data = body;
  if (body !== undefined && !(body instanceof Blob) && !(body instanceof ArrayBuffer) && typeof body !== 'string') {
    data = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  } else if (body !== undefined) {
    headers['Content-Type'] = type || 'application/octet-stream';
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  let r;
  try {
    r = await fetch(conn.url + path, { method, headers, body: data, signal: ac.signal, credentials: 'omit' });
  } catch (e) {
    throw new ShareError(e.name === 'AbortError' ? 'The share site didn’t answer in time' : `Can’t reach the share site (${e.message})`, 0);
  } finally {
    clearTimeout(timer);
  }
  const text = await r.text();
  let j = null;
  try { j = text ? JSON.parse(text) : {}; } catch { /* not JSON */ }
  if (!r.ok) throw new ShareError((j && j.error) || `${method} ${path}: ${r.status}`, r.status);
  return j ?? {};
}

// The same, retried with backoff on network errors, timeouts and 5xx/429 (not on other 4xx).
export async function apiRetry(conn, method, path, body, opts = {}, tries = 6) {
  for (let i = 0; ; i++) {
    try {
      return await api(conn, method, path, body, opts);
    } catch (e) {
      const transient = !e.status || e.status >= 500 || e.status === 429 || e.status === 408;
      if (!transient || i >= tries - 1) throw e;
      await new Promise((r) => setTimeout(r, Math.min(30000, 1000 * 2 ** i)));
    }
  }
}

// Checks a code against the site and returns the connection to store.
export async function connect(code) {
  const c = parseCode(code);
  let info;
  try {
    info = await api(c, 'GET', '/api/info', undefined, { timeout: 15000 });
  } catch (e) {
    if (e.status === 401) throw new Error('The share site didn’t accept this code (revoked or already removed?). Make a new one.');
    if (e.status === 404) throw new Error('This share site is too old for Lumen for Chrome. Update it first (lumen setup site).');
    throw e;
  }
  if (!info.features?.includes('tokens') || info.you?.kind !== 'device') throw new Error('This share site doesn’t support device keys yet. Update it first (lumen setup site).');
  return { url: c.url, token: c.token, name: info.you.name || c.name, tokenId: info.you.id, owner: info.owner || '', connectedAt: Date.now() };
}

// Disconnecting removes the key on the site too (best effort: offline still forgets it here).
export async function disconnect(conn) {
  try { await api(conn, 'DELETE', '/api/tokens/self', undefined, { timeout: 10000 }); } catch { /* forget it locally anyway */ }
}

export function siteName(conn) {
  try { return new URL(conn.url).host; } catch { return conn?.url || ''; }
}
