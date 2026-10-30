'use strict';
// LaMa core (runs inside the lama-worker utility process). Built-in AI eraser with LaMa (ONNX, 512×512), running on the GPU
// through DirectML (any DX12 GPU, no CUDA/Python/ComfyUI needed). The session is
// created on demand and released after a minute idle to give RAM/VRAM back.
const path = require('path');
const fs = require('fs');
const log = require('../log');

const SIZE = 512;
let session = null;
let sessionProvider = '';
let idleTimer = null;
let ort = null;

function modelPath() {
  if (process.env.CW_LAMA_MODEL) return process.env.CW_LAMA_MODEL;
  const { app } = require('electron');
  return app.isPackaged ? path.join(process.resourcesPath, 'models', 'lama.onnx') : path.join(__dirname, '..', '..', 'resources', 'models', 'lama.onnx');
}

async function getSession() {
  clearTimeout(idleTimer);
  if (!session) {
    ort = ort || require('onnxruntime-node');
    const providers = process.platform === 'win32' ? [['dml', 'cpu'], ['cpu']] : [['cpu']];
    let lastErr;
    for (const ep of providers) {
      try {
        session = await ort.InferenceSession.create(modelPath(), { executionProviders: ep, logSeverityLevel: 3, graphOptimizationLevel: 'all' });
        sessionProvider = ep[0];
        log.info('lama: sessão criada com', sessionProvider);
        break;
      } catch (err) { lastErr = err; log.warn('lama: provider falhou', ep[0], err.message); }
    }
    if (!session) throw lastErr || new Error('Não foi possível iniciar a IA.');
  }
  idleTimer = setTimeout(release, 60000);
  return session;
}

async function release() {
  clearTimeout(idleTimer);
  if (session) {
    try { await session.release(); } catch (_) { /* ignore */ }
    session = null;
    log.info('lama: sessão liberada (memória devolvida)');
  }
}

/** Runs LaMa on a 512×512 RGB crop. rgb: Buffer (512*512*3), mask: Buffer (512*512, >127 = fill). */
async function run512(rgb, mask) {
  const s = await getSession();
  const N = SIZE * SIZE;
  const img = new Float32Array(3 * N);
  const m = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const hole = mask[i] > 127;
    m[i] = hole ? 1 : 0;
    // Holes are zeroed so the model never copies what is underneath.
    img[i] = hole ? 0 : rgb[i * 3] / 255;
    img[N + i] = hole ? 0 : rgb[i * 3 + 1] / 255;
    img[2 * N + i] = hole ? 0 : rgb[i * 3 + 2] / 255;
  }
  const out = await s.run({
    image: new ort.Tensor('float32', img, [1, 3, SIZE, SIZE]),
    mask: new ort.Tensor('float32', m, [1, 1, SIZE, SIZE]),
  });
  const o = out.output.data;
  const res = Buffer.alloc(N * 3);
  for (let i = 0; i < N; i++) {
    res[i * 3] = clamp(o[i]);
    res[i * 3 + 1] = clamp(o[N + i]);
    res[i * 3 + 2] = clamp(o[2 * N + i]);
  }
  return res;
}

function clamp(v) { return v < 0 ? 0 : v > 255 ? 255 : Math.round(v); }

/**
 * Fills the masked area of `rgb` (W×H×3) in place, working in a context window
 * around each masked region so even 4K/8K images stay sharp outside the fill.
 */
