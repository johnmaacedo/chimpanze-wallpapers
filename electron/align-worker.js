'use strict';
// "Encaixe automático" of the Editor: finds where a picture (the original) sits inside
// another (e.g. a ChatGPT expansion of it): scale, position and a small vertical stretch,
// plus the colour change between them. Normalised cross-correlation of the grey levels,
// coarse to fine; the last passes only look where both pictures agree (the part painted
// over before expanding, and what ChatGPT redrew, are left out). Runs in a worker thread.
const { parentPort, workerData } = require('worker_threads');
const sharp = require('./img');

const MAXL = 2400; // working size cap (long side) for both pictures
/** Colour of the "Pintar" brush (src/ui/editor/composite.ts PAINT_RGB). */
const PAINT_RGB = [10, 100, 255];

/** A pixel that looks like the "Pintar" paint (also after ChatGPT re-shaded it a little). */
function isPaint(r, g, b) {
  return Math.abs(r - PAINT_RGB[0]) + Math.abs(g - PAINT_RGB[1]) + Math.abs(b - PAINT_RGB[2]) < 120;
}

/** `ignorePaint`: painted pixels get NaN grey levels, which every comparison below skips. */
async function load(file, ignorePaint = false) {
  const meta = await sharp(file, { limitInputPixels: false }).rotate().metadata();
  const swap = (meta.orientation || 1) >= 5;
  const W0 = swap ? meta.height : meta.width, H0 = swap ? meta.width : meta.height;
  const k = Math.min(1, MAXL / Math.max(W0, H0));
  const w = Math.round(W0 * k), h = Math.round(H0 * k);
  const rgb = await sharp(file, { limitInputPixels: false }).rotate().resize(w, h, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const g = new Float32Array(w * h);
  for (let i = 0; i < g.length; i++) {
    g[i] = ignorePaint && isPaint(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]) ? NaN : 0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2];
  }
  return { W0, H0, k, w, h, g, rgb };
}

/** Box-filtered half size (anti-aliased pyramid level). */
function half(I) {
  const w = I.w >> 1, h = I.h >> 1, g = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = 2 * y * I.w + 2 * x;
    g[y * w + x] = (I.g[i] + I.g[i + 1] + I.g[i + I.w] + I.g[i + I.w + 1]) / 4;
  }
  return { w, h, g };
}
function pyramid(I) { const p = [{ w: I.w, h: I.h, g: I.g }]; while (p[p.length - 1].w > 48) p.push(half(p[p.length - 1])); return p; }

/** Bilinear resample of a pyramid to w×h (from the level just above that size). */
function sample(P, w, h, mask) {
  let L = P[0], scale = 1;
  for (let i = P.length - 1; i >= 0; i--) if (P[i].w >= w) { L = P[i]; scale = P[0].w / P[i].w; break; }
  const g = new Float32Array(w * h); const m = mask ? new Uint8Array(w * h) : null;
  const sx = L.w / w, sy = L.h / h;
  for (let y = 0; y < h; y++) {
    const fy = Math.min(L.h - 1.001, Math.max(0, (y + 0.5) * sy - 0.5)); const y0 = fy | 0, ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(L.w - 1.001, Math.max(0, (x + 0.5) * sx - 0.5)); const x0 = fx | 0, tx = fx - x0;
      const i = y0 * L.w + x0;
      g[y * w + x] = (L.g[i] * (1 - tx) + L.g[i + 1] * tx) * (1 - ty) + (L.g[i + L.w] * (1 - tx) + L.g[i + L.w + 1] * tx) * ty;
      if (m) { const mx = Math.round(((x + 0.5) * sx) * scale), my = Math.round(((y + 0.5) * sy) * scale); m[y * w + x] = mask.m[Math.min(mask.h - 1, my) * mask.w + Math.min(mask.w - 1, mx)]; }
    }
  }
  return { w, h, g, m };
}

