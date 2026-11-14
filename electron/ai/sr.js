'use strict';
// Runs one ONNX upscale job in its own process (sr-worker.js) and reports progress.
const path = require('path');
const fs = require('fs');
const { app, utilityProcess } = require('electron');
const log = require('../log');

const modelFile = (name) => require('../models').modelPath(name);

/** opts: { model (file name), scale, tile, passes }; ctx: { progress(p), onCancel(fn) }. → { width, height, provider, ms } */
function run(image, out, opts, ctx) {
  return new Promise((resolve, reject) => {
    const child = utilityProcess.fork(path.join(__dirname, 'sr-worker.js'), [], { serviceName: 'Chimpanze Wallpapers Upscale', stdio: 'pipe' });
    let done = false;
    const end = (fn, v) => { if (done) return; done = true; try { child.kill(); } catch (_) { /* ignore */ } fn(v); };
    if (child.stderr) child.stderr.on('data', (b) => { const l = String(b).trim(); if (l && !/onnxruntime|AbiCustom/.test(l)) log.info('upscale:', l.slice(0, 200)); });
    child.on('message', (m) => {
      if (!m) return;
      if (typeof m.progress === 'number') { if (ctx && ctx.progress) ctx.progress(m.progress); return; }
      if (m.ok) end(resolve, m.result); else end(reject, new Error(m.error));
    });
    child.on('exit', (code) => end(reject, new Error(`O processo do upscale terminou (código ${code}).`)));
    if (ctx && ctx.onCancel) ctx.onCancel(() => end(reject, Object.assign(new Error('Cancelado'), { canceled: true })));
    child.postMessage({ id: 1, image, out, model: modelFile(opts.model), scale: opts.scale, tile: opts.tile, passes: opts.passes });
  });
}

module.exports = { run, modelFile, exists: (name) => fs.existsSync(modelFile(name)) };
