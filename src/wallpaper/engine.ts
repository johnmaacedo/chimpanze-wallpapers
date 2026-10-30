import { VERTEX, fragmentFor } from './shaders';

type Fit = 'cover' | 'contain' | 'stretch' | 'center';
const FIT_INDEX: Record<Fit, number> = { cover: 0, contain: 1, stretch: 2, center: 3 };

export interface ShowMsg {
  url: string;
  type: 'image' | 'gif' | 'video';
  transition: string;
  duration: number;
  easing: string;
  instant?: boolean;
}

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

  dispose() {
    this.disposed = true;
    try { this.gl.deleteTexture(this.tex); } catch (_) { /* ignore */ }
    if (this.video) { this.video.pause(); this.video.removeAttribute('src'); this.video.load(); this.video = null; }
    if (this.frame) { try { this.frame.close(); } catch (_) { /* ignore */ } }
    if (this.decoder) { try { this.decoder.close(); } catch (_) { /* ignore */ } }
  }
}

export class Engine {
  private gl: WebGL2RenderingContext;
  private programs = new Map<string, { prog: WebGLProgram; loc: Record<string, WebGLUniformLocation | null> }>();
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
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
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

  private program(name: string) {
    let p = this.programs.get(name);
    if (p) { this.touch(name); return p; }
    const gl = this.gl;
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`shader ${name}: ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fragmentFor(name)));
    gl.bindAttribLocation(prog, 0, 'aPos');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`link ${name}: ${gl.getProgramInfoLog(prog)}`);
    const names = ['uFrom', 'uTo', 'uFromSize', 'uToSize', 'uRes', 'uProgress', 'uTime', 'uSeed', 'uFit', 'uFromZoom', 'uToZoom', 'uFromPan', 'uToPan', 'uHasFrom', 'uFromMips', 'uToMips', 'uIntensity'];
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

  setSettings(s: { fit?: Fit; kenBurns?: boolean; intensity?: number }) {
    if (s.fit && s.fit in FIT_INDEX) this.fit = s.fit;
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

  async show(msg: ShowMsg) {
    const token = ++this.loadToken;
    const media = new Media(this.gl);
    try {
      // Mipmaps always: the blur transitions sample lower mip levels.
      await media.load(msg, this.canvas.width, this.canvas.height, true);
    } catch (err: any) {
      media.dispose();
      this.onError?.(`Falha ao carregar ${decodeURIComponent(msg.url.split('/').pop() || '')}: ${err.message || err}`);
      return;
    }
    if (token !== this.loadToken) { media.dispose(); return; }
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
    gl.uniform1f(L.uTime, now / 1000);
    gl.uniform1f(L.uSeed, this.seed);
    gl.uniform1i(L.uFit, FIT_INDEX[this.fit]);
    const kf = this.kb(fromM, now);
    const kt = this.kb(this.to, now);
    gl.uniform1f(L.uFromZoom, kf.zoom);
    gl.uniform1f(L.uToZoom, kt.zoom);
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
    if (!this.paused && (this.transition !== 'idle' || this.kenBurns || animated)) this.kick();
    else if (this.paused && this.transition !== 'idle') this.kick();
  }
}
