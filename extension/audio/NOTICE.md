# RNNoise (mic noise removal)

`rnnoise.wasm` and `rnnoise_simd.wasm` are copied here at build time from
[`@sapphi-red/web-noise-suppressor`](https://github.com/sapphi-red/web-noise-suppressor) 0.4.1 (MIT).
They are [Shiguredo's WebAssembly build](https://github.com/shiguredo/rnnoise-wasm) (Apache-2.0) of
[RNNoise](https://github.com/xiph/rnnoise) by Jean-Marc Valin / Xiph.Org (BSD-3-Clause), with its built-in model.
Lumen runs them on this computer, inside the extension (`src/voice-worklet.js`); no audio leaves it.
