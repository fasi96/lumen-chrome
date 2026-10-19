// Takes the cuts (lib/cleanup.js) out of an MP4, in the browser: Mediabunny decodes
// every frame and sound sample with Chrome's own codecs, drops the ones inside a cut,
// moves the rest earlier, and encodes them again (a cut in the middle of a second can't
// be done by copying: video is stored in chunks that start at key frames). Same codec
// as the recording, a key frame every second like the recorder, so seeking stays smooth.

import { Input, Output, Conversion, BlobSource, BufferTarget, Mp4OutputFormat, MP4 } from 'mediabunny';
import { remap } from './cleanup.js';

// file: the MP4 (Blob); cuts: [[start, end]] in seconds, sorted, not overlapping.
// Returns { blob, duration } or throws (then the uncut video is shared).
export async function cutVideo(file, cuts, { onProgress } = {}) {
  const input = new Input({ source: new BlobSource(file), formats: [MP4] });
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
  const v = await input.getPrimaryVideoTrack();
  // Each sample keeps its place on the new timeline, or goes if it starts inside a cut.
  const retime = (sample) => {
    const t = remap(sample.timestamp, cuts);
    if (t === null) return null;
    sample.setTimestamp(t);
    return sample;
  };
  const conversion = await Conversion.init({
    input, output,
    video: { forceTranscode: true, keyFrameInterval: 1, bitrate: 5_000_000, process: retime,
      ...(v ? { codec: v.codec === 'avc' ? 'avc' : v.codec === 'vp8' ? 'vp8' : 'vp9' } : {}) },
    audio: { forceTranscode: true, codec: 'opus', bitrate: 128_000, process: retime },
  });
  if (!conversion.isValid || conversion.discardedTracks.length) {
    const why = conversion.discardedTracks.map((d) => `${d.track.type}: ${d.reason}`).join(', ');
    throw new Error(`can't cut this video (${why || 'no usable tracks'})`);
  }
  if (onProgress) conversion.onProgress = onProgress;
  await conversion.execute();
  const blob = new Blob([target.buffer], { type: 'video/mp4' });
  const check = new Input({ source: new BlobSource(blob), formats: [MP4] });
  return { blob, duration: await check.computeDuration() };
}
