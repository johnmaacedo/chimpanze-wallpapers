// Photographic looks of the Editor's "Filtros" tab. Each one is a small colour
// recipe run by the film stage of the shader (gl.ts): a 3×3 colour matrix,
// per-channel gain, gamma, an S-curve, tints for shadows and highlights,
// saturation, optional black-and-white mix and a matte "fade". They are my own
// approximations of how each stock / camera / grade is known to look, not
// measured profiles; the names only say which look is being imitated.

export interface Film {
  id: string; label: string; cat: FilmCat;
  /** Colour matrix (row-major) applied first. */
  mat?: number[];
  gain?: [number, number, number];
  gamma?: number;
  /** -0.5 (flat) .. 0.5 (hard). */
  con?: number;
  sat?: number;
  shadow?: [number, number, number];
  high?: [number, number, number];
  /** Black-and-white: how much of R, G, B makes the grey. */
  mono?: [number, number, number];
  fade?: number;
  /** Lens/film effects the look starts with (the sliders can change them). */
  fx?: { grain?: number; halation?: number; bloom?: number; vignette?: number };
}

export type FilmCat = 'neg' | 'slide' | 'bw' | 'cam' | 'cine' | 'day';
export const FILM_CATS: { id: FilmCat; label: string }[] = [
  { id: 'neg', label: 'Filme' }, { id: 'slide', label: 'Slide' }, { id: 'bw', label: 'P&B' },
  { id: 'cam', label: 'Câmeras' }, { id: 'cine', label: 'Cinema' }, { id: 'day', label: 'Dia a dia' },
];

const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
/** Matrix that pushes saturation of one family of colours: `k` > 0 separates the channels more. */
const sep = (r: number, g: number, b: number) => [1 + r, -r / 2, -r / 2, -g / 2, 1 + g, -g / 2, -b / 2, -b / 2, 1 + b];

