'use strict';
// Utility process hosting onnxruntime + Depth Anything. It only exists while depth
// maps are being made: when it exits, the runtime and the model leave RAM/VRAM.
const core = require('./depth-core');

process.parentPort.on('message', async (e) => {
  const { id, image, out, variant } = e.data || {};
  try {
    const result = await core.estimate(image, out, variant || 0);
    process.parentPort.postMessage({ id, ok: true, result });
  } catch (err) {
    process.parentPort.postMessage({ id, ok: false, error: err && err.message ? err.message : String(err) });
  }
});
