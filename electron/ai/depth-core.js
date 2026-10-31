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

/**
 * imageFile → packed depth PNG (RGB: foreground depth, background depth, matte)
 * + a background plate JPEG with the characters removed.
 */
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
  const N2 = ow * oh;
  // extractChannel(0): sharp outputs 3 channels after a resize otherwise.
  const dUp = await sharp(d8, { raw: { width: pw, height: ph, channels: 1 } }).resize(ow, oh, { fit: 'fill', kernel: 'cubic' }).extractChannel(0).raw().toBuffer();
  const rgbO = await sharp(imageFile, { limitInputPixels: false }).rotate().removeAlpha().resize(ow, oh, { fit: 'fill' }).raw().toBuffer();
  if (dUp.length !== N2 || rgbO.length !== N2 * 3) throw new Error('Mapa de profundidade com tamanho inesperado.');
  const I = new Float32Array(N2); const p = new Float32Array(N2);
  for (let i = 0; i < N2; i++) {
    I[i] = (0.299 * rgbO[i * 3] + 0.587 * rgbO[i * 3 + 1] + 0.114 * rgbO[i * 3 + 2]) / 255;
    p[i] = dUp[i] / 255;
  }
  const qRef = guidedFilter(I, p, ow, oh, Math.max(3, Math.round(ow / 320)), 1e-4);

  // --- Two layers: what is in focus (characters) and the background behind it.
  const t = otsu(qRef);
  // Soft matte: a depth cut, then snapped to the picture's own edges so it
  // follows hair strands and line art instead of the blurry depth outline.
  let matte = new Float32Array(N2);
  for (let i = 0; i < N2; i++) matte[i] = smooth(t - 0.05, t + 0.05, qRef[i]);
  matte = guidedFilter(I, matte, ow, oh, Math.max(3, Math.round(ow / 320)), 2e-3);
  // Firm up partial values: thin objects (a sword, fingers) must not end up half
  // in each layer (that shows as a faint double).
  for (let i = 0; i < N2; i++) matte[i] = smooth(0.12, 0.6, matte[i]);

  // Depth the foreground layer moves with (grown a little so its outline travels with it).
  let q = dilate(qRef, ow, oh, Math.max(2, Math.round(ow / 400)));
  q = boxBlur(q, ow, oh, Math.max(1, Math.round(ow / 640)));

  // Hole = where the characters are (grown a few pixels so thin hair strands are
  // included). The background layer samples the source where a character used to
  // be exactly there, so only this area has to be rebuilt; everything around it
  // keeps its real pixels and its real depth.
  const holeBin = new Float32Array(N2);
  let holeCount = 0;
  for (let i = 0; i < N2; i++) if (matte[i] > 0.06) holeBin[i] = 1;
  const grown = dilate(holeBin, ow, oh, Math.max(2, Math.round(ow / 400)));
  for (let i = 0; i < N2; i++) if (grown[i] > 0.5) holeCount++;
  const useLayers = holeCount > N2 * 0.002 && holeCount < N2 * 0.95;

  // Background depth: the hole filled in from the surroundings (no walls left).
  const bgDepth = useLayers ? fillFromOutside(qRef, grown, ow, oh, 1) : Float32Array.from(qRef);
  if (useLayers) for (let i = 0; i < N2; i++) if (grown[i] > 0.5) bgDepth[i] = Math.min(bgDepth[i], t);
  const bgSmooth = boxBlur(bgDepth, ow, oh, Math.max(2, Math.round(ow / 200)));

  // Background plate: the picture with the characters removed.
  let plate = rgbO;
  let plateBy = 'none';
  if (useLayers) {
    const mask = Buffer.alloc(N2);
    for (let i = 0; i < N2; i++) mask[i] = grown[i] > 0.5 ? 255 : 0;
    plate = Buffer.from(rgbO);
    try {
      // LaMa rebuilds texture well when the hole is a modest part of the picture;
      // for characters filling most of the frame it invents dark mush, so those
      // get the smooth fill pulled in from the surroundings instead.
      if (holeCount > N2 * 0.22) throw new Error('personagem grande');
      const lama = require('./lama-core');
      if (!lama.exists()) throw new Error('sem LaMa');
      for (const b of lama.maskBoxes(mask, ow, oh)) await lama.fillRegion(sharp, plate, ow, oh, mask, b, null, 1.6);
      plateBy = 'lama';
    } catch (err) {
      // Fallback: colours pulled in from the edges of the hole.
      if (err.message !== 'personagem grande') log.warn('depth: LaMa indisponível para o fundo, usando preenchimento suave', err.message);
      plate = Buffer.from(rgbO);
      const f = new Float32Array(N2 * 3);
      for (let i = 0; i < N2 * 3; i++) f[i] = rgbO[i] / 255;
      const filled = fillFromOutside(f, grown, ow, oh, 3);
      // Soften the streaks of the ring fill (only inside the hole).
      const r = Math.max(2, Math.round(ow / 256));
      for (let c = 0; c < 3; c++) {
        const plane = new Float32Array(N2);
        for (let i = 0; i < N2; i++) plane[i] = filled[i * 3 + c];
        const bl = boxBlur(plane, ow, oh, r);
        for (let i = 0; i < N2; i++) plate[i * 3 + c] = Math.round(255 * Math.min(1, Math.max(0, grown[i] > 0.5 ? bl[i] : plane[i])));
      }
      plateBy = 'suave';
    }
  }

  // Where the background layer shows the plate: the hole, feathered by a pixel.
  const plateMask = boxBlur(grown, ow, oh, Math.max(1, Math.round(ow / 800)));

  // Packed: R = foreground depth, G = background depth, B = matte, A = plate mask.
  // (Loaded without premultiplication, so the alpha channel is plain data.)
  const outBuf = Buffer.alloc(N2 * 4);
  const u8 = (v) => Math.round(255 * Math.min(1, Math.max(0, v)));
  for (let i = 0; i < N2; i++) {
    outBuf[i * 4] = u8(q[i]);
    outBuf[i * 4 + 1] = u8(bgSmooth[i]);
    outBuf[i * 4 + 2] = u8(useLayers ? matte[i] : 0);
    outBuf[i * 4 + 3] = u8(useLayers ? plateMask[i] : 0);
  }
  await fs.promises.mkdir(path.dirname(outFile), { recursive: true });
  const tmp = outFile + '.tmp.png';
  await sharp(outBuf, { raw: { width: ow, height: oh, channels: 4 } }).png({ compressionLevel: 6 }).toFile(tmp);
  const plateFile = plateFor(outFile);
  const tmpPlate = plateFile + '.tmp.jpg';
  await sharp(plate, { raw: { width: ow, height: oh, channels: 3 } }).jpeg({ quality: 90, chromaSubsampling: '4:4:4' }).toFile(tmpPlate);
  await fs.promises.rename(tmpPlate, plateFile);
  await fs.promises.rename(tmp, outFile); // last: its presence means both files are complete
  return { width: ow, height: oh, provider: sessionProvider, plate: plateBy, split: +t.toFixed(2), ms: Date.now() - t0 };
}

