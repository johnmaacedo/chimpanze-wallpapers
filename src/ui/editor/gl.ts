// GPU image pipeline of the Editor: every adjustment runs in one WebGL2 fragment
// shader, so the preview is live even on 8K images and the export is pixel-exact.

export interface Crop { x: number; y: number; w: number; h: number }
export interface Adjust {
  exposure: number; contrast: number; highlights: number; shadows: number; whites: number; blacks: number;
  temperature: number; tint: number; saturation: number; vibrance: number;
  /** Per colour band (red, orange, yellow, green, cyan, blue, purple, magenta): hue, saturation, luminance. */
  hsl: { h: number; s: number; l: number }[];
  /** 5 control points (0, .25, .5, .75, 1) per channel. */
  curve: { master: number[]; r: number[]; g: number[]; b: number[] };
  sharpen: number; clarity: number; denoise: number; deband: number; dehaze: number; vignette: number; grain: number;
  rotate: 0 | 90 | 180 | 270; flipX: boolean; flipY: boolean;
  /** Normalised crop rectangle in the rotated image. */
  crop: Crop;
}

export const CURVE_X = [0, 0.25, 0.5, 0.75, 1];

export function defaultAdjust(): Adjust {
  return {
    exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
    temperature: 0, tint: 0, saturation: 0, vibrance: 0,
    hsl: Array.from({ length: 8 }, () => ({ h: 0, s: 0, l: 0 })),
    curve: { master: [...CURVE_X], r: [...CURVE_X], g: [...CURVE_X], b: [...CURVE_X] },
    sharpen: 0, clarity: 0, denoise: 0, deband: 0, dehaze: 0, vignette: 0, grain: 0,
    rotate: 0, flipX: false, flipY: false,
    crop: { x: 0, y: 0, w: 1, h: 1 },
  };
}

export const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

const VERT = `#version 300 es
in vec2 aPos; out vec2 vUv;
void main(){ vUv = aPos*0.5+0.5; gl_Position = vec4(aPos,0.,1.); }`;

const FRAG = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uTex; uniform sampler2D uLut;
uniform vec2 uTexel; uniform float uBypass;
uniform vec4 uCrop; uniform int uRot; uniform vec2 uFlip; uniform vec2 uOutSize;
uniform float uExposure, uContrast, uHighlights, uShadows, uWhites, uBlacks;
uniform float uTemp, uTint, uSat, uVib;
uniform vec3 uHsl[8];
uniform float uSharpen, uClarity, uDenoise, uDeband, uDehaze, uVignette, uGrain, uSeed;

vec2 mapUv(vec2 uv){
  // output uv -> crop -> undo flips -> undo rotation -> texture uv (top-left origin)
  vec2 c = uCrop.xy + vec2(uv.x, 1.0-uv.y) * uCrop.zw;
  if (uFlip.x > 0.5) c.x = 1.0 - c.x;
  if (uFlip.y > 0.5) c.y = 1.0 - c.y;
  if (uRot == 90) c = vec2(c.y, 1.0 - c.x);
  else if (uRot == 180) c = vec2(1.0 - c.x, 1.0 - c.y);
  else if (uRot == 270) c = vec2(1.0 - c.y, c.x);
  return c;
}
float luma(vec3 c){ return dot(c, vec3(0.2126,0.7152,0.0722)); }
vec3 rgb2hsv(vec3 c){ vec4 K=vec4(0.,-1./3.,2./3.,-1.); vec4 p=mix(vec4(c.bg,K.wz),vec4(c.gb,K.xy),step(c.b,c.g)); vec4 q=mix(vec4(p.xyw,c.r),vec4(c.r,p.yzx),step(p.x,c.r)); float d=q.x-min(q.w,q.y); float e=1e-10; return vec3(abs(q.z+(q.w-q.y)/(6.*d+e)),d/(q.x+e),q.x); }
vec3 hsv2rgb(vec3 c){ vec4 K=vec4(1.,2./3.,1./3.,3.); vec3 p=abs(fract(c.xxx+K.xyz)*6.-K.www); return c.z*mix(K.xxx,clamp(p-K.xxx,0.,1.),c.y); }
float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233)) + uSeed) * 43758.5453); }
vec3 curve(vec3 c){
  c = clamp(c,0.,1.);
  vec3 m = vec3(texture(uLut, vec2(c.r,0.125)).a, texture(uLut, vec2(c.g,0.125)).a, texture(uLut, vec2(c.b,0.125)).a);
  return vec3(texture(uLut, vec2(m.r,0.375)).r, texture(uLut, vec2(m.g,0.625)).g, texture(uLut, vec2(m.b,0.875)).b);
}

