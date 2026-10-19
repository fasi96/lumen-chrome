// The recordings journal: one IndexedDB row per recording, written while it records.
// It lives in the extension's own origin, so the offscreen recorder, the fallback
// recorder tab and the recordings page all see the same rows. If Chrome dies
// mid-recording, the row is still "recording" next time, and the page offers Recover.
//
// Row: { id, createdAt, mode: 'tab'|'screen', title, mime, state, bytes, chunks,
//        files: { webm, mic, mp4 }, duration, size, error }
// state: 'recording' → 'processing' → 'done' | 'failed'

const DB = 'lumen';
const STORE = 'recordings';

let dbp;
function db() {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const result = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(result?.result ?? result);
    t.onerror = () => reject(t.error);
  });
}

export const put = (row) => tx('readwrite', (s) => s.put(row));
export const get = (id) => tx('readonly', (s) => s.get(id));
export const remove = (id) => tx('readwrite', (s) => s.delete(id));

// Merge fields into a row (read-modify-write in one transaction).
export async function update(id, fields) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, 'readwrite');
    const s = t.objectStore(STORE);
    let row;
    s.get(id).onsuccess = (e) => {
      row = { ...(e.target.result || { id }), ...fields };
      s.put(row);
    };
    t.oncomplete = () => resolve(row);
    t.onerror = () => reject(t.error);
  });
}

// All rows, newest first.
export async function list() {
  const rows = await tx('readonly', (s) => s.getAll());
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}

// A short, sortable, unique id like "20261007-231512-k3f9".
export function newId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${Math.random().toString(36).slice(2, 6)}`;
}
