// "Colar": puts a picture (layer) on top of the edited one with perspective, colour matching
// and an optional "only the painted part" mask. The same code makes the live preview (small)
// and the final picture (full size), so what you see is what you get.

/** Colour of the brush of the "Pintar" tab (hidden areas sent to ChatGPT). */
export const PAINT_RGB: [number, number, number] = [10, 100, 255];
export const PAINT_CSS = 'rgb(10,100,255)';

export interface LayerGeom {
  /** Centre (0..1 of the edited picture), width (0..1 of its width), vertical stretch, rotation (degrees), mirror. */
  cx: number; cy: number; w: number; sy: number; rot: number; flip: boolean;
  /** Picture size (to keep its proportion). */
  nw: number; nh: number;
  /** Corner offsets (perspective), as fractions of the box: tl, tr, br, bl. */
  corners: [number, number][];
}

export interface PasteOpts {
  /** 'all' = the whole picture; 'paint' = only where the edited picture shows paint / what was hidden. */
  mode: 'all' | 'paint';
  /** Grow the painted area (px of the edited picture) and soften its edge (px). */
  grow: number; soft: number;
  /** Soft edge of the whole picture (px). */
  feather: number;
  /** 0..1: local colour matching to the picture below. */
  match: number;
  /** Manual colour: -1..1 each. */
  bright: number; contrast: number; sat: number; temp: number;
}

export const defaultOpts = (): PasteOpts => ({ mode: 'all', grow: 10, soft: 8, feather: 0, match: 1, bright: 0, contrast: 0, sat: 0, temp: 0 });
export const NO_CORNERS: [number, number][] = [[0, 0], [0, 0], [0, 0], [0, 0]];

/** Height of the layer box relative to the edited picture's height. */
export const boxH = (g: LayerGeom, bw: number, bh: number) => g.w * (bw / bh) * (g.nh / g.nw) * g.sy;

/** The four corners (tl, tr, br, bl) in pixels of a W×H picture. */
export function quad(g: LayerGeom, W: number, H: number): [number, number][] {
  const bw = g.w * W, bh = boxH(g, W, H) * H;
  const base: [number, number][] = [[-bw / 2, -bh / 2], [bw / 2, -bh / 2], [bw / 2, bh / 2], [-bw / 2, bh / 2]];
  const r = (g.rot * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return base.map(([x, y], i) => {
    const px = x + g.corners[i][0] * bw, py = y + g.corners[i][1] * bh;
    return [g.cx * W + px * c - py * s, g.cy * H + px * s + py * c] as [number, number];
  });
}

/** Homography from the unit square (0,0)(1,0)(1,1)(0,1) to a quad: [a,b,c,d,e,f,g,h]. */
export function squareToQuad(q: [number, number][]): number[] {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  if (Math.abs(dx3) < 1e-9 && Math.abs(dy3) < 1e-9) return [x1 - x0, x2 - x1, x0, y1 - y0, y2 - y1, y0, 0, 0];
  const den = dx1 * dy2 - dx2 * dy1;
  const g = (dx3 * dy2 - dx2 * dy3) / den, h = (dx1 * dy3 - dx3 * dy1) / den;
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h];
}

/** CSS matrix3d that maps a w×h element (origin top-left) onto the quad (same pixel units). */
export function cssMatrix(w: number, h: number, q: [number, number][]): string {
  const [a, b, c, d, e, f, g, hh] = squareToQuad(q);
  const m = [a / w, d / w, 0, g / w, b / h, e / h, 0, hh / h, 0, 0, 1, 0, c, f, 0, 1];
  return `matrix3d(${m.map((v) => +v.toFixed(8)).join(',')})`;
}

/** Inverse of the 3×3 homography (a..h, i = 1). */
function invert(H: number[]): number[] {
  const [a, b, c, d, e, f, g, h] = H; const i = 1;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  const D = -(b * i - c * h), E = a * i - c * g, F = -(a * h - b * g);
  const G = b * f - c * e, Hh = -(a * f - c * d), I = a * e - b * d;
  return [A / det, D / det, G / det, B / det, E / det, Hh / det, C / det, F / det, I / det];
}

/** 3×4 colour matrix of the manual settings (applied to 0..255 values). */
function colorMatrix(o: PasteOpts): number[] {
  // contrast & brightness
  const k = 1 + o.contrast * 0.6; const off = 128 * (1 - k) + o.bright * 70;
  // saturation (around luminance)
  const s = 1 + o.sat; const lr = 0.299, lg = 0.587, lb = 0.114;
  const S = [
    lr * (1 - s) + s, lg * (1 - s), lb * (1 - s),
    lr * (1 - s), lg * (1 - s) + s, lb * (1 - s),
    lr * (1 - s), lg * (1 - s), lb * (1 - s) + s,
  ];
  // temperature: warmer = more red, less blue
  const tr = 1 + o.temp * 0.12, tb = 1 - o.temp * 0.12;
  const T = [tr, 1, tb];
  const M: number[] = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) M.push(T[r] * S[r * 3 + c] * k);
    M.push(T[r] * off * (S[r * 3] + S[r * 3 + 1] + S[r * 3 + 2]));
  }
  return M;
}

