'use strict';
// Utility process for the "Clique mágico" (sam-core.js). Stays up between clicks on the
// same picture (its encoding is kept) and is killed by the parent after a while idle.
const core = require('./sam-core');

process.parentPort.on('message', async (e) => {
  const { id, image, points, side } = e.data || {};
  try {
    const r = await core.segment(image, points, side);
    process.parentPort.postMessage({ id, ok: true, result: { png: r.png, share: r.share, score: r.score } });
  } catch (err) {
    process.parentPort.postMessage({ id, ok: false, error: err && err.message ? err.message : String(err) });
  }
});