const plateFor = (depthFile) => depthFile.replace(/\.png$/i, '.plate.jpg');

function smooth(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Otsu threshold on a 0..1 map: the depth that best splits near from far. */
function otsu(v) {
  const hist = new Float64Array(256);
  for (let i = 0; i < v.length; i++) hist[Math.min(255, Math.max(0, Math.round(v[i] * 255)))]++;
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0; let wB = 0; let best = 0; let th = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i]; if (!wB) continue;
    const wF = v.length - wB; if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB; const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; th = i; }
  }
  return Math.min(0.85, Math.max(0.25, (th + 0.5) / 255));
}

/**
 * Fills the masked pixels (mask > 0.5) from the unmasked surroundings, ring by
 * ring (normalised box blurs of growing radius). Works on `ch` interleaved channels.
 */
function fillFromOutside(src, mask, W, H, ch) {
  const N = W * H;
  const cur = Float32Array.from(src);
  const known = new Float32Array(N);
  for (let i = 0; i < N; i++) known[i] = mask[i] > 0.5 ? 0 : 1;
  for (const r of [3, 6, 12, 24, 48, 96, 192]) {
    const den = boxBlur(known, W, H, r);
    const nums = [];
    for (let c = 0; c < ch; c++) {
      const plane = new Float32Array(N);
      for (let i = 0; i < N; i++) plane[i] = cur[i * ch + c] * known[i];
      nums.push(boxBlur(plane, W, H, r));
    }
    let left = 0;
    for (let i = 0; i < N; i++) {
      if (known[i]) continue;
      if (den[i] > 0.02) {
        for (let c = 0; c < ch; c++) cur[i * ch + c] = nums[c][i] / den[i];
        known[i] = 1;
      } else left++;
    }
    if (!left) break;
  }
  return cur;
}

module.exports = { estimate, release, modelPath, plateFor, exists: () => fs.existsSync(modelPath()) };
