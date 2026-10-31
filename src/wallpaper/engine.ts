import { VERTEX, fragmentFor, MOTION_BLUR } from './shaders';

/** Virtual camera shutter for motion blur (≈ 3/4 of a 60 Hz frame). */
const SHUTTER_MS = 12.5;
const MB_SAMPLES = 8;

type Fit = 'cover' | 'contain' | 'stretch' | 'center';
const FIT_INDEX: Record<Fit, number> = { cover: 0, contain: 1, stretch: 2, center: 3 };

export interface ShowMsg {
  url: string;
  type: 'image' | 'gif' | 'video';
  transition: string;
  duration: number;
  easing: string;
  instant?: boolean;
  /** Packed depth map (R fg depth, G bg depth, B matte) for the 2.5D parallax. */
  depthUrl?: string;
  /** Background plate (characters removed) that fills what the camera uncovers. */
  plateUrl?: string;
  /** What the picture is and how far it can move without artifacts (from the depth pass). */
  analysis?: ParAnalysis | null;
}

export interface ParAnalysis {
  kind: 'anime' | 'real' | 'landscape';
  count: number; cover: number; gap: number; busy: number; hair: number; band: number; style: ParStyle;
}
export type ParPreset = 'auto' | 'anime' | 'landscape' | 'real' | 'custom';

/**
 * Per-kind recipes, calibrated on a bench of anime wallpapers, landscapes and
 * photos. "band" = widest strip (px at 1920 wide) the camera may uncover behind
 * a character before the rebuilt background starts to show.
 */
const RECIPES: Record<'anime' | 'real' | 'landscape', { band: number; style: ParStyle; focus: number; dolly: number; blur: number; speed: number }> = {
  anime: { band: 30, style: 'orbit', focus: 0.62, dolly: 0.55, blur: 0.05, speed: 0.8 },
  real: { band: 22, style: 'orbit', focus: 0.66, dolly: 0.4, blur: 0.06, speed: 0.7 },
  landscape: { band: 26, style: 'travel', focus: 0.3, dolly: 1.2, blur: 0, speed: 0.6 },
};

/** Safe strip for one picture under a recipe: thinner with busy backgrounds, loose hair, big characters. */
function safeBand(kind: 'anime' | 'real' | 'landscape', a: ParAnalysis) {
  let band = RECIPES[kind].band;
  if (kind !== 'landscape' && a.kind !== 'landscape') {
    band *= 1 - 0.45 * a.busy;
    band *= 1 - 0.3 * a.hair;
    if (a.cover > 0.45) band *= 0.8;
  }
  return Math.max(9, band);
}

/** Parallax camera: how far (in image width) the nearest layer travels at 100%. */
const PAR_AMP = 0.045;
/** Dolly (push-in) at 100%: how much nearer layers grow relative to farther ones. */
const PAR_DOLLY = 0.12;
const PAR_FADE_MS = 1400;
/** One loop of the camera path at speed 1×, in seconds. */
const PAR_PERIOD = 12;
export type ParStyle = 'orbit' | 'walk' | 'travel' | 'dolly' | 'float';

/** Camera paths (one loop = phase 0..2π): [shift x, shift y, dolly]. */
const PATHS: Record<ParStyle, (p: number) => [number, number, number]> = {
  // Circles around the subject, like an isometric turntable.
  orbit: (p) => [Math.cos(p), 0.55 * Math.sin(p), 0.35 * (0.5 - 0.5 * Math.cos(p * 2))],
  // Walks toward the scene and back with a light head bob.
  walk: (p) => [0.35 * Math.sin(p), 0.16 * Math.sin(p * 4), 0.5 - 0.5 * Math.cos(p)],
  // Slides side to side along the scene.
  travel: (p) => [Math.sin(p), 0.12 * Math.sin(p * 2), 0.25 * (0.5 - 0.5 * Math.cos(p * 2))],
  // Pushes in toward the subject and pulls back out.
  dolly: (p) => [0.22 * Math.sin(p), 0.12 * Math.cos(p), 0.5 - 0.5 * Math.cos(p)],
  // Drifts in a lazy figure eight.
  float: (p) => [0.8 * Math.sin(p) + 0.2 * Math.sin(p * 2.3), 0.5 * Math.sin(p * 2 + 0.6), 0.25 * (0.5 + 0.5 * Math.sin(p * 1.5))],
};