/** NCC of template T at (ox, oy) in I over the overlap (and T.m, when given). */
function ncc(T, I, ox, oy, step) {
  let n = 0, tot = 0, st = 0, si = 0, stt = 0, sii = 0, sti = 0;
  const y0 = Math.max(0, -oy), y1 = Math.min(T.h, I.h - oy), x0 = Math.max(0, -ox), x1 = Math.min(T.w, I.w - ox);
  for (let y = y0; y < y1; y += step) {
    const tr = y * T.w, ir = (y + oy) * I.w + ox;
    for (let x = x0; x < x1; x += step) {
      if (T.m && !T.m[tr + x]) continue;
      tot++;
      const t = T.g[tr + x], v = I.g[ir + x];
      if (v !== v || t !== t) continue; // paint (NaN) is left out
      n++; st += t; si += v; stt += t * t; sii += v * v; sti += t * v;
    }
  }
  // Enough overlap (paint included), and enough of it actually compared (paint can hide most of a person).
  if (tot < (T.m ? 150 : (T.w * T.h * 0.2) / (step * step)) || n < Math.max(40, tot * 0.2)) return -1;
  const ct = stt - (st * st) / n, ci = sii - (si * si) / n, c = sti - (st * si) / n;
  return c / Math.sqrt(Math.max(1e-6, ct * ci));
}

async function run({ base, layer, ignorePaint = false }) {
  const B = await load(base, ignorePaint), L = await load(layer, ignorePaint);
  const PB = pyramid(B), PL = pyramid(L);
  // Scale s maps layer working pixels to base working pixels.
  const fit = Math.min(B.w / L.w, B.h / L.h), cover = Math.max(B.w / L.w, B.h / L.h);
  const levelOf = (f) => sample(PB, Math.round(B.w * f), Math.round(B.h * f));
  // 1) Coarse: base ~120 px wide, every scale from 30% of "fit" to 120% of "cover".
  let f = Math.min(1, 120 / B.w); let BI = levelOf(f);
  let best = { s: fit, k: 1, x: 0, y: 0, v: -2 };
  for (let s = fit * 0.3; s <= cover * 1.2; s *= 1.025) {
    const tw = Math.round(L.w * s * f), th = Math.round(L.h * s * f);
    if (tw < 8 || th < 8) continue;
    const T = sample(PL, tw, th);
    for (let oy = -Math.round(th * 0.45); oy <= BI.h - th * 0.55; oy++) for (let ox = -Math.round(tw * 0.45); ox <= BI.w - tw * 0.55; ox++) {
      const v = ncc(T, BI, ox, oy, 1);
      if (v > best.v) best = { s, k: 1, x: ox / f, y: oy / f, v };
    }
  }
  // 2) Refinement passes at growing sizes. `mask` (in layer space) keeps only agreeing pixels.
  let mask = null;
  const pass = (fNew, sR, sN, kR, kN, pos, step) => {
    f = fNew; BI = levelOf(f);
    let b = { ...best, v: -2 };
    for (let i = -sN; i <= sN; i++) for (let j = -kN; j <= kN; j++) {
      const s = best.s * (1 + (sR * i) / Math.max(1, sN)), k = best.k * (1 + (kR * j) / Math.max(1, kN));
      const tw = Math.round(L.w * s * f), th = Math.round(L.h * s * k * f);
      const T = sample(PL, tw, th, mask);
      // Keep the centre where it was while the size changes.
      const cx = Math.round((best.x + (L.w * best.s) / 2) * f - tw / 2), cy = Math.round((best.y + (L.h * best.s * best.k) / 2) * f - th / 2);
      for (let oy = cy - pos; oy <= cy + pos; oy++) for (let ox = cx - pos; ox <= cx + pos; ox++) {
        const v = ncc(T, BI, ox, oy, step);
        if (v > b.v) b = { s, k, x: ox / f, y: oy / f, v };
      }
    }
    best = b;
  };
  pass(Math.min(1, 320 / B.w), 0.04, 8, 0, 0, 3, 1);
  pass(Math.min(1, 800 / B.w), 0.008, 6, 0, 0, 3, 1);
  // Where do the pictures agree? (colour-tolerant: normalised grey difference)
  mask = agreement(B, L, best);
  pass(Math.min(1, 800 / B.w), 0.006, 4, 0.008, 2, 4, 1);
  mask = agreement(B, L, best);
  pass(Math.min(1, 1600 / B.w), 0.0015, 3, 0.002, 2, 2, 2);
  pass(1, 0.0006, 2, 0.001, 1, 1, 2);
  // Back to the pictures' real sizes.
  const sReal = best.s * (L.k / B.k);
  const pw = L.W0 * sReal, ph = L.H0 * sReal * best.k;
  const x = best.x / B.k, y = best.y / B.k;
  const color = matchColors(B, L, best, mask);
  return {
    score: best.v,
    w: pw / B.W0, sy: best.k, cx: (x + pw / 2) / B.W0, cy: (y + ph / 2) / B.H0,
    px: { x: Math.round(x), y: Math.round(y), w: Math.round(pw), h: Math.round(ph) },
    agree: mask ? +(mask.m.reduce((a, v) => a + v, 0) / mask.m.length).toFixed(3) : 1,
    color,
  };
}

