// Turns the recorded WebM into an MP4 without re-encoding (a "remux"): the video
// and audio data are copied as they are into a new container. That takes seconds,
// fixes WebM's missing duration and seek index, and gives a file every player and
// the Lumen share site expect. Uses Mediabunny (MPL-2.0), bundled in the extension.

import { Input, Output, Conversion, BlobSource, BufferTarget, Mp4OutputFormat, WEBM, MATROSKA } from 'mediabunny';

// Returns { blob, duration, video, audio } or throws if the streams can't be copied
// into MP4 (then the caller keeps the WebM).
export async function webmToMp4(webmBlob, onProgress) {
  // H.264 recordings come out as Matroska ("video/x-matroska"), not WebM (M0).
  const input = new Input({ source: new BlobSource(webmBlob), formats: [WEBM, MATROSKA] });
  const target = new BufferTarget();
  // 'in-memory' puts the index (moov) at the front so the video starts playing
  // before it has fully downloaded. It holds the output in RAM while muxing,
  // which is fine for minutes of video; very long recordings need 'reserve' (M3).
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
  const conversion = await Conversion.init({ input, output, copy: { mode: 'forced' } });
  if (!conversion.isValid || conversion.discardedTracks.length) {
    const why = conversion.discardedTracks.map((d) => `${d.track.type}: ${d.reason}`).join(', ');
    throw new Error(`can't copy into MP4 (${why || 'no usable tracks'})`);
  }
  if (onProgress) conversion.onProgress = onProgress;
  await conversion.execute();
  const duration = await input.computeDuration();
  const v = await input.getPrimaryVideoTrack();
  const a = await input.getPrimaryAudioTrack();
  return {
    blob: new Blob([target.buffer], { type: 'video/mp4' }),
    duration,
    video: v ? { codec: v.codec, width: v.displayWidth, height: v.displayHeight } : null,
    audio: a ? { codec: a.codec } : null,
  };
}
