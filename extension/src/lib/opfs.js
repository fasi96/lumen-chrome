// Helpers for the extension's private disk space (OPFS: origin private file system).
// Recordings are stored here, not in RAM, and never leave the computer in M1.

// Talks to opfs-worker.js, which owns the fast synchronous file handles.
export class ChunkWriter {
  constructor() {
    this.worker = new Worker('opfs-worker.js', { type: 'module' });
    this.seq = 0;
    this.waiting = new Map();
    this.worker.onmessage = ({ data }) => {
      const p = this.waiting.get(data.seq);
      this.waiting.delete(data.seq);
      if (data.ok) p?.resolve(data.size); else p?.reject(new Error(data.error));
    };
  }
  #send(op, name, buf) {
    const seq = ++this.seq;
    return new Promise((resolve, reject) => {
      this.waiting.set(seq, { resolve, reject });
      this.worker.postMessage({ seq, op, name, buf }, buf ? [buf] : []);
    });
  }
  open(name) { return this.#send('open', name); }
  // Resolves with the file size after the chunk is on disk.
  append(name, buf) { return this.#send('append', name, buf); }
  close(name) { return this.#send('close', name); }
  terminate() { this.worker.terminate(); }
}

const root = () => navigator.storage.getDirectory();

// A File (a Blob backed by disk) for a stored recording, or null.
export async function readFile(name) {
  try {
    return await (await (await root()).getFileHandle(name)).getFile();
  } catch {
    return null;
  }
}

// Writes a Blob/ArrayBuffer to a new file in one go.
export async function writeFile(name, data) {
  const h = await (await root()).getFileHandle(name, { create: true });
  const w = await h.createWritable();
  await w.write(data);
  await w.close();
}

export async function deleteFile(name) {
  try { await (await root()).removeEntry(name); } catch { /* already gone */ }
}

// Total bytes used and the quota, for the recordings page footer.
export async function usage() {
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  return { usage, quota };
}
