// GLSL ES 3.00 transitions. Every transition defines `vec4 transition(vec2 uv)`
// using getFrom(uv) / getTo(uv) (getFromL / getToL take a mip level for blur) and the eased progress `p`.

export const VERTEX = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const HEADER = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uFrom;
uniform sampler2D uTo;
uniform vec2 uFromSize;
uniform vec2 uToSize;
uniform vec2 uRes;
uniform float uProgress;
uniform float uTime;
uniform float uSeed;
uniform int uFit;
uniform float uFromZoom;
uniform float uToZoom;
uniform vec2 uFromPan;
uniform vec2 uToPan;
uniform float uHasFrom;
uniform float uFromMips;
uniform float uToMips;
uniform float uIntensity;
uniform sampler2D uFromDepth;
uniform sampler2D uToDepth;
uniform vec3 uFromPar; // 2.5D parallax: xy = camera shift (image uv), z = amount 0..1
uniform vec3 uToPar;

#define PI 3.14159265359
float p;

float hash(vec2 v) { return fract(sin(dot(v, vec2(12.9898, 78.233)) + uSeed) * 43758.5453); }
float noise(vec2 v) {
  vec2 i = floor(v); vec2 f = fract(v);
  float a = hash(i), b = hash(i + vec2(1.0, 0.0)), c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
}
float fbm(vec2 v) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * noise(v); v *= 2.03; a *= 0.5; }
  return s;
}

vec2 fitScale(vec2 size) {
  float ca = uRes.x / uRes.y;
  float ma = size.x / max(size.y, 1.0);
  vec2 sc = vec2(1.0);
  if (uFit == 0) { if (ma > ca) sc.x = ca / ma; else sc.y = ma / ca; }
  else if (uFit == 1) { if (ma > ca) sc.y = ma / ca; else sc.x = ca / ma; }
  else if (uFit == 3) { sc = uRes / max(size, vec2(1.0)); }
  return sc;
}

// Parallax occlusion: march from the nearest layer to the farthest and stop at
// the first surface that is in front of the ray, so a character covers what is
// behind it and the background slides out from under it (white depth = near).
#define PAR_FOCUS 0.35
#define PAR_STEPS 14
vec2 parallaxUv(sampler2D dtex, vec2 q, vec3 par) {
  if (par.z < 0.001) return q;
  vec2 o = par.xy * par.z;
  float L0 = 1.0;
  vec2 q0 = q - o * (L0 - PAR_FOCUS);
  float d0 = texture(dtex, vec2(q0.x, 1.0 - q0.y)).r - L0;
  for (int i = 1; i <= PAR_STEPS; i++) {
    float L = 1.0 - float(i) / float(PAR_STEPS);
    vec2 q1 = q - o * (L - PAR_FOCUS);
    float d1 = texture(dtex, vec2(q1.x, 1.0 - q1.y)).r - L;
    if (d1 >= 0.0) return mix(q0, q1, d0 / min(d0 - d1, -1e-5));
    q0 = q1; d0 = d1;
  }
  return q0;
}

vec4 sampleMedia(sampler2D tex, vec2 size, vec2 uv, float zoom, vec2 pan, float mips, float lod, sampler2D dtex, vec3 par) {
  vec2 sc = fitScale(size);
  vec2 q = (uv - 0.5) * sc / zoom + 0.5 + pan;
  q = parallaxUv(dtex, q, par);
  bool inside = q.x >= 0.0 && q.x <= 1.0 && q.y >= 0.0 && q.y <= 1.0;
  if (inside || uFit == 0 || uFit == 2) {
    q = clamp(q, 0.0, 1.0);
    if (lod > 0.01 && mips > 0.5) return textureLod(tex, vec2(q.x, 1.0 - q.y), lod);
    return texture(tex, vec2(q.x, 1.0 - q.y));
  }
  // Letterbox area (contain/center): blurred, darkened cover of the same image.
  float ca = uRes.x / uRes.y; float ma = size.x / max(size.y, 1.0);
  vec2 cs = vec2(1.0); if (ma > ca) cs.x = ca / ma; else cs.y = ma / ca;
  vec2 bq = clamp((uv - 0.5) * cs * 0.9 + 0.5, 0.0, 1.0);
  vec4 bg = mips > 0.5 ? textureLod(tex, vec2(bq.x, 1.0 - bq.y), max(6.5, lod)) : texture(tex, vec2(bq.x, 1.0 - bq.y));
  return vec4(bg.rgb * 0.45, 1.0);
}

