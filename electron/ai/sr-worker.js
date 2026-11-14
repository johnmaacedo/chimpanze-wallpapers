'use strict';
// Utility process for the ONNX upscale models (sr-core.js). One job, then it is
// killed by the parent: the runtime and the model leave RAM/VRAM at once.
const core = require('./sr-core');
const path = require('path');
const fs = require('fs');

process.parentPort.on('message', async (e) => {
  const { id, image, out, model, scale, tile, passes } = e.data || {};
  try {
    let src = image; let last = null;
    const n = Math.max(1, passes || 1);
    for (let p = 0; p < n; p++) {
      const dst = p === n - 1 ? out : path.join(path.dirname(out), `pass${p}.png`);
      last = await core.upscaleFile(src, dst, { model, scale, tile, onProgress: (v) => process.parentPort.postMessage({ id, progress: (p + v) / n }) });
      if (src !== image) fs.rmSync(src, { force: true });
      src = dst;
    }
    process.parentPort.postMessage({ id, ok: true, result: last });
  } catch (err) {
    process.parentPort.postMessage({ id, ok: false, error: err && err.message ? err.message : String(err) });
  }
});
