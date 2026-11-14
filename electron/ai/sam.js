'use strict';
// "Clique mágico": asks the SAM process for the object under a click.
const path = require('path');
const fs = require('fs');
const { app, utilityProcess } = require('electron');

const model = (name) => require('../models').modelPath(name);
const ENC = 'sam2.1-tiny-encoder.onnx'; const DEC = 'sam2.1-tiny-decoder.onnx';
let child = null; let seq = 0; let idle = null;
const pending = new Map();

function start() {
  if (child) return child;
  const c = utilityProcess.fork(path.join(__dirname, 'sam-worker.js'), [], {
    serviceName: 'Chimpanze Wallpapers Clique', stdio: 'ignore',
    env: Object.assign({}, process.env, { CW_SAM_ENCODER: model(ENC), CW_SAM_DECODER: model(DEC) }),
  });
  child = c;
  c.on('message', (m) => { const p = pending.get(m && m.id); if (!p) return; pending.delete(m.id); if (m.ok) p.resolve(m.result); else p.reject(new Error(m.error)); });
  c.on('exit', () => { if (child === c) child = null; for (const [id, p] of pending) { p.reject(new Error('O clique mágico parou.')); pending.delete(id); } });
  return c;
}

/** points: [{ x, y (0..1), add }] → { png (Buffer, grey mask), share, score } */
function segment(image, points, side = 1024) {
  clearTimeout(idle);
  const c = start(); const id = ++seq;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); c.postMessage({ id, image, points, side }); })
    .finally(() => { clearTimeout(idle); idle = setTimeout(() => { if (child && !pending.size) { try { child.kill(); } catch (_) { /* ignore */ } child = null; } }, 90000); });
}

module.exports = { segment, exists: () => fs.existsSync(model(ENC)) && fs.existsSync(model(DEC)) };
