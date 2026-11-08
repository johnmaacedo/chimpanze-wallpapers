'use strict';
// Runs "Juntar com o original" (merge-core.js) in a worker thread, reporting its stages.
const { parentPort, workerData } = require('worker_threads');
const { merge } = require('./merge-core');

merge({ ...workerData, onStage: (stage) => parentPort.postMessage({ stage }) })
  .then((r) => parentPort.postMessage({ ok: true, r }))
  .catch((e) => parentPort.postMessage({ ok: false, error: e && e.message ? e.message : String(e), code: e && e.code }));
