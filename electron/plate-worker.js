'use strict';
// The picture with its people taken out (worker thread), for the local AI expansion: FLUX Fill
// copies whoever it sees into the new areas (a second woman in the background, or a collage of
// the same person), so it only gets the empty scene. The app puts the untouched original back
// afterwards (merge-core.js), so the plate's middle never shows.
// People: the app's character segmentation (anime-seg, also fine on 3D renders), grown a little.
// Filled by LaMa when they are a modest part of the picture, else by the smooth fill pulled in
// from the surroundings (LaMa invents dark mush in very large holes) — the same rules as the
// background plate of the 3D parallax (depth-core.js).
const { parentPort, workerData } = require('worker_threads');
const sharp = require('./img');
const core = require('./ai/depth-core');

const MAX_SIDE = 1600;

async function run({ image, out }) {
  const m = await sharp(image, { limitInputPixels: false }).rotate().metadata();
  const swap = (m.orientation || 1) >= 5;
  const W0 = swap ? m.height : m.width, H0 = swap ? m.width : m.height;
  const k = Math.min(1, MAX_SIDE / Math.max(W0, H0));
  const w = Math.round(W0 * k), h = Math.round(H0 * k), N = w * h;
  const rgb = await sharp(image, { limitInputPixels: false }).rotate().resize(w, h, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const matte = await core.segment(sharp, image, w, h);
  if (!matte) return { file: image, people: 0, by: 'sem recorte' };
  const hole = new Float32Array(N);
  let people = 0;
  for (let i = 0; i < N; i++) if (matte[i] > 0.35) { hole[i] = 1; people++; }
  if (people < N * 0.005) return { file: image, people: people / N, by: 'ninguém' };
  // Grown, so hair strands and soft edges go too.
  const grown = core.dilate(hole, w, h, Math.max(3, Math.round(Math.max(w, h) / 90)));
  let holeCount = 0;
  for (let i = 0; i < N; i++) if (grown[i] > 0.5) holeCount++;
  let plate = Buffer.from(rgb);
  let by = 'suave';
  if (holeCount <= N * 0.22) {
    try {
      const lama = require('./ai/lama-core');
      if (!lama.exists()) throw new Error('sem LaMa');
      const mask = Buffer.alloc(N);
      for (let i = 0; i < N; i++) mask[i] = grown[i] > 0.5 ? 255 : 0;
      for (const b of lama.maskBoxes(mask, w, h)) await lama.fillRegion(sharp, plate, w, h, mask, b, null, 1.6);
      by = 'lama';
    } catch (_) { plate = Buffer.from(rgb); }
  }
  if (by === 'suave') {
    const f = new Float32Array(N * 3);
    for (let i = 0; i < N * 3; i++) f[i] = rgb[i] / 255;
    const filled = core.fillFromOutside(f, grown, w, h, 3);
    const r = Math.max(2, Math.round(w / 200));
    for (let c = 0; c < 3; c++) {
      const plane = new Float32Array(N);
      for (let i = 0; i < N; i++) plane[i] = filled[i * 3 + c];
      const bl = core.boxBlur(plane, w, h, r);
      for (let i = 0; i < N; i++) plate[i * 3 + c] = Math.round(255 * Math.min(1, Math.max(0, grown[i] > 0.5 ? bl[i] : plane[i])));
    }
  }
  await sharp(plate, { raw: { width: w, height: h, channels: 3 } }).png({ compressionLevel: 3 }).toFile(out);
  // Where the people were: the AI also repaints those parts near the picture's edges, so it
  // does not carry the smooth fill (a smudge) out into the new areas.
  const holeFile = out.replace(/\.png$/i, '-hole.png');
  const hm = Buffer.alloc(N);
  for (let i = 0; i < N; i++) hm[i] = grown[i] > 0.5 ? 255 : 0;
  await sharp(hm, { raw: { width: w, height: h, channels: 1 } }).png().toFile(holeFile);
  return { file: out, holeFile, people: +(people / N).toFixed(3), hole: +(holeCount / N).toFixed(3), by };
}

run(workerData).then((r) => parentPort.postMessage({ ok: true, r }), (e) => parentPort.postMessage({ ok: false, error: e && e.message ? e.message : String(e) }));
