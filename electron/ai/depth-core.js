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
let segSession = null;
const SEG_SIZE = 1024;
/** How much of a character's own depth relief is kept (0 = flat card, 1 = raw depth). */
const RELIEF = 0.35;

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

function segModelPath() {
  if (process.env.CW_SEG_MODEL) return process.env.CW_SEG_MODEL;
  const { app } = require('electron');
  return app.isPackaged ? path.join(process.resourcesPath, 'models', 'anime-seg-isnetis.onnx') : path.join(__dirname, '..', '..', 'resources', 'models', 'anime-seg-isnetis.onnx');
}

/** Anime character segmentation (SkyTNT anime-segmentation, ISNet, Apache-2.0). */
async function getSegSession() {
  if (segSession) return segSession;
  if (!fs.existsSync(segModelPath())) return null;
  ort = ort || require('onnxruntime-node');
  const providers = process.platform === 'win32' && !process.env.CW_DEPTH_CPU ? [['dml', 'cpu'], ['cpu']] : [['cpu']];
  for (const ep of providers) {
    try {
      segSession = await ort.InferenceSession.create(segModelPath(), { executionProviders: ep, logSeverityLevel: 3, graphOptimizationLevel: 'all' });
      log.info('depth: recorte de anime pronto com', ep[0]);
      return segSession;
    } catch (err) { log.warn('depth: recorte de anime, provider falhou', ep[0], err.message); }
  }
  return null;
}

/**
 * Soft mask (0..1, ow×oh) of the characters, or null without the model. The
 * picture is fitted into 1024×1024 (padded), as the model was trained.
 */
async function segment(sharp, imageFile, ow, oh) {
  const ss = await getSegSession();
  if (!ss) return null;
  const S = SEG_SIZE;
  const k = S / Math.max(ow, oh);
  const w = Math.max(1, Math.round(ow * k)); const h = Math.max(1, Math.round(oh * k));
  const px = Math.floor((S - w) / 2); const py = Math.floor((S - h) / 2);
  const rgb = await sharp(imageFile, { limitInputPixels: false }).rotate().removeAlpha().resize(w, h, { fit: 'fill' }).raw().toBuffer();
  const x = new Float32Array(3 * S * S);
  for (let y = 0; y < h; y++) {
    for (let xx = 0; xx < w; xx++) {
      const si = (y * w + xx) * 3; const di = (y + py) * S + xx + px;
      x[di] = rgb[si] / 255; x[S * S + di] = rgb[si + 1] / 255; x[2 * S * S + di] = rgb[si + 2] / 255;
    }
  }
  const out = await ss.run({ [ss.inputNames[0]]: new ort.Tensor('float32', x, [1, 3, S, S]) });
  const md = out[ss.outputNames[0]].data;
  const crop = Buffer.alloc(w * h);
  for (let y = 0; y < h; y++) for (let xx = 0; xx < w; xx++) crop[y * w + xx] = Math.round(255 * Math.min(1, Math.max(0, md[(y + py) * S + xx + px])));
  const up = await sharp(crop, { raw: { width: w, height: h, channels: 1 } }).resize(ow, oh, { fit: 'fill', kernel: 'cubic' }).extractChannel(0).raw().toBuffer();
  const m = new Float32Array(ow * oh);
  for (let i = 0; i < ow * oh; i++) m[i] = up[i] / 255;
  return m;
}

