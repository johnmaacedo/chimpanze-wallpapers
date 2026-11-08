'use strict';
// "Juntar com o original": puts the untouched original back into an expansion of it (made by
// ChatGPT or by the local AI) so that nothing of the expansion stays over the original.
//
//  1. finds where the original sits in the expansion (align-worker: NCC, coarse to fine);
//  2. builds the output at the ORIGINAL's resolution (capped at ~4K area): the expansion is
//     scaled up to it, the original goes in 1:1;
//  3. matches the expansion's colours to the original (global gain/offset + a smooth local
//     offset field measured near the original's borders, spread over the new areas);
//  4. the only seam runs inside a thin band along the expanded borders of the original, on
//     the path where both pictures agree most (dynamic programming), and is blended with a
//     Laplacian pyramid (no ghosting, no visible tone step).
// Everything about the picture's content (paint, people) is irrelevant here: the original
// always wins inside its rectangle, except for that thin band.
const sharp = require('./img');
const { run: align } = require('./align-worker');

/** Output pixel budget: about a 4K screen (3840×2160). */
const MAX_PIXELS = 3840 * 2160;
/** Colour of the "Pintar" brush (src/ui/editor/composite.ts PAINT_RGB). */
const PAINT_RGB = [10, 100, 255];

async function orientedSize(file) {
  const m = await sharp(file, { limitInputPixels: false }).metadata();
  const swap = (m.orientation || 1) >= 5;
  return { w: swap ? m.height : m.width, h: swap ? m.width : m.height };
}

/** RGB bytes of `file` resized to w×h. */
async function rgbAt(file, w, h) {
  return sharp(file, { limitInputPixels: false }).rotate().resize(w, h, { fit: 'fill', kernel: 'lanczos3' }).removeAlpha().raw().toBuffer();
}

/**
 * The expansion mapped onto the output canvas: E scaled by (kx, ky), then the canvas window
 * (left, top, W, H) cut out of it; outside E the border pixels are repeated.
 */
async function expansionOnCanvas(file, E, kx, ky, left, top, W, H) {
  const SW = Math.max(1, Math.round(E.w * kx)), SH = Math.max(1, Math.round(E.h * ky));
  const scaled = await sharp(file, { limitInputPixels: false }).rotate().resize(SW, SH, { fit: 'fill', kernel: 'lanczos3' }).removeAlpha().raw().toBuffer();
  const out = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    const sy = Math.min(SH - 1, Math.max(0, y + top));
    for (let x = 0; x < W; x++) {
      const sx = Math.min(SW - 1, Math.max(0, x + left));
      const s = (sy * SW + sx) * 3, d = (y * W + x) * 3;
      out[d] = scaled[s]; out[d + 1] = scaled[s + 1]; out[d + 2] = scaled[s + 2];
    }
  }
  return out;
}

/**
 * Where the original goes on the canvas and how big the canvas is.
 * px = original's rectangle inside the expansion (expansion pixels); ow×oh = original's output size.
 */
function layout(E, px, ow, oh, aspect) {
  const kx = ow / px.w, ky = oh / px.h;
  // How much the expansion reaches beyond the original on each side (canvas pixels).
  const room = {
    left: Math.max(0, px.x * kx), right: Math.max(0, (E.w - px.x - px.w) * kx),
    top: Math.max(0, px.y * ky), bottom: Math.max(0, (E.h - px.y - px.h) * ky),
  };
  const wide = aspect >= ow / oh;
  // Along the expanded axis: original size `o`, room before/after it (a, b). Across: size `q`
  // and where the expansion covers it (c0..c1, original pixels).
  const o = wide ? ow : oh, q = wide ? oh : ow;
  const a = wide ? room.left : room.top, b = wide ? room.right : room.bottom;
  const c0 = wide ? -px.y * ky : -px.x * kx, c1 = wide ? (E.h - px.y) * ky : (E.w - px.x) * kx;
  const want = (len) => (wide ? len * aspect : len / aspect); // expanded-axis size for a cross size
  let cross = q, cropAt = 0, short = 0;
  if (want(q) - o > a + b + 0.5) {
    // The expansion doesn't reach the full aspect: crop the original across (where the expansion
    // kept its picture, i.e. ChatGPT's own framing) until what it covers is enough.
    short = want(q) - o - (a + b);
    cross = Math.max(1, Math.min(q, Math.floor(wide ? (o + a + b) / aspect : (o + a + b) * aspect)));
    const centre = Math.min(q - cross / 2, Math.max(cross / 2, (Math.max(0, c0) + Math.min(q, c1)) / 2));
    cropAt = Math.round(centre - cross / 2);
  }
  const extra = Math.max(0, Math.round(want(cross)) - o);
  // Keep the expansion's framing: share of the extra space on each side, within what it covers.
  const ideal = a + b > 0 ? (extra * a) / (a + b) : extra / 2;
  const first = Math.round(Math.min(a, Math.max(extra - b, ideal)));
  const W = wide ? o + extra : cross, H = wide ? cross : o + extra;
  return {
    kx, ky, W, H, wide, short, room,
    x0: wide ? first : 0, y0: wide ? 0 : first,
    /** Part of the original that is used (pixels of the ow×oh original). */
    crop: wide ? { x: 0, y: cropAt, w: ow, h: cross } : { x: cropAt, y: 0, w: cross, h: oh },
  };
}

