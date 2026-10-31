'use strict';
// Depth maps for the 2.5D parallax. Each picture is analysed once (in a utility
// process that closes when idle) and the map is cached on disk, keyed by the
// file's path, size and date, so the next time it is instant.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { app, utilityProcess } = require('electron');
const log = require('../log');

const IDLE_MS = 30000;
const VERSION = 1; // bump when the depth recipe changes (old maps are rebuilt)
const MAX_CACHE = 600;
let child = null;
let idleTimer = null;
let seq = 0;
const pending = new Map();
const inflight = new Map(); // out file -> promise
let queue = Promise.resolve();
let writes = 0;

function modelPath() {
  return app.isPackaged ? path.join(process.resourcesPath, 'models', 'depth-anything-v2-small.onnx') : path.join(__dirname, '..', '..', 'resources', 'models', 'depth-anything-v2-small.onnx');
}
const cacheDir = () => path.join(app.getPath('userData'), 'depth');

function cachePath(file) {
  let st;
  try { st = fs.statSync(file); } catch (_) { return null; }
  const key = crypto.createHash('sha1').update(`${VERSION}|${path.resolve(file).toLowerCase()}|${st.size}|${Math.round(st.mtimeMs)}`).digest('hex');
  return path.join(cacheDir(), key.slice(0, 2), key + '.png');
}

function start() {
  if (child) return child;
  child = utilityProcess.fork(path.join(__dirname, 'depth-worker.js'), [], {
    serviceName: 'Chimpanze Wallpapers Profundidade',
    stdio: 'pipe',
    env: Object.assign({}, process.env, { CW_DEPTH_MODEL: modelPath() }),
  });
  const c = child;
  const fwd = (buf) => String(buf).split(/\r?\n/).filter(Boolean).forEach((l) => log.info('depth:', l.replace(/^\[[^\]]+\]\s*\w+\s*/, '')));
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
    for (const [id, p] of pending) { p.reject(new Error(`O processo de profundidade terminou (código ${code}).`)); pending.delete(id); }
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
    log.info('depth: processo encerrado (memória devolvida)');
  }
}

function runInWorker(image, out) {
  clearTimeout(idleTimer);
  const c = start();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    c.postMessage({ id, image, out });
  });
}

/** Keeps the cache bounded: drops the least recently used maps. */
function prune() {
  try {
    const all = [];
    for (const d of fs.readdirSync(cacheDir())) {
      const dir = path.join(cacheDir(), d);
      for (const f of fs.readdirSync(dir)) {
        const full = path.join(dir, f);
        all.push({ full, t: fs.statSync(full).atimeMs });
      }
    }
    if (all.length <= MAX_CACHE) return;
    all.sort((a, b) => b.t - a.t);
    for (const x of all.slice(MAX_CACHE)) fs.rmSync(x.full, { force: true });
  } catch (_) { /* nothing cached yet */ }
}

/** Cached depth map for `file` if it already exists (no work), else null. */
function cached(file) {
  const out = cachePath(file);
  return out && fs.existsSync(out) ? out : null;
}

/** Depth map for an image (made once, then served from the cache). */
function get(file) {
  const out = cachePath(file);
  if (!out) return Promise.reject(new Error('Arquivo não encontrado.'));
  if (fs.existsSync(out)) {
    const now = new Date();
    try { fs.utimesSync(out, now, fs.statSync(out).mtime); } catch (_) { /* ignore */ }
    return Promise.resolve(out);
  }
  if (inflight.has(out)) return inflight.get(out);
  if (!fs.existsSync(modelPath())) return Promise.reject(new Error('Modelo de profundidade não encontrado.'));
  // One picture at a time: the GPU work is short, and this keeps VRAM low.
  const job = queue.then(async () => {
    if (fs.existsSync(out)) return out;
    const r = await runInWorker(file, out);
    log.info('depth: mapa pronto', path.basename(file), `${r.width}x${r.height}`, r.provider, `${r.ms} ms`);
    if (++writes % 40 === 0) prune();
    return out;
  });
  queue = job.catch(() => {});
  inflight.set(out, job);
  job.finally(() => inflight.delete(out)).catch(() => {});
  return job;
}

module.exports = { get, cached, release, modelPath, exists: () => fs.existsSync(modelPath()) };