const EASE: Record<string, (t: number) => number> = {
  linear: (t) => t,
  easeInOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  easeInOutQuint: (t) => (t < 0.5 ? 16 * t ** 5 : 1 - Math.pow(-2 * t + 2, 5) / 2),
  easeOutExpo: (t) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  easeInOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  easeOutBack: (t) => { const c1 = 1.20158; const c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
  easeOutQuart: (t) => 1 - Math.pow(1 - t, 4),
  easeInOutExpo: (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2),
  // Critically damped spring (no overshoot) and an under-damped one (small bounce).
  spring: (t) => (t >= 1 ? 1 : (1 - (1 + 9 * t) * Math.exp(-9 * t)) / (1 - 10 * Math.exp(-9))),
  springBounce: (t) => (t >= 1 ? 1 : 1 - Math.exp(-6.5 * t) * Math.cos(9.5 * t) + t * Math.exp(-6.5) * Math.cos(9.5)),
  // iOS default curve: cubic-bezier(0.25, 0.1, 0.25, 1).
  apple: (t) => cubicBezier(0.25, 0.1, 0.25, 1, t),
};

function cubicBezier(x1: number, y1: number, x2: number, y2: number, x: number) {
  const cx = 3 * x1; const bx = 3 * (x2 - x1) - cx; const ax = 1 - cx - bx;
  const cy = 3 * y1; const by = 3 * (y2 - y1) - cy; const ay = 1 - cy - by;
  let t = x;
  // Newton-Raphson on x(t) = x.
  for (let i = 0; i < 6; i++) {
    const err = ((ax * t + bx) * t + cx) * t - x;
    const d = (3 * ax * t + 2 * bx) * t + cx;
    if (Math.abs(d) < 1e-6) break;
    t -= err / d;
  }
  t = Math.min(1, Math.max(0, t));
  return ((ay * t + by) * t + cy) * t;
}

/** A decoded media source bound to a GL texture. */
class Media {
  tex: WebGLTexture;
  width = 1;
  height = 1;
  animated = false;
  mips = false;
  kbStart = performance.now();
  kbSeed = Math.random() * 1000;
  url = '';
  depthTex: WebGLTexture | null = null;
  plateTex: WebGLTexture | null = null;
  analysis: ParAnalysis | null = null;
  /** When the depth map arrived (parallax fades in from there). */
  depthAt = 0;
  private video: HTMLVideoElement | null = null;
  private decoder: any = null;
  private frame: any = null;
  private frameIndex = 0;
  private frameCount = 0;
  private nextFrameAt = 0;
  private decoding = false;
  private disposed = false;
  private needsUpload = false;

  constructor(private gl: WebGL2RenderingContext) {
    this.tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
  }

  async load(msg: ShowMsg, canvasW: number, canvasH: number, wantMips: boolean): Promise<void> {
    this.mips = wantMips;
    this.url = msg.url;
    if (msg.type === 'video') return this.loadVideo(msg.url);
    if (msg.type === 'gif' && 'ImageDecoder' in window) {
      try { return await this.loadAnimated(msg.url, 'image/gif'); } catch (_) { /* fall back to still */ }
    }
    const res = await fetch(msg.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    // Animated WebP support via ImageDecoder when available.
    if (msg.url.toLowerCase().includes('.webp') && 'ImageDecoder' in window) {
      try {
        const D = (window as any).ImageDecoder;
        const dec = new D({ data: await blob.arrayBuffer(), type: 'image/webp' });
        await dec.tracks.ready;
        if (dec.tracks.selectedTrack && dec.tracks.selectedTrack.frameCount > 1) {
          dec.close();
          return await this.loadAnimated(msg.url, 'image/webp');
        }
        dec.close();
      } catch (_) { /* ignore */ }
    }
    const probe = await createImageBitmap(blob);
    let w = probe.width; let h = probe.height;
    // Keep VRAM low: ~1.1× the screen is plenty (incl. Ken Burns); the bitmap is
    // freed right after the upload.
    const ratio = Math.min(w / canvasW, h / canvasH);
    let bmp = probe;
    if (ratio > 1.25) {
      const f = 1.1 / ratio;
      w = Math.round(w * f); h = Math.round(h * f);
      bmp = await createImageBitmap(probe, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
      probe.close();
    }
    this.width = w; this.height = h;
    this.upload(bmp);
    bmp.close();
  }

  private upload(src: TexImageSource) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    if (this.mips) {
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    } else {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    }
  }

  private loadVideo(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const v = document.createElement('video');
      v.muted = true;
      v.loop = true;
      v.playsInline = true;
      v.preload = 'auto';
      v.crossOrigin = 'anonymous';
      v.src = url;
      const onReady = () => {
        v.removeEventListener('loadeddata', onReady);
        this.video = v;
        this.animated = true;
        this.width = v.videoWidth || 1920;
        this.height = v.videoHeight || 1080;
        this.mips = false; // per-frame mipmaps are wasteful
        v.play().catch(() => { /* autoplay muted is allowed */ });
        this.upload(v);
        resolve();
      };
      v.addEventListener('loadeddata', onReady);
      v.addEventListener('error', () => reject(new Error('Não foi possível decodificar o vídeo (use MP4 H.264 ou WebM).')), { once: true });
    });
  }

  private async loadAnimated(url: string, type: string) {
    const D = (window as any).ImageDecoder;
    const res = await fetch(url);
    const data = await res.arrayBuffer();
    const dec = new D({ data, type });
    await dec.tracks.ready;
    await dec.completed.catch(() => {});
    this.decoder = dec;
    this.frameCount = dec.tracks.selectedTrack ? dec.tracks.selectedTrack.frameCount : 1;
    this.animated = this.frameCount > 1;
    this.mips = false;
    const first = await dec.decode({ frameIndex: 0 });
    this.frame = first.image;
    this.width = this.frame.displayWidth;
    this.height = this.frame.displayHeight;
    this.upload(this.frame);
    this.nextFrameAt = performance.now() + Math.max(20, (this.frame.duration || 100000) / 1000);
  }

  /** Called every frame; uploads the newest frame for animated sources. */
  tick(now: number) {
    if (this.disposed || !this.animated) return;
    if (this.video) {
      if (this.video.readyState >= 2 && !this.video.paused) this.upload(this.video);
      return;
    }
    if (this.decoder && !this.decoding && now >= this.nextFrameAt) {
      this.decoding = true;
      this.frameIndex = (this.frameIndex + 1) % this.frameCount;
      this.decoder.decode({ frameIndex: this.frameIndex }).then((r: any) => {
        if (this.disposed) { r.image.close(); return; }
        if (this.frame) this.frame.close();
        this.frame = r.image;
        this.needsUpload = true;
        const dur = Math.max(20, (this.frame.duration || 100000) / 1000);
        this.nextFrameAt = Math.max(performance.now(), this.nextFrameAt + dur);
      }).catch(() => { /* ignore */ }).finally(() => { this.decoding = false; });
    }
    if (this.needsUpload && this.frame) {
      this.needsUpload = false;
      this.upload(this.frame);
    }
  }

  setPaused(p: boolean) {
    if (this.video) {
      if (p) this.video.pause();
      else this.video.play().catch(() => {});
    }
    if (!p && this.decoder) this.nextFrameAt = performance.now();
  }

  /** Loads the packed depth map and the background plate used by the parallax. */
  async loadDepth(url: string, plateUrl: string | undefined, fade: boolean): Promise<void> {
    const bitmap = async (u: string) => {
      const res = await fetch(u);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return createImageBitmap(await res.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    };
    const [dbmp, pbmp] = await Promise.all([bitmap(url), plateUrl ? bitmap(plateUrl).catch(() => null) : Promise.resolve(null)]);
    if (this.disposed) { dbmp.close(); pbmp?.close(); return; }
    const gl = this.gl;
    const up = (tex: WebGLTexture | null, bmp: ImageBitmap, mips: boolean) => {
      const t = tex || gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
      if (mips) gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
      bmp.close();
      return t;
    };
    this.depthTex = up(this.depthTex, dbmp, false);
    if (pbmp) this.plateTex = up(this.plateTex, pbmp, true);
    this.depthAt = fade ? performance.now() : -1e9;
  }

  dispose() {
    this.disposed = true;
    try { this.gl.deleteTexture(this.tex); } catch (_) { /* ignore */ }
    if (this.depthTex) { try { this.gl.deleteTexture(this.depthTex); } catch (_) { /* ignore */ } }
    if (this.plateTex) { try { this.gl.deleteTexture(this.plateTex); } catch (_) { /* ignore */ } }
    if (this.video) { this.video.pause(); this.video.removeAttribute('src'); this.video.load(); this.video = null; }
    if (this.frame) { try { this.frame.close(); } catch (_) { /* ignore */ } }
    if (this.decoder) { try { this.decoder.close(); } catch (_) { /* ignore */ } }
  }
}

export class Engine {
  private gl: WebGL2RenderingContext;
  private programs = new Map<string, { prog: WebGLProgram; loc: Record<string, WebGLUniformLocation | null> }>();
  private compiling = new Map<string, { prog: WebGLProgram; vs: WebGLShader; fs: WebGLShader }>();
  private parallel: { COMPLETION_STATUS_KHR: number } | null = null;
  private from: Media | null = null;
  private to: Media | null = null;
  private transition = 'idle';
  private tStart = 0;
  private tDuration = 1;
  private easing = EASE.easeInOutCubic;
  private seed = Math.random() * 100;
  private raf = 0;
  private paused = false;
  private fit: Fit = 'cover';
  private kenBurns = true;
  private intensity = 1;
  private parallax = false;
  private parStrength = 1;
  private parSpeed = 1;
  private parStyle: ParStyle = 'orbit';
  private parDolly = 1;
  private parFocus = 0.35;
  private parBlur = 0.2;
  private parMouse = true;
  private parPreset: ParPreset = 'auto';
  /** Camera path phase (radians), integrated so speed changes never jump. */
  private parPhase = 0;
  /** Global parallax amount, eased toward 0/1 when the switch changes. */
  private parAmt = 0;
  private parT0 = performance.now();
  private parSeed = Math.random() * 100;
  private pointer = { x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0, inside: false, at: -1e9 };
  private lastFrame = 0;
  private blackTex: WebGLTexture;
  /** Most recently used programs first; only a few stay compiled (GPU memory). */
  private lru: string[] = [];
  private loadToken = 0;
  private firstFrameSent = false;
  onFirstFrame: (() => void) | null = null;
  reloadOnLoss = true;
  onError: ((m: string) => void) | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 indisponível');
    this.gl = gl;
    this.parallel = gl.getExtension('KHR_parallel_shader_compile');
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    this.blackTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.blackTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); if (this.reloadOnLoss) location.reload(); });
    this.resize();
    this.ro = new ResizeObserver(() => { this.resize(); this.kick(); });
    this.ro.observe(canvas);
  }

  private ro: ResizeObserver;

  destroy() {
    this.ro.disconnect();
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.from?.dispose();
    this.to?.dispose();
    this.from = null;
    this.to = null;
    for (const c of this.compiling.values()) { this.gl.deleteProgram(c.prog); this.gl.deleteShader(c.vs); this.gl.deleteShader(c.fs); }
    this.compiling.clear();
    const ext = this.gl.getExtension('WEBGL_lose_context');
    ext?.loseContext();
  }

  private resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round((this.canvas.clientWidth || window.innerWidth) * dpr));
    const h = Math.max(1, Math.round((this.canvas.clientHeight || window.innerHeight) * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  /**
   * Starts compiling a transition without waiting for it. With
   * KHR_parallel_shader_compile the driver works in the background, so the
   * 100–400 ms a big shader takes never freezes the screen.
   */
  private prepare(name: string) {
    if (this.programs.has(name) || this.compiling.has(name)) return;
    const gl = this.gl;
    const mk = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };
    const vs = mk(gl.VERTEX_SHADER, VERTEX);
    const fs = mk(gl.FRAGMENT_SHADER, fragmentFor(name));
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, 'aPos');
    gl.linkProgram(prog);
    this.compiling.set(name, { prog, vs, fs });
  }

  /** True once a prepared transition can be used without a stall. */
  private isReady(name: string) {
    if (this.programs.has(name)) return true;
    const c = this.compiling.get(name);
    if (!c) return false;
    return !this.parallel || !!this.gl.getProgramParameter(c.prog, this.parallel.COMPLETION_STATUS_KHR);
  }

  private program(name: string) {
    let p = this.programs.get(name);
    if (p) { this.touch(name); return p; }
    const gl = this.gl;
    this.prepare(name);
    const { prog, vs, fs } = this.compiling.get(name)!;
    this.compiling.delete(name);
    const fail = (what: string) => { gl.deleteProgram(prog); gl.deleteShader(vs); gl.deleteShader(fs); throw new Error(what); };
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) fail(`shader ${name}: ${gl.getShaderInfoLog(vs)}`);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) fail(`shader ${name}: ${gl.getShaderInfoLog(fs)}`);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) fail(`link ${name}: ${gl.getProgramInfoLog(prog)}`);
    gl.detachShader(prog, vs); gl.detachShader(prog, fs);
    gl.deleteShader(vs); gl.deleteShader(fs);
    const names = ['uFrom', 'uTo', 'uFromSize', 'uToSize', 'uRes', 'uProgress', 'uTime', 'uSeed', 'uFit', 'uFromZoom', 'uToZoom', 'uFromPan', 'uToPan', 'uHasFrom', 'uFromMips', 'uToMips', 'uIntensity', 'uMbSamples', 'uShutter', 'uFromDepth', 'uToDepth', 'uFromPlate', 'uToPlate', 'uFromPar', 'uToPar', 'uFromPar2', 'uToPar2'];
    const loc: Record<string, WebGLUniformLocation | null> = {};
    for (const n of names) loc[n] = gl.getUniformLocation(prog, n);
    p = { prog, loc };
    this.programs.set(name, p);
    this.touch(name);
    return p;
  }

  private touch(name: string) {
    this.lru = [name, ...this.lru.filter((n) => n !== name)];
    const keep = new Set(['idle', this.transition, name]);
    for (let i = this.lru.length - 1; i >= 0 && this.lru.length > 7; i--) {
      const n = this.lru[i];
      if (keep.has(n)) continue;
      const old = this.programs.get(n);
      if (old) { this.gl.deleteProgram(old.prog); this.programs.delete(n); }
      this.lru.splice(i, 1);
    }
  }

  /** Pre-compiles every transition so the first use is instant. */
  warmup(names: string[]) {
    for (const n of ['idle', ...names]) {
      try { this.program(n); } catch (err: any) { this.onError?.(String(err.message || err)); }
    }
  }

  setSettings(s: {
    fit?: Fit; kenBurns?: boolean; intensity?: number; parallax?: boolean; parallaxStrength?: number; parallaxMouse?: boolean;
    parallaxSpeed?: number; parallaxStyle?: ParStyle; parallaxDolly?: number; parallaxFocus?: number; parallaxBlur?: number;
    parallaxPreset?: ParPreset;
  }) {
    if (s.parallaxPreset && ['auto', 'anime', 'landscape', 'real', 'custom'].includes(s.parallaxPreset)) this.parPreset = s.parallaxPreset;
    const num = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : null);
    this.parSpeed = num(s.parallaxSpeed, 0.1, 4) ?? this.parSpeed;
    this.parDolly = num(s.parallaxDolly, 0, 3) ?? this.parDolly;
    this.parFocus = num(s.parallaxFocus, 0, 1) ?? this.parFocus;
    this.parBlur = num(s.parallaxBlur, 0, 1) ?? this.parBlur;
    if (s.parallaxStyle && s.parallaxStyle in PATHS) this.parStyle = s.parallaxStyle;
    if (s.fit && s.fit in FIT_INDEX) this.fit = s.fit;
    if (typeof s.parallax === 'boolean') this.parallax = s.parallax;
    if (typeof s.parallaxStrength === 'number' && Number.isFinite(s.parallaxStrength)) this.parStrength = Math.max(0.1, Math.min(3, s.parallaxStrength));
    if (typeof s.parallaxMouse === 'boolean') this.parMouse = s.parallaxMouse;
    if (typeof s.kenBurns === 'boolean') this.kenBurns = s.kenBurns;
    if (typeof s.intensity === 'number' && Number.isFinite(s.intensity)) this.intensity = Math.max(0.2, Math.min(2, s.intensity));
    this.kick();
  }

  setPaused(p: boolean) {
    this.paused = p;
    this.from?.setPaused(p);
    this.to?.setPaused(p);
    if (!p) this.kick();
  }

  /** Depth map that arrived after the picture (fades the parallax in). */
  async setDepth(msg: { url: string; depthUrl: string; plateUrl?: string; analysis?: ParAnalysis | null }) {
    const m = this.to && this.to.url === msg.url ? this.to : null;
    if (!m) return;
    m.analysis = msg.analysis || null;
    try { await m.loadDepth(msg.depthUrl, msg.plateUrl, true); } catch (err: any) { this.onError?.(`Profundidade: ${err.message || err}`); }
    this.kick();
  }

  /** Cursor over this monitor, -1..1 (the scene leans toward it). */
  setPointer(p: { x: number; y: number; inside?: boolean }) {
    this.pointer.tx = p.x;
    this.pointer.ty = p.y;
    this.pointer.inside = !!p.inside;
    this.pointer.at = performance.now();
    this.kick();
  }

  async show(msg: ShowMsg) {
    const token = ++this.loadToken;
    const media = new Media(this.gl);
    // Compile the transition while the picture loads (in parallel, off the frame loop).
    const willAnimate = !msg.instant && !!this.to;
    const wanted = msg.transition || 'fade';
    if (willAnimate) { try { this.prepare(wanted); } catch (_) { /* reported when used */ } }
    try {
      // Mipmaps always: the blur transitions sample lower mip levels.
      await media.load(msg, this.canvas.width, this.canvas.height, true);
      // Depth that is ready up front comes in without a fade (the picture arrives in 3D).
      if (msg.depthUrl) await media.loadDepth(msg.depthUrl, msg.plateUrl, false).catch(() => {});
      media.analysis = msg.analysis || null;
    } catch (err: any) {
      media.dispose();
      this.onError?.(`Falha ao carregar ${decodeURIComponent(msg.url.split('/').pop() || '')}: ${err.message || err}`);
      return;
    }
    if (token !== this.loadToken) { media.dispose(); return; }
    if (willAnimate) {
      // The old picture keeps animating meanwhile; give up after 4 s and use the fallback.
      const t0 = performance.now();
      while (!this.isReady(wanted) && performance.now() - t0 < 4000) {
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        if (token !== this.loadToken) { media.dispose(); return; }
      }
      if (!this.isReady(wanted)) msg = Object.assign({}, msg, { transition: 'fade' });
    }
    // If a transition is running, freeze it at its end state.
    if (this.from && this.from !== this.to) this.from.dispose();
    this.from = this.to;
    this.to = media;
    if (this.paused) media.setPaused(true);
    const instant = !!msg.instant || !this.from;
    this.transition = instant ? 'idle' : (msg.transition || 'fade');
    try { this.program(this.transition); } catch (err: any) {
      this.onError?.(String(err.message || err));
      this.transition = instant ? 'idle' : 'fade';
    }
    if (instant && this.from) { this.from.dispose(); this.from = null; }
    this.easing = EASE[msg.easing] || EASE.easeInOutCubic;
    this.tDuration = Math.max(150, msg.duration || 1600);
    this.tStart = performance.now();
    this.seed = Math.random() * 100;
    this.kick();
  }

  kick() {
    if (!this.raf) this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  private kb(m: Media, now: number) {
    if (!this.kenBurns) return { zoom: 1, pan: [0, 0] as [number, number] };
    const t = (now - m.kbStart) / 1000;
    // Slow breathing zoom (≈70 s period) with a gentle drift — subtle on purpose.
    const z = 1.0 + 0.045 * (0.5 - 0.5 * Math.cos((t / 70) * Math.PI * 2));
    const px = Math.sin(t / 53 + m.kbSeed) * 0.012;
    const py = Math.cos(t / 61 + m.kbSeed * 1.3) * 0.008;
    return { zoom: z, pan: [px, py] as [number, number] };
  }

  /**
   * Parallax camera for one picture: a looping camera path (orbit, walk,
   * travelling, push-in or float) plus a lean toward the mouse, which follows a
   * critically damped spring so it never jerks. Returns [shift x, shift y,
   * dolly, amount] in image uv.
   */
  /**
   * Settings for one picture. With a preset, the recipe of its kind is applied
   * and the camera is scaled so the strip uncovered behind the characters never
   * exceeds the safe band measured for that picture ("Intensidade" multiplies
   * that band). "custom" uses the sliders as they are.
   */
  private parSettings(m: Media) {
    const a = m.analysis;
    if (this.parPreset === 'custom' || !a) {
      return { style: this.parStyle, focus: this.parFocus, blur: this.parBlur, speed: 1, amp: PAR_AMP * this.parStrength, dolly: PAR_DOLLY * this.parDolly * Math.min(2, this.parStrength) };
    }
    const kind = this.parPreset === 'auto' ? a.kind : this.parPreset;
    const r = RECIPES[kind];
    const style: ParStyle = this.parPreset === 'auto' ? (a.kind === 'landscape' ? 'travel' : a.count > 2 ? 'float' : r.style) : r.style;
    // A touch of depth of field hides the rebuilt strip on detailed backgrounds.
    const blur = kind === 'landscape' ? 0 : r.blur + 0.2 * a.busy;
    // Relative slide of the characters against the background = shift × depth gap
    // (+ half the dolly at the frame edges). Solve the shift for the safe band.
    const want = (safeBand(kind, a) * this.parStrength) / 1920 / Math.max(0.06, a.gap);
    const zPeak = ({ orbit: 0.35, walk: 1, travel: 0.25, dolly: 1, float: 0.5 } as Record<ParStyle, number>)[style];
    const amp = want / (1 + 0.5 * r.dolly * zPeak);
    return { style, focus: r.focus, blur, speed: r.speed, amp, dolly: amp * r.dolly };
  }

  private parCamera(m: Media, now: number): [number, number, number, number] {
    if (!m.depthTex || this.parAmt < 0.001) return [0, 0, 0, 0];
    const fade = Math.min(1, (now - m.depthAt) / PAR_FADE_MS);
    const amt = this.parAmt * fade * fade * (3 - 2 * fade);
    const ps = this.parSettings(m);
    let [vx, vy, vz] = PATHS[ps.style](this.parPhase + this.parSeed);
    if (this.parMouse && now - this.pointer.at < 20000) {
      const w = this.pointer.inside ? 0.6 : 0.3;
      vx += this.pointer.x * w;
      vy += this.pointer.y * w;
    }
    const asp = this.canvas.width / Math.max(1, this.canvas.height);
    // Near things slide against the camera, like looking past them from that side.
    return [-vx * ps.amp, vy * ps.amp * asp * 0.75, vz * ps.dolly, amt];
  }

  private stepParallax(now: number) {
    const dt = Math.min(0.1, Math.max(0, (now - (this.lastFrame || now)) / 1000));
    this.lastFrame = now;
    const kindSpeed = this.to && this.to.analysis ? this.parSettings(this.to).speed : 1;
    this.parPhase = (this.parPhase + dt * this.parSpeed * kindSpeed * (2 * Math.PI / PAR_PERIOD)) % (Math.PI * 2000);
    const target = this.parallax ? 1 : 0;
    this.parAmt += (target - this.parAmt) * (1 - Math.exp(-dt * 2.2));
    if (Math.abs(target - this.parAmt) < 0.002) this.parAmt = target;
    // Critically damped spring toward the cursor (w = 3.2 rad/s: soft, no overshoot).
    const P = this.pointer; const w = 3.2;
    const ax = w * w * (P.tx - P.x) - 2 * w * P.vx;
    const ay = w * w * (P.ty - P.y) - 2 * w * P.vy;
    P.vx += ax * dt; P.vy += ay * dt;
    P.x += P.vx * dt; P.y += P.vy * dt;
  }

  private frame(now: number) {
    this.raf = 0;
    if (!this.to) return;
    const gl = this.gl;
    this.resize();
    const transitioning = this.transition !== 'idle';
    let progress = 1;
    if (transitioning) {
      progress = Math.min(1, (now - this.tStart) / this.tDuration);
      if (progress >= 1) {
        this.transition = 'idle';
        if (this.from) { this.from.dispose(); this.from = null; }
      }
    }
    if (this.paused && !transitioning && this.firstFrameSent) return;
    this.from?.tick(now);
    this.to.tick(now);

    let p;
    try { p = this.program(transitioning ? this.transition : 'idle'); } catch (err: any) {
      this.onError?.(String(err.message || err));
      this.transition = 'idle';
      p = this.program('idle');
    }
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(p.prog);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const L = p.loc;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.from ? this.from.tex : this.to.tex);
    gl.uniform1i(L.uFrom, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.to.tex);
    gl.uniform1i(L.uTo, 1);
    const fromM = this.from || this.to;
    gl.uniform2f(L.uFromSize, fromM.width, fromM.height);
    gl.uniform2f(L.uToSize, this.to.width, this.to.height);
    gl.uniform2f(L.uRes, this.canvas.width, this.canvas.height);
    gl.uniform1f(L.uProgress, transitioning ? this.easing(progress) : 1);
    // Shutter = how far the eased progress moves during the exposure, so the blur
    // follows the real speed: none at rest, longest at the fastest point.
    let shutter = 0;
    if (transitioning && MOTION_BLUR.has(this.transition)) {
      const h = SHUTTER_MS / 2 / this.tDuration;
      shutter = Math.abs(this.easing(Math.min(1, progress + h)) - this.easing(Math.max(0, progress - h))) * this.intensity;
    }
    gl.uniform1i(L.uMbSamples, shutter > 1e-4 ? MB_SAMPLES : 1);
    gl.uniform1f(L.uShutter, shutter);
    gl.uniform1f(L.uTime, now / 1000);
    gl.uniform1f(L.uSeed, this.seed);
    gl.uniform1i(L.uFit, FIT_INDEX[this.fit]);
    this.stepParallax(now);
    const kf = this.kb(fromM, now);
    const kt = this.kb(this.to, now);
    const pf = this.parCamera(fromM, now);
    const pt = this.parCamera(this.to, now);
    // Overscan so the shifted layers never reveal the picture's border: the
    // farthest a pixel can travel is the shift/dolly times its distance to the focus.
    const sf = this.parSettings(fromM); const st = this.parSettings(this.to);
    const over = (p: number[], focus: number) => 1 + (2 * Math.hypot(p[0], p[1]) + Math.abs(p[2])) * Math.max(focus, 1 - focus) * p[3] + 0.004 * p[3];
    gl.uniform1f(L.uFromZoom, kf.zoom * over(pf, sf.focus));
    gl.uniform1f(L.uToZoom, kt.zoom * over(pt, st.focus));
    gl.uniform4f(L.uFromPar, pf[0], pf[1], pf[2], pf[3]);
    gl.uniform4f(L.uToPar, pt[0], pt[1], pt[2], pt[3]);
    gl.uniform2f(L.uFromPar2, sf.focus, sf.blur);
    gl.uniform2f(L.uToPar2, st.focus, st.blur);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, fromM.plateTex || this.blackTex);
    gl.uniform1i(L.uFromPlate, 4);
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, this.to.plateTex || this.blackTex);
    gl.uniform1i(L.uToPlate, 5);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, fromM.depthTex || this.blackTex);
    gl.uniform1i(L.uFromDepth, 2);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.to.depthTex || this.blackTex);
    gl.uniform1i(L.uToDepth, 3);
    gl.uniform2f(L.uFromPan, kf.pan[0], kf.pan[1]);
    gl.uniform2f(L.uToPan, kt.pan[0], kt.pan[1]);
    gl.uniform1f(L.uHasFrom, this.from ? 1 : 0);
    gl.uniform1f(L.uFromMips, fromM.mips ? 1 : 0);
    gl.uniform1f(L.uToMips, this.to.mips ? 1 : 0);
    gl.uniform1f(L.uIntensity, this.intensity);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    if (!this.firstFrameSent) {
      this.firstFrameSent = true;
      // Wait one more frame so the compositor actually presented it.
      requestAnimationFrame(() => this.onFirstFrame?.());
    }
    const animated = this.to.animated || (this.from?.animated ?? false);
    const parActive = this.parAmt > 0.001 && !!(this.to.depthTex || fromM.depthTex);
    if (!this.paused && (this.transition !== 'idle' || this.kenBurns || animated || parActive || (this.parallax && this.parAmt < 1))) this.kick();
    else if (this.paused && this.transition !== 'idle') this.kick();
  }
}