/**
 * Small local shifts of the expansion near one expanded border of the original, so lines that
 * cross the seam (a frame, a bed edge) meet. Block matching of grey levels along the border;
 * the measured shift is applied fully inside the band and fades out into the new area.
 * Canvas is "vertical seams" oriented. Changes `Ec` in place; returns the mean |shift|.
 */
function alignBorder(Ec, A, W, H, x0, w0, y0, h0, side, bandW) {
  const R = Math.max(4, Math.min(14, Math.round(H * 0.01)));
  const span = Math.min(w0 >> 1, Math.round(bandW * 1.5));
  const xa = side === 'first' ? x0 : x0 + w0 - span, xb = side === 'first' ? x0 + span : x0 + w0;
  const grey = (B, i) => 0.299 * B[i] + 0.587 * B[i + 1] + 0.114 * B[i + 2];
  const BH = 64, STEP = 32;
  const rows = [];
  for (let by = y0; by + BH <= y0 + h0; by += STEP) {
    // Texture check: flat blocks can't tell a shift.
    let s = 0, s2 = 0, n = 0;
    for (let y = by; y < by + BH; y += 2) for (let x = xa; x < xb; x += 2) { const v = grey(A, (y * W + x) * 3); s += v; s2 += v * v; n++; }
    const sd = Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2));
    if (sd < 6) continue;
    const sad = (dx, dy) => {
      let t = 0, m = 0;
      for (let y = by; y < by + BH; y += 2) {
        const yy = y + dy; if (yy < 0 || yy >= H) continue;
        for (let x = xa; x < xb; x += 2) {
          const xx = x + dx; if (xx < 0 || xx >= W) continue;
          t += Math.abs(grey(A, (y * W + x) * 3) - grey(Ec, (yy * W + xx) * 3)); m++;
        }
      }
      return m ? t / m : 1e9;
    };
    let best = { dx: 0, dy: 0, v: sad(0, 0) };
    const zero = best.v;
    for (let dy = -R; dy <= R; dy += 2) for (let dx = -R; dx <= R; dx += 2) { const v = sad(dx, dy); if (v < best.v) best = { dx, dy, v }; }
    const cx = best.dx, cy = best.dy; // fixed centre: the refinement must not wander
    for (let dy = Math.max(-R, cy - 1); dy <= Math.min(R, cy + 1); dy++) for (let dx = Math.max(-R, cx - 1); dx <= Math.min(R, cx + 1); dx++) { const v = sad(dx, dy); if (v < best.v) best = { dx, dy, v }; }
    // Only trust a clear improvement.
    if (best.v < zero * 0.85) rows.push({ y: by + BH / 2, dx: best.dx, dy: best.dy });
  }
  if (rows.length < 4) return 0;
  const med = (v) => { const s = v.slice().sort((p, q) => p - q); return s[s.length >> 1]; };
  // Across the border (dx): one rigid shift, so vertical lines (a frame's side) stay straight.
  const mx = med(rows.map((r) => r.dx));
  const gx = rows.filter((r) => Math.abs(r.dx - mx) <= 3);
  const sx = gx.length >= Math.max(3, rows.length * 0.3) ? gx.reduce((t, r) => t + r.dx, 0) / gx.length : 0;
  // Along the border (dy): follows the blocks (running median drops odd ones), smoothed; it only
  // stretches the picture along the seam, so straight lines do not bend.
  const dyMed = rows.map((r, i) => med(rows.slice(Math.max(0, i - 2), i + 3).map((q) => q.dy)));
  const dY = new Float32Array(H);
  for (let y = 0; y < H; y++) {
    let j = 0; while (j < rows.length - 1 && rows[j + 1].y < y) j++;
    const j1 = Math.min(rows.length - 1, j + 1);
    const t = rows[j1].y > rows[j].y ? Math.min(1, Math.max(0, (y - rows[j].y) / (rows[j1].y - rows[j].y))) : 0;
    dY[y] = dyMed[j] + (dyMed[j1] - dyMed[j]) * t;
  }
  const sY = boxBlur(dY, 1, H, 48, 2);
  // dy fades out across the new area (far from the seam nothing needs to move).
  const outer = side === 'first' ? x0 : x0 + w0;
  const decay = Math.max(bandW * 3, (side === 'first' ? x0 : W - x0 - w0) * 0.6);
  const x1 = side === 'first' ? 0 : xa, x2 = side === 'first' ? xb : W;
  const src = Buffer.from(Ec);
  let mean = 0;
  for (let y = 0; y < H; y++) {
    mean += Math.abs(sx) + Math.abs(sY[y]);
    for (let x = x1; x < x2; x++) {
      const tOut = side === 'first' ? outer - x : x - outer; // > 0 = in the new area
      const wy = tOut <= 0 ? 1 : Math.max(0, 1 - tOut / decay);
      const fx = Math.min(W - 1.001, Math.max(0, x + sx)), fy = Math.min(H - 1.001, Math.max(0, y + sY[y] * wy));
      const ix = fx | 0, iy = fy | 0, tx = fx - ix, ty = fy - iy;
      const i00 = (iy * W + ix) * 3, i10 = i00 + 3, i01 = i00 + W * 3, i11 = i01 + 3, d = (y * W + x) * 3;
      for (let c = 0; c < 3; c++) Ec[d + c] = Math.round((src[i00 + c] * (1 - tx) + src[i10 + c] * tx) * (1 - ty) + (src[i01 + c] * (1 - tx) + src[i11 + c] * tx) * ty);
    }
  }
  return mean / H;
}