/** Pixel pairs (layer working px → base working px) for the current placement, at step `st`. */
function* pairs(B, L, p, st) {
  for (let y = 0; y < L.h; y += st) {
    const by = Math.round(p.y + (y + 0.5) * p.s * p.k - 0.5); if (by < 0 || by >= B.h) continue;
    for (let x = 0; x < L.w; x += st) {
      const bx = Math.round(p.x + (x + 0.5) * p.s - 0.5); if (bx < 0 || bx >= B.w) continue;
      yield [y * L.w + x, by * B.w + bx, x, y];
    }
  }
}

/** Layer-space mask of pixels whose (locally normalised) grey level matches the base. */
function agreement(B, L, p) {
  const st = Math.max(1, Math.round(L.w / 600));
  const w = Math.ceil(L.w / st), h = Math.ceil(L.h / st);
  const d = new Float32Array(w * h).fill(255);
  // Global gain/offset first (colours shift), then per-pixel difference.
  let n = 0, sa = 0, sb = 0, saa = 0, sab = 0;
  for (const [li, bi] of pairs(B, L, p, st)) { const a = L.g[li], b = B.g[bi]; if (a !== a || b !== b) continue; n++; sa += a; sb += b; saa += a * a; sab += a * b; }
  const g = n > 10 ? (sab - (sa * sb) / n) / Math.max(1, saa - (sa * sa) / n) : 1, o = n > 10 ? (sb - g * sa) / n : 0;
  for (const [li, bi, x, y] of pairs(B, L, p, st)) {
    const v = Math.abs(g * L.g[li] + o - B.g[bi]);
    if (v === v) d[Math.floor(y / st) * w + Math.floor(x / st)] = v; // paint stays "disagrees"
  }
  // Smooth the difference (3×3) and keep the agreeing part.
  const m = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    let s = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += d[(y + dy) * w + x + dx];
    m[y * w + x] = s / 9 < 22 ? 1 : 0;
  }
  // If too little agrees, the mask would mislead: use everything.
  const share = m.reduce((a, v) => a + v, 0) / m.length;
  if (share < 0.25) m.fill(1);
  return { w, h, m };
}

/**
 * Colours of the placed picture matched to the other one (ChatGPT shifts them a little):
 * per channel out = gain·in + offset, fitted where both pictures show the same thing.
 */
function matchColors(B, L, p, mask) {
  const st = Math.max(1, Math.round(L.w / 500));
  const list = [];
  for (const [li, bi, x, y] of pairs(B, L, p, st)) {
    if (mask && !mask.m[Math.min(mask.h - 1, Math.floor((y / L.h) * mask.h)) * mask.w + Math.min(mask.w - 1, Math.floor((x / L.w) * mask.w))]) continue;
    if (L.g[li] !== L.g[li] || B.g[bi] !== B.g[bi]) continue;
    list.push([L.rgb[li * 3], L.rgb[li * 3 + 1], L.rgb[li * 3 + 2], B.rgb[bi * 3], B.rgb[bi * 3 + 1], B.rgb[bi * 3 + 2]]);
  }
  const gain = [1, 1, 1], off = [0, 0, 0];
  if (list.length < 300) return { gain, off };
  for (let round = 0; round < 3; round++) {
    const keep = round === 0 ? list : list.filter((q) => { let d = 0; for (let c = 0; c < 3; c++) d += Math.abs(gain[c] * q[c] + off[c] - q[c + 3]); return d / 3 < 18; });
    if (keep.length < 200) break;
    for (let c = 0; c < 3; c++) {
      let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (const q of keep) { const a = q[c], b = q[c + 3]; n++; sx += a; sy += b; sxx += a * a; sxy += a * b; }
      const vx = sxx - (sx * sx) / n;
      const g = Math.max(0.6, Math.min(1.6, vx > 1 ? (sxy - (sx * sy) / n) / vx : 1));
      gain[c] = g; off[c] = Math.max(-80, Math.min(80, (sy - g * sx) / n));
    }
  }
  return { gain: gain.map((v) => +v.toFixed(4)), off: off.map((v) => +v.toFixed(2)) };
}

// As a worker it runs at once; required as a module (merge-core.js) it only exports `run`.
if (parentPort && workerData && workerData.base) {
  run(workerData).then((r) => parentPort.postMessage({ ok: true, r }), (e) => parentPort.postMessage({ ok: false, error: e && e.message ? e.message : String(e) }));
}

module.exports = { run };