async function fillRegion(sharp, rgb, W, H, maskFull, box, onStep, grow = 2.2) {
  // Context window: bbox grown so the hole is ~40% of the window, min 512 px.
  const bw = box.x1 - box.x0; const bh = box.y1 - box.y0;
  let side = Math.max(SIZE, Math.ceil(Math.max(bw, bh) * grow));
  side = Math.min(side, Math.max(W, H));
  const cx = (box.x0 + box.x1) / 2; const cy = (box.y0 + box.y1) / 2;
  let x0 = Math.round(cx - side / 2); let y0 = Math.round(cy - side / 2);
  const cw = Math.min(side, W); const ch = Math.min(side, H);
  x0 = Math.max(0, Math.min(W - cw, x0)); y0 = Math.max(0, Math.min(H - ch, y0));

  const crop = Buffer.alloc(cw * ch * 3);
  const cmask = Buffer.alloc(cw * ch);
  for (let y = 0; y < ch; y++) {
    rgb.copy(crop, y * cw * 3, ((y0 + y) * W + x0) * 3, ((y0 + y) * W + x0 + cw) * 3);
    maskFull.copy(cmask, y * cw, (y0 + y) * W + x0, (y0 + y) * W + x0 + cw);
  }
  const rgb512 = await sharp(crop, { raw: { width: cw, height: ch, channels: 3 } }).resize(SIZE, SIZE, { fit: 'fill', kernel: 'lanczos3' }).raw().toBuffer();
  // Mask: grow a few pixels (covers anti-aliased watermark edges), then resize.
  const grown = await sharp(cmask, { raw: { width: cw, height: ch, channels: 1 } }).dilate(Math.max(2, Math.round(cw / 256))).extractChannel(0).raw().toBuffer();
  const m512 = await sharp(grown, { raw: { width: cw, height: ch, channels: 1 } }).resize(SIZE, SIZE, { fit: 'fill', kernel: 'nearest' }).extractChannel(0).raw().toBuffer();
  onStep && onStep();
  const out512 = await run512(rgb512, m512);
  const outCrop = await sharp(out512, { raw: { width: SIZE, height: SIZE, channels: 3 } }).resize(cw, ch, { fit: 'fill', kernel: 'lanczos3' }).raw().toBuffer();
  // Feathered blend back (only where the grown mask is set).
  const feather = await sharp(grown, { raw: { width: cw, height: ch, channels: 1 } }).blur(Math.max(1, cw / 400)).extractChannel(0).raw().toBuffer();
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const a = feather[y * cw + x] / 255;
      if (a <= 0.002) continue;
      const di = ((y0 + y) * W + x0 + x) * 3; const si = (y * cw + x) * 3;
      for (let c = 0; c < 3; c++) rgb[di + c] = Math.round(rgb[di + c] * (1 - a) + outCrop[si + c] * a);
    }
  }
}

/** Finds bounding boxes of mask blobs (coarse grid flood fill). */
function maskBoxes(mask, W, H) {
  const G = 32; const gw = Math.ceil(W / G); const gh = Math.ceil(H / G);
  const cell = new Uint8Array(gw * gh);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (mask[y * W + x] > 127) cell[((y / G) | 0) * gw + ((x / G) | 0)] = 1;
  const seen = new Uint8Array(gw * gh); const boxes = [];
  for (let i = 0; i < cell.length; i++) {
    if (!cell[i] || seen[i]) continue;
    const st = [i]; seen[i] = 1; let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    while (st.length) {
      const k = st.pop(); const cx = k % gw; const cy = (k / gw) | 0;
      x0 = Math.min(x0, cx); y0 = Math.min(y0, cy); x1 = Math.max(x1, cx); y1 = Math.max(y1, cy);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const nx = cx + dx; const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const n = ny * gw + nx;
        if (cell[n] && !seen[n]) { seen[n] = 1; st.push(n); }
      }
    }
    boxes.push({ x0: x0 * G, y0: y0 * G, x1: Math.min(W, (x1 + 1) * G), y1: Math.min(H, (y1 + 1) * G) });
  }
  return boxes;
}

/** Erase: imageFile + maskPng (white = remove, same size) → outFile (PNG). */
async function erase(imageFile, maskPng, outFile, onProgress) {
  const sharp = require('../img');
  const { data: rgb, info } = await sharp(imageFile, { limitInputPixels: false }).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width; const H = info.height;
  const mask = await sharp(maskPng).resize(W, H, { fit: 'fill' }).extractChannel(0).raw().toBuffer();
  const boxes = maskBoxes(mask, W, H);
  if (!boxes.length) throw new Error('Pinte por cima do que quer apagar.');
  let done = 0;
  for (const b of boxes) {
    await fillRegion(sharp, rgb, W, H, mask, b, () => onProgress && onProgress(done / boxes.length));
    done++;
  }
  await sharp(rgb, { raw: { width: W, height: H, channels: 3 } }).png({ compressionLevel: 3 }).toFile(outFile);
  return { width: W, height: H, regions: boxes.length, provider: sessionProvider };
}

module.exports = { erase, release, maskBoxes, modelPath, exists: () => fs.existsSync(modelPath()) };
