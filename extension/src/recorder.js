// Fallback recorder tab (pinned). Used for screen recording only if Chrome refuses
// getDisplayMedia in the offscreen document. Same recorder, visible host.

import { Recorder } from './lib/recorder-core.js';
import { host } from './lib/host.js';

host('tab', (report) => new Recorder(report), {
  onState: (text) => { document.getElementById('state').textContent = text; },
});