/** Robust per-channel gain/offset that maps `src` to `dst` where they agree (both RGB arrays, same length). */
function fitGainOffset(pairs) {
  const gain = [1, 1, 1], off = [0, 0, 0];
  if (pairs.length < 300) return { gain, off };
  let keep = pairs;
  for (let round = 0; round < 3; round++) {
    if (round) keep = pairs.filter((q) => { let d = 0; for (let c = 0; c < 3; c++) d += Math.abs(gain[c] * q[c] + off[c] - q[c + 3]); return d / 3 < 16; });
    if (keep.length < 200) break;
    for (let c = 0; c < 3; c++) {
      let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (const q of keep) { const a = q[c], b = q[c + 3]; n++; sx += a; sy += b; sxx += a * a; sxy += a * b; }
      const vx = sxx - (sx * sx) / n;
      const g = Math.max(0.7, Math.min(1.4, vx > 1 ? (sxy - (sx * sy) / n) / vx : 1));
      gain[c] = g; off[c] = Math.max(-60, Math.min(60, (sy - g * sx) / n));
    }
  }
  return { gain, off };
}

/** Separable box blur of a float grid (in place copy returned). */
function boxBlur(a, w, h, r, passes = 2) {
  if (r < 1) return Float32Array.from(a);
  let src = Float32Array.from(a); const t = new Float32Array(w * h); const n = 2 * r + 1;
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      const o = y * w; let s = 0;
      for (let x = -r; x <= r; x++) s += src[o + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) { t[o + x] = s / n; s += src[o + Math.min(w - 1, x + r + 1)] - src[o + Math.max(0, x - r)]; }
    }
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let y = -r; y <= r; y++) s += t[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) { src[y * w + x] = s / n; s += t[Math.min(h - 1, y + r + 1) * w + x] - t[Math.max(0, y - r) * w + x]; }
    }
  }
  return src;
}

/**
 * Fills a sparse field (num/den per cell) everywhere: pull to coarser levels, push back
 * where a cell has no data. Returns num/den with holes filled from the surroundings.
 */
