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
const VERSION = 2; // bump when the depth recipe changes (old maps are rebuilt)
const MAX_CACHE = 1200; // files (each picture = depth PNG + background plate JPEG)
let child = null;
let idleTimer = null;
let seq = 0;
const pending = new Map();
const inflight = new Map(); // out file -> promise
let queue = Promise.resolve();
let writes = 0;

function lamaPath() {
  return app.isPackaged ? path.join(process.resourcesPath, 'models', 'lama.onnx') : path.join(__dirname, '..', '..', 'resources', 'models', 'lama.onnx');
}
const plateFor = (depthFile) => depthFile.replace(/\.png$/i, '.plate.jpg');

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
    env: Object.assign({}, process.env, { CW_DEPTH_MODEL: modelPath(), CW_LAMA_MODEL: lamaPath() }),
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
      if (!fs.statSync(dir).isDirectory()) continue;
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

const result = (out) => ({ depth: out, plate: plateFor(out) });
const complete = (out) => fs.existsSync(out) && fs.existsSync(plateFor(out));

/** Cached { depth, plate } for `file` if it already exists (no work), else null. */
function cached(file) {
  checkCacheVersion();
  const out = cachePath(file);
  return out && complete(out) ? result(out) : null;
}

/** Maps from an older recipe are useless: drop the whole cache once per version. */
let cacheChecked = false;
function checkCacheVersion() {
  if (cacheChecked) return;
  cacheChecked = true;
  const marker = path.join(cacheDir(), `v${VERSION}`);
  try {
    if (fs.existsSync(marker)) return;
    if (fs.existsSync(cacheDir())) fs.rmSync(cacheDir(), { recursive: true, force: true });
    fs.mkdirSync(cacheDir(), { recursive: true });
    fs.writeFileSync(marker, '');
  } catch (err) { log.warn('depth: limpeza do cache antigo falhou', err.message); }
}

/** { depth, plate } for an image (made once, then served from the cache). */
function get(file) {
  checkCacheVersion();
  const out = cachePath(file);
  if (!out) return Promise.reject(new Error('Arquivo não encontrado.'));
  if (complete(out)) {
    const now = new Date();
    for (const f of [out, plateFor(out)]) { try { fs.utimesSync(f, now, fs.statSync(f).mtime); } catch (_) { /* ignore */ } }
    return Promise.resolve(result(out));
  }
  if (inflight.has(out)) return inflight.get(out);
  if (!fs.existsSync(modelPath())) return Promise.reject(new Error('Modelo de profundidade não encontrado.'));
  // One picture at a time: the GPU work is short, and this keeps VRAM low.
  const job = queue.then(async () => {
    if (complete(out)) return result(out);
    const r = await runInWorker(file, out);
    log.info('depth: mapa pronto', path.basename(file), `${r.width}x${r.height}`, r.provider, `fundo ${r.plate}`, `corte ${r.split}`, `${r.ms} ms`);
    if (++writes % 40 === 0) prune();
    return result(out);
  });
  queue = job.catch(() => {});
  inflight.set(out, job);
  job.finally(() => inflight.delete(out)).catch(() => {});
  return job;
}

module.exports = { get, cached, release, modelPath, exists: () => fs.existsSync(modelPath()) };
