'use strict';
// Depth core (runs inside the depth-worker utility process). Depth Anything V2
// Small (ONNX, Apache-2.0) estimates how near every pixel is; the result drives
// the 2.5D parallax of the wallpaper. Runs on the GPU through DirectML, falls
// back to the CPU. The session is released after a short idle time.
const fs = require('fs');
const path = require('path');
const log = require('../log');

const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
const PATCH = 14;
const NET_LONG = 812; // network input, long side (58 × 14): sharp edges, still fast
const OUT_LONG = 1280; // saved depth map, long side

let session = null;
let sessionProvider = '';
let idleTimer = null;
let ort = null;

function modelPath() {
  if (process.env.CW_DEPTH_MODEL) return process.env.CW_DEPTH_MODEL;
  const { app } = require('electron');
  return app.isPackaged ? path.join(process.resourcesPath, 'models', 'depth-anything-v2-small.onnx') : path.join(__dirname, '..', '..', 'resources', 'models', 'depth-anything-v2-small.onnx');
}

async function getSession() {
  clearTimeout(idleTimer);
  if (!session) {
    ort = ort || require('onnxruntime-node');
    const providers = process.platform === 'win32' && !process.env.CW_DEPTH_CPU ? [['dml', 'cpu'], ['cpu']] : [['cpu']];
    let lastErr;
    for (const ep of providers) {
      try {
        // The fp16 model trips a CPU graph-fusion bug at level 'all'; 'basic' runs fine.
        session = await ort.InferenceSession.create(modelPath(), { executionProviders: ep, logSeverityLevel: 3, graphOptimizationLevel: ep[0] === 'cpu' ? 'basic' : 'all' });
        sessionProvider = ep[0];
        log.info('depth: sessão criada com', sessionProvider);
        break;
      } catch (err) { lastErr = err; log.warn('depth: provider falhou', ep[0], err.message); }
    }
    if (!session) throw lastErr || new Error('Não foi possível iniciar a IA de profundidade.');
  }
  idleTimer = setTimeout(release, 30000);
  return session;
}

async function release() {
  clearTimeout(idleTimer);
  if (session) {
    try { await session.release(); } catch (_) { /* ignore */ }
    session = null;
    log.info('depth: sessão liberada (memória devolvida)');
  }
}

const snap = (v) => Math.max(PATCH, Math.round(v / PATCH) * PATCH);

/** Box filter (running sums), radius r, on a W×H Float32Array. */
function boxBlur(src, W, H, r) {
  const tmp = new Float32Array(W * H);
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    let acc = 0; const row = y * W;
    for (let x = -r; x <= r; x++) acc += src[row + Math.min(W - 1, Math.max(0, x))];
    for (let x = 0; x < W; x++) {
      tmp[row + x] = acc / (2 * r + 1);
      acc += src[row + Math.min(W - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < W; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(H - 1, Math.max(0, y)) * W + x];
    for (let y = 0; y < H; y++) {
      out[y * W + x] = acc / (2 * r + 1);
      acc += tmp[Math.min(H - 1, y + r + 1) * W + x] - tmp[Math.max(0, y - r) * W + x];
    }
  }
  return out;
}

/**
 * Guided filter (He et al.): smooths the depth while snapping its edges to the
 * edges of the picture, so the line art of a character and its depth agree.
 */
function guidedFilter(I, p, W, H, r, eps) {
  const mI = boxBlur(I, W, H, r); const mp = boxBlur(p, W, H, r);
  const Ip = new Float32Array(W * H); const II = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) { Ip[i] = I[i] * p[i]; II[i] = I[i] * I[i]; }
  const mIp = boxBlur(Ip, W, H, r); const mII = boxBlur(II, W, H, r);
  const a = new Float32Array(W * H); const b = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const cov = mIp[i] - mI[i] * mp[i];
    const v = mII[i] - mI[i] * mI[i];
    a[i] = cov / (v + eps);
    b[i] = mp[i] - a[i] * mI[i];
  }
  const ma = boxBlur(a, W, H, r); const mb = boxBlur(b, W, H, r);
  const q = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) q[i] = ma[i] * I[i] + mb[i];
  return q;
}

/** Grayscale dilation (max filter), separable square window of radius r. */
function dilate(src, W, H, r) {
  const tmp = new Float32Array(W * H); const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let m = 0; for (let k = -r; k <= r; k++) { const v = src[y * W + Math.min(W - 1, Math.max(0, x + k))]; if (v > m) m = v; }
    tmp[y * W + x] = m;
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let m = 0; for (let k = -r; k <= r; k++) { const v = tmp[Math.min(H - 1, Math.max(0, y + k)) * W + x]; if (v > m) m = v; }
    out[y * W + x] = m;
  }
  return out;
}