async function release() {
  clearTimeout(idleTimer);
  if (segSession) { try { await segSession.release(); } catch (_) { /* ignore */ } segSession = null; }
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
  // 1st choice: the anime character segmentation (follows hair strands, holds
  // groups of characters together). Fallback: a cut of the depth map, snapped
  // to the picture's own edges.
  let matte = null;
  let cut = 'profundidade';
  let seg = null;
  try { seg = await segment(sharp, imageFile, ow, oh); } catch (err) { log.warn('depth: recorte de anime falhou', err.message); }
  if (seg) {
    let cover = 0;
    for (let i = 0; i < N2; i++) if (seg[i] > 0.5) cover++;
    if (cover > N2 * 0.005 && cover < N2 * 0.92) {
      matte = seg;
      for (let i = 0; i < N2; i++) matte[i] = smooth(0.04, 0.96, matte[i]);
      cut = 'anime';
    }
  }
  // No character found: a scene whose near part runs along the whole bottom
  // (ground, hills, water) is a landscape and moves as one soft sheet. A compact
  // near shape (e.g. realistic 3D characters the anime model doesn't know) still
  // gets cut out by depth.
  if (!matte && seg && looksLikeGround(qRef, t, ow, oh)) {
    matte = new Float32Array(N2);
    cut = 'paisagem';
  }
  if (!matte) {
    matte = new Float32Array(N2);
    for (let i = 0; i < N2; i++) matte[i] = smooth(t - 0.05, t + 0.05, qRef[i]);
    matte = guidedFilter(I, matte, ow, oh, Math.max(3, Math.round(ow / 320)), 2e-3);
    // Firm up partial values: thin objects (a sword, fingers) must not end up half
    // in each layer (that shows as a faint double).
    for (let i = 0; i < N2; i++) matte[i] = smooth(0.12, 0.6, matte[i]);
  }

  // Hole = where the characters are (grown a few pixels so thin hair strands are
  // included). The background layer samples the source where a character used to
  // be exactly there, so only this area has to be rebuilt; everything around it
  // keeps its real pixels and its real depth.
  const holeBin = new Float32Array(N2);
  let holeCount = 0;
  for (let i = 0; i < N2; i++) if (matte[i] > (cut === 'anime' ? 0.02 : 0.06)) holeBin[i] = 1;
  const grown = dilate(holeBin, ow, oh, Math.max(3, Math.round(ow / 320)));
  for (let i = 0; i < N2; i++) if (grown[i] > 0.5) holeCount++;
  const useLayers = cut !== 'paisagem' && holeCount > N2 * 0.002 && holeCount < N2 * 0.95;

  // Background depth: the hole filled in from the surroundings (no walls left).
  const bgDepth = useLayers ? fillFromOutside(qRef, grown, ow, oh, 1) : Float32Array.from(qRef);
  if (useLayers) for (let i = 0; i < N2; i++) if (grown[i] > 0.5) bgDepth[i] = Math.min(bgDepth[i], t);
  // A gentle background: fine depth noise would bend straight lines (windows,
  // horizons) as the camera moves, so the background warps like a soft sheet.
  const bgSmooth = boxBlur(boxBlur(bgDepth, ow, oh, Math.max(3, Math.round(ow / 120))), ow, oh, Math.max(3, Math.round(ow / 120)));

  // Depth the foreground layer moves with. Inside a character the relief is
  // flattened toward its average depth (hair and face at different depths would
  // tear apart); every character stays in front of what is right behind it.
  let q;
  if (useLayers) {
    const R = Math.max(8, Math.round(ow / 30));
    const wq = new Float32Array(N2);
    for (let i = 0; i < N2; i++) wq[i] = qRef[i] * matte[i];
    const num = boxBlur(wq, ow, oh, R); const den = boxBlur(matte, ow, oh, R);
    q = new Float32Array(N2);
    for (let i = 0; i < N2; i++) {
      const avg = den[i] > 1e-3 ? num[i] / den[i] : qRef[i];
      const fgd = Math.max(avg + (qRef[i] - avg) * RELIEF, bgSmooth[i] + 0.08);
      q[i] = matte[i] > 0.02 ? fgd : bgSmooth[i];
    }
    q = boxBlur(q, ow, oh, Math.max(2, Math.round(ow / 320)));
  } else {
    q = Float32Array.from(bgSmooth);
  }
  q = dilate(q, ow, oh, Math.max(2, Math.round(ow / 400)));

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
  const analysis = analyse({ rgbO, I, matte, q, bgSmooth, ow, oh, useLayers, cut, plateBy });
  await fs.promises.writeFile(outFile.replace(/\.png$/i, '.json'), JSON.stringify(analysis));
  await fs.promises.rename(tmp, outFile); // last: its presence means all files are complete
  return {
    analysis, width: ow, height: oh, provider: sessionProvider, plate: plateBy, cut: useLayers ? cut : 'nenhum', split: +t.toFixed(2), ms: Date.now() - t0 };
}