function pushPull(nums, den, w, h) {
  const levels = [{ w, h, nums, den }];
  while (levels[levels.length - 1].w > 1 || levels[levels.length - 1].h > 1) {
    const L = levels[levels.length - 1];
    const w2 = Math.max(1, Math.ceil(L.w / 2)), h2 = Math.max(1, Math.ceil(L.h / 2));
    const d2 = new Float32Array(w2 * h2); const n2 = L.nums.map(() => new Float32Array(w2 * h2));
    for (let y = 0; y < L.h; y++) for (let x = 0; x < L.w; x++) {
      const i = y * L.w + x, j = (y >> 1) * w2 + (x >> 1);
      d2[j] += L.den[i]; for (let c = 0; c < n2.length; c++) n2[c][j] += L.nums[c][i];
    }
    levels.push({ w: w2, h: h2, nums: n2, den: d2 });
  }
  // Values (num/den) from the coarsest level down; empty cells take the coarser value.
  let val = levels[levels.length - 1].nums.map((n) => Float32Array.from([levels[levels.length - 1].den[0] > 0 ? n[0] / levels[levels.length - 1].den[0] : 0]));
  for (let li = levels.length - 2; li >= 0; li--) {
    const L = levels[li], C = levels[li + 1];
    const next = L.nums.map(() => new Float32Array(L.w * L.h));
    for (let y = 0; y < L.h; y++) for (let x = 0; x < L.w; x++) {
      const i = y * L.w + x;
      // Bilinear sample of the coarser level at this cell's centre.
      const fx = Math.min(C.w - 1, Math.max(0, (x + 0.5) / 2 - 0.5)), fy = Math.min(C.h - 1, Math.max(0, (y + 0.5) / 2 - 0.5));
      const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(C.w - 1, x0 + 1), y1 = Math.min(C.h - 1, y0 + 1), tx = fx - x0, ty = fy - y0;
      const wgt = Math.min(1, L.den[i] / 4);
      for (let c = 0; c < next.length; c++) {
        const v = val[c];
        const coarse = (v[y0 * C.w + x0] * (1 - tx) + v[y0 * C.w + x1] * tx) * (1 - ty) + (v[y1 * C.w + x0] * (1 - tx) + v[y1 * C.w + x1] * tx) * ty;
        const own = L.den[i] > 0 ? L.nums[c][i] / L.den[i] : 0;
        next[c][i] = own * wgt + coarse * (1 - wgt);
      }
    }
    val = next;
  }
  return val;
}

/**
 * Colour of the expansion matched to the original: global gain/offset, then a smooth local
 * offset measured near the original's expanded borders and spread over the whole canvas.
 * Changes `Ec` in place; returns the global fit (for the log).
 */
function matchExpansion(Ec, O, lay, ow, oh, bandW) {
  const { W, H, x0, y0 } = lay;
  const near = Math.max(bandW * 2, Math.round(Math.min(ow, oh) * 0.18));
  const sideOf = (x, y) => (lay.wide ? Math.min(x, ow - 1 - x) : Math.min(y, oh - 1 - y));
  // 1) global fit on agreeing pixels close to the expanded borders
  const pairs = [];
  const st = Math.max(1, Math.round(Math.sqrt((ow * oh) / 250000)));
  for (let y = 0; y < oh; y += st) for (let x = 0; x < ow; x += st) {
    if (sideOf(x, y) > near) continue;
    const o = (y * ow + x) * 3, e = ((y + y0) * W + x + x0) * 3;
    let d = 0; for (let c = 0; c < 3; c++) d += Math.abs(O[o + c] - Ec[e + c]);
    if (d / 3 < 45) pairs.push([Ec[e], Ec[e + 1], Ec[e + 2], O[o], O[o + 1], O[o + 2]]);
  }
  const fit = fitGainOffset(pairs);
  const lut = [0, 1, 2].map((c) => { const t = new Uint8ClampedArray(256); for (let v = 0; v < 256; v++) t[v] = fit.gain[c] * v + fit.off[c]; return t; });
  for (let i = 0; i < Ec.length; i += 3) { Ec[i] = lut[0][Ec[i]]; Ec[i + 1] = lut[1][Ec[i + 1]]; Ec[i + 2] = lut[2][Ec[i + 2]]; }
  // 2) local offset field on a coarse grid
  const f = 8, gw = Math.ceil(W / f), gh = Math.ceil(H / f);
  const den = new Float32Array(gw * gh); const nums = [new Float32Array(gw * gh), new Float32Array(gw * gh), new Float32Array(gw * gh)];
  for (let y = 0; y < oh; y += 2) for (let x = 0; x < ow; x += 2) {
    if (sideOf(x, y) > near) continue;
    const o = (y * ow + x) * 3, cx = x + x0, cy = y + y0, e = (cy * W + cx) * 3;
    let d = 0; for (let c = 0; c < 3; c++) d += Math.abs(O[o + c] - Ec[e + c]);
    if (d / 3 > 28) continue;
    const j = Math.floor(cy / f) * gw + Math.floor(cx / f);
    den[j]++; for (let c = 0; c < 3; c++) nums[c][j] += O[o + c] - Ec[e + c];
  }
  let any = 0; for (let j = 0; j < den.length; j++) any += den[j];
  if (any < 200) return fit;
  const field = pushPull(nums, den, gw, gh).map((v) => boxBlur(v, gw, gh, Math.max(2, Math.round(Math.min(gw, gh) * 0.06)), 3));
  for (let y = 0; y < H; y++) {
    const fy = Math.min(gh - 1.001, Math.max(0, y / f - 0.5)), yy = fy | 0, ty = fy - yy;
    for (let x = 0; x < W; x++) {
      const fx = Math.min(gw - 1.001, Math.max(0, x / f - 0.5)), xx = fx | 0, tx = fx - xx;
      const j00 = yy * gw + xx, j10 = Math.min(gw * gh - 1, j00 + 1), j01 = Math.min(gw * gh - 1, j00 + gw), j11 = Math.min(gw * gh - 1, j01 + 1);
      const e = (y * W + x) * 3;
      for (let c = 0; c < 3; c++) {
        const F = field[c];
        const v = (F[j00] * (1 - tx) + F[j10] * tx) * (1 - ty) + (F[j01] * (1 - tx) + F[j11] * tx) * ty;
        const nv = Ec[e + c] + Math.max(-40, Math.min(40, v));
        Ec[e + c] = nv < 0 ? 0 : nv > 255 ? 255 : nv;
      }
    }
  }
  return fit;
}