/** imageFile → 8-bit grayscale PNG depth map (white = near). */
async function estimate(imageFile, outFile) {
  const sharp = require('../img');
  const t0 = Date.now();
  const meta = await sharp(imageFile, { limitInputPixels: false }).metadata();
  const swap = (meta.orientation || 1) >= 5; // EXIF 5..8 = rotated 90°
  const iw = swap ? meta.height : meta.width;
  const ih = swap ? meta.width : meta.height;
  const k = NET_LONG / Math.max(iw, ih);
  const nw = snap(iw * k); const nh = snap(ih * k);
  const rgb = await sharp(imageFile, { limitInputPixels: false }).rotate().removeAlpha().resize(nw, nh, { fit: 'fill', kernel: 'cubic' }).raw().toBuffer();
  const N = nw * nh;
  const input = new Float32Array(3 * N);
  for (let i = 0; i < N; i++) {
    for (let c = 0; c < 3; c++) input[c * N + i] = (rgb[i * 3 + c] / 255 - MEAN[c]) / STD[c];
  }
  const s = await getSession();
  const feeds = {}; feeds[s.inputNames[0]] = new ort.Tensor('float32', input, [1, 3, nh, nw]);
  const out = await s.run(feeds);
  const pred = out[s.outputNames[0]];
  const dims = pred.dims; const ph = dims[dims.length - 2]; const pw = dims[dims.length - 1];
  const raw = pred.data;

  // Robust normalisation (1st..99th percentile) → 0 = far, 1 = near.
  const sorted = Float32Array.from(raw).sort();
  const lo = sorted[Math.floor(sorted.length * 0.01)];
  const hi = sorted[Math.floor(sorted.length * 0.99)];
  const span = Math.max(1e-6, hi - lo);
  const d8 = Buffer.alloc(pw * ph);
  for (let i = 0; i < pw * ph; i++) d8[i] = Math.round(255 * Math.min(1, Math.max(0, (raw[i] - lo) / span)));

  // Up to the saved size, then edge-aware refinement guided by the picture.
  const ko = OUT_LONG / Math.max(iw, ih);
  const ow = Math.round(iw * Math.min(1, ko)); const oh = Math.round(ih * Math.min(1, ko));
  // extractChannel(0): sharp outputs 3 channels after a resize otherwise.
  const dUp = await sharp(d8, { raw: { width: pw, height: ph, channels: 1 } }).resize(ow, oh, { fit: 'fill', kernel: 'cubic' }).extractChannel(0).raw().toBuffer();
  const gray = await sharp(imageFile, { limitInputPixels: false }).rotate().removeAlpha().resize(ow, oh, { fit: 'fill' }).greyscale().extractChannel(0).raw().toBuffer();
  if (dUp.length !== ow * oh || gray.length !== ow * oh) throw new Error('Mapa de profundidade com tamanho inesperado.');
  const I = new Float32Array(ow * oh); const p = new Float32Array(ow * oh);
  for (let i = 0; i < ow * oh; i++) { I[i] = gray[i] / 255; p[i] = dUp[i] / 255; }
  let q = guidedFilter(I, p, ow, oh, Math.max(3, Math.round(ow / 320)), 1e-4);
  // Grow the near layer a little so a character's own outline moves with it
  // (no thin halo of the background stuck to the edge), then soften the steps.
  q = dilate(q, ow, oh, Math.max(2, Math.round(ow / 400)));
  q = boxBlur(q, ow, oh, Math.max(1, Math.round(ow / 640)));
  const outBuf = Buffer.alloc(ow * oh);
  for (let i = 0; i < ow * oh; i++) outBuf[i] = Math.round(255 * Math.min(1, Math.max(0, q[i])));
  await fs.promises.mkdir(path.dirname(outFile), { recursive: true });
  const tmp = outFile + '.tmp.png';
  await sharp(outBuf, { raw: { width: ow, height: oh, channels: 1 } }).png({ compressionLevel: 6 }).toFile(tmp);
  await fs.promises.rename(tmp, outFile);
  return { width: ow, height: oh, provider: sessionProvider, ms: Date.now() - t0 };
}

module.exports = { estimate, release, modelPath, exists: () => fs.existsSync(modelPath()) };
