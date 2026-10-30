'use strict';
// Utility process hosting onnxruntime + LaMa. It only exists while the eraser is
// being used: when it exits, the ONNX runtime, DirectML and the model leave RAM/VRAM.
const core = require('./lama-core');

process.parentPort.on('message', async (e) => {
  const { id, image, mask, out } = e.data || {};
  try {
    const result = await core.erase(image, mask, out);
    process.parentPort.postMessage({ id, ok: true, result });
  } catch (err) {
    process.parentPort.postMessage({ id, ok: false, error: err && err.message ? err.message : String(err) });
  }
});
