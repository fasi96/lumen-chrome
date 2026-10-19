// Glue between the service worker and a Recorder, shared by the offscreen document
// and the fallback recorder tab. Messages with target 'host' are for us.

export function host(kind, makeRecorder, { onState } = {}) {
  let rec = null;
  const report = (msg) => {
    onState?.(msg.type);
    // A finished (or cancelled) recorder frees the host for the next recording.
    if (['cancelled', 'saved', 'error'].includes(msg.type) && rec?.opts?.id === msg.id) rec = null;
    // The service worker's answer, for the few messages that need one (bubble-live).
    return chrome.runtime.sendMessage({ target: 'sw', from: kind, ...msg }).catch(() => null);
  };

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg.target !== 'host') return;
    if (msg.type === 'start') {
      if (rec && !rec.stopping && !rec.cancelled) { reply({ ok: false, error: 'already recording' }); return; }
      rec = makeRecorder(report);
      rec.start(msg.opts).then(
        () => reply({ ok: true }),
        (e) => { rec.cleanup(); rec = null; reply({ ok: false, error: `${e.name}: ${e.message}` }); });
      return true; // reply later
    }
    if (msg.type === 'stop') {
      rec?.stop('user');
      reply({ ok: !!rec });
    }
    if (msg.type === 'ping') reply({ ok: true, kind, recording: !!rec && !rec.stopping });
  });

  // Tell the SW we're ready (the fallback tab is opened before it can be messaged).
  report({ type: 'host-ready' });
}