/**
 * Seam inside a band of columns [xa, xb) of the canvas (all rows): path x(y) with |Δx| ≤ 1
 * through the lowest colour difference between `A` (original side) and `B`. `outerAt` is the
 * band's column next to the expansion: ties prefer keeping more of the original.
 * Returns { path: Int32Array(H) of columns, cost: mean difference along the path }.
 */
function verticalSeam(A, B, W, H, xa, xb, outerAt) {
  const bw = xb - xa;
  const cost = new Float32Array(bw * H);
  for (let y = 0; y < H; y++) for (let i = 0; i < bw; i++) {
    const k = (y * W + xa + i) * 3;
    cost[y * bw + i] = (Math.abs(A[k] - B[k]) + Math.abs(A[k + 1] - B[k + 1]) + Math.abs(A[k + 2] - B[k + 2])) / 3;
  }
  const sm = boxBlur(cost, bw, H, 2, 1);
  for (let y = 0; y < H; y++) for (let i = 0; i < bw; i++) {
    const dist = Math.abs(xa + i - outerAt) / Math.max(1, bw);
    sm[y * bw + i] += 1 + dist * 3;
  }
  const M = new Float32Array(bw * H); const from = new Int8Array(bw * H);
  for (let i = 0; i < bw; i++) M[i] = sm[i];
  for (let y = 1; y < H; y++) for (let i = 0; i < bw; i++) {
    let best = M[(y - 1) * bw + i], d = 0;
    if (i > 0 && M[(y - 1) * bw + i - 1] < best) { best = M[(y - 1) * bw + i - 1]; d = -1; }
    if (i < bw - 1 && M[(y - 1) * bw + i + 1] < best) { best = M[(y - 1) * bw + i + 1]; d = 1; }
    M[y * bw + i] = best + sm[y * bw + i]; from[y * bw + i] = d;
  }
  let i = 0;
  for (let j = 1; j < bw; j++) if (M[(H - 1) * bw + j] < M[(H - 1) * bw + i]) i = j;
  const path = new Int32Array(H); let total = 0;
  for (let y = H - 1; y >= 0; y--) { path[y] = xa + i; total += cost[y * bw + i]; i += from[y * bw + i]; }
  return { path, cost: total / H };
}

