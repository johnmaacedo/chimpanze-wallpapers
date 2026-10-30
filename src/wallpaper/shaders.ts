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

vec4 sampleMedia(sampler2D tex, vec2 size, vec2 uv, float zoom, vec2 pan, float mips, float lod) {
  vec2 sc = fitScale(size);
  vec2 q = (uv - 0.5) * sc / zoom + 0.5 + pan;
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
  return sampleMedia(uFrom, uFromSize, uv, uFromZoom, uFromPan, uFromMips, lod);
}
vec4 getToL(vec2 uv, float lod) { return sampleMedia(uTo, uToSize, uv, uToZoom, uToPan, uToMips, lod); }
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

const FOOTER = `
void main() {
  p = clamp(uProgress, 0.0, 1.0);
  outColor = vec4(transition(vUv).rgb, 1.0);
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
  float m = smoothstep(p * (1.0 + 2.0 * w) - w, p * (1.0 + 2.0 * w) - w + w, d);
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
      col += getTo(vec2((q.x - edge) * 0.7 + 0.15 + (1.0 - e) * 0.15, q.y));
    } else {
      col += getFrom(vec2(q.x + e * 0.35, q.y)) * (1.0 - 0.35 * e);
    }
  }
  col /= 8.0;
  float shadow = smoothstep(0.0, 0.06, abs(uv.x - (1.0 - e)));
  return col * mix(0.6, 1.0, shadow);
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
};

export function fragmentFor(name: string): string {
  return HEADER + (TRANSITIONS[name] || TRANSITIONS.fade) + FOOTER;
}

export const TRANSITION_NAMES = Object.keys(TRANSITIONS).filter((n) => n !== 'idle');
