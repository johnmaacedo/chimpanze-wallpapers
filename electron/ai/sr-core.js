'use strict';
// Super-resolution with the newer upscale models (ONNX), on the GPU through
// DirectML: AnimeSharp V4 (2x, anime) and UltraSharp V2 (4x, everything).
// The picture is processed in tiles with a margin of real context around each
// one; only the middle of each result is kept, so no seams show.
const path = require('path');

let ort = null;

/** float32 → IEEE half (as uint16), for the fp16 models. */
const f32 = new Float32Array(1); const u32 = new Uint32Array(f32.buffer);
function toHalf(v) {
  f32[0] = v;
  const x = u32[0];
  const sign = (x >> 16) & 0x8000; let exp = ((x >> 23) & 0xff) - 112; let man = x & 0x7fffff;
  if (exp <= 0) return sign; // values here are 0..1: tiny ones become 0
  if (exp >= 31) return sign | 0x7c00;
  return sign | (exp << 10) | (man >> 13);
}
function fromHalf(h) {
  const s = (h & 0x8000) ? -1 : 1; const e = (h >> 10) & 0x1f; const m = h & 0x3ff;
  if (e === 0) return s * m * 5.960464477539063e-8;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * Math.pow(2, e - 15);
}

async function open(modelFile, forceCpu) {
  // onnxruntime-node 1.27 cannot read a native Float16Array ("not enough space: got 0"), but its
  // wrapper switches to one when the runtime has it. Hide it before the library loads, so half
  // floats travel as plain uint16. This file runs in a process of its own (sr-worker), so nothing else is affected.
  if (!ort && typeof Float16Array !== 'undefined') globalThis.Float16Array = undefined;
  ort = ort || require('onnxruntime-node');
  const providers = process.platform === 'win32' && !forceCpu ? [['dml', 'cpu'], ['cpu']] : [['cpu']];
  let last;
  for (const ep of providers) {
    try {
      const session = await ort.InferenceSession.create(modelFile, { executionProviders: ep, logSeverityLevel: 3, graphOptimizationLevel: ep[0] === 'cpu' ? 'basic' : 'all' });
      return { session, provider: ep[0] };
    } catch (err) { last = err; }
  }
  throw last || new Error('Não foi possível iniciar o modelo de upscale.');
}

/**
 * rgb (Buffer, w×h×3) → { data: Buffer (w·s × h·s × 3), width, height, provider }.
 * opts: { model (file), scale (2 | 4), tile (px), onProgress(0..1), canceled() }
 */
async function upscale(rgb, w, h, opts) {
  const scale = opts.scale;
  const { session, provider } = await open(opts.model, opts.cpu);
  const meta = session.inputMetadata && session.inputMetadata[0];
  const half = !!(meta && meta.type === 'float16');
  const name = session.inputNames[0]; const outName = session.outputNames[0];
  const pad = 16;
  const tile = Math.max(64, opts.tile || 256);
  const W = w * scale, H = h * scale;
  const out = Buffer.alloc(W * H * 3);
  const xs = []; for (let x = 0; x < w; x += tile) xs.push(x);
  const ys = []; for (let y = 0; y < h; y += tile) ys.push(y);
  let done = 0; const total = xs.length * ys.length;
  try {
    for (const ty of ys) for (const tx of xs) {
      if (opts.canceled && opts.canceled()) { const e = new Error('Cancelado'); e.canceled = true; throw e; }
      // Core of this tile, and the same with context around it (clamped to the picture).
      const cw = Math.min(tile, w - tx), ch = Math.min(tile, h - ty);
      const x0 = Math.max(0, tx - pad), y0 = Math.max(0, ty - pad);
      const x1 = Math.min(w, tx + cw + pad), y1 = Math.min(h, ty + ch + pad);
      const iw = x1 - x0, ih = y1 - y0, n = iw * ih;
      const raw16 = half;
      const src = half ? new Uint16Array(3 * n) : new Float32Array(3 * n);
      for (let y = 0; y < ih; y++) {
        let s = ((y + y0) * w + x0) * 3;
        for (let x = 0; x < iw; x++, s += 3) {
          const i = y * iw + x;
          if (raw16) { src[i] = toHalf(rgb[s] / 255); src[n + i] = toHalf(rgb[s + 1] / 255); src[2 * n + i] = toHalf(rgb[s + 2] / 255); }
          else { src[i] = rgb[s] / 255; src[n + i] = rgb[s + 1] / 255; src[2 * n + i] = rgb[s + 2] / 255; }
        }
      }
      const res = await session.run({ [name]: new ort.Tensor(half ? 'float16' : 'float32', src, [1, 3, ih, iw]) });
      const o = res[outName]; const od = o.data; const ow = o.dims[3], oh = o.dims[2]; const on = ow * oh;
      const isHalf = o.type === 'float16' && od instanceof Uint16Array;
      // Keep only the tile's own area.
      const ox = (tx - x0) * scale, oy = (ty - y0) * scale;
      for (let y = 0; y < ch * scale; y++) {
        let d = ((ty * scale + y) * W + tx * scale) * 3;
        const row = (oy + y) * ow + ox;
        for (let x = 0; x < cw * scale; x++, d += 3) {
          const i = row + x;
          for (let c = 0; c < 3; c++) {
            let v = od[c * on + i];
            if (isHalf) v = fromHalf(v);
            v = v * 255 + 0.5;
            out[d + c] = v < 0 ? 0 : v > 255 ? 255 : v;
          }
        }
      }
      done++;
      if (opts.onProgress) opts.onProgress(done / total);
    }
  } finally {
    try { await session.release(); } catch (_) { /* ignore */ }
  }
  return { data: out, width: W, height: H, provider };
}

/** file → PNG file. Returns { width, height, provider, ms }. */
async function upscaleFile(inFile, outFile, opts) {
  const sharp = require('../img');
  const t0 = Date.now();
  const { data, info } = await sharp(inFile, { limitInputPixels: false }).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const r = await upscale(data, info.width, info.height, opts);
  await sharp(r.data, { raw: { width: r.width, height: r.height, channels: 3 }, limitInputPixels: false }).png({ compressionLevel: 1 }).toFile(outFile);
  return { width: r.width, height: r.height, provider: r.provider, ms: Date.now() - t0 };
}

module.exports = { upscale, upscaleFile, _test: { toHalf, fromHalf }, modelDir: () => path.join(__dirname, '..', '..', 'resources', 'models') };
