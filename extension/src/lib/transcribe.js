// What was said in a shared recording: a transcript with word timings, then a title,
// summary and chapters, all written by the AI on the user's own share site (Workers AI:
// Whisper large-v3-turbo and a small Llama), the way desktop Lumen's "cloud" option does
// (lumen/share/clean/clean.py and meta.py). Runs in the offscreen document once the
// video is up. Only the mic track is sent: it's what you said, without the tab's sound.

import { apiRetry } from './share.js';
import { VERBATIM } from './cleanup.js';

const SR = 16000;          // what Whisper listens at
const CHUNK_S = 180;       // seconds per request (a 16 kHz WAV of 3 min is ~5.8 MB)

// The mic recording (WebM/Opus) as 16 kHz mono samples.
export async function micSamples(blob) {
  const ctx = new OfflineAudioContext(1, 1, SR);
  const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
  return buf.getChannelData(0);
}

// 16-bit PCM WAV, what the share site's /api/transcribe passes to Whisper.
export function wav(samples) {
  const out = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); out.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, SR, true); out.setUint32(28, SR * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true);
  str(36, 'data'); out.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true);
  return out.buffer;
}

// Lines for the transcript panel and captions: at most 8 words or 3.5 s, and a new line
// after a sentence ends (clean.py's cues()).
export function cues(words, maxWords = 8, maxLen = 3.5) {
  const out = [];
  let cur = [];
  for (const w of words) {
    if (cur.length && (cur.length >= maxWords || w.e - cur[0].s > maxLen || /[.?!۔।]$/.test(cur[cur.length - 1].w))) {
      out.push(cur);
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length) out.push(cur);
  return out.map((c) => ({ s: c[0].s, e: c[c.length - 1].e, text: c.map((w) => w.w).join(' ') }));
}

// Words with start/end times from the share site's Whisper, or null if nobody spoke.
// verbatim: keep the ums and uhs in (for cutting them): like desktop, a short first pass
// finds the language, then every piece goes with a prompt full of hesitations in it.
export async function transcribe(conn, samples, { verbatim = false, lang = null } = {}) {
  let sum = 0;
  for (let i = 0; i < samples.length; i += 4) sum += samples[i] * samples[i];
  if (10 * Math.log10(sum / (samples.length / 4) + 1e-12) < -60) return null;    // a silent mic
  const call = (piece, language, prompt) => {
    const q = new URLSearchParams({ ...(language ? { language } : {}), ...(prompt ? { prompt } : {}) }).toString();
    return apiRetry(conn, 'POST', `/api/transcribe${q ? `?${q}` : ''}`, wav(piece), { type: 'audio/wav', timeout: 300000 }, 3);
  };
  if (verbatim && !lang) lang = (await call(samples.subarray(0, SR * 30))).language || 'en';
  const words = [];
  for (let start = 0; start < samples.length; start += SR * CHUNK_S) {
    const r = await call(samples.subarray(start, start + SR * CHUNK_S), lang, verbatim ? VERBATIM[lang] : null);
    lang ||= r.language || null;          // without verbatim, the first piece finds the language
    const off = start / SR;
    for (const w of r.words || []) words.push({ w: w.w, s: +(w.s + off).toFixed(3), e: +(w.e + off).toFixed(3) });
  }
  return words.length ? { lang, words } : null;
}

// meta.py's prompt, word for word, so Chrome and desktop links read alike.
const PROMPT = `You name screen recordings for a Loom-style share page. Below is a timestamped transcript
of a {dur}-second recording (spoken language: {lang}).

Reply with ONLY a JSON object, no prose, no code fence:
{"title": "...", "summary": "...", "chapters": [{"t": 0, "title": "..."}]}

- title: what the recording shows or explains, specific and plain, sentence case, at most 60 characters,
  in English. No quotes, no emoji, no "Video of"/"Recording of".
- summary: one or two sentences, at most 200 characters, in English, saying what a viewer will learn or see.
- chapters: only if the recording is at least 60 seconds long AND covers two or more distinct parts;
  otherwise []. 2 to 6 chapters, the first at t=0, each t (seconds) taken from the transcript where that
  part starts, titles at most 4 words.

Transcript:
{lines}`;

// { title?, summary?, chapters? } from the share site's small LLM; {} for too little speech
// or anything unusable (a title is a bonus).
export async function describe(conn, lines, duration, lang) {
  if (lines.reduce((a, c) => a + c.text.split(/\s+/).length, 0) < 6) return {};
  const prompt = PROMPT.replace('{dur}', String(Math.round(duration))).replace('{lang}', lang || 'unknown')
    .replace('{lines}', lines.map((c) => `[${Math.round(c.s)}s] ${c.text}`).join('\n').slice(0, 24000));
  const r = await apiRetry(conn, 'POST', '/api/complete', { prompt }, { timeout: 120000 }, 2);
  let meta = {};
  try { meta = JSON.parse((String(r.text || '').match(/\{[\s\S]*\}/) || ['{}'])[0]); } catch { return {}; }
  const out = {};
  if (typeof meta.title === 'string' && meta.title.trim()) out.title = meta.title.trim().replace(/^["']|["']$/g, '').slice(0, 80);
  if (typeof meta.summary === 'string' && meta.summary.trim()) out.summary = meta.summary.trim().slice(0, 280);
  const ch = (Array.isArray(meta.chapters) ? meta.chapters : []).filter((c) => c && Number.isFinite(Number(c.t)) && c.title);
  if (ch.length >= 2 && duration >= 60) {          // small models ignore the "60 s or longer" rule
    out.chapters = ch.map((c) => ({ t: Math.max(0, Math.min(Number(c.t), duration)), title: String(c.title).slice(0, 40) }))
      .sort((a, b) => a.t - b.t);
    out.chapters[0].t = 0;
  }
  return out;
}
