// Small display helpers shared by the popup and the recordings page.

export function duration(sec) {
  if (sec == null || !isFinite(sec)) return '–';
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function bytes(n) {
  if (!n) return '0 KB';
  if (n < 1e6) return `${Math.max(1, Math.round(n / 1e3))} KB`;
  if (n < 1e9) return `${(n / 1e6).toFixed(1)} MB`;
  return `${(n / 1e9).toFixed(2)} GB`;
}

export function when(ms) {
  const d = new Date(ms);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function label(row) {
  return row.title || (row.mode === 'screen' ? 'Screen recording' : 'Tab recording');
}

// Rows left "recording"/"processing" by a crash (not the one recording right now).
export function isUnfinished(row, liveId) {
  return (row.state === 'recording' || row.state === 'processing') && row.id !== liveId;
}
