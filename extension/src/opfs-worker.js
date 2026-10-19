// A dedicated worker that appends recording chunks to files in the extension's
// private disk space (OPFS). It uses "sync access handles", which write straight
// into the file (no temporary copy), and flushes after every chunk, so whatever was
// recorded up to the last second survives a crash.
//
// Messages in:  { seq, op: 'open'|'append'|'close'|'delete', name, buf? }
// Messages out: { seq, ok, size?, error? }

const handles = new Map(); // name → FileSystemSyncAccessHandle

async function open(name) {
  const root = await navigator.storage.getDirectory();
  const file = await root.getFileHandle(name, { create: true });
  const h = await file.createSyncAccessHandle();
  h.truncate(0);
  handles.set(name, h);
  return 0;
}

function append(name, buf) {
  const h = handles.get(name);
  if (!h) throw new Error(`not open: ${name}`);
  const at = h.getSize();
  h.write(new Uint8Array(buf), { at });
  h.flush();
  return at + buf.byteLength;
}

function close(name) {
  const h = handles.get(name);
  if (!h) return 0;
  h.flush();
  const size = h.getSize();
  h.close();
  handles.delete(name);
  return size;
}

self.onmessage = async ({ data }) => {
  const { seq, op, name, buf } = data;
  try {
    let size;
    if (op === 'open') size = await open(name);
    else if (op === 'append') size = append(name, buf);
    else if (op === 'close') size = close(name);
    else throw new Error(`unknown op ${op}`);
    self.postMessage({ seq, ok: true, size });
  } catch (e) {
    self.postMessage({ seq, ok: false, error: String(e) });
  }
};