vec4 getFromL(vec2 uv, float lod) {
  if (uHasFrom < 0.5) return vec4(0.0, 0.0, 0.0, 1.0);
  return sampleMedia(uFrom, uFromSize, uv, uFromZoom, uFromPan, uFromMips, lod, uFromDepth, uFromPar);
}
vec4 getToL(vec2 uv, float lod) { return sampleMedia(uTo, uToSize, uv, uToZoom, uToPan, uToMips, lod, uToDepth, uToPar); }
vec4 getFrom(vec2 uv) { return getFromL(uv, 0.0); }
vec4 getTo(vec2 uv) { return getToL(uv, 0.0); }
vec2 zoomUv(vec2 uv, float z) { return (uv - 0.5) / z + 0.5; }
vec2 aspectV() { return vec2(uRes.x / uRes.y, 1.0); }
float bell(float t) { return sin(clamp(t, 0.0, 1.0) * PI); }
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
vec2 rot2(vec2 v, float a) { float c = cos(a), s = sin(a); return vec2(c * v.x - s * v.y, s * v.x + c * v.y); }
float sdRoundBox(vec2 q, vec2 b, float r) { vec2 d = abs(q) - b + r; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r; }
bool inUnit(vec2 q) { return q.x >= 0.0 && q.x <= 1.0 && q.y >= 0.0 && q.y <= 1.0; }
vec4 stage(vec2 uv) { // dark backdrop for 3D transitions
  float v = 1.0 - 0.55 * length(uv - 0.5);
  return vec4(vec3(0.045, 0.035, 0.03) * v * 1.4, 1.0);
}
`;

// Motion blur: when uMbSamples > 1 the transition is rendered several times
// across the camera "shutter" (a slice of progress) and averaged, so fast
// moves smear like a filmed motion instead of stepping frame to frame.
const FOOTER = `
uniform int uMbSamples;
uniform float uShutter;
void main() {
  float P = clamp(uProgress, 0.0, 1.0);
  if (uMbSamples <= 1 || uShutter < 1e-5) {
    p = P;
    outColor = vec4(transition(vUv).rgb, 1.0);
    return;
  }
  vec3 acc = vec3(0.0);
  float n = float(uMbSamples);
  for (int i = 0; i < 12; i++) {
    if (i >= uMbSamples) break;
    p = clamp(P + ((float(i) + 0.5) / n - 0.5) * uShutter, 0.0, 1.0);
    acc += transition(vUv).rgb;
  }
  outColor = vec4(acc / n, 1.0);
}`;

export const TRANSITIONS: Record<string, string> = {
  idle: `vec4 transition(vec2 uv) { return getTo(uv); }`,
  crossBlur: `vec4 transition(vec2 uv) {
  float k = uIntensity;
  vec4 a = getFromL(zoomUv(uv, 1.0 + 0.03 * k * p), 5.0 * k * smoothstep(0.0, 0.65, p));
  vec4 b = getToL(zoomUv(uv, 1.03 - 0.03 * p), 5.0 * k * (1.0 - smoothstep(0.35, 1.0, p)));
  return mix(a, b, smoothstep(0.3, 0.7, p));
}`,
  appleZoom: `vec4 transition(vec2 uv) {
  float k = uIntensity;
  float f = smoothstep(0.0, 1.0, p);
  vec4 a = getFromL(zoomUv(uv, 1.0 + 0.28 * k * f), 4.5 * k * f);
  vec4 b = getToL(zoomUv(uv, 1.0 + 0.1 * k * (1.0 - f)), 4.5 * k * (1.0 - f));
  vec4 c = mix(a, b, smoothstep(0.18, 0.82, p));
  return c * (1.0 - 0.12 * bell(p));
}`,
  lumaReveal: `vec4 transition(vec2 uv) {
  float l = luma(getToL(uv, 3.5).rgb);
  float t = p * 1.3 - 0.15;
  float m = smoothstep(1.0 - t - 0.14, 1.0 - t + 0.14, l);
  vec4 col = mix(getFrom(uv), getTo(zoomUv(uv, 1.0 + 0.04 * uIntensity * (1.0 - p))), m);
  float e = (1.0 - abs(m * 2.0 - 1.0)) * bell(p);
  return col + vec4(vec3(1.0, 0.92, 0.8) * 0.14 * e * uIntensity, 0.0);
}`,
  mistFade: `vec4 transition(vec2 uv) {
  float n = fbm(uv * 2.6 + 3.1) * 0.7 + fbm(uv * 8.0) * 0.3;
  float t = p * 1.6 - 0.3;
  float m = smoothstep(t - 0.3, t + 0.3, n);
  float b = bell(p);
  vec4 a = getFromL(uv, 2.5 * (1.0 - m) * b);
  vec4 c = getToL(uv, 2.5 * m * b);
  vec4 col = mix(c, a, m);
  float haze = (1.0 - abs(m * 2.0 - 1.0)) * b;
  return col + vec4(vec3(0.07 * haze * uIntensity), 0.0);
}`,
  bokeh: `vec4 transition(vec2 uv) {
  float b = bell(p);
  float R = b * 0.03 * uIntensity;
  vec2 asp = aspectV();
  vec3 sa = vec3(0.0), sb = vec3(0.0); float wa = 0.0, wb = 0.0;
  for (int i = 0; i < 16; i++) {
    float fi = float(i) + 0.5;
    float th = fi * 2.39996;
    vec2 o = vec2(cos(th), sin(th)) * sqrt(fi / 16.0) * R / asp;
    vec3 A = getFromL(uv + o, b).rgb; vec3 B = getToL(uv + o, b).rgb;
    float w1 = 1.0 + 7.0 * pow(luma(A), 4.0); float w2 = 1.0 + 7.0 * pow(luma(B), 4.0);
    sa += A * w1; wa += w1; sb += B * w2; wb += w2;
  }
  return vec4(mix(sa / wa, sb / wb, smoothstep(0.3, 0.7, p)), 1.0);
}`,
  morph: `vec4 transition(vec2 uv) {
  vec4 ca = getFromL(uv, 2.5); vec4 cb = getToL(uv, 2.5);
  vec2 oa = vec2(ca.r + ca.b, ca.g + ca.b) - 1.0;
  vec2 ob = vec2(cb.r + cb.b, cb.g + cb.b) - 1.0;
  vec2 oc = mix(oa, ob, 0.5) * 0.12 * uIntensity;
  return mix(getFrom(uv + oc * p), getTo(uv - oc * (1.0 - p)), smoothstep(0.0, 1.0, p));
}`,
  dipBlack: `vec4 transition(vec2 uv) {
  float k = uIntensity;
  vec4 a = getFrom(zoomUv(uv, 1.0 + 0.05 * k * p)) * (1.0 - smoothstep(0.0, 0.5, p));
  vec4 b = getTo(zoomUv(uv, 1.0 + 0.05 * k * (1.0 - p))) * smoothstep(0.5, 1.0, p);
  return p < 0.5 ? a : b;
}`,
  flashWhite: `vec4 transition(vec2 uv) {
  float b = bell(p);
  vec4 c = mix(getFromL(uv, 3.0 * b), getToL(uv, 3.0 * b), smoothstep(0.38, 0.62, p));
  vec3 hi = 1.0 - exp(-c.rgb * (1.0 + 6.0 * b * uIntensity));
  c.rgb = mix(c.rgb, hi + vec3(0.3 * b * b * uIntensity), b);
  return c;
}`,
  irisSoft: `vec4 transition(vec2 uv) {
  vec2 asp = aspectV();
  float d = length((uv - 0.5) * asp);
  float maxD = length(0.5 * asp);
  float r = p * (maxD + 0.35);
  float m = 1.0 - smoothstep(r - 0.35, r, d);
  vec4 b = getToL(zoomUv(uv, 1.0 + 0.12 * uIntensity * (1.0 - p)), 3.0 * (1.0 - m));
  vec4 a = getFromL(uv, 2.0 * p * uIntensity) * (1.0 - 0.25 * p);
  return mix(a, b, m);
}`,
  pushLeft: `vec4 transition(vec2 uv) {
  float edge = 1.0 - p;
  float v = bell(p) * 0.03 * uIntensity;
  vec4 col = vec4(0.0);
  for (int i = 0; i < 8; i++) {
    vec2 q = uv + vec2((float(i) / 7.0 - 0.5) * v, 0.0);
    if (q.x >= edge) col += getTo(vec2(q.x - edge, q.y));
    else col += getFrom(vec2(q.x + p * 0.3, q.y)) * (1.0 - 0.5 * p);
  }
  col /= 8.0;
  if (uv.x < edge) col.rgb *= 1.0 - 0.35 * exp(-(edge - uv.x) * 30.0) * bell(p);
  return col;
}`,
  sheetUp: `vec4 transition(vec2 uv) {
  vec2 asp = aspectV();
  float s = 1.0 - 0.08 * uIntensity * p;
  vec4 a = getFromL((uv - 0.5) / s + 0.5, 1.5 * p) * (1.0 - 0.55 * p);
  float off = 1.0 - p;
  vec2 qt = uv + vec2(0.0, off);
  float r = 0.04 * (1.0 - smoothstep(0.8, 1.0, p));
  float d = sdRoundBox((qt - 0.5) * asp, 0.5 * asp, r);
  float inside = 1.0 - smoothstep(0.0, 1.5 / uRes.y, d);
  a.rgb *= 1.0 - 0.45 * exp(-max(d, 0.0) * 25.0) * (1.0 - p) * step(0.001, p);
  return mix(a, getTo(qt), inside);
}`,
  elasticSwipe: `vec4 transition(vec2 uv) {
  float L = 0.14 * bell(p) * uIntensity;
  vec4 col = vec4(0.0);
  for (int i = 0; i < 12; i++) {
    float x = uv.x + (float(i) / 11.0 - 0.5) * L + p;
    col += x < 1.0 ? getFrom(vec2(x, uv.y)) : getTo(vec2(x - 1.0, uv.y));
  }
  return col / 12.0;
}`,
  prism: `vec4 transition(vec2 uv) {
  float s = 0.07 * uIntensity;
  vec3 col;
  for (int ch = 0; ch < 3; ch++) {
    float pc = clamp((p - float(ch) * s) / (1.0 - 2.0 * s), 0.0, 1.0);
    pc = pc * pc * (3.0 - 2.0 * pc);
    float x = uv.x + pc;
    vec4 c = x < 1.0 ? getFrom(vec2(x, uv.y)) : getTo(vec2(x - 1.0, uv.y));
    col[ch] = c[ch];
  }
  return vec4(col, 1.0);
}`,
  waveReveal: `vec4 transition(vec2 uv) {
  float edge = mix(-0.15, 1.15, p) + sin(uv.x * 6.0 + p * 5.0) * 0.05 * uIntensity * bell(p);
  float m = smoothstep(edge + 0.03, edge - 0.03, uv.y);
  vec4 b = getTo(uv + vec2(0.0, (1.0 - p) * 0.05));
  vec4 a = getFrom(uv - vec2(0.0, p * 0.05));
  float rim = exp(-pow((uv.y - edge) / 0.02, 2.0)) * bell(p) * 0.18 * uIntensity;
  return mix(a, b, m) + vec4(vec3(rim), 0.0);
}`,
  lightSweep: `vec4 transition(vec2 uv) {
  vec2 dir = normalize(vec2(1.0, 0.35));
  vec2 asp = aspectV();
  float d = dot((uv - 0.5) * asp, dir) / dot(0.5 * asp, abs(dir)) * 0.5 + 0.5;
  float pos = mix(-0.25, 1.25, p);
  float m = smoothstep(pos + 0.12, pos - 0.12, d);
  float band = exp(-pow((d - pos) / 0.07, 2.0));
  vec4 col = mix(getFrom(uv), getTo(uv), m);
  col.rgb += vec3(1.0, 0.93, 0.82) * band * 0.45 * uIntensity;
  return col;
}`,
  directionalWarp: `vec4 transition(vec2 uv) {
  float sm = 0.18;
  vec2 v = normalize(vec2(-1.0, 1.0)); v /= abs(v.x) + abs(v.y);
  float d = v.x * 0.5 + v.y * 0.5;
  float m = 1.0 - smoothstep(-sm, 0.0, v.x * uv.x + v.y * uv.y - (d - 0.5 + p * (1.0 + sm)));
  return mix(getFrom((uv - 0.5) * (1.0 - m) + 0.5), getTo((uv - 0.5) * m + 0.5), m);
}`,
  radialSoft: `vec4 transition(vec2 uv) {
  vec2 c = (uv - 0.5) * aspectV();
  float a = fract(atan(c.x, c.y) / (2.0 * PI) + 1.0);
  float f = 0.1;
  float m = smoothstep(a, a + f, p * (1.0 + f));
  return mix(getFrom(uv), getTo(zoomUv(uv, 1.0 + 0.05 * uIntensity * (1.0 - p))), m);
}`,
  cube3d: `vec2 cubeSkew(vec2 q, float persp, float center) {
  float x = mix(q.x, 1.0 - q.x, center);
  return (vec2(x, (q.y - 0.5 * (1.0 - persp) * x) / (1.0 + (persp - 1.0) * x)) - vec2(0.5 - distance(center, 0.5), 0.0))
    * vec2(0.5 / distance(center, 0.5) * (center < 0.5 ? 1.0 : -1.0), 1.0) + vec2(center < 0.5 ? 0.0 : 1.0, 0.0);
}
vec4 transition(vec2 op) {
  if (p <= 0.001) return getFrom(op);
  if (p >= 0.999) return getTo(op);
  float persp = 0.7; float unzoom = 0.3 * uIntensity;
  float uz = unzoom * 2.0 * (0.5 - distance(0.5, p));
  vec2 q = -uz * 0.5 + (1.0 + uz) * op;
  float pp = clamp(p, 0.001, 0.999);
  vec2 fromP = cubeSkew((q - vec2(pp, 0.0)) / vec2(1.0 - pp, 1.0), 1.0 - mix(pp, 0.0, persp), 0.0);
  vec2 toP = cubeSkew(q / vec2(pp, 1.0), mix(pow(pp, 2.0), 1.0, persp), 1.0);
  if (inUnit(fromP)) return getFrom(fromP) * (1.0 - 0.35 * p);
  if (inUnit(toP)) return getTo(toP) * (0.65 + 0.35 * p);
  return stage(op);
}`,
  tilt3d: `vec3 plane(vec2 s, float a, float shift, float sc) {
  float D = 2.4;
  s.x -= shift;
  float t = D / (D - s.x * tan(a));
  return vec3(t * s.x / cos(a) / sc, t * s.y / sc, t);
}
vec4 transition(vec2 uv) {
  vec2 asp = aspectV();
  vec2 s = (uv - 0.5) * asp;
  float k = uIntensity;
  float af = p * 1.05 * k; float at = -(1.0 - p) * 1.05 * k;
  vec3 pf = plane(s, af, -p * 0.75 * asp.x, 1.0 - 0.25 * bell(p));
  vec3 pt = plane(s, at, (1.0 - p) * 0.75 * asp.x, 1.0 - 0.25 * bell(p));
  vec2 qf = vec2(pf.x / asp.x + 0.5, pf.y + 0.5);
  vec2 qt = vec2(pt.x / asp.x + 0.5, pt.y + 0.5);
  bool hf = pf.z > 0.0 && inUnit(qf); bool ht = pt.z > 0.0 && inUnit(qt);
  vec4 col = stage(uv);
  // reflections on the floor
  vec2 rf = vec2(qf.x, -qf.y - 0.02); vec2 rt = vec2(qt.x, -qt.y - 0.02);
  if (pf.z > 0.0 && inUnit(rf)) col += getFrom(rf) * 0.18 * (1.0 - rf.y * 3.0);
  if (pt.z > 0.0 && inUnit(rt)) col += getTo(rt) * 0.18 * (1.0 - rt.y * 3.0);
  if (p < 0.5) { if (ht) col = getTo(qt) * (0.55 + 0.45 * cos(at)); if (hf) col = getFrom(qf) * (0.55 + 0.45 * cos(af)); }
  else { if (hf) col = getFrom(qf) * (0.55 + 0.45 * cos(af)); if (ht) col = getTo(qt) * (0.55 + 0.45 * cos(at)); }
  return col;
}`,
  doorway: `vec4 transition(vec2 uv) {
  vec2 pfr = vec2(-1.0);
  float slit = 2.0 * abs(uv.x - 0.5) - p;
  if (slit > 0.0) {
    pfr = uv + (uv.x > 0.5 ? -1.0 : 1.0) * vec2(0.5 * p, 0.0);
    float d = 1.0 / (1.0 + 0.4 * uIntensity * p * (1.0 - slit));
    pfr.y = (pfr.y - d / 2.0) * d + d / 2.0;
  }
  float size = mix(1.0, 3.0, 1.0 - p);
  vec2 pto = (uv - 0.5) * size + 0.5;
  if (inUnit(pfr)) return getFrom(pfr) * (1.0 - 0.4 * p);
  if (inUnit(pto)) return getTo(pto);
  return stage(uv);
}`,
  squircle: `vec4 transition(vec2 uv) {
  vec2 asp = aspectV();
  vec2 c = (uv - 0.5) * asp;
  vec2 hb = mix(vec2(0.0), 0.5 * asp + 0.12, p);
  float r = min(hb.x, hb.y) * 0.5;
  float d = sdRoundBox(c, hb, r);
  float m = 1.0 - smoothstep(-0.003, 0.003, d);
  vec4 b = getTo(zoomUv(uv, 1.0 + 0.18 * uIntensity * (1.0 - p)));
  vec4 a = getFromL(zoomUv(uv, 1.0 + 0.05 * uIntensity * p), 2.5 * p * uIntensity) * (1.0 - 0.35 * p);
  a.rgb *= 1.0 - 0.5 * exp(-max(d, 0.0) * 22.0) * bell(p);
  return mix(a, b, m);
}`,
  bubbles: `vec4 transition(vec2 uv) {
  vec2 g = vec2(14.0, 14.0 * uRes.y / uRes.x);
  vec2 cell = floor(uv * g); vec2 f = fract(uv * g) - 0.5;
  float delay = (cell.x / g.x * 0.6 + (1.0 - cell.y / g.y) * 0.4) * 0.5;
  float lp = clamp((p - delay) / 0.5, 0.0, 1.0);
  lp = lp * lp * (3.0 - 2.0 * lp);
  float rad = lp * 0.76;
  float m = 1.0 - smoothstep(rad - 0.05, rad + 0.02, length(f));
  return mix(getFrom(uv), getTo(zoomUv(uv, 1.0 + 0.04 * (1.0 - p))), m);
}`,
  crossZoom: `vec4 transition(vec2 uv) {
  vec2 center = vec2(mix(0.25, 0.75, p), 0.5);
  float dissolve = p < 0.5 ? 0.5 * pow(2.0, 20.0 * p - 10.0) : 1.0 - 0.5 * pow(2.0, -20.0 * p + 10.0);
  float strength = bell(p) * 0.4 * uIntensity;
  vec2 to = center - uv;
  float off = hash(uv * 311.0);
  vec4 col = vec4(0.0); float total = 0.0;
  for (int i = 0; i < 24; i++) {
    float pc = (float(i) + off) / 24.0;
    float w = 4.0 * (pc - pc * pc);
    vec2 q = uv + to * pc * strength;
    col += mix(getFrom(q), getTo(q), dissolve) * w; total += w;
  }
  return col / total;
}`,
  zoomSpin: `vec4 transition(vec2 uv) {
  float b = bell(p); float k = uIntensity;
  vec2 asp = aspectV();
  float z = 1.0 + 0.3 * k * b;
  vec2 cf = rot2((uv - 0.5) * asp, p * 0.2 * k) / asp / z + 0.5;
  vec2 ct = rot2((uv - 0.5) * asp, -(1.0 - p) * 0.2 * k) / asp / z + 0.5;
  vec4 col = mix(getFromL(cf, 3.0 * b), getToL(ct, 3.0 * b), smoothstep(0.4, 0.6, p));
  return col + vec4(vec3(pow(b, 6.0) * 0.18 * k), 0.0);
}`,
  swirlSoft: `vec4 transition(vec2 uv) {
  float b = bell(p);
  vec2 asp = aspectV();
  vec2 c = (uv - 0.5) * asp;
  float r = length(c);
  float ang = b * 2.4 * uIntensity * (1.0 - smoothstep(0.0, 0.9, r));
  vec2 q = rot2(c, ang) / asp + 0.5;
  q = zoomUv(q, 1.0 + 0.1 * b);
  return mix(getFromL(q, 2.0 * b), getToL(q, 2.0 * b), smoothstep(0.35, 0.65, p));
}`,
  fade: `vec4 transition(vec2 uv) {
  vec4 a = getFrom(zoomUv(uv, 1.0 + p * 0.06));
  vec4 b = getTo(zoomUv(uv, 1.06 - p * 0.06));
  return mix(a, b, smoothstep(0.0, 1.0, p));
}`,
  zoomBlur: `vec4 transition(vec2 uv) {
  float s = sin(p * PI) * 0.22;
  vec2 dir = uv - 0.5;
  vec4 a = vec4(0.0); vec4 b = vec4(0.0);
  for (int i = 0; i < 18; i++) {
    float t = float(i) / 17.0;
    vec2 q = uv - dir * s * t;
    a += getFrom(zoomUv(q, 1.0 + p * 0.9));
    b += getTo(zoomUv(q, 1.0 + (1.0 - p) * 0.6));
  }
  a /= 18.0; b /= 18.0;
  return mix(a, b, smoothstep(0.38, 0.62, p));
}`,
  liquid: `vec4 transition(vec2 uv) {
  float n = fbm(uv * 3.0 + vec2(uTime * 0.05, 0.0));
  vec2 d = vec2(fbm(uv * 4.0 + 7.1), fbm(uv * 4.0 + 3.7)) - 0.5;
  vec4 a = getFrom(uv + d * p * 0.35);
  vec4 b = getTo(uv - d * (1.0 - p) * 0.35);
  float m = smoothstep(p - 0.12, p + 0.12, n * 0.5 + (1.0 - p) * 0.0 + (1.0 - uv.y) * 0.25 + 0.1);
  return mix(b, a, m);
}`,
  circleReveal: `vec4 transition(vec2 uv) {
  vec2 c = vec2(0.5 + (hash(vec2(3.0, 1.0)) - 0.5) * 0.4, 0.5 + (hash(vec2(1.0, 7.0)) - 0.5) * 0.3);
  vec2 asp = vec2(uRes.x / uRes.y, 1.0);
  float d = length((uv - c) * asp);
  float maxD = length(max(c, 1.0 - c) * asp);
  float r = p * maxD * 1.08;
  float edge = 0.025;
  float m = smoothstep(r - edge, r + edge, d);
  vec4 b = getTo(zoomUv(uv, 1.12 - p * 0.12));
  vec4 a = getFrom(zoomUv(uv, 1.0 + p * 0.05));
  float ring = (1.0 - smoothstep(0.0, 0.035, abs(d - r))) * sin(p * PI);
  vec4 col = mix(b, a, m);
  return col + vec4(vec3(1.0, 0.72, 0.45) * ring * 0.55, 0.0);
}`,
  slices: `vec4 transition(vec2 uv) {
  float n = 9.0;
  float idx = floor(uv.x * n);
  float delay = (idx / n) * 0.45;
  float lp = clamp((p - delay) / 0.55, 0.0, 1.0);
  lp = lp < 0.5 ? 4.0 * lp * lp * lp : 1.0 - pow(-2.0 * lp + 2.0, 3.0) / 2.0;
  bool up = mod(idx, 2.0) < 0.5;
  float edge = up ? lp : 1.0 - lp;
  bool showTo = up ? uv.y < edge : uv.y > edge;
  if (showTo) {
    float off = up ? (1.0 - lp) : -(1.0 - lp);
    return getTo(vec2(uv.x, uv.y + off * 0.25));
  }
  float shade = 1.0 - 0.25 * lp;
  return getFrom(uv) * shade;
}`,
  glitch: `vec4 transition(vec2 uv) {
  float strength = sin(p * PI);
  float t = floor(uTime * 24.0);
  float row = floor(uv.y * 28.0);
  float h = hash(vec2(row, t));
  float shift = (h - 0.5) * 0.18 * strength * step(0.55, hash(vec2(t, row * 3.1)));
  vec2 q = vec2(uv.x + shift, uv.y);
  float blockT = hash(vec2(floor(uv.x * 14.0), floor(uv.y * 9.0)) + t * 0.01);
  bool toSide = p > 0.5 ? blockT > (1.0 - p) * 1.4 - 0.2 : blockT < p * 1.4 - 0.5;
  float ab = 0.012 * strength;
  vec4 col;
  if (toSide) col = vec4(getTo(q + vec2(ab, 0.0)).r, getTo(q).g, getTo(q - vec2(ab, 0.0)).b, 1.0);
  else col = vec4(getFrom(q + vec2(ab, 0.0)).r, getFrom(q).g, getFrom(q - vec2(ab, 0.0)).b, 1.0);
  float scan = 0.94 + 0.06 * sin(uv.y * uRes.y * 1.5);
  return mix(col, col * scan, strength);
}`,
  pixelDissolve: `vec4 transition(vec2 uv) {
  float s = sin(p * PI);
  float cells = mix(uRes.x, 36.0, pow(s, 0.6));
  vec2 grid = vec2(cells, cells * uRes.y / uRes.x);
  vec2 q = (floor(uv * grid) + 0.5) / grid;
  vec2 blocks = vec2(48.0, 48.0 * uRes.y / uRes.x);
  float r = hash(floor(uv * blocks));
  bool showTo = r < p * 1.15 - 0.075;
  vec2 sampleUv = s > 0.02 ? q : uv;
  return showTo ? getTo(sampleUv) : getFrom(sampleUv);
}`,
  softWipe: `vec4 transition(vec2 uv) {
  vec2 dir = normalize(vec2(1.0, 0.45));
  float d = dot(uv - 0.5, dir) + 0.5;
  float w = 0.18;
  // The diagonal spans about -0.17..1.17, so start/end fully off screen (no jump).
  float t = mix(-w - 0.17, 1.17, p);
  float m = smoothstep(t, t + w, d);
  vec4 b = getTo(uv + dir * (1.0 - p) * 0.04);
  vec4 a = getFrom(uv - dir * p * 0.04);
  return mix(b, a, m);
}`,
  inkBleed: `vec4 transition(vec2 uv) {
  float n = fbm(uv * 5.0) * 0.75 + fbm(uv * 13.0) * 0.25;
  float th = p * 1.3 - 0.15;
  float m = smoothstep(th - 0.04, th + 0.04, n);
  float inkEdge = (1.0 - smoothstep(0.0, 0.05, abs(n - th))) * sin(p * PI);
  vec4 col = mix(getTo(zoomUv(uv, 1.05 - p * 0.05)), getFrom(uv), m);
  return col * (1.0 - inkEdge * 0.65);
}`,
  parallaxSlide: `vec4 transition(vec2 uv) {
  float e = p;
  vec4 col = vec4(0.0);
  float blur = sin(p * PI) * 0.03;
  for (int i = 0; i < 8; i++) {
    float o = (float(i) / 7.0 - 0.5) * blur;
    vec2 q = uv + vec2(o, 0.0);
    float edge = 1.0 - e;
    if (q.x > edge) {
      // Lands exactly on the new image at the end (no jump on the last frame).
      col += getTo(vec2((q.x - edge) * mix(0.7, 1.0, e) + 0.3 * (1.0 - e), q.y));
    } else {
      col += getFrom(vec2(q.x + e * 0.35, q.y)) * (1.0 - 0.35 * e);
    }
  }
  col /= 8.0;
  float shadow = smoothstep(0.0, 0.06, abs(uv.x - (1.0 - e)));
  return col * mix(1.0, mix(0.6, 1.0, shadow), bell(p));
}`,
  ripple: `vec4 transition(vec2 uv) {
  vec2 asp = vec2(uRes.x / uRes.y, 1.0);
  vec2 d = (uv - 0.5) * asp;
  float dist = length(d);
  float amp = sin(p * PI) * 0.035;
  vec2 off = normalize(d + 1e-5) * sin(dist * 42.0 - p * 22.0) * amp / asp;
  return mix(getFrom(uv + off), getTo(uv + off), smoothstep(0.25, 0.75, p));
}`,
  dreamWave: `vec4 transition(vec2 uv) {
  float amp = sin(p * PI) * 0.03;
  vec2 off = vec2(sin(uv.y * 18.0 + p * 10.0) * amp, cos(uv.x * 14.0 + p * 8.0) * amp * 0.5);
  vec4 a = getFrom(uv + off);
  vec4 b = getTo(uv - off);
  vec4 col = mix(a, b, smoothstep(0.15, 0.85, p));
  return col + vec4(vec3(sin(p * PI) * 0.06), 0.0);
}`,
  cardSwap: `vec4 transition(vec2 uv) {
  vec4 bg = vec4(0.03, 0.025, 0.02, 1.0);
  float s1 = 1.0 - 0.18 * smoothstep(0.0, 0.5, p);
  float x1 = -smoothstep(0.25, 1.0, p) * 1.1;
  float s2 = 0.82 + 0.18 * smoothstep(0.5, 1.0, p);
  float x2 = (1.0 - smoothstep(0.0, 0.75, p)) * 1.1;
  vec2 q2 = (uv - vec2(0.5 + x2, 0.5)) / s2 + 0.5;
  vec2 q1 = (uv - vec2(0.5 + x1, 0.5)) / s1 + 0.5;
  vec2 asp = vec2(uRes.x / uRes.y, 1.0);
  float rad = 0.035 * (1.0 - smoothstep(0.85, 1.0, p));
  vec2 b2 = abs(q2 - 0.5) * asp - (0.5 * asp - rad);
  float in2 = 1.0 - smoothstep(0.0, 0.003, length(max(b2, 0.0)) - rad);
  vec2 b1 = abs(q1 - 0.5) * asp - (0.5 * asp - rad);
  float in1 = 1.0 - smoothstep(0.0, 0.003, length(max(b1, 0.0)) - rad);
  vec4 col = bg;
  col = mix(col, getFrom(q1) * (1.0 - 0.3 * p), in1);
  col = mix(col, getTo(q2), in2);
  return col;
}`,
  lightLeak: `vec4 transition(vec2 uv) {
  float f = sin(p * PI);
  vec2 c = vec2(mix(-0.2, 1.2, p), 0.35 + 0.2 * sin(p * 3.0));
  vec2 asp = vec2(uRes.x / uRes.y, 1.0);
  float g = exp(-pow(length((uv - c) * asp) * 1.6, 2.0));
  vec3 warm = mix(vec3(1.0, 0.55, 0.2), vec3(1.0, 0.85, 0.6), g);
  vec4 base = mix(getFrom(uv), getTo(uv), smoothstep(0.35, 0.65, p));
  vec3 col = base.rgb + warm * g * f * 1.25 + vec3(f * f * 0.18);
  return vec4(col, 1.0);
}`,
  chromaPunch: `vec4 transition(vec2 uv) {
  float k = p < 0.5 ? p * 2.0 : (1.0 - p) * 2.0;
  float ab = k * k * 0.03;
  vec2 dir = (uv - 0.5);
  if (p < 0.5) {
    float z = 1.0 + k * k * 0.35;
    vec2 q = zoomUv(uv, z);
    return vec4(getFrom(q + dir * ab).r, getFrom(q).g, getFrom(q - dir * ab).b, 1.0) + vec4(vec3(k * k * 0.25), 0.0);
  }
  float z = 1.0 + k * k * 0.18;
  vec2 q = zoomUv(uv, z);
  return vec4(getTo(q + dir * ab).r, getTo(q).g, getTo(q - dir * ab).b, 1.0) + vec4(vec3(k * k * 0.25), 0.0);
}`,
  gridFlip: `vec4 transition(vec2 uv) {
  vec2 n = vec2(7.0, 4.0);
  vec2 cell = floor(uv * n);
  vec2 local = fract(uv * n);
  float delay = (cell.x + (n.y - 1.0 - cell.y)) / (n.x + n.y - 2.0) * 0.5;
  float lp = clamp((p - delay) / 0.5, 0.0, 1.0);
  float a = lp * PI;
  float w = abs(cos(a));
  float gap = 0.04;
  vec2 lc = vec2((local.x - 0.5) / max(w, 1e-3) + 0.5, local.y);
  bool inCell = lc.x >= gap * 0.5 && lc.x <= 1.0 - gap * 0.5 && local.y >= gap * 0.5 && local.y <= 1.0 - gap * 0.5;
  if (!inCell && lp > 0.0 && lp < 1.0) return vec4(0.02, 0.015, 0.01, 1.0);
  vec2 q = (cell + clamp(lc, 0.0, 1.0)) / n;
  float shade = 0.75 + 0.25 * w;
  return (lp < 0.5 ? getFrom(q) : getTo(q)) * (lp > 0.0 && lp < 1.0 ? shade : 1.0);
}`,

  // ---- 1.5: smooth / motion additions ----
  defocus: `vec4 transition(vec2 uv) {
  float b = bell(p); float k = uIntensity;
  vec2 asp = aspectV();
  float vig = 0.6 + 0.8 * length((uv - 0.5) * asp);
  float la = 6.0 * k * smoothstep(0.0, 0.6, p) * vig;
  float lb = 6.0 * k * (1.0 - smoothstep(0.4, 1.0, p)) * vig;
  vec4 a = getFromL(zoomUv(uv, 1.0 + 0.025 * k * p), la);
  vec4 c = getToL(zoomUv(uv, 1.025 - 0.025 * p), lb);
  vec4 col = mix(a, c, smoothstep(0.35, 0.65, p));
  vec3 glow = max(mix(getFromL(uv, 5.5).rgb, getToL(uv, 5.5).rgb, p) - 0.55, 0.0);
  col.rgb = 1.0 - (1.0 - col.rgb) * (1.0 - glow * 0.9 * b * k);
  return col;
}`,
  dreamyZoom: `vec4 transition(vec2 uv) {
  float b = bell(p); float k = uIntensity;
  vec2 asp = aspectV();
  vec2 c = (uv - 0.5) * asp;
  vec2 qa = rot2(c, 0.1 * k * p) / asp / (1.0 + 0.4 * k * p) + 0.5;
  vec2 qb = rot2(c, -0.1 * k * (1.0 - p)) / asp / (1.0 + 0.25 * k * (1.0 - p)) + 0.5;
  vec4 col = mix(getFromL(qa, 3.5 * b), getToL(qb, 3.5 * b), smoothstep(0.3, 0.7, p));
  vec3 glow = getFromL(qa, 6.0).rgb * (1.0 - p) + getToL(qb, 6.0).rgb * p;
  col.rgb = 1.0 - (1.0 - col.rgb) * (1.0 - glow * 0.35 * b * k);
  return col;
}`,
  displacement: `vec4 transition(vec2 uv) {
  vec2 asp = aspectV();
  float n = fbm(uv * asp * 2.5 + 4.0);
  vec2 w = vec2(fbm(uv * asp * 3.5 + 1.7), fbm(uv * asp * 3.5 + 8.3)) - 0.5;
  vec2 dir = normalize(vec2(1.0, 0.55));
  vec2 da = (dir * n + w * 0.4) * 0.32 * uIntensity;
  vec4 a = getFromL(uv + da * p, 1.5 * p);
  vec4 b = getToL(uv - da * (1.0 - p), 1.5 * (1.0 - p));
  return mix(a, b, smoothstep(0.1, 0.9, p));
}`,
  perlinDissolve: `vec4 transition(vec2 uv) {
  vec2 asp = aspectV();
  float n = clamp((fbm(uv * asp * 3.2) - 0.2) / 0.6, 0.0, 1.0);
  float w = 0.14;
  float t = p * (1.0 + 2.0 * w) - w;
  float m = smoothstep(n - w, n + w, t);
  float e = 1.0 - abs(m * 2.0 - 1.0);
  vec4 col = mix(getFromL(uv, 2.5 * e), getToL(zoomUv(uv, 1.0 + 0.03 * (1.0 - p)), 2.5 * e), m);
  col.rgb += vec3(1.0, 0.9, 0.75) * 0.08 * e * uIntensity;
  return col;
}`,
  glowDissolve: `vec4 transition(vec2 uv) {
  float b = bell(p);
  vec3 gc = getToL(uv, 5.0).rgb;
  float m = clamp(p * 1.5 - 0.25 + (luma(gc) - 0.5) * 0.5 * b, 0.0, 1.0);
  m = m * m * (3.0 - 2.0 * m);
  vec3 col = mix(getFrom(uv).rgb, getTo(uv).rgb, m);
  vec3 glow = mix(getFromL(uv, 5.0).rgb, gc, m);
  col = 1.0 - (1.0 - col) * (1.0 - glow * glow * 0.55 * b * uIntensity);
  return vec4(col, 1.0);
}`,
  hueShift: `vec3 hueRot(vec3 c, float a) {
  vec3 k = vec3(0.57735);
  float ca = cos(a);
  return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca);
}
vec4 transition(vec2 uv) {
  float b = bell(p);
  vec4 c = mix(getFromL(uv, 1.5 * b), getToL(uv, 1.5 * b), smoothstep(0.25, 0.75, p));
  c.rgb = clamp(hueRot(c.rgb, b * 1.3 * uIntensity), 0.0, 1.0) * (1.0 + 0.08 * b);
  return c;
}`,
  grayFade: `vec4 transition(vec2 uv) {
  vec3 col = mix(getFrom(uv).rgb, getTo(uv).rgb, smoothstep(0.3, 0.7, p));
  vec3 gray = (vec3(luma(col)) * vec3(1.02, 1.0, 0.97) - 0.5) * 1.08 + 0.5;
  float g = smoothstep(0.0, 0.35, p) * (1.0 - smoothstep(0.65, 1.0, p)) * min(uIntensity, 1.0);
  return vec4(mix(col, clamp(gray, 0.0, 1.0), g), 1.0);
}`,
  smokeFlow: `vec4 transition(vec2 uv) {
  vec2 asp = aspectV();
  float b = bell(p);
  float t = p * 1.8;
  vec2 w = vec2(fbm(uv * asp * 2.2 + vec2(0.0, -t)), fbm(uv * asp * 2.2 + vec2(5.2, 1.3 - t))) - 0.5;
  float n = fbm(uv * asp * 1.8 + w * 1.6 + vec2(0.0, -t * 0.4));
  n = clamp((n - 0.25) / 0.5, 0.0, 1.0) * 0.7 + uv.y * 0.3;
  float wd = 0.16;
  float th = p * (1.0 + 2.0 * wd) - wd;
  float m = smoothstep(n - wd, n + wd, th);
  vec2 drift = w * 0.07 * uIntensity * b;
  vec4 a = getFromL(uv + drift, 3.0 * b * m);
  vec4 c = getToL(uv - drift, 3.0 * b * (1.0 - m));
  vec4 col = mix(a, c, m);
  float haze = (1.0 - abs(m * 2.0 - 1.0)) * b;
  col.rgb = 1.0 - (1.0 - col.rgb) * (1.0 - vec3(0.12, 0.11, 0.1) * haze * uIntensity);
  return col;
}`,
  silk: `vec4 transition(vec2 uv) {
  float b = bell(p);
  float front = mix(-0.35, 1.35, p);
  float x = uv.x + 0.05 * sin(uv.y * 5.0 + p * 6.0) * b;
  float dd = x - front;
  float m = 1.0 - smoothstep(-0.12, 0.12, dd);
  float wave = sin(dd * 28.0) * exp(-dd * dd * 25.0) * b;
  vec2 off = vec2(wave * 0.012, wave * 0.006) * uIntensity;
  vec4 col = mix(getFrom(uv + off), getTo(uv + off), m);
  col.rgb *= 1.0 + 0.14 * wave * uIntensity;
  return col;
}`,

  linearBlur: `vec4 transition(vec2 uv) {
  float L = 0.09 * uIntensity * bell(p);
  vec4 a = vec4(0.0), c = vec4(0.0);
  for (int i = 0; i < 16; i++) {
    vec2 o = vec2((float(i) / 15.0 - 0.5) * L, 0.0);
    a += getFrom(uv + o); c += getTo(uv + o);
  }
  return mix(a, c, smoothstep(0.35, 0.65, p)) / 16.0;
}`,
  slideUp: `vec4 transition(vec2 uv) {
  float y = uv.y - p;
  if (y >= 0.0) {
    vec4 a = getFrom(vec2(uv.x, y)) * (1.0 - 0.2 * p);
    return a;
  }
  vec4 b = getTo(vec2(uv.x, y + 1.0));
  b.rgb *= 1.0 - 0.3 * exp(-(-y) * 40.0) * bell(p);
  return b;
}`,
  slideScaled: `vec4 cardAt(vec2 uv, float off, float s, float r, bool isTo) {
  vec2 asp = aspectV();
  vec2 c = (uv - 0.5) * asp - vec2(off * asp.x, 0.0);
  float d = sdRoundBox(c, 0.5 * asp * s + 2.0 / uRes.y, r);
  float m = 1.0 - smoothstep(-1.0 / uRes.y, 1.0 / uRes.y, d);
  vec2 q = c / s / asp + 0.5;
  return vec4(isTo ? getTo(q).rgb : getFrom(q).rgb, m);
}
vec4 transition(vec2 uv) {
  float shrink = smoothstep(0.0, 0.35, p) * (1.0 - smoothstep(0.65, 1.0, p));
  float s = 1.0 - 0.16 * uIntensity * shrink;
  float r = 0.2 * (1.0 - s);
  float sl = smoothstep(0.2, 0.8, p);
  float gap = s + 0.04;
  vec4 col = stage(uv);
  vec4 A = cardAt(uv, -sl * gap, s, r, false);
  vec4 B = cardAt(uv, (1.0 - sl) * gap, s, r, true);
  col.rgb = mix(col.rgb, A.rgb, A.a);
  col.rgb = mix(col.rgb, B.rgb, B.a);
  return col;
}`,
  slideAway: `vec4 transition(vec2 uv) {
  float edge = p;
  if (uv.x >= edge) return getFrom(vec2(uv.x - edge, uv.y));
  vec4 b = getTo(vec2(uv.x + 0.25 * uIntensity * (1.0 - p), uv.y));
  b.rgb *= 0.65 + 0.35 * p;
  b.rgb *= 1.0 - 0.5 * exp(-(edge - uv.x) * 25.0) * bell(p);
  return b;
}`,
  squeeze: `vec4 transition(vec2 uv) {
  if (uv.y >= p) {
    float y = (uv.y - p) / max(1.0 - p, 1e-4);
    return getFrom(vec2(uv.x, y)) * (1.0 - 0.5 * p);
  }
  vec4 b = getTo(zoomUv(uv, 1.0 + 0.08 * uIntensity * (1.0 - p)));
  b.rgb *= 1.0 - 0.35 * exp(-(p - uv.y) * 30.0) * bell(p);
  return b;
}`,
  containerExpand: `vec4 transition(vec2 uv) {
  vec2 asp = aspectV();
  float k = uIntensity;
  float s = mix(0.14, 1.0, p);
  vec2 hb = 0.5 * asp * vec2(s * mix(0.72, 1.0, p), s) + 2.0 / uRes.y * p;
  float r = min(hb.x, hb.y) * 0.22 * (1.0 - smoothstep(0.75, 1.0, p));
  vec2 c = (uv - 0.5) * asp;
  float d = sdRoundBox(c, hb, r);
  float vis = smoothstep(0.0, 0.12, p);
  float inside = (1.0 - smoothstep(-1.0 / uRes.y, 1.0 / uRes.y, d)) * vis;
  vec4 bt = getTo(c / s / asp + 0.5);
  vec4 a = getFromL(zoomUv(uv, 1.0 + 0.06 * k * p), 3.0 * k * p);
  a.rgb *= 1.0 - 0.45 * p;
  a.rgb *= 1.0 - 0.55 * exp(-max(d, 0.0) * 16.0) * vis * (1.0 - smoothstep(0.8, 1.0, p));
  return mix(a, bt, inside);
}`,
  frostedGlass: `vec4 transition(vec2 uv) {
  float w = 0.26;
  float pos = mix(-w - 0.15, 1.0 + w + 0.15, p);
  float d = uv.x + 0.12 * (uv.y - 0.5) - pos;
  float g = 1.0 - smoothstep(w * 0.5 - 0.004, w * 0.5 + 0.004, abs(d));
  float m = 1.0 - smoothstep(-0.002, 0.002, d);
  vec4 base = mix(getFrom(uv), getTo(uv), m);
  vec2 j = (vec2(hash(uv * 517.0), hash(uv * 911.0 + 3.0)) - 0.5) * 0.006;
  float lod = 4.5 * uIntensity;
  vec4 frost = mix(getFromL(uv + j, lod), getToL(uv + j, lod), smoothstep(w * 0.5, -w * 0.5, d));
  frost.rgb = frost.rgb * 1.05 + 0.05;
  float rim = exp(-pow((abs(d) - w * 0.5) / 0.003, 2.0));
  vec4 col = mix(base, frost, g);
  col.rgb += vec3(rim * 0.35 + g * 0.03);
  return col;
}`,

  pageCurl: `vec4 transition(vec2 uv) {
  vec2 asp = aspectV();
  vec2 dir = normalize(vec2(1.0, 0.28));
  vec2 pos = (uv - 0.5) * asp;
  float M = dot(0.5 * asp, abs(dir));
  float R = 0.1 + 0.06 * uIntensity;
  float x0 = mix(M + 0.02, -M - PI * R * 0.5 - 0.05, p);
  float dp = dot(pos, dir);
  float d = dp - x0;
  // Back of the page: the flat part lying on top, then the far half of the roll.
  float sBack = d < 0.0 ? PI * R - d : (d < R ? R * (PI - asin(d / R)) : -1.0);
  if (sBack > 0.0) {
    vec2 q = (pos + dir * (x0 + sBack - dp)) / asp + 0.5;
    if (inUnit(q)) {
      float lit = d < 0.0 ? 0.92 : 0.72 + 0.22 * (d / R);
      vec3 paper = mix(getFrom(q).rgb, vec3(0.96, 0.93, 0.88), 0.72);
      return vec4(paper * lit, 1.0);
    }
  }
  if (d >= 0.0 && d < R) {
    float s = R * asin(d / R);
    vec2 q = (pos + dir * (x0 + s - dp)) / asp + 0.5;
    if (inUnit(q)) return getFrom(q) * (1.0 - 0.35 * (d / R) * (d / R));
  }
  if (d < 0.0) return getFrom(uv);
  vec4 b = getTo(uv);
  b.rgb *= 1.0 - 0.55 * exp(-max(d - R, 0.0) * 10.0) * (1.0 - smoothstep(0.85, 1.0, p));
  return b;
}`,
  bookFlip: `vec4 transition(vec2 uv) {
  float k = uIntensity;
  float a = p * PI;
  float c = cos(a);
  float x = uv.x - 0.5;
  float w = 0.5 * abs(c);
  bool right = c > 0.0;
  if (right ? (x >= 0.0 && x <= w) : (x <= 0.0 && x >= -w)) {
    float t = abs(x) / max(w, 1e-4);
    float y = (uv.y - 0.5) * (1.0 + 0.22 * k * sin(a) * t) + 0.5;
    if (y >= 0.0 && y <= 1.0) {
      float shade = 0.55 + 0.45 * abs(c);
      return (right ? getFrom(vec2(0.5 + t * 0.5, y)) : getTo(vec2(0.5 - t * 0.5, y))) * shade;
    }
  }
  vec4 col = x >= 0.0 ? getTo(uv) : getFrom(uv);
  float sd = right ? (x > 0.0 ? x - w : 1.0) : (x < 0.0 ? -x - w : 1.0);
  col.rgb *= 1.0 - 0.45 * sin(a) * exp(-max(sd, 0.0) * 9.0);
  col.rgb *= 1.0 - 0.25 * exp(-abs(x) * 60.0) * sin(a);
  return col;
}`,
  fold: `vec4 transition(vec2 uv) {
  float edge = 1.0 - p;
  if (uv.x < edge) {
    float t = uv.x / max(edge, 1e-4);
    float y = (uv.y - 0.5) * (1.0 + 0.12 * uIntensity * sin(p * PI * 0.5) * t) + 0.5;
    return inUnit(vec2(t, y)) ? getFrom(vec2(t, y)) * (1.0 - 0.45 * p * t) : stage(uv);
  }
  float t = (uv.x - edge) / max(p, 1e-4);
  float y = (uv.y - 0.5) * (1.0 + 0.12 * uIntensity * cos(p * PI * 0.5) * (1.0 - t)) + 0.5;
  return inUnit(vec2(t, y)) ? getTo(vec2(t, y)) * (0.55 + 0.45 * p) : stage(uv);
}`,
  revolve: `vec4 transition(vec2 uv) {
  vec2 asp = aspectV();
  float a = p * PI;
  bool front = a < 0.5 * PI;
  float ang = front ? a : a - PI;
  float z = 1.0 - 0.18 * uIntensity * bell(p);
  vec2 s = (uv - 0.5) * asp / z;
  float D = 2.6;
  float den = D * cos(ang) - s.x * sin(ang);
  vec4 col = stage(uv);
  if (den > 0.0) {
    float x = s.x * D / den;
    float y = s.y * (D + x * sin(ang)) / D;
    vec2 q = vec2(x / asp.x + 0.5, y + 0.5);
    if (inUnit(q)) col = (front ? getFrom(q) : getTo(q)) * (0.6 + 0.4 * abs(cos(ang)));
  }
  return col;
}`,
  zoomOut: `vec4 transition(vec2 uv) {
  vec2 asp = aspectV();
  float k = uIntensity;
  float s = 1.0 - 0.42 * min(k, 1.5) * smoothstep(0.0, 1.0, p);
  float fadeA = 1.0 - smoothstep(0.45, 0.9, p);
  vec2 c = (uv - 0.5) * asp;
  float d = sdRoundBox(c, 0.5 * asp * s + 2.0 / uRes.y, 0.15 * (1.0 - s));
  float inside = (1.0 - smoothstep(-1.0 / uRes.y, 1.0 / uRes.y, d)) * fadeA;
  vec4 a = getFrom(c / s / asp + 0.5);
  vec4 b = getToL(zoomUv(uv, 1.0 + 0.15 * k * (1.0 - p)), 3.0 * (1.0 - smoothstep(0.2, 0.9, p)));
  b.rgb *= 0.6 + 0.4 * smoothstep(0.0, 1.0, p);
  b.rgb *= 1.0 - 0.5 * exp(-max(d, 0.0) * 14.0) * fadeA * step(0.001, p);
  return mix(b, a, inside);
}`,
  dolly: `vec4 transition(vec2 uv) {
  float Z = exp(p * log(2.6));
  float sT = Z / 2.6;
  vec2 asp = aspectV();
  vec2 c = uv - 0.5;
  float blur = 0.09 * uIntensity * bell(p);
  float fe = 0.012 * (1.0 - smoothstep(0.85, 1.0, p)) + 1e-4;
  float vis = smoothstep(0.0, 0.25, p);
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 12; i++) {
    vec2 cc = c * (1.0 - blur * float(i) / 11.0);
    vec2 qf = cc / Z + 0.5;
    vec2 qt = cc / sT + 0.5;
    vec2 e2 = (abs(qt - 0.5) - 0.5) * asp * sT;
    float m = (1.0 - smoothstep(-fe, 0.0, max(e2.x, e2.y))) * vis;
    acc += mix(getFrom(qf), getTo(clamp(qt, 0.0, 1.0)), m);
  }
  vec4 col = acc / 12.0;
  vec2 e0 = (abs(c / sT) - 0.5) * asp * sT;
  float out0 = max(e0.x, e0.y);
  col.rgb *= 1.0 - 0.4 * exp(-max(out0, 0.0) * 30.0) * step(0.0, out0) * vis * (1.0 - p);
  return col;
}`,

  waterDrop: `vec4 transition(vec2 uv) {
  vec2 asp = aspectV();
  vec2 d = (uv - 0.5) * asp;
  float dist = length(d);
  float r = p * (length(0.5 * asp) + 0.25) - 0.02;
  float x = dist - r;
  float wave = sin(x * 70.0) * exp(-abs(x) * 12.0);
  vec2 off = normalize(d + 1e-5) * wave * 0.01 * uIntensity * bell(p) / asp;
  float m = 1.0 - smoothstep(-0.03, 0.03, x);
  vec4 col = mix(getFrom(uv + off), getTo(uv + off * 0.5), m);
  col.rgb += vec3(max(wave, 0.0)) * 0.12 * bell(p) * uIntensity;
  return col;
}`,
  lens: `vec4 transition(vec2 uv) {
  vec2 asp = aspectV();
  vec2 c = vec2(mix(0.3, 0.5, p), 0.5);
  float R = p * (length(max(c, 1.0 - c) * asp) + 0.3) - 0.01;
  vec2 d = (uv - c) * asp;
  float r = length(d);
  float k = clamp(r / max(R, 1e-4), 0.0, 1.0);
  float settle = smoothstep(0.55, 1.0, p);
  float f = mix(0.55 + 0.45 * k * k, 1.0, settle);
  float ca = 0.03 * uIntensity * (1.0 - settle) * k * k;
  vec2 dd = d / asp;
  vec3 tcol = vec3(getTo(c + dd * f * (1.0 + ca)).r, getTo(c + dd * f).g, getTo(c + dd * f * (1.0 - ca)).b);
  float m = 1.0 - smoothstep(R - 0.006, R + 0.006, r);
  float push = exp(-max(r - R, 0.0) * 18.0) * 0.04 * uIntensity * (1.0 - settle) * step(0.001, p);
  vec3 col = mix(getFrom(uv - normalize(d + 1e-5) / asp * push).rgb, tcol, m);
  col *= 1.0 - 0.25 * m * k * k * k * (1.0 - settle);
  col += vec3(1.0, 0.95, 0.88) * exp(-pow((r - R) / 0.008, 2.0)) * (1.0 - settle) * 0.4 * uIntensity;
  return vec4(col, 1.0);
}`,
  blinds: `vec4 transition(vec2 uv) {
  float n = 9.0;
  float idx = floor(uv.y * n);
  float local = fract(uv.y * n);
  float delay = (n - 1.0 - idx) / (n - 1.0) * 0.4;
  float lp = smoothstep(0.0, 1.0, clamp((p - delay) / 0.6, 0.0, 1.0));
  float a = lp * PI;
  float h = max(abs(cos(a)), 1e-3);
  float ly = (local - 0.5) / h + 0.5;
  vec2 q = vec2(uv.x, (idx + clamp(ly, 0.0, 1.0)) / n);
  vec4 col = (lp < 0.5 ? getFrom(q) : getTo(q)) * (0.62 + 0.38 * h);
  col.rgb += vec3(pow(1.0 - abs(clamp(ly, 0.0, 1.0) - 0.5) * 2.0, 6.0) * sin(a) * 0.12 * uIntensity);
  float aa = clamp(min(ly, 1.0 - ly) / (1.5 * n / (uRes.y * h)), 0.0, 1.0);
  aa = max(aa, 1.0 - clamp(sin(a) * 40.0, 0.0, 1.0)); // slats at rest show no seams
  return mix(getToL(uv, 4.0) * 0.3, col, aa);
}`,
  hexReveal: `vec4 hexCell(vec2 v) {
  vec2 s = vec2(1.0, 1.7320508);
  vec4 hc = floor(vec4(v, v - vec2(0.5, 1.0)) / s.xyxy) + 0.5;
  vec4 h = vec4(v - hc.xy * s, v - (hc.zw + 0.5) * s);
  return dot(h.xy, h.xy) < dot(h.zw, h.zw) ? vec4(h.xy, hc.xy) : vec4(h.zw, hc.zw + 0.5);
}
float hexDist(vec2 v) { v = abs(v); return max(dot(v, vec2(0.5, 0.8660254)), v.x); }
vec4 transition(vec2 uv) {
  vec2 asp = aspectV();
  float sc = 11.0;
  vec4 h = hexCell((uv - 0.5) * asp * sc);
  vec2 center = h.zw * vec2(1.0, 1.7320508) / sc;
  float delay = length(center) / length(0.5 * asp) * 0.45 + hash(h.zw) * 0.12;
  float lp = smoothstep(0.0, 1.0, clamp((p - delay) / 0.43, 0.0, 1.0));
  float hd = hexDist(h.xy);
  float size = lp * 0.6 - 0.03;
  float m = 1.0 - smoothstep(size - 0.02, size + 0.02, hd);
  vec4 col = mix(getFrom(uv), getTo(zoomUv(uv, 1.0 + 0.04 * (1.0 - p))), m);
  col.rgb += vec3(1.0, 0.78, 0.45) * exp(-pow((hd - size) / 0.025, 2.0)) * bell(lp) * 0.35 * uIntensity;
  return col;
}`,

  tangentMotion: `vec4 transition(vec2 uv) {
  float b = bell(p); float k = uIntensity;
  vec2 asp = aspectV();
  vec2 c = (uv - 0.5) * asp;
  float spread = 0.16 * k * b;
  float af = 0.22 * k * p; float at = -0.22 * k * (1.0 - p);
  float zf = 1.0 + 1.9 * (af + spread * 0.5);
  float zt = 1.0 + 1.9 * (-at + spread * 0.5);
  vec4 a = vec4(0.0), t = vec4(0.0);
  for (int i = 0; i < 16; i++) {
    float o = (float(i) / 15.0 - 0.5) * spread;
    a += getFrom(rot2(c, af + o) / asp / zf + 0.5);
    t += getTo(rot2(c, at + o) / asp / zt + 0.5);
  }
  return mix(a, t, smoothstep(0.4, 0.6, p)) / 16.0;
}`,
  lumaMelt: `vec4 transition(vec2 uv) {
  float colN = noise(vec2(uv.x * 38.0, 0.5)) * 0.6 + noise(vec2(uv.x * 160.0, 3.5)) * 0.4;
  float speed = 0.6 + colN * 0.8 + luma(getFromL(uv, 4.0).rgb) * 0.5;
  float d = p * p * speed * 1.7 * clamp(uIntensity, 0.6, 1.4);
  vec2 q = uv + vec2(0.0, d);
  float m = smoothstep(0.995, 1.02, q.y);
  vec4 a = getFrom(vec2(q.x, min(q.y, 1.0)));
  vec4 b = getTo(zoomUv(uv, 1.0 + 0.04 * (1.0 - p)));
  return mix(a, b, max(m, smoothstep(0.85, 1.0, p)));
}`,
  filmBurn: `vec4 transition(vec2 uv) {
  vec2 asp = aspectV();
  vec2 c = vec2(0.3 + 0.4 * hash(vec2(2.0, 5.0)), 0.3 + 0.4 * hash(vec2(9.0, 1.0)));
  float d = length((uv - c) * asp) + (fbm(uv * asp * 4.0) - 0.5) * 0.35;
  float r = p * (length(max(c, 1.0 - c) * asp) + 0.45) - 0.12;
  float m = 1.0 - smoothstep(r - 0.03, r + 0.03, d);
  float edge = exp(-pow((d - r) / 0.045, 2.0)) * bell(p);
  vec4 col = mix(getFrom(uv), getTo(uv), m);
  col.rgb *= 1.0 - 0.5 * exp(-max(d - r, 0.0) * 14.0) * (1.0 - m) * bell(p);
  vec3 hot = mix(vec3(1.0, 0.35, 0.05), vec3(1.0, 0.9, 0.6), edge);
  col.rgb = 1.0 - (1.0 - col.rgb) * (1.0 - clamp(hot * edge * 1.2 * uIntensity, 0.0, 1.0));
  return col;
}`,
  edgeGlow: `vec4 transition(vec2 uv) {
  vec2 px = 1.5 / uRes;
  float gx = luma(getToL(uv + vec2(px.x, 0.0), 1.0).rgb) - luma(getToL(uv - vec2(px.x, 0.0), 1.0).rgb);
  float gy = luma(getToL(uv + vec2(0.0, px.y), 1.0).rgb) - luma(getToL(uv - vec2(0.0, px.y), 1.0).rgb);
  float e = smoothstep(0.04, 0.25, length(vec2(gx, gy)));
  float draw = smoothstep(0.0, 0.4, p) * (1.0 - smoothstep(0.6, 1.0, p));
  vec4 a = getFrom(uv);
  a.rgb *= 1.0 - 0.7 * smoothstep(0.0, 0.45, p);
  vec4 col = mix(a, getTo(uv), smoothstep(0.4, 0.9, p));
  vec3 glowc = mix(vec3(1.0, 0.62, 0.3), vec3(1.0, 0.95, 0.85), e);
  col.rgb = 1.0 - (1.0 - col.rgb) * (1.0 - clamp(glowc * e * draw * uIntensity, 0.0, 1.0));
  return col;
}`,
  wind: `vec4 transition(vec2 uv) {
  float n = noise(vec2(0.5, uv.y * 70.0)) * 0.65 + noise(vec2(2.5, uv.y * 300.0)) * 0.35;
  float sz = 0.35; float w = 0.07;
  float front = p * (1.0 + sz + w) - sz * n;
  float e = 1.0 - uv.x;
  float m = 1.0 - smoothstep(front - w, front, e);
  float near = exp(-max(e - front, 0.0) * 9.0) * bell(p);
  vec4 a = vec4(0.0);
  for (int i = 0; i < 8; i++) a += getFrom(uv + vec2(float(i) / 7.0 * 0.06 * near * uIntensity, 0.0));
  return mix(a / 8.0, getTo(uv), m);
}`,
  colorPhase: `vec4 transition(vec2 uv) {
  float s = 0.25 * min(uIntensity, 1.5);
  vec3 pc = vec3(smoothstep(0.0, 1.0 - 2.0 * s, p), smoothstep(s, 1.0 - s, p), smoothstep(2.0 * s, 1.0, p));
  return vec4(mix(getFrom(uv).rgb, getTo(uv).rgb, pc), 1.0);
}`,
  burnOut: `vec4 transition(vec2 uv) {
  vec2 asp = aspectV();
  float n = fbm(uv * asp * 3.0 + vec2(0.0, -p * 1.5)) * 0.6 + fbm(uv * asp * 9.0) * 0.4;
  float h = uv.y * 0.65 + n * 0.55;
  float t = p * 1.4 - 0.1;
  float m = 1.0 - smoothstep(t - 0.02, t + 0.02, h);
  float edge = exp(-pow((h - t) / 0.03, 2.0));
  float charr = exp(-max(h - t, 0.0) * 18.0) * (1.0 - m);
  vec4 col = mix(getFrom(uv), getTo(uv), m);
  col.rgb *= 1.0 - 0.6 * charr * bell(p);
  vec3 ember = mix(vec3(0.9, 0.2, 0.02), vec3(1.0, 0.85, 0.4), edge * edge);
  float flick = 0.75 + 0.25 * noise(uv * 40.0 + uTime * 3.0);
  float live = smoothstep(0.0, 0.1, p) * (1.0 - smoothstep(0.9, 1.0, p));
  col.rgb = 1.0 - (1.0 - col.rgb) * (1.0 - clamp(ember * edge * 1.3 * flick * uIntensity * live, 0.0, 1.0));
  return col;
}`,
  aurora: `vec4 transition(vec2 uv) {
  float y = uv.y + 0.07 * sin(uv.x * 4.0 + p * 5.0) + 0.04 * sin(uv.x * 11.0 - p * 7.0);
  float front = mix(-0.25, 1.25, p);
  float m = 1.0 - smoothstep(front - 0.12, front + 0.04, y);
  float band = exp(-pow((y - front + 0.03) / 0.08, 2.0)) + exp(-pow((y - front + 0.15) / 0.14, 2.0)) * 0.5;
  vec3 aur = mix(vec3(0.15, 1.0, 0.65), vec3(0.65, 0.35, 1.0), 0.5 + 0.5 * sin(uv.x * 5.0 + p * 3.0 + y * 4.0));
  vec4 col = mix(getFrom(uv), getTo(uv), m);
  float live = smoothstep(0.0, 0.15, p) * (1.0 - smoothstep(0.85, 1.0, p));
  col.rgb = 1.0 - (1.0 - col.rgb) * (1.0 - clamp(aur * band * 0.5 * uIntensity * live, 0.0, 1.0));
  return col;
}`,
};

/**
 * Transitions with big geometric moves and no blur of their own: the engine
 * renders them with temporal motion blur (several progress samples per frame).
 */
export const MOTION_BLUR = new Set([
  'sheetUp', 'cube3d', 'tilt3d', 'doorway', 'cardSwap', 'gridFlip', 'squircle', 'prism', 'slices',
  'directionalWarp', 'waveReveal', 'softWipe', 'circleReveal',
  'slideUp', 'slideScaled', 'slideAway', 'squeeze', 'containerExpand', 'frostedGlass',
  'pageCurl', 'bookFlip', 'fold', 'revolve', 'zoomOut', 'blinds', 'hexReveal', 'lens',
]);

export function fragmentFor(name: string): string {
  return HEADER + (TRANSITIONS[name] || TRANSITIONS.fade) + FOOTER;
}

export const TRANSITION_NAMES = Object.keys(TRANSITIONS).filter((n) => n !== 'idle');