// --- Laplacian pyramid blending ------------------------------------------------------
function down(img, w, h) {
  // 5-tap binomial blur, then every second pixel.
  const k = [1, 4, 6, 4, 1];
  const t = new Float32Array(w * h), w2 = Math.ceil(w / 2), h2 = Math.ceil(h / 2), out = new Float32Array(w2 * h2);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0; for (let j = -2; j <= 2; j++) s += k[j + 2] * img[y * w + Math.min(w - 1, Math.max(0, x + j))];
    t[y * w + x] = s / 16;
  }
  for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) {
    let s = 0; for (let j = -2; j <= 2; j++) s += k[j + 2] * t[Math.min(h - 1, Math.max(0, 2 * y + j)) * w + 2 * x];
    out[y * w2 + x] = s / 16;
  }
  return out;
}
function up(img, w, h, W, H) {
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const fy = Math.min(h - 1, Math.max(0, (y + 0.5) / 2 - 0.5)), y0 = Math.floor(fy), y1 = Math.min(h - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < W; x++) {
      const fx = Math.min(w - 1, Math.max(0, (x + 0.5) / 2 - 0.5)), x0 = Math.floor(fx), x1 = Math.min(w - 1, x0 + 1), tx = fx - x0;
      out[y * W + x] = (img[y0 * w + x0] * (1 - tx) + img[y0 * w + x1] * tx) * (1 - ty) + (img[y1 * w + x0] * (1 - tx) + img[y1 * w + x1] * tx) * ty;
    }
  }
  return out;
}
/** Blends two single-channel images with mask m (1 = a) over `levels` frequency bands. */
function blendChannel(a, b, m, w, h, levels) {
  const sizes = [[w, h]];
  const GA = [a], GB = [b], GM = [m];
  for (let l = 1; l <= levels; l++) {
    const [pw, ph] = sizes[l - 1];
    GA.push(down(GA[l - 1], pw, ph)); GB.push(down(GB[l - 1], pw, ph)); GM.push(down(GM[l - 1], pw, ph));
    sizes.push([Math.ceil(pw / 2), Math.ceil(ph / 2)]);
  }
  // Coarsest level blended directly, then each band added back.
  let [cw, ch] = sizes[levels];
  let R = new Float32Array(cw * ch);
  for (let i = 0; i < R.length; i++) R[i] = GM[levels][i] * GA[levels][i] + (1 - GM[levels][i]) * GB[levels][i];
  for (let l = levels - 1; l >= 0; l--) {
    const [lw, lh] = sizes[l];
    const ua = up(GA[l + 1], cw, ch, lw, lh), ub = up(GB[l + 1], cw, ch, lw, lh), ur = up(R, cw, ch, lw, lh);
    const next = new Float32Array(lw * lh);
    for (let i = 0; i < next.length; i++) {
      const la = GA[l][i] - ua[i], lb = GB[l][i] - ub[i], mm = GM[l][i];
      next[i] = ur[i] + mm * la + (1 - mm) * lb;
    }
    R = next; cw = lw; ch = lh;
  }
  return R;
}

/**
 * Blends the canvas strip [sx0, sx1) × all rows: `A` = original side (where it exists), `B` =
 * expansion, `inA(x, y)` = which side of the seam a pixel is on. Writes into `out`.
 */
function blendStrip(out, A, B, W, H, sx0, sx1, inA) {
  const sw = sx1 - sx0; if (sw < 4) return;
  const levels = Math.max(1, Math.min(5, Math.floor(Math.log2(Math.min(sw, H) / 6))));
  const m = new Float32Array(sw * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < sw; x++) m[y * sw + x] = inA(sx0 + x, y) ? 1 : 0;
  const fade = Math.min(16, Math.floor(sw / 6));
  for (let c = 0; c < 3; c++) {
    const a = new Float32Array(sw * H), b = new Float32Array(sw * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < sw; x++) { const k = (y * W + sx0 + x) * 3 + c; a[y * sw + x] = A[k]; b[y * sw + x] = B[k]; }
    const r = blendChannel(a, b, m, sw, H, levels);
    for (let y = 0; y < H; y++) for (let x = 0; x < sw; x++) {
      const k = (y * W + sx0 + x) * 3 + c;
      // Fade into what is already there at the strip's two ends (the blend matches it there anyway).
      const e = Math.min(x, sw - 1 - x); const t = fade > 0 && e < fade ? (e + 0.5) / fade : 1;
      const v = r[y * sw + x] * t + out[k] * (1 - t);
      out[k] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
    }
  }
}

/** Transposes an RGB image (W×H → H×W). */
function transpose(src, W, H) {
  const out = Buffer.alloc(src.length);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const s = (y * W + x) * 3, d = (x * H + y) * 3;
    out[d] = src[s]; out[d + 1] = src[s + 1]; out[d + 2] = src[s + 2];
  }
  return out;
}

/** Share of pixels painted with the "Pintar" colour. */
function paintShare(rgb) {
  let n = 0, t = 0;
  for (let i = 0; i < rgb.length; i += 3 * 7) { t++; if (Math.abs(rgb[i] - PAINT_RGB[0]) + Math.abs(rgb[i + 1] - PAINT_RGB[1]) + Math.abs(rgb[i + 2] - PAINT_RGB[2]) < 60) n++; }
  return t ? n / t : 0;
}

/**
 * A pixel that is the "Pintar" paint: that exact vivid blue (ChatGPT re-shades it only a little)
 * on a flat area. A blue sky or a blue dress is never that colour and never that flat.
 */
function isPaint(img, W, H, x, y) {
  const i = (y * W + x) * 3;
  const dp = Math.abs(img[i] - PAINT_RGB[0]) + Math.abs(img[i + 1] - PAINT_RGB[1]) + Math.abs(img[i + 2] - PAINT_RGB[2]);
  // Red almost zero (10) is what sets the paint apart from any real blue (a sky has 60+ of red).
  if (dp >= 70 || img[i] > 40) return false;
  // Flat: the pixels 3 px away look the same.
  let far = 0;
  for (const [dx, dy] of [[3, 0], [-3, 0], [0, 3], [0, -3]]) {
    const xx = Math.min(W - 1, Math.max(0, x + dx)), yy = Math.min(H - 1, Math.max(0, y + dy)), j = (yy * W + xx) * 3;
    far = Math.max(far, Math.abs(img[j] - img[i]) + Math.abs(img[j + 1] - img[i + 1]) + Math.abs(img[j + 2] - img[i + 2]));
  }
  return far < 40;
}