void main(){
  vec2 uv = mapUv(vUv);
  vec3 c = texture(uTex, uv).rgb;
  if (uBypass > 0.5) { o = vec4(c,1.); return; }

  // --- Detail: denoise (edge-aware 3x3), sharpen (unsharp), clarity (mip-based local contrast)
  if (uDenoise > 0.001) {
    vec3 acc = vec3(0.); float wsum = 0.;
    for (int y=-1;y<=1;y++) for (int x=-1;x<=1;x++) {
      vec3 s = texture(uTex, uv + vec2(float(x),float(y))*uTexel*1.5).rgb;
      float w = exp(-dot(s-c,s-c) * mix(400.,40.,uDenoise));
      acc += s*w; wsum += w;
    }
    c = mix(c, acc/wsum, uDenoise);
  }
  if (abs(uSharpen) > 0.001) {
    vec3 b = (texture(uTex, uv+vec2(uTexel.x,0.)).rgb + texture(uTex, uv-vec2(uTexel.x,0.)).rgb + texture(uTex, uv+vec2(0.,uTexel.y)).rgb + texture(uTex, uv-vec2(0.,uTexel.y)).rgb) * 0.25;
    c += (c - b) * uSharpen * 1.6;
  }
  if (abs(uClarity) > 0.001 || uDehaze > 0.001) {
    vec3 blur = textureLod(uTex, uv, 4.5).rgb;
    float l = luma(c), lb = luma(blur);
    float mid = 1.0 - abs(l*2.-1.); // protect deep shadows/highlights
    c += (l - lb) * uClarity * 1.2 * mid;
    if (uDehaze > 0.001) {
      float haze = min(min(blur.r,blur.g),blur.b);
      c = (c - haze*uDehaze*0.6) / max(1.0 - haze*uDehaze*0.6, 0.2);
    }
  }
  if (uDeband > 0.001) {
    // Smooth tiny steps in flat gradients, then add sub-LSB dither so they can't come back.
    vec3 s = (texture(uTex, uv+vec2(3.,0.)*uTexel).rgb + texture(uTex, uv-vec2(3.,0.)*uTexel).rgb + texture(uTex, uv+vec2(0.,3.)*uTexel).rgb + texture(uTex, uv-vec2(0.,3.)*uTexel).rgb)*0.25;
    float flatW = 1.0 - smoothstep(0.004, 0.02, length(s - c));
    c = mix(c, s, flatW * uDeband);
    c += (hash(vUv*uOutSize) - 0.5) / 255.0 * 1.5 * uDeband;
  }

  // --- Light
  c *= exp2(uExposure);
  float l = luma(c);
  c += c * uShadows * 0.9 * pow(1.0 - clamp(l,0.,1.), 3.0);
  c += c * uHighlights * 0.6 * pow(clamp(l,0.,1.), 3.0);
  c = (c - uBlacks*0.08) / max(1.0 + uWhites*0.25 - uBlacks*0.08, 0.05);
  c = (c - 0.5) * (1.0 + uContrast) + 0.5;

  // --- White balance (temperature / tint)
  c *= vec3(1.0 + uTemp*0.18, 1.0 - uTint*0.12, 1.0 - uTemp*0.18);
  c *= vec3(1.0 + uTint*0.06, 1.0, 1.0 + uTint*0.06);

  // --- Saturation / vibrance
  float g = luma(c);
  float sat = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
  c = mix(vec3(g), c, 1.0 + uSat + uVib * (1.0 - sat) * 1.2);

  // --- HSL per colour band
  vec3 hsv = rgb2hsv(clamp(c,0.,1.));
  // band centres (degrees): red, orange, yellow, green, cyan, blue, purple, magenta
  float centres[8] = float[8](0., 30., 60., 120., 180., 240., 280., 320.);
  float widths[8] = float[8](30., 22., 30., 50., 45., 45., 30., 35.);
  float hdeg = hsv.x * 360.0;
  vec3 adj = vec3(0.);
  for (int i=0;i<8;i++){
    float d = abs(hdeg - centres[i]); d = min(d, 360.0 - d);
    float w = clamp(1.0 - d / widths[i], 0., 1.) * smoothstep(0.02, 0.15, hsv.y);
    adj += uHsl[i] * w;
  }
  hsv.x = fract(hsv.x + adj.x * 0.08);
  hsv.y = clamp(hsv.y * (1.0 + adj.y), 0., 1.);
  hsv.z = clamp(hsv.z * (1.0 + adj.z * 0.5), 0., 1.);
  c = hsv2rgb(hsv);

  // --- Curves
  c = curve(c);

  // --- Vignette / grain
  vec2 d = vUv - 0.5; d.x *= uOutSize.x/uOutSize.y;
  float v = smoothstep(0.35, 1.1, length(d));
  c *= 1.0 - uVignette * v * 0.85;
  c += (hash(vUv*uOutSize + 7.0) - 0.5) * uGrain * 0.12;

  o = vec4(clamp(c,0.,1.), 1.);
}`;

/** Catmull-Rom through evenly spaced points, evaluated at t in [0, 1]. */
export function curveAt(pts: number[], t: number) {
  const n = pts.length - 1;
  const x = Math.min(n - 1e-6, Math.max(0, t * n));
  const i = Math.floor(x);
  const f = x - i;
  const p0 = pts[Math.max(0, i - 1)]; const p1 = pts[i]; const p2 = pts[i + 1]; const p3 = pts[Math.min(n, i + 2)];
  const v = 0.5 * (2 * p1 + (-p0 + p2) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f * f + (-p0 + 3 * p1 - 3 * p2 + p3) * f * f * f);
  return Math.min(1, Math.max(0, v));
}

const UNIFORMS = 'uTex uLut uTexel uBypass uCrop uRot uFlip uOutSize uExposure uContrast uHighlights uShadows uWhites uBlacks uTemp uTint uSat uVib uHsl uSharpen uClarity uDenoise uDeband uDehaze uVignette uGrain uSeed'.split(' ');

export class EditorGL {
  readonly gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private tex: WebGLTexture | null = null;
  private lut: WebGLTexture;
  width = 0;
  height = 0;
  private loc: Record<string, WebGLUniformLocation | null> = {};

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false, premultipliedAlpha: false });
    if (!gl) throw new Error('WebGL2 indisponível');
    this.gl = gl;
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.bindAttribLocation(prog, 0, 'aPos');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link');
    this.prog = prog;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    for (const u of UNIFORMS) this.loc[u] = gl.getUniformLocation(prog, u);
    this.lut = gl.createTexture()!;
  }

  async load(url: string) {
    const blob = await (await fetch(url)).blob();
    const probe = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    const gl = this.gl;
    const max = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    let bmp = probe;
    if (probe.width > max || probe.height > max) {
      const f = max / Math.max(probe.width, probe.height);
      bmp = await createImageBitmap(blob, { resizeWidth: Math.floor(probe.width * f), resizeHeight: Math.floor(probe.height * f), resizeQuality: 'high' });
      probe.close();
    }
    if (this.tex) gl.deleteTexture(this.tex);
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.width = bmp.width;
    this.height = bmp.height;
    bmp.close();
  }

  /** Size of the result (rotation + crop applied). */
  outputSize(a: Adjust) {
    const swap = a.rotate === 90 || a.rotate === 270;
    const w = swap ? this.height : this.width;
    const h = swap ? this.width : this.height;
    return { w: Math.max(1, Math.round(w * a.crop.w)), h: Math.max(1, Math.round(h * a.crop.h)) };
  }

  private uploadLut(a: Adjust) {
    const gl = this.gl;
    // Row 0 = master curve, rows 1..3 = R, G, B.
    const data = new Uint8Array(256 * 4 * 4);
    const rows = [a.curve.master, a.curve.r, a.curve.g, a.curve.b];
    for (let r = 0; r < 4; r++) {
      for (let i = 0; i < 256; i++) {
        const v = Math.round(curveAt(rows[r], i / 255) * 255);
        const k = (r * 256 + i) * 4;
        data[k] = data[k + 1] = data[k + 2] = data[k + 3] = v;
      }
    }
    gl.bindTexture(gl.TEXTURE_2D, this.lut);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 4, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  /** Renders into the current framebuffer. `texelScale` widens the detail kernels for a downscaled preview. */
  draw(a: Adjust, w: number, h: number, bypass = false, texelScale = 1) {
    const gl = this.gl;
    if (!this.tex) return;
    this.uploadLut(a);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.prog);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(this.loc.uTex, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lut);
    gl.uniform1i(this.loc.uLut, 1);
    const L = this.loc;
    gl.uniform2f(L.uTexel, texelScale / this.width, texelScale / this.height);
    gl.uniform1f(L.uBypass, bypass ? 1 : 0);
    gl.uniform4f(L.uCrop, a.crop.x, a.crop.y, a.crop.w, a.crop.h);
    gl.uniform1i(L.uRot, a.rotate);
    gl.uniform2f(L.uFlip, a.flipX ? 1 : 0, a.flipY ? 1 : 0);
    gl.uniform2f(L.uOutSize, w, h);
    gl.uniform1f(L.uExposure, a.exposure);
    gl.uniform1f(L.uContrast, a.contrast);
    gl.uniform1f(L.uHighlights, a.highlights);
    gl.uniform1f(L.uShadows, a.shadows);
    gl.uniform1f(L.uWhites, a.whites);
    gl.uniform1f(L.uBlacks, a.blacks);
    gl.uniform1f(L.uTemp, a.temperature);
    gl.uniform1f(L.uTint, a.tint);
    gl.uniform1f(L.uSat, a.saturation);
    gl.uniform1f(L.uVib, a.vibrance);
    gl.uniform3fv(L.uHsl, new Float32Array(a.hsl.flatMap((b) => [b.h, b.s, b.l])));
    gl.uniform1f(L.uSharpen, a.sharpen);
    gl.uniform1f(L.uClarity, a.clarity);
    gl.uniform1f(L.uDenoise, a.denoise);
    gl.uniform1f(L.uDeband, a.deband);
    gl.uniform1f(L.uDehaze, a.dehaze);
    gl.uniform1f(L.uVignette, a.vignette);
    gl.uniform1f(L.uGrain, a.grain);
    gl.uniform1f(L.uSeed, 3.7);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Full-resolution render → PNG bytes. */
  async exportPng(a: Adjust): Promise<Uint8Array> {
    const gl = this.gl;
    const { w, h } = this.outputSize(a);
    const target = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, target);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
    this.draw(a, w, h, false, 1);
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    gl.deleteTexture(target);
    // GL rows are bottom-up.
    const oc = new OffscreenCanvas(w, h);
    const ctx = oc.getContext('2d')!;
    const img = ctx.createImageData(w, h);
    const row = w * 4;
    for (let y = 0; y < h; y++) img.data.set(px.subarray((h - 1 - y) * row, (h - y) * row), y * row);
    ctx.putImageData(img, 0, 0);
    const blob = await oc.convertToBlob({ type: 'image/png' });
    return new Uint8Array(await blob.arrayBuffer());
  }

  /** Small unedited copy of the image (for the auto adjustment). */
  sample(width = 160) {
    const gl = this.gl;
    const a = defaultAdjust();
    const w = width; const h = Math.max(1, Math.round((width * this.height) / this.width));
    const target = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, target);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
    this.draw(a, w, h, true);
    const data = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    gl.deleteTexture(target);
    return { data, w, h };
  }

  destroy() {
    const gl = this.gl;
    if (this.tex) gl.deleteTexture(this.tex);
    gl.deleteTexture(this.lut);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

/** "Auto" button: levels from the luminance percentiles + grey-world white balance. */
export function autoAdjust(sample: { data: Uint8Array }): Partial<Adjust> {
  const d = sample.data;
  const lum: number[] = [];
  let r = 0; let g = 0; let b = 0; let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    lum.push(l);
    if (l > 40 && l < 220) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
  }
  lum.sort((x, y) => x - y);
  const pct = (p: number) => lum[Math.min(lum.length - 1, Math.floor(p * lum.length))] / 255;
  const lo = pct(0.005); const hi = pct(0.995); const mid = pct(0.5);
  const avg = n ? { r: r / n, g: g / n, b: b / n } : { r: 1, g: 1, b: 1 };
  const temp = Math.max(-0.4, Math.min(0.4, ((avg.b - avg.r) / 255) * 1.5));
  const tint = Math.max(-0.3, Math.min(0.3, (((avg.r + avg.b) / 2 - avg.g) / 255) * 1.5));
  return {
    exposure: Math.max(-0.6, Math.min(0.6, Math.log2(0.48 / Math.max(0.05, mid)) * 0.5)),
    blacks: Math.max(0, Math.min(1, lo * 6)),
    whites: Math.max(-1, Math.min(0.6, (1 - hi) * -3)),
    temperature: temp * 0.6,
    tint: tint * 0.6,
    vibrance: 0.2,
    clarity: 0.1,
    deband: 0.4,
  };
}

export const LOOKS: Record<string, { label: string; adj: Partial<Adjust> }> = {
  vivid: { label: 'Vívido', adj: { vibrance: 0.35, saturation: 0.1, contrast: 0.12, clarity: 0.15 } },
  animePop: { label: 'Anime pop', adj: { vibrance: 0.45, contrast: 0.1, sharpen: 0.25, deband: 0.6, shadows: 0.15 } },
  cinema: {
    label: 'Cinema',
    adj: {
      contrast: 0.18, saturation: -0.1, temperature: 0.08, vignette: 0.35, grain: 0.12,
      curve: { master: [0.04, 0.24, 0.5, 0.77, 0.96], r: [0, 0.25, 0.5, 0.75, 1], g: [0, 0.25, 0.5, 0.75, 1], b: [0.06, 0.28, 0.5, 0.73, 0.95] },
    },
  },
  warm: { label: 'Quente', adj: { temperature: 0.35, tint: 0.05, vibrance: 0.15 } },
  cool: { label: 'Frio', adj: { temperature: -0.3, tint: -0.03, contrast: 0.06 } },
  night: { label: 'Noturno', adj: { exposure: -0.35, temperature: -0.2, contrast: 0.2, vignette: 0.5, saturation: -0.15 } },
  pastel: { label: 'Pastel', adj: { contrast: -0.2, saturation: -0.15, exposure: 0.15, blacks: -0.3, temperature: 0.05 } },
  mono: { label: 'P&B', adj: { saturation: -1, contrast: 0.2, clarity: 0.2, grain: 0.1 } },
};

export const HSL_NAMES = ['Vermelho', 'Laranja', 'Amarelo', 'Verde', 'Ciano', 'Azul', 'Roxo', 'Magenta'];
export const HSL_COLORS = ['#ff4d4d', '#ff9a3d', '#ffd84d', '#5fd36b', '#4dd8e0', '#4d7dff', '#9a5cff', '#ff5ccf'];