const plateFor = (depthFile) => depthFile.replace(/\.png$/i, '.plate.jpg');

/**
 * Looks at the picture to pick depth settings that will not break it:
 * - kind: anime / real (photo-like) / landscape (no characters found);
 * - gap: how far in front of the background the characters stand (in depth);
 * - busy: how detailed the background right behind the characters is (a detailed
 *   background makes the rebuilt strip behind them easier to notice);
 * - hair: how much fine, semi-transparent outline (loose hair) there is;
 * - cover / count: how much of the frame the characters fill, and how many.
 * From those comes "band": the widest strip (in pixels at 1920 wide) the camera
 * may uncover behind a character, plus a suggested camera style, focus, blur.
 */
function analyse({ rgbO, I, matte, q, bgSmooth, ow, oh, useLayers, cut, plateBy }) {
  const N = ow * oh;
  // Anime vs photo: flat areas and a short palette (same idea as the upscaler).
  let flat = 0; let total = 0; const colors = new Set();
  const st = Math.max(1, Math.round(ow / 320));
  for (let y = st; y < oh - st; y += st) {
    for (let x = st; x < ow - st; x += st) {
      const i = (y * ow + x) * 3; const r = i + 3 * st; const d = i + 3 * st * ow;
      let g = 0;
      for (let k = 0; k < 3; k++) g += Math.abs(rgbO[i + k] - rgbO[r + k]) + Math.abs(rgbO[i + k] - rgbO[d + k]);
      if (g < 9) flat++;
      total++;
      colors.add(((rgbO[i] >> 3) << 10) | ((rgbO[i + 1] >> 3) << 5) | (rgbO[i + 2] >> 3));
    }
  }
  const flatRatio = flat / Math.max(1, total);
  const colorRatio = colors.size / Math.max(1, total);
  const animeScore = Math.min(1, flatRatio / 0.45) * 0.7 + (colorRatio < 0.12 ? 0.3 : colorRatio < 0.22 ? 0.15 : 0);

  let cover = 0;
  for (let i = 0; i < N; i++) if (matte[i] > 0.5) cover++;
  cover /= N;
  const hasChars = useLayers && cover > 0.005;
  // Photo grain: real photos keep fine noise in their smooth areas, drawings don't.
  const lap = [];
  for (let y = 2; y < oh - 2; y += 2) {
    for (let x = 2; x < ow - 2; x += 2) {
      const i = y * ow + x;
      const gx = Math.abs(I[i + 1] - I[i - 1]) * 255; const gy = Math.abs(I[i + ow] - I[i - ow]) * 255;
      if (gx + gy < 6) lap.push(Math.abs(4 * I[i] - I[i + 1] - I[i - 1] - I[i + ow] - I[i - ow]) * 255);
    }
  }
  lap.sort((a, b) => a - b);
  const grain = lap.length ? lap[Math.floor(lap.length * 0.75)] : 0;
  const kind = !hasChars ? 'landscape'
    : cut === 'anime' ? (grain >= 5 && animeScore < 0.6 ? 'real' : 'anime')
      : 'real';

  // Characters: connected blobs on a coarse grid.
  let count = 0;
  if (hasChars) {
    const G = Math.max(4, Math.round(ow / 160)); const gw = Math.ceil(ow / G); const gh = Math.ceil(oh / G);
    const cell = new Uint8Array(gw * gh);
    for (let y = 0; y < oh; y += 2) for (let x = 0; x < ow; x += 2) if (matte[y * ow + x] > 0.5) cell[((y / G) | 0) * gw + ((x / G) | 0)] = 1;
    const seen = new Uint8Array(gw * gh);
    for (let i = 0; i < cell.length; i++) {
      if (!cell[i] || seen[i]) continue;
      let area = 0; const stack = [i]; seen[i] = 1;
      while (stack.length) {
        const k = stack.pop(); area++;
        const cx = k % gw; const cy = (k / gw) | 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx; const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
          const n = ny * gw + nx;
          if (cell[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
        }
      }
      if (area > gw * gh * 0.004) count++;
    }
  }

  // Ring just outside the characters: background detail and the depth gap.
  let busy = 0; let gap = 0.25; let hair = 0;
  if (!hasChars) {
    // Landscape: the depth range of the soft sheet sets how far it may move.
    const v = [];
    for (let i = 0; i < N; i += 7) v.push(bgSmooth[i]);
    v.sort((a, b) => a - b);
    gap = Math.max(0.08, v[Math.floor(v.length * 0.95)] - v[Math.floor(v.length * 0.05)]);
  }
  if (hasChars) {
    const bin = new Float32Array(N);
    for (let i = 0; i < N; i++) bin[i] = matte[i] > 0.5 ? 1 : 0;
    const ring = dilate(bin, ow, oh, Math.max(6, Math.round(ow / 40)));
    let gsum = 0; let gn = 0; const bgv = []; const fgv = [];
    for (let y = 1; y < oh - 1; y += 2) {
      for (let x = 1; x < ow - 1; x += 2) {
        const i = y * ow + x;
        if (ring[i] > 0.5 && matte[i] < 0.1) {
          gsum += Math.abs(I[i + 1] - I[i - 1]) + Math.abs(I[i + ow] - I[i - ow]);
          gn++;
          bgv.push(bgSmooth[i]);
        } else if (matte[i] > 0.9) fgv.push(q[i]);
      }
    }
    busy = Math.min(1, (gsum / Math.max(1, gn)) / 0.09);
    const med = (a) => { if (!a.length) return 0; a.sort((m, n) => m - n); return a[a.length >> 1]; };
    gap = Math.max(0.06, med(fgv) - med(bgv));
    let soft = 0; let solid = 0;
    for (let i = 0; i < N; i += 2) { if (matte[i] > 0.12 && matte[i] < 0.88) soft++; else if (matte[i] >= 0.88) solid++; }
    hair = Math.min(1, (soft / Math.max(1, solid)) / 0.1);
  }

  // Widest uncovered strip, in px at 1920 wide (what still looks clean).
  let band;
  if (kind === 'landscape') band = 26;
  else {
    band = kind === 'anime' ? 30 : 22;
    band *= 1 - 0.45 * busy;          // detailed background: keep the strip thin
    band *= 1 - 0.3 * hair;           // loose hair: same
    if (cover > 0.45) band *= 0.8;    // characters filling the frame: big rebuilt area
    if (plateBy === 'lama') band *= 1.15;
    band = Math.max(9, band);
  }
  const style = kind === 'landscape' ? 'travel' : count > 2 ? 'float' : 'orbit';
  return {
    v: 1,
    kind,
    count,
    cover: +cover.toFixed(3),
    gap: +gap.toFixed(3),
    busy: +busy.toFixed(2),
    hair: +hair.toFixed(2),
    anime: +animeScore.toFixed(2),
    grain: +grain.toFixed(1),
    band: Math.round(band),
    style,
    // Characters held almost still (faces never wobble), the scene moves around them.
    focus: kind === 'landscape' ? 0.3 : 0.62,
    dolly: kind === 'landscape' ? 1.2 : kind === 'anime' ? 0.55 : 0.4,
    blur: kind === 'landscape' ? 0 : +(0.12 + 0.25 * busy).toFixed(2),
  };
}

/** True when the near part of the depth spans the bottom of the frame (a ground plane). */
function looksLikeGround(d, t, W, H) {
  let bottom = 0; let n = 0;
  for (let y = Math.floor(H * 0.88); y < H; y += 2) {
    for (let x = 0; x < W; x += 4) { n++; if (d[y * W + x] > t) bottom++; }
  }
  // Width covered by near pixels across the lower third.
  let minX = W; let maxX = 0;
  for (let y = Math.floor(H * 0.66); y < H; y += 4) {
    for (let x = 0; x < W; x += 4) if (d[y * W + x] > t) { if (x < minX) minX = x; if (x > maxX) maxX = x; }
  }
  return bottom / Math.max(1, n) > 0.6 && (maxX - minX) / W > 0.85;
}

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