/**
 * Mask (W×H, 255 = fill) of paint that ChatGPT carried into the new areas, grown a little;
 * null when there is (almost) none. Only outside the original's rectangle.
 */
function leftoverPaint(img, W, H, rect) {
  const m = Buffer.alloc(W * H);
  let n = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h) continue;
    if (isPaint(img, W, H, x, y)) { m[y * W + x] = 255; n++; }
  }
  if (n < 150) return null;
  // Grow by a few pixels (ChatGPT softens the paint's edge).
  const r = Math.max(3, Math.round(Math.min(W, H) * 0.004));
  const g = boxBlur(Float32Array.from(m, (v) => v / 255), W, H, r, 1);
  for (let i = 0; i < m.length; i++) m[i] = g[i] > 0.02 ? 255 : 0;
  return { mask: m, share: n / (W * H) };
}

/**
 * opts: { original, expansion, aspect (W/H), out (PNG path), maskOut? (PNG for leftover paint), onStage? }
 * Returns { out, width, height, score, seams: [{ side, cost, shift }], warnings: [], paintMask? }.
 */
async function merge(opts) {
  const stage = opts.onStage || (() => {});
  const warnings = [];
  // The local AI knows where it put the picture (its middle is the empty scene, so a search could
  // not match the people); expansions from ChatGPT are searched.
  const known = opts.place && opts.place.w > 0 && opts.place.h > 0;
  if (!known) stage('Procurando o original dentro da expansão…');
  const a = known ? { score: 1, px: opts.place } : await align({ base: opts.expansion, layer: opts.original, ignorePaint: true });
  // Real expansions match at 0.9+; below 0.75 the expansion redrew the scene (or it is another picture).
  if (a.score < 0.75) {
    const e = new Error('Não consegui encaixar o original nesta expansão: a cena mudou demais (enquadramento, móveis ou luz redesenhados) ou é outra imagem. Peça a expansão de novo ou use a IA local.');
    e.code = 'NO_MATCH'; throw e;
  }
  if (a.score < 0.85) warnings.push('O encaixe ficou menos seguro que o normal. Confira o resultado no zoom.');
  const E = await orientedSize(opts.expansion), O0 = await orientedSize(opts.original);
  const aspect = opts.aspect > 0 ? opts.aspect : E.w / E.h;
  // Output size: the original 1:1, unless the canvas would pass the pixel budget.
  const wide0 = aspect >= O0.w / O0.h;
  const area = wide0 ? O0.h * O0.h * aspect : O0.w * (O0.w / aspect);
  const f = Math.min(1, Math.sqrt(MAX_PIXELS / area));
  const ow = Math.round(O0.w * f), oh = Math.round(O0.h * f);
  const lay = layout(E, a.px, ow, oh, aspect);
  const lost = 1 - (lay.crop.w * lay.crop.h) / (ow * oh);
  if (lost > 0.005) warnings.push(`A expansão não cobriu a proporção inteira, então ${Math.round(lost * 100)}% do original (${lay.wide ? 'em cima/embaixo' : 'nas laterais'}) ficou de fora, seguindo o enquadramento da expansão.`);
  if (lost > 0.25) warnings.push('Ficou muita coisa de fora. Peça a expansão de novo (o ChatGPT mudou demais o enquadramento).');
  const expanded = lay.wide ? lay.W > lay.crop.w : lay.H > lay.crop.h;
  if (!expanded) warnings.push('A expansão não acrescentou nada em volta do original.');

  stage('Ampliando a expansão para a resolução do original…');
  const Ofull = await rgbAt(opts.original, ow, oh);
  if (paintShare(Ofull) > 0.002) warnings.push('O original escolhido tem partes pintadas de azul (Pintar). Use a imagem sem pintura para juntar.');
  // The used part of the original.
  const cw = lay.crop.w, ch = lay.crop.h;
  const O = Buffer.alloc(cw * ch * 3);
  for (let y = 0; y < ch; y++) Ofull.copy(O, y * cw * 3, ((y + lay.crop.y) * ow + lay.crop.x) * 3, ((y + lay.crop.y) * ow + lay.crop.x + cw) * 3);
  const left = Math.round(a.px.x * lay.kx) - lay.x0 + lay.crop.x, top = Math.round(a.px.y * lay.ky) - lay.y0 + lay.crop.y;
  let Ec = await expansionOnCanvas(opts.expansion, E, lay.kx, lay.ky, left, top, lay.W, lay.H);
  const bandW = Math.max(24, Math.min(200, Math.round(Math.min(cw, ch) * 0.07), Math.floor((lay.wide ? cw : ch) / 4)));
  stage('Igualando as cores…');
  const fit = matchExpansion(Ec, O, lay, cw, ch, bandW);

  stage('Costurando e misturando a emenda…');
  // Work with vertical seams only: a tall expansion is transposed first.
  let W = lay.W, H = lay.H, x0 = lay.x0, y0 = lay.y0, w0 = cw, h0 = ch, Ow = O;
  if (!lay.wide) { Ec = transpose(Ec, lay.W, lay.H); Ow = transpose(O, cw, ch); [W, H, x0, y0, w0, h0] = [lay.H, lay.W, lay.y0, lay.x0, ch, cw]; }
  const sides = [];
  if (x0 > 0) sides.push('first');
  if (x0 + w0 < W) sides.push('last');
  // A = original where it is, the matched expansion elsewhere.
  const placeOriginal = (src) => { const A = Buffer.from(src); for (let y = 0; y < h0; y++) Ow.copy(A, ((y + y0) * W + x0) * 3, y * w0 * 3, (y + 1) * w0 * 3); return A; };
  // Local alignment along each expanded border (lines crossing the seam meet).
  const shifts = {};
  {
    const A0 = placeOriginal(Ec);
    for (const side of sides) shifts[side] = +alignBorder(Ec, A0, W, H, x0, w0, y0, h0, side, bandW).toFixed(1);
  }
  const A = placeOriginal(Ec);
  const out = Buffer.from(A);
  const seams = [];
  const margin = 96;
  for (const side of sides) {
    const xa = side === 'first' ? x0 + 2 : x0 + w0 - bandW, xb = side === 'first' ? x0 + bandW : x0 + w0 - 2;
    const outer = side === 'first' ? x0 : x0 + w0 - 1;
    const { path, cost } = verticalSeam(A, Ec, W, H, xa, xb, outer);
    seams.push({ side: lay.wide ? (side === 'first' ? 'esquerda' : 'direita') : (side === 'first' ? 'cima' : 'baixo'), cost: +cost.toFixed(1), shift: shifts[side] });
    const inA = side === 'first' ? (x, y) => x > path[y] && y >= y0 && y < y0 + h0 : (x, y) => x < path[y] && y >= y0 && y < y0 + h0;
    blendStrip(out, A, Ec, W, H, Math.max(0, xa - margin), Math.min(W, xb + margin), inA);
  }
  const worst = seams.reduce((m, s) => Math.max(m, s.cost), 0);
  if (worst > 22) warnings.push('Perto da borda do original a expansão ficou bem diferente (talvez um personagem encoste na borda). Confira a emenda no zoom.');
  const final = lay.wide ? out : transpose(out, W, H);
  const rect = { x: lay.x0, y: lay.y0, w: cw, h: ch };
  stage('Salvando…');
  await sharp(final, { raw: { width: lay.W, height: lay.H, channels: 3 } }).png({ compressionLevel: 6 }).toFile(opts.out);
  // Paint carried into the new areas: the caller fills it with LaMa.
  let paintMask = null;
  const lp = leftoverPaint(final, lay.W, lay.H, rect);
  // Lots of paint outside the original = it was placed in the wrong spot.
  if (lp && lp.share > 0.08) {
    const e = new Error('O encaixe não ficou certo (sobrou muita tinta azul fora do original). Peça a expansão de novo ou use a IA local.');
    e.code = 'NO_MATCH'; throw e;
  }
  if (lp && opts.maskOut) {
    await sharp(lp.mask, { raw: { width: lay.W, height: lay.H, channels: 1 } }).png().toFile(opts.maskOut);
    paintMask = opts.maskOut;
  }
  return {
    out: opts.out, width: lay.W, height: lay.H, score: +a.score.toFixed(3),
    original: rect, crop: lay.crop, seams, warnings, paintMask, paintShare: lp ? +lp.share.toFixed(4) : 0,
    color: { gain: fit.gain.map((v) => +v.toFixed(3)), off: fit.off.map((v) => +v.toFixed(1)) },
  };
}

module.exports = { merge, isPaint, _test: { layout, verticalSeam, blendChannel, pushPull, fitGainOffset, transpose, paintShare, leftoverPaint, alignBorder } };