export const FILMS: Film[] = [
  // --- Negative film -------------------------------------------------------
  { id: 'portra160', label: 'Portra 160', cat: 'neg', con: -0.06, sat: 0.92, gain: [1.03, 1.0, 0.96], shadow: [-0.01, 0.01, 0.015], high: [0.015, 0.008, -0.008], fade: 0.03, fx: { grain: 0.08 } },
  { id: 'portra400', label: 'Portra 400', cat: 'neg', con: 0.03, sat: 0.96, gain: [1.045, 1.0, 0.95], shadow: [0, 0.012, 0.02], high: [0.02, 0.01, -0.01], fade: 0.025, fx: { grain: 0.14 } },
  { id: 'portra800', label: 'Portra 800', cat: 'neg', con: 0.07, sat: 1.0, gain: [1.06, 1.0, 0.93], shadow: [0.01, 0.015, 0.02], high: [0.025, 0.01, -0.015], fade: 0.03, fx: { grain: 0.24 } },
  { id: 'gold200', label: 'Gold 200', cat: 'neg', con: 0.1, sat: 1.12, gain: [1.08, 1.02, 0.88], shadow: [0.01, 0, -0.01], high: [0.03, 0.02, -0.02], fx: { grain: 0.16 } },
  { id: 'ultramax', label: 'UltraMax 400', cat: 'neg', con: 0.13, sat: 1.16, gain: [1.06, 1.0, 0.92], shadow: [0.005, 0.005, 0.01], high: [0.02, 0.012, -0.015], fx: { grain: 0.22 } },
  { id: 'ektar100', label: 'Ektar 100', cat: 'neg', con: 0.16, sat: 1.22, mat: sep(0.08, 0.02, 0.08), gain: [1.02, 1.0, 1.0], shadow: [-0.005, 0, 0.012], fx: { grain: 0.05 } },
  { id: 'fuji400h', label: 'Fuji 400H', cat: 'neg', con: -0.03, sat: 0.9, gain: [0.98, 1.02, 1.0], shadow: [-0.015, 0.015, 0.01], high: [0, 0.01, 0.005], fade: 0.04, gamma: 0.96, fx: { grain: 0.12 } },
  { id: 'superia', label: 'Superia 400', cat: 'neg', con: 0.1, sat: 1.08, mat: sep(0, 0.06, 0), gain: [0.99, 1.03, 0.98], shadow: [-0.01, 0.02, 0], fx: { grain: 0.2 } },
  { id: 'cine800t', label: 'CineStill 800T', cat: 'neg', con: 0.08, sat: 1.0, gain: [0.94, 1.0, 1.1], shadow: [-0.01, 0.01, 0.03], high: [0.03, 0, -0.01], fx: { grain: 0.24, halation: 0.6 } },
  { id: 'cine50d', label: 'CineStill 50D', cat: 'neg', con: 0.1, sat: 1.05, gain: [1.03, 1.0, 0.97], high: [0.015, 0.005, -0.005], fx: { grain: 0.06, halation: 0.35 } },
  // --- Slide film ----------------------------------------------------------
  { id: 'velvia50', label: 'Velvia 50', cat: 'slide', con: 0.24, sat: 1.4, mat: sep(0.05, 0.08, 0.06), gain: [1.0, 1.0, 1.03], shadow: [-0.015, -0.01, 0.01], fx: { grain: 0.04 } },
  { id: 'provia', label: 'Provia 100F', cat: 'slide', con: 0.12, sat: 1.1, gain: [0.99, 1.0, 1.02], fx: { grain: 0.04 } },
  { id: 'astia', label: 'Astia 100F', cat: 'slide', con: 0.04, sat: 1.03, gain: [1.01, 1.0, 0.99], high: [0.01, 0.005, 0], fx: { grain: 0.04 } },
  { id: 'ektachrome', label: 'Ektachrome E100', cat: 'slide', con: 0.14, sat: 1.12, gain: [0.98, 1.0, 1.05], shadow: [0, 0, 0.02], fx: { grain: 0.05 } },
  { id: 'kodachrome', label: 'Kodachrome 64', cat: 'slide', con: 0.22, sat: 1.12, mat: sep(0.12, 0, 0.04), gain: [1.04, 1.0, 0.94], shadow: [-0.01, 0, 0.015], high: [0.02, 0.01, -0.02], fx: { grain: 0.07 } },
  // --- Black and white -----------------------------------------------------
  { id: 'trix', label: 'Tri-X 400', cat: 'bw', mono: [0.3, 0.59, 0.11], con: 0.28, shadow: [-0.01, -0.01, -0.01], fx: { grain: 0.32 } },
  { id: 'hp5', label: 'HP5 Plus', cat: 'bw', mono: [0.33, 0.5, 0.17], con: 0.12, fade: 0.03, fx: { grain: 0.24 } },
  { id: 'acros', label: 'Acros 100', cat: 'bw', mono: [0.2, 0.65, 0.15], con: 0.2, fx: { grain: 0.06 } },
  { id: 'delta3200', label: 'Delta 3200', cat: 'bw', mono: [0.3, 0.55, 0.15], con: 0.16, fade: 0.05, fx: { grain: 0.55 } },
  { id: 'redfilter', label: 'Filtro vermelho', cat: 'bw', mono: [0.75, 0.25, 0.0], con: 0.3, fx: { grain: 0.12 } },
  { id: 'sepia', label: 'Sépia antigo', cat: 'bw', mono: [0.33, 0.5, 0.17], con: 0.06, shadow: [0.02, 0.01, -0.01], high: [0.07, 0.04, -0.04], fade: 0.05, fx: { grain: 0.2, vignette: 0.3 } },
  { id: 'selenium', label: 'Selênio', cat: 'bw', mono: [0.3, 0.59, 0.11], con: 0.18, shadow: [0.0, 0.0, 0.025], high: [0.015, 0.0, 0.01], fx: { grain: 0.1 } },
  // --- Cameras -------------------------------------------------------------
  { id: 'classicChrome', label: 'Classic Chrome', cat: 'cam', con: 0.14, sat: 0.78, mat: sep(0.02, 0, -0.08), gain: [1.0, 1.0, 0.97], shadow: [0, 0.01, 0.015] },
  { id: 'classicNeg', label: 'Classic Neg', cat: 'cam', con: 0.2, sat: 0.9, shadow: [-0.015, 0.02, 0.01], high: [0.03, 0.01, -0.02], fx: { grain: 0.1 } },
  { id: 'eterna', label: 'Eterna', cat: 'cam', con: -0.08, sat: 0.72, shadow: [0, 0.012, 0.02], fade: 0.05 },
  { id: 'nostalgic', label: 'Nostalgic Neg', cat: 'cam', con: 0.05, sat: 0.96, shadow: [0.01, 0, -0.005], high: [0.05, 0.03, -0.03], fx: { grain: 0.1 } },
  { id: 'leica', label: 'Estilo Leica', cat: 'cam', con: 0.18, sat: 0.95, gain: [1.02, 1.0, 0.98], shadow: [-0.01, -0.005, 0], fx: { vignette: 0.25 } },
  { id: 'hasselblad', label: 'Estilo Hasselblad', cat: 'cam', con: 0.04, sat: 1.03, gamma: 0.97, high: [0.005, 0.005, 0] },
  { id: 'polaroid', label: 'Polaroid 600', cat: 'cam', con: -0.05, sat: 0.85, gain: [1.03, 1.02, 0.94], shadow: [0, 0.03, 0.04], high: [0.04, 0.03, -0.02], fade: 0.1, fx: { vignette: 0.3, grain: 0.1 } },
  { id: 'lomo', label: 'Lomo', cat: 'cam', con: 0.3, sat: 1.35, shadow: [-0.02, 0.03, 0.05], high: [0.05, 0.04, -0.05], fx: { vignette: 0.55, grain: 0.15 } },
  { id: 'disposable', label: 'Descartável com flash', cat: 'cam', con: 0.15, sat: 1.1, gain: [1.05, 1.0, 0.95], fade: 0.03, fx: { grain: 0.26, vignette: 0.4, bloom: 0.15 } },
  // --- Cinema --------------------------------------------------------------
  { id: 'k2383', label: 'Cópia Kodak 2383', cat: 'cine', con: 0.2, sat: 0.95, shadow: [-0.01, 0.01, 0.03], high: [0.03, 0.015, -0.02], fx: { grain: 0.1 } },
  { id: 'tealOrange', label: 'Teal & orange', cat: 'cine', con: 0.15, sat: 1.05, shadow: [-0.04, 0.02, 0.05], high: [0.06, 0.02, -0.05] },
  { id: 'bleach', label: 'Bleach bypass', cat: 'cine', con: 0.36, sat: 0.45, fx: { grain: 0.16 } },
  { id: 'technicolor', label: 'Technicolor', cat: 'cine', con: 0.18, sat: 1.2, mat: [1.25, -0.15, -0.1, -0.1, 1.2, -0.1, -0.1, -0.15, 1.25] },
  { id: 'dayNight', label: 'Noite americana', cat: 'cine', con: 0.15, sat: 0.6, gain: [0.55, 0.7, 1.0], gamma: 1.12, shadow: [0, 0, 0.02] },
  { id: 'neon', label: 'Neon', cat: 'cine', con: 0.2, sat: 1.25, shadow: [0.03, -0.02, 0.07], high: [-0.03, 0.04, 0.05], fx: { bloom: 0.3, halation: 0.25 } },
  { id: 'matrix', label: 'Verde digital', cat: 'cine', con: 0.15, sat: 0.85, gain: [0.95, 1.06, 0.92], shadow: [-0.01, 0.03, 0] },
  { id: 'western', label: 'Deserto quente', cat: 'cine', con: 0.15, sat: 0.9, gain: [1.1, 1.0, 0.82], fade: 0.02, fx: { grain: 0.12 } },
  { id: 'pastelFilm', label: 'Pastel simétrico', cat: 'cine', con: -0.05, sat: 1.1, shadow: [0.02, 0, 0.02], high: [0.04, 0.02, 0], fade: 0.05 },
  // --- Everyday ------------------------------------------------------------
  { id: 'food', label: 'Comida', cat: 'day', con: 0.08, sat: 1.22, gain: [1.05, 1.01, 0.95], gamma: 0.94 },
  { id: 'softSkin', label: 'Pele suave', cat: 'day', con: -0.06, sat: 0.96, gamma: 0.96, high: [0.02, 0.01, 0], fx: { bloom: 0.14 } },
  { id: 'pastel', label: 'Pastel', cat: 'day', con: -0.18, sat: 0.85, gamma: 0.93, fade: 0.06 },
  { id: 'animeSky', label: 'Céu de anime', cat: 'day', con: 0.1, sat: 1.3, mat: sep(0, 0.03, 0.12), shadow: [-0.01, 0, 0.04], high: [0.02, 0.01, 0], fx: { bloom: 0.25 } },
  { id: 'sunset', label: 'Pôr do sol', cat: 'day', con: 0.08, sat: 1.15, gain: [1.1, 1.0, 0.85], high: [0.05, 0.02, -0.04] },
  { id: 'coldMorning', label: 'Manhã fria', cat: 'day', con: 0.05, sat: 0.95, gain: [0.95, 1.0, 1.08], fade: 0.02 },
];

export const FILM_BY_ID: Record<string, Film> = Object.fromEntries(FILMS.map((f) => [f.id, f]));
export const IDENTITY = I;
