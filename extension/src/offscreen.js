// The hidden offscreen document: Lumen's recorder lives here while recording, so
// it keeps going with the popup closed. It also shares finished recordings on the
// user's own share site (uploads keep going with every tab closed). It only answers
// the service worker.

import { Recorder } from './lib/recorder-core.js';
import { host } from './lib/host.js';
import { createShare, shareRecording } from './lib/uploader.js';
import { startPreview, stopPreview } from './lib/preview.js';

host('offscreen', (report) => new Recorder(report));

const report = (msg) => chrome.runtime.sendMessage({ target: 'sw', from: 'uploader', ...msg }).catch(() => {});

// Clipboard from a hidden page: the documented way is a textarea + execCommand('copy')
// (the offscreen document is created with the CLIPBOARD reason for this).
function copy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.append(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  return ok;
}

const creating = new Map();   // recording id → the "create the link" promise

// target 'preview': the camera in the floating window before recording starts (lib/preview.js).
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.target !== 'preview') return;
  if (msg.on) startPreview(msg.deviceId).catch((e) => console.warn('[lumen] camera preview:', e.message));
  else stopPreview();
  reply({ ok: true });
});

// target 'uploader': only this document handles these (not the fallback recorder tab).
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.target !== 'uploader') return;
  if (msg.type === 'create') {
    // At stop: make the link and copy it before the MP4 is even ready.
    const p = createShare(msg.conn, msg.id, { title: msg.title, codec: msg.codec, report, copy })
      .catch((e) => { report({ type: 'upload-failed', id: msg.id, error: String(e.message || e) }); });
    creating.set(msg.id, p);
    p.finally(() => creating.delete(msg.id));
    reply({ ok: true });
  }
  if (msg.type === 'share') {
    // After the MP4 is saved (or to resume/retry): pictures, parts, complete, card, transcript.
    Promise.resolve(creating.get(msg.id))
      .then(() => shareRecording(msg.conn, msg.id, { report, copy, title: msg.title, ai: msg.ai !== false, clean: msg.clean !== false }))
      .catch(() => { /* recorded in the journal row; the review page shows it */ });
    reply({ ok: true });
  }
  if (msg.type === 'copy') reply({ ok: copy(msg.text) });
});
