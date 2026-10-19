// Content script: Lumen's 3·2·1, big and centred on the page you clicked ✦ on.
// Injected only into that tab, only when a recording with a countdown starts. The
// recorder doesn't start until this is gone, so it is never in the video. It ignores
// the mouse (pointer-events: none), and its host element lives in a shadow root so the
// page's styles can't touch it.

(() => {
  if (window.__lumenCountdown) return;
  const host = document.createElement('lumen-countdown');
  host.id = 'lumen-countdown';
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    .wrap { position: fixed; inset: 0; display: grid; place-items: center; pointer-events: none;
            font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
    .disc { width: 180px; height: 180px; border-radius: 50%; display: grid; place-items: center;
            background: rgba(18, 18, 26, 0.72); box-shadow: 0 0 0 6px #8b8cf6, 0 12px 40px rgba(0,0,0,.45); }
    .n { color: #fff; font-size: 104px; font-weight: 700; line-height: 1; }
    .n.small { font-size: 22px; font-weight: 600; }
    .hint { position: fixed; left: 50%; top: calc(50% + 116px); transform: translateX(-50%); white-space: nowrap;
            color: #fff; font-size: 14px; background: rgba(18,18,26,.72); padding: 6px 12px; border-radius: 99px; }
    .pop { animation: pop .35s ease-out; }
    @keyframes pop { from { transform: scale(1.25); opacity: .4; } to { transform: scale(1); opacity: 1; } }
  </style>
  <div class="wrap"><div class="disc"><div class="n small" id="n">Starting…</div></div>
  <div class="hint">Recording starts after the count · click ✦ to cancel</div></div>`;
  document.documentElement.append(host);
  const n = root.getElementById('n');

  const remove = () => { host.remove(); window.__lumenCountdown = null; };
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== 'lumen-countdown') return;
    if (!msg.n) return remove();
    n.textContent = String(msg.n);
    n.className = 'n';
    void n.offsetWidth;          // restart the pop animation
    n.className = 'n pop';
  });
  window.__lumenCountdown = { remove };
})();