export interface Pix { w: number; h: number; data: Uint8ClampedArray }

/** Separable box blur of a float field, `passes` times (≈ gaussian), radius r. */
function boxBlur(a: Float32Array, w: number, h: number, r: number, passes = 2): Float32Array<ArrayBuffer> {
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
 * The edited picture `B` with the layer `S` put on it. `scale` = how many pixels of the real
 * edited picture one pixel of `B` stands for (sizes in px are given at real size).
 * Returns the new pixels and the paste mask (0..1), for the preview tint.
 */
export function composite(B: Pix, S: Pix, g: LayerGeom, o: PasteOpts, scale = 1): { out: Uint8ClampedArray; alpha: Float32Array } {
  const W = B.w, H = B.h, N = W * H;
  const q = quad(g, W, H);
  const Hinv = invert(squareToQuad(q));
  const boxW = g.w * W, boxHh = boxH(g, W, H) * H;
  const feather = o.feather / scale;
  const M = colorMatrix(o);
  const L = new Float32Array(N * 3);
  const edge = new Float32Array(N);
  let x0 = W, x1 = 0, y0 = H, y1 = 0;
  for (const [x, y] of q) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0)); x1 = Math.min(W - 1, Math.ceil(x1)); y1 = Math.min(H - 1, Math.ceil(y1));
  const sw = S.w, sh = S.h, sd = S.data;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const X = x + 0.5, Y = y + 0.5;
      const z = Hinv[6] * X + Hinv[7] * Y + Hinv[8];
      let u = (Hinv[0] * X + Hinv[1] * Y + Hinv[2]) / z, v = (Hinv[3] * X + Hinv[4] * Y + Hinv[5]) / z;
      if (u < 0 || u > 1 || v < 0 || v > 1) continue;
      const k = y * W + x;
      // Soft edge of the whole layer (distance to its border, in picture px).
      const dist = Math.min(u * boxW, (1 - u) * boxW, v * boxHh, (1 - v) * boxHh);
      edge[k] = feather > 0.5 ? Math.min(1, dist / feather) : 1;
      if (g.flip) u = 1 - u;
      const fx = Math.min(sw - 1.001, Math.max(0, u * sw - 0.5)), fy = Math.min(sh - 1.001, Math.max(0, v * sh - 0.5));
      const ix = fx | 0, iy = fy | 0, tx = fx - ix, ty = fy - iy;
      const i00 = (iy * sw + ix) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
      const rgb = [0, 0, 0];
      for (let c = 0; c < 3; c++) rgb[c] = (sd[i00 + c] * (1 - tx) + sd[i10 + c] * tx) * (1 - ty) + (sd[i01 + c] * (1 - tx) + sd[i11 + c] * tx) * ty;
      for (let c = 0; c < 3; c++) L[k * 3 + c] = M[c * 4] * rgb[0] + M[c * 4 + 1] * rgb[1] + M[c * 4 + 2] * rgb[2] + M[c * 4 + 3];
    }
  }
  const bd = B.data;
  // Paint seen in the edited picture: our brush colour, or flat areas that differ a lot from the layer.
  const isPaint = new Float32Array(N);
  if (o.mode === 'paint' || o.match > 0) {
    const lum = new Float32Array(N); const lum2 = new Float32Array(N);
    for (let k = 0; k < N; k++) { const l = 0.299 * bd[k * 4] + 0.587 * bd[k * 4 + 1] + 0.114 * bd[k * 4 + 2]; lum[k] = l; lum2[k] = l * l; }
    const r = Math.max(1, Math.round(3 / Math.max(0.25, scale)));
    const m1 = boxBlur(lum, W, H, r, 1), m2 = boxBlur(lum2, W, H, r, 1);
    for (let k = 0; k < N; k++) {
      if (!edge[k]) continue;
      const pr = bd[k * 4], pg = bd[k * 4 + 1], pb = bd[k * 4 + 2];
      const dp = Math.abs(pr - PAINT_RGB[0]) + Math.abs(pg - PAINT_RGB[1]) + Math.abs(pb - PAINT_RGB[2]);
      const diff = (Math.abs(L[k * 3] - pr) + Math.abs(L[k * 3 + 1] - pg) + Math.abs(L[k * 3 + 2] - pb)) / 3;
      const std = Math.sqrt(Math.max(0, m2[k] - m1[k] * m1[k]));
      // Hand paint is a vivid flat colour: white, grey or black areas (a redrawn sink, a wall) never count.
      const mx = Math.max(pr, pg, pb), mn = Math.min(pr, pg, pb), sat = mx > 0 ? (mx - mn) / mx : 0;
      if (dp < 110 || (diff > 50 && std < 9 && sat > 0.45 && mx > 60)) isPaint[k] = 1;
    }
  }
  // Local colour matching: the colour difference where both agree, spread smoothly (no visible square).
  if (o.match > 0) {
    const f = 4; const w4 = Math.ceil(W / f), h4 = Math.ceil(H / f);
    const den = new Float32Array(w4 * h4); const num = [new Float32Array(w4 * h4), new Float32Array(w4 * h4), new Float32Array(w4 * h4)];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const k = y * W + x; if (!edge[k] || isPaint[k]) continue;
      let d = 0; for (let c = 0; c < 3; c++) d += Math.abs(L[k * 3 + c] - bd[k * 4 + c]);
      if (d / 3 > 40) continue;
      const j = Math.floor(y / f) * w4 + Math.floor(x / f);
      den[j]++; for (let c = 0; c < 3; c++) num[c][j] += bd[k * 4 + c] - L[k * 3 + c];
    }
    const R = Math.max(2, Math.round((Math.max(W, H) * 0.035) / f));
    const dB = boxBlur(den, w4, h4, R, 3);
    const fld = num.map((n) => boxBlur(n, w4, h4, R, 3));
    for (let y = 0; y < H; y++) {
      const fy = Math.min(h4 - 1.001, Math.max(0, y / f - 0.5)), yy = fy | 0, ty = fy - yy;
      for (let x = 0; x < W; x++) {
        const k = y * W + x; if (!edge[k]) continue;
        const fx = Math.min(w4 - 1.001, Math.max(0, x / f - 0.5)), xx = fx | 0, tx = fx - xx;
        const j00 = yy * w4 + xx, j10 = j00 + 1, j01 = j00 + w4, j11 = j01 + 1;
        const dd = (dB[j00] * (1 - tx) + dB[j10] * tx) * (1 - ty) + (dB[j01] * (1 - tx) + dB[j11] * tx) * ty;
        if (dd < 1e-4) continue;
        for (let c = 0; c < 3; c++) {
          const F = fld[c];
          const v = ((F[j00] * (1 - tx) + F[j10] * tx) * (1 - ty) + (F[j01] * (1 - tx) + F[j11] * tx) * ty) / dd;
          L[k * 3 + c] += o.match * Math.max(-60, Math.min(60, v));
        }
      }
    }
  }
  // Where the layer goes in.
  let alpha: Float32Array = edge;
  if (o.mode === 'paint') {
    const grow = Math.max(0, Math.round(o.grow / scale)), soft = Math.max(0, Math.round(o.soft / scale));
    let m: Float32Array<ArrayBuffer> = isPaint;
    if (grow > 0) { const b = boxBlur(m, W, H, grow, 1); m = new Float32Array(N); for (let k = 0; k < N; k++) m[k] = b[k] > 0.02 ? 1 : 0; }
    if (soft > 0) m = boxBlur(m, W, H, Math.max(1, Math.round(soft / 2)), 2);
    alpha = new Float32Array(N);
    for (let k = 0; k < N; k++) alpha[k] = edge[k] * m[k];
  }
  const out = new Uint8ClampedArray(bd);
  for (let k = 0; k < N; k++) {
    const a = alpha[k]; if (a <= 0) continue;
    for (let c = 0; c < 3; c++) out[k * 4 + c] = bd[k * 4 + c] * (1 - a) + L[k * 3 + c] * a;
  }
  return { out, alpha };
}

/** Pixels of an image URL, optionally scaled to fit `maxW` wide. */
export async function loadPix(url: string, maxW = 0): Promise<Pix> {
  const bmp = await createImageBitmap(await (await fetch(url)).blob(), { imageOrientation: 'from-image' });
  const k = maxW && bmp.width > maxW ? maxW / bmp.width : 1;
  const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
  const oc = new OffscreenCanvas(w, h);
  const ctx = oc.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  return { w, h, data: ctx.getImageData(0, 0, w, h).data };
}

export async function toPng(p: Pix | { w: number; h: number; data: Uint8ClampedArray }): Promise<Uint8Array> {
  const oc = new OffscreenCanvas(p.w, p.h);
  oc.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(p.data), p.w, p.h), 0, 0);
  return new Uint8Array(await (await oc.convertToBlob({ type: 'image/png' })).arrayBuffer());
}
