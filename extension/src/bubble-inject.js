// Content script, injected (only) into the tab being recorded when the face bubble is
// on (for a screen recording: the "Show my camera" pill, on the tab you started from). It adds Lumen's bubble
// iframe to the page and moves/resizes it when the iframe asks. In a screen recording
// the bubble can float: a Picture-in-Picture window, always on top of every app, that
// shows the camera (Chrome opens one only from a click in the page, hence the button).
// Nothing else on the page is read or changed (the title, for a second, on Linux: below).

(() => {
  if (window.__lumenBubble) return;               // already there (injected twice)
  // pill: a screen recording draws the bubble into the video; this page only gets the
  // "Show my camera" button.
  // 'ask': first the "Show your camera while you record?" card, in the middle; then the pill.
  const pill = !!window.__lumenBubblePill;
  let asking = window.__lumenBubblePill === 'ask';
  const iframe = document.createElement('iframe');
  const origin = new URL(chrome.runtime.getURL('')).origin;
  iframe.src = chrome.runtime.getURL('bubble.html') + (asking ? '?ask' : pill ? '?pill' : '');
  iframe.title = pill ? 'Lumen camera button' : 'Lumen camera bubble';
  const INSET = 24;
  let w = asking ? 380 : pill ? 210 : 325, h = asking ? 150 : pill ? 44 : 359;   // medium, until the bubble says otherwise
  let x = asking ? (innerWidth - w) / 2 : INSET, y = asking ? innerHeight * 0.3 : innerHeight - h - INSET;
  const toPill = () => {           // after the answer: the pill, bottom-left
    asking = false;
    w = 210; h = 44; x = INSET; y = innerHeight - h - INSET;
    iframe.src = chrome.runtime.getURL('bubble.html') + '?pill';
    place();
  };
  const place = () => {
    x = Math.min(Math.max(x, 0), Math.max(0, innerWidth - w));
    y = Math.min(Math.max(y, 0), Math.max(0, innerHeight - h));
    Object.assign(iframe.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
  };
  iframe.style.cssText = 'position:fixed;border:0;margin:0;padding:0;z-index:2147483647;background:transparent;'
    + 'color-scheme:normal;box-shadow:none;outline:none;display:block;';
  place();
  document.documentElement.append(iframe);

  // ---- floating (whole-screen recordings) ----
  let pip = null;
  const float = async () => {
    if (pip || !window.documentPictureInPicture) return;
    // (an extension page has no "Picture-in-Picture" trick to do: same code)
    // Hyprland (Omarchy) floats and pins only windows titled exactly "Picture-in-Picture",
    // and Chrome names this window after the page, so the page wears that title while the
    // window opens. Other desktops keep these windows on top by themselves.
    const linux = /Linux/.test(navigator.userAgent) && !/Android|CrOS/.test(navigator.userAgent);
    const title = document.title;
    if (linux) document.title = 'Picture-in-Picture';
    try {
      pip = await documentPictureInPicture.requestWindow({ width: 360, height: 203 });
    } catch (e) {
      console.warn('[lumen] the bubble can’t float here:', e.message);
      return;
    } finally {
      if (linux) setTimeout(() => { document.title = title; }, 1500);
    }
    const d = pip.document;
    const css = d.createElement('style');
    css.textContent = 'html,body{margin:0;height:100%;background:#000;overflow:hidden}iframe{border:0;width:100%;height:100%;display:block}';
    d.head.append(css);
    const f = d.createElement('iframe');
    f.src = chrome.runtime.getURL('bubble.html') + '?float';
    f.title = 'Lumen camera';
    d.body.append(f);
    iframe.style.display = 'none';
    pip.addEventListener('message', (e) => {
      if (e.origin === origin && e.data?.lumenBubble && e.data.type === 'unfloat') pip?.close();
    });
    pip.addEventListener('pagehide', () => { pip = null; iframe.style.display = 'block'; });
  };

  const remove = () => {
    pip?.close();
    iframe.remove();
    removeEventListener('message', onMessage);
    removeEventListener('resize', place);
    window.__lumenBubble = null;
  };
  const onMessage = (e) => {
    if (e.source !== iframe.contentWindow || e.origin !== origin || !e.data?.lumenBubble) return;
    const m = e.data;
    if (m.type === 'move') { x += m.dx; y += m.dy; place(); }
    if (m.type === 'size') {
      // Keep the bottom-left corner where it is, so it grows up and to the right.
      const bottom = y + h;
      w = m.w; h = m.h;
      y = bottom - h;
      place();
    }
    if (m.type === 'remove') remove();
    if (m.type === 'float') float();
    if (m.type === 'answer') {
      // Float first, inside the click (Chrome allows the window only then), then tell
      // the service worker to go on to the picker.
      const go = () => chrome.runtime.sendMessage({ target: 'sw', type: 'camera-answer', answer: m.answer }).catch(() => {});
      if (m.answer === 'float') float().finally(go); else go();
      toPill();
    }
  };
  addEventListener('message', onMessage);
  addEventListener('resize', place);
  chrome.runtime.onMessage.addListener((msg) => { if (msg?.type === 'lumen-bubble-remove') remove(); });
  window.__lumenBubble = { remove };
})();
