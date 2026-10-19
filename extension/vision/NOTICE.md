# Bundled MediaPipe files

The face bubble finds you in the camera picture with Google's
[MediaPipe](https://ai.google.dev/edge/mediapipe), all of it bundled in the extension
(nothing is downloaded at run time):

| File | What it is | Where it comes from |
|---|---|---|
| `selfie_segmenter.tflite` | The person-segmentation model ("Selfie segmentation", float16), the same file desktop Lumen uses in `cam/models/` | https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite |
| `vision_wasm_internal.js`, `vision_wasm_internal.wasm` | The MediaPipe Tasks Vision runtime, copied from the `@mediapipe/tasks-vision` npm package by `scripts/build.mjs` (not stored in git) | https://www.npmjs.com/package/@mediapipe/tasks-vision |

`selfie_segmenter.tflite` sha256:
`191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b`

These files are Copyright Google LLC and are distributed under the
[Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0), unchanged. See the
[MediaPipe model cards](https://ai.google.dev/edge/mediapipe/solutions/vision/image_segmenter#models).
The rest of Lumen for Chrome is under the MIT licence in the repository root.
