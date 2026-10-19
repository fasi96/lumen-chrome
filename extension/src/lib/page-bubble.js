// Lumen's own pages (the review page above all: the next recording often starts there)
// can't be scripted by the extension like a website, so for a screen recording they add
// the "Show your camera while you record?" card and the pill themselves when the service
// worker asks: the same bubble-inject.js, loaded as a script.
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type !== 'lumen-page-bubble') return;
  window.__lumenBubblePill = msg.pill;
  if (window.__lumenBubble) return reply({ ok: true });
  const s = document.createElement('script');
  s.src = chrome.runtime.getURL('bubble-inject.js');
  s.onload = () => reply({ ok: true });
  s.onerror = () => reply({ ok: false });
  document.head.append(s);
  return true;
});
