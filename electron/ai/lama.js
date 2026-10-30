'use strict';
// LaMa eraser front-end. The model runs in a separate utility process that is
// started on demand and closed after a short idle time, so onnxruntime/DirectML
// never stay resident in the app's memory between uses.
const path = require('path');
const fs = require('fs');
const { app, utilityProcess } = require('electron');
const log = require('../log');

const IDLE_MS = 45000;
let child = null;
let idleTimer = null;
let seq = 0;
const pending = new Map();

function modelPath() {
  return app.isPackaged ? path.join(process.resourcesPath, 'models', 'lama.onnx') : path.join(__dirname, '..', '..', 'resources', 'models', 'lama.onnx');
}

function start() {
  if (child) return child;
  child = utilityProcess.fork(path.join(__dirname, 'lama-worker.js'), [], {
    serviceName: 'Chimpanze Wallpapers LaMa',
    stdio: 'pipe',
    env: Object.assign({}, process.env, { CW_LAMA_MODEL: modelPath() }),
  });
  const c = child;
  const fwd = (buf) => String(buf).split(/\r?\n/).filter(Boolean).forEach((l) => log.info('lama:', l.replace(/^\[[^\]]+\]\s*\w+\s*/, '')));
  if (c.stdout) c.stdout.on('data', fwd);
  if (c.stderr) c.stderr.on('data', fwd);
  c.on('message', (m) => {
    const p = pending.get(m && m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.ok) p.resolve(m.result); else p.reject(new Error(m.error));
    armIdle();
  });
  c.on('exit', (code) => {
    if (child === c) child = null;
    for (const [id, p] of pending) { p.reject(new Error(`O processo da borracha terminou (código ${code}).`)); pending.delete(id); }
  });
  return c;
}

function armIdle() {
  clearTimeout(idleTimer);
  if (pending.size) return;
  idleTimer = setTimeout(release, IDLE_MS);
}

function release() {
  clearTimeout(idleTimer);
  if (child && !pending.size) {
    try { child.kill(); } catch (_) { /* ignore */ }
    child = null;
    log.info('lama: processo encerrado (memória devolvida)');
  }
}

let inProcess = false; // safety net if the utility process can't run on this machine

function eraseInWorker(imageFile, maskPng, outFile) {
  clearTimeout(idleTimer);
  const c = start();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    c.postMessage({ id, image: imageFile, mask: maskPng, out: outFile });
  });
}

/** Erase: imageFile + maskPng (white = remove, same size) → outFile (PNG). */
async function erase(imageFile, maskPng, outFile) {
  if (!inProcess) {
    try {
      return await eraseInWorker(imageFile, maskPng, outFile);
    } catch (err) {
      // Only infrastructure failures fall back; real errors (e.g. empty mask) are reported.
      if (!/terminou|Cannot find module|MODULE_NOT_FOUND|fork/i.test(err.message)) throw err;
      log.warn('lama: processo separado falhou, usando o modo antigo', err.message);
      inProcess = true;
    }
  }
  return require('./lama-core').erase(imageFile, maskPng, outFile);
}

function maskBoxes(...a) { return require('./lama-core').maskBoxes(...a); }

module.exports = { erase, release, maskBoxes, modelPath, exists: () => fs.existsSync(modelPath()) };
