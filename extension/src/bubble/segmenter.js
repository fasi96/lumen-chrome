// The person segmenter: MediaPipe's selfie_segmenter model (the same .tflite the
// desktop bubble uses), run with @mediapipe/tasks-vision. Everything (the wasm, its
// loader and the model) ships inside the extension under vision/; nothing is fetched
// from the web.

import { ImageSegmenter } from '@mediapipe/tasks-vision';

const url = (p) => chrome.runtime.getURL(p);

export class Segmenter {
  // delegate: 'CPU' (default: predictable, no GPU readback) or 'GPU'.
  static async create(delegate = 'CPU') {
    const fileset = {
      wasmLoaderPath: url('vision/vision_wasm_internal.js'),
      wasmBinaryPath: url('vision/vision_wasm_internal.wasm'),
    };
    const make = (d) => ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: url('vision/selfie_segmenter.tflite'), delegate: d },
      runningMode: 'VIDEO',
      outputConfidenceMasks: true,
      outputCategoryMask: false,
    });
    let seg;
    try {
      seg = await make(delegate);
    } catch (e) {
      if (delegate === 'CPU') throw e;
      console.warn('[lumen] GPU segmenter failed, using CPU', e);
      seg = await make((delegate = 'CPU'));
    }
    return new Segmenter(seg, delegate);
  }

  constructor(seg, delegate) {
    this.seg = seg;
    this.delegate = delegate;
    this.lastTs = 0;
  }

  // image: a 256×256 canvas (or any image source). Returns a Float32Array of
  // 256×256 person confidences (0..1), copied out of MediaPipe's buffer.
  run(image) {
    const ts = Math.max(this.lastTs + 1, performance.now());   // must keep increasing
    this.lastTs = ts;
    let out = null;
    const t0 = performance.now();
    let t1 = t0;
    this.seg.segmentForVideo(image, ts, (res) => {
      t1 = performance.now();
      const m = res.confidenceMasks?.[0];
      if (m) out = { data: m.getAsFloat32Array().slice(), width: m.width, height: m.height };
    });
    this.inferMs = (this.inferMs || 0) + (t1 - t0);          // the model itself
    this.copyMs = (this.copyMs || 0) + (performance.now() - t1);  // getting the mask out
    return out;
  }

  close() { this.seg.close(); }
}
