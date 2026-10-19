// Welcome page: says what Lumen captures, and gets the one-time mic permission
// (the permission then also covers the hidden recorder).

// One row per device: the permission name, the getUserMedia request, the words.
const DEVICES = [
  { perm: 'microphone', button: 'allow', state: 'mic-state', ask: { audio: true }, name: 'Mic' },
  { perm: 'camera', button: 'allow-cam', state: 'cam-state', ask: { video: true }, name: 'Camera' },
];

async function show(dev) {
  const el = document.getElementById(dev.state);
  let s = 'prompt';
  try { s = (await navigator.permissions.query({ name: dev.perm })).state; } catch { /* older Chrome */ }
  el.className = 'small ' + (s === 'granted' ? 'ok' : s === 'denied' ? 'bad' : '');
  el.textContent = s === 'granted' ? `✓ ${dev.name} allowed.`
    : s === 'denied' ? `Blocked. Click the icon at the left of the address bar to allow the ${dev.name.toLowerCase()}.` : '';
}

for (const dev of DEVICES) {
  document.getElementById(dev.button).onclick = async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia(dev.ask);
      s.getTracks().forEach((t) => t.stop());
    } catch { /* shown by show() */ }
    show(dev);
  };
  show(dev);
}

// Show the shortcut Chrome actually assigned (it skips suggested keys that clash).
chrome.commands.getAll((cmds) => {
  const c = cmds.find((x) => x.name === 'toggle-recording');
  document.getElementById('shortcut').textContent = c?.shortcut || 'your shortcut (none set yet)';
});
// chrome:// links can't be opened by a plain <a>, only through the tabs API.
document.getElementById('shortcuts-link').onclick = (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
};
