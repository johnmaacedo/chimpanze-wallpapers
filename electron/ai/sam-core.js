'use strict';
// "Clique mágico" of the cut editor: Segment Anything 2.1 (tiny, ONNX, Apache-2.0).
// A click on something selects the whole thing. The picture is encoded once
// (about a second on the GPU) and kept, so the next clicks on it answer at once.
let ort = null;
let enc = null; let dec = null; let provider = '';
let cache = null; // { file, feats }

const SIZE = 1024;
const MEAN = [0.485, 0.456, 0.406]; const STD = [0.229, 0.224, 0.225];

async function open(file) {
  ort = ort || require('onnxruntime-node');
  // On the processor on purpose: through DirectML this encoder gives wrong masks (tested on the
  // RTX 5070: picture-like noise instead of the object). The CPU takes ~3 s once per picture.
  const providers = process.env.CW_SAM_DML ? [['dml', 'cpu'], ['cpu']] : [['cpu']];
  let last;
  for (const ep of providers) {
    // Graph optimisations off: with them (and several threads) this export returns different,
    // broken numbers on every run (NaN, 1e36) in onnxruntime 1.27. Off, it is stable and correct.
    try { const s = await ort.InferenceSession.create(file, { executionProviders: ep, logSeverityLevel: 3, graphOptimizationLevel: 'disabled' }); provider = ep[0]; return s; } catch (err) { last = err; }
  }
  throw last;
}

async function embed(imageFile) {
  if (cache && cache.file === imageFile) return cache.feats;
  const sharp = require('../img');
  enc = enc || await open(process.env.CW_SAM_ENCODER);
  // SAM 2 stretches the picture to 1024×1024 (no padding).
  const rgb = await sharp(imageFile, { limitInputPixels: false }).rotate().resize(SIZE, SIZE, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const n = SIZE * SIZE; const data = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) data[c * n + i] = (rgb[i * 3 + c] / 255 - MEAN[c]) / STD[c];
  const out = await enc.run({ image: new ort.Tensor('float32', data, [1, 3, SIZE, SIZE]) });
  cache = { file: imageFile, feats: { image_embed: out.image_embed, high_res_feats_0: out.high_res_feats_0, high_res_feats_1: out.high_res_feats_1 } };
  return cache.feats;
}

/**
 * points: [{ x, y (0..1 of the picture), add: true|false }] → { png (grey mask, `side` px on the long side), share, provider }.
 */
async function segment(imageFile, points, side = 768) {
  const sharp = require('../img');
  const feats = await embed(imageFile);
  dec = dec || await open(process.env.CW_SAM_DECODER);
  const n = points.length;
  const coords = new Float32Array(n * 2); const labels = new Float32Array(n);
  points.forEach((p, i) => { coords[i * 2] = p.x * SIZE; coords[i * 2 + 1] = p.y * SIZE; labels[i] = p.add === false ? 0 : 1; });
  const out = await dec.run({
    ...feats,
    point_coords: new ort.Tensor('float32', coords, [1, n, 2]),
    point_labels: new ort.Tensor('float32', labels, [1, n]),
    mask_input: new ort.Tensor('float32', new Float32Array(256 * 256), [1, 1, 256, 256]),
    has_mask_input: new ort.Tensor('float32', new Float32Array([0]), [1]),
  });
  const masks = out.masks; const iou = out.iou_predictions.data;
  const [, count, mh, mw] = masks.dims;
  // With one click the model offers 3 guesses (a part, the object, everything around it). The one
  // it trusts most is often the biggest (half the picture, as tested on John's wallpapers), so take
  // the most trusted guess that is still object-sized; when all are huge, the smallest.
  const plane = mh * mw;
  const share = [];
  for (let k = 0; k < count; k++) { let on = 0; for (let i = 0; i < plane; i++) if (masks.data[k * plane + i] > 0) on++; share.push(on / plane); }
  let best = -1;
  for (let k = 0; k < count; k++) if (share[k] > 0.002 && share[k] < 0.55 && (best < 0 || iou[k] > iou[best])) best = k;
  if (best < 0) { best = 0; for (let k = 1; k < count; k++) if (share[k] < share[best]) best = k; }
  const grey = Buffer.alloc(plane);
  let on = 0;
  for (let i = 0; i < plane; i++) { const v = masks.data[best * plane + i]; const p = 1 / (1 + Math.exp(-v)); grey[i] = Math.round(p * 255); if (p > 0.5) on++; }
  const m = await sharp(imageFile, { limitInputPixels: false }).rotate().metadata();
  const k = side / Math.max(m.width, m.height);
  const png = await sharp(grey, { raw: { width: mw, height: mh, channels: 1 } }).resize(Math.max(8, Math.round(m.width * k)), Math.max(8, Math.round(m.height * k)), { fit: 'fill', kernel: 'cubic' }).png().toBuffer();
  return { png, share: on / plane, score: iou[best], provider };
}

module.exports = { segment };
