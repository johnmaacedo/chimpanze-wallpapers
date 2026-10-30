(function(){let e=document.createElement(`link`).relList;if(e&&e.supports&&e.supports(`modulepreload`))return;for(let e of document.querySelectorAll(`link[rel="modulepreload"]`))n(e);new MutationObserver(e=>{for(let t of e)if(t.type===`childList`)for(let e of t.addedNodes)e.tagName===`LINK`&&e.rel===`modulepreload`&&n(e)}).observe(document,{childList:!0,subtree:!0});function t(e){let t={};return e.integrity&&(t.integrity=e.integrity),e.referrerPolicy&&(t.referrerPolicy=e.referrerPolicy),t.credentials=e.crossOrigin===`use-credentials`?`include`:e.crossOrigin===`anonymous`?`omit`:`same-origin`,t}function n(e){if(e.ep)return;e.ep=!0;let n=t(e);fetch(e.href,n)}})();var e=`#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`,t=`#version 300 es
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
`,n=`
void main() {
  p = clamp(uProgress, 0.0, 1.0);
  outColor = vec4(transition(vUv).rgb, 1.0);
}`,r={idle:`vec4 transition(vec2 uv) { return getTo(uv); }`,crossBlur:`vec4 transition(vec2 uv) {
    float k = uIntensity;
    vec4 a = getFromL(zoomUv(uv, 1.0 + 0.03 * k * p), 5.0 * k * smoothstep(0.0, 0.65, p));
    vec4 b = getToL(zoomUv(uv, 1.03 - 0.03 * p), 5.0 * k * (1.0 - smoothstep(0.35, 1.0, p)));
    return mix(a, b, smoothstep(0.3, 0.7, p));
  }`,appleZoom:`vec4 transition(vec2 uv) {
    float k = uIntensity;
    float f = smoothstep(0.0, 1.0, p);
    vec4 a = getFromL(zoomUv(uv, 1.0 + 0.28 * k * f), 4.5 * k * f);
    vec4 b = getToL(zoomUv(uv, 1.0 + 0.1 * k * (1.0 - f)), 4.5 * k * (1.0 - f));
    vec4 c = mix(a, b, smoothstep(0.18, 0.82, p));
    return c * (1.0 - 0.12 * bell(p));
  }`,lumaReveal:`vec4 transition(vec2 uv) {
    float l = luma(getToL(uv, 3.5).rgb);
    float t = p * 1.3 - 0.15;
    float m = smoothstep(1.0 - t - 0.14, 1.0 - t + 0.14, l);
    vec4 col = mix(getFrom(uv), getTo(zoomUv(uv, 1.0 + 0.04 * uIntensity * (1.0 - p))), m);
    float e = (1.0 - abs(m * 2.0 - 1.0)) * bell(p);
    return col + vec4(vec3(1.0, 0.92, 0.8) * 0.14 * e * uIntensity, 0.0);
  }`,mistFade:`vec4 transition(vec2 uv) {
    float n = fbm(uv * 2.6 + 3.1) * 0.7 + fbm(uv * 8.0) * 0.3;
    float t = p * 1.6 - 0.3;
    float m = smoothstep(t - 0.3, t + 0.3, n);
    float b = bell(p);
    vec4 a = getFromL(uv, 2.5 * (1.0 - m) * b);
    vec4 c = getToL(uv, 2.5 * m * b);
    vec4 col = mix(c, a, m);
    float haze = (1.0 - abs(m * 2.0 - 1.0)) * b;
    return col + vec4(vec3(0.07 * haze * uIntensity), 0.0);
  }`,bokeh:`vec4 transition(vec2 uv) {
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
  }`,morph:`vec4 transition(vec2 uv) {
    vec4 ca = getFromL(uv, 2.5); vec4 cb = getToL(uv, 2.5);
    vec2 oa = vec2(ca.r + ca.b, ca.g + ca.b) - 1.0;
    vec2 ob = vec2(cb.r + cb.b, cb.g + cb.b) - 1.0;
    vec2 oc = mix(oa, ob, 0.5) * 0.12 * uIntensity;
    return mix(getFrom(uv + oc * p), getTo(uv - oc * (1.0 - p)), smoothstep(0.0, 1.0, p));
  }`,dipBlack:`vec4 transition(vec2 uv) {
    float k = uIntensity;
    vec4 a = getFrom(zoomUv(uv, 1.0 + 0.05 * k * p)) * (1.0 - smoothstep(0.0, 0.5, p));
    vec4 b = getTo(zoomUv(uv, 1.0 + 0.05 * k * (1.0 - p))) * smoothstep(0.5, 1.0, p);
    return p < 0.5 ? a : b;
  }`,flashWhite:`vec4 transition(vec2 uv) {
    float b = bell(p);
    vec4 c = mix(getFromL(uv, 3.0 * b), getToL(uv, 3.0 * b), smoothstep(0.38, 0.62, p));
    vec3 hi = 1.0 - exp(-c.rgb * (1.0 + 6.0 * b * uIntensity));
    c.rgb = mix(c.rgb, hi + vec3(0.3 * b * b * uIntensity), b);
    return c;
  }`,irisSoft:`vec4 transition(vec2 uv) {
    vec2 asp = aspectV();
    float d = length((uv - 0.5) * asp);
    float maxD = length(0.5 * asp);
    float r = p * (maxD + 0.35);
    float m = 1.0 - smoothstep(r - 0.35, r, d);
    vec4 b = getToL(zoomUv(uv, 1.0 + 0.12 * uIntensity * (1.0 - p)), 3.0 * (1.0 - m));
    vec4 a = getFromL(uv, 2.0 * p * uIntensity) * (1.0 - 0.25 * p);
    return mix(a, b, m);
  }`,pushLeft:`vec4 transition(vec2 uv) {
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
  }`,sheetUp:`vec4 transition(vec2 uv) {
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
  }`,elasticSwipe:`vec4 transition(vec2 uv) {
    float L = 0.14 * bell(p) * uIntensity;
    vec4 col = vec4(0.0);
    for (int i = 0; i < 12; i++) {
      float x = uv.x + (float(i) / 11.0 - 0.5) * L + p;
      col += x < 1.0 ? getFrom(vec2(x, uv.y)) : getTo(vec2(x - 1.0, uv.y));
    }
    return col / 12.0;
  }`,prism:`vec4 transition(vec2 uv) {
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
  }`,waveReveal:`vec4 transition(vec2 uv) {
    float edge = mix(-0.15, 1.15, p) + sin(uv.x * 6.0 + p * 5.0) * 0.05 * uIntensity * bell(p);
    float m = smoothstep(edge + 0.03, edge - 0.03, uv.y);
    vec4 b = getTo(uv + vec2(0.0, (1.0 - p) * 0.05));
    vec4 a = getFrom(uv - vec2(0.0, p * 0.05));
    float rim = exp(-pow((uv.y - edge) / 0.02, 2.0)) * bell(p) * 0.18 * uIntensity;
    return mix(a, b, m) + vec4(vec3(rim), 0.0);
  }`,lightSweep:`vec4 transition(vec2 uv) {
    vec2 dir = normalize(vec2(1.0, 0.35));
    vec2 asp = aspectV();
    float d = dot((uv - 0.5) * asp, dir) / dot(0.5 * asp, abs(dir)) * 0.5 + 0.5;
    float pos = mix(-0.25, 1.25, p);
    float m = smoothstep(pos + 0.12, pos - 0.12, d);
    float band = exp(-pow((d - pos) / 0.07, 2.0));
    vec4 col = mix(getFrom(uv), getTo(uv), m);
    col.rgb += vec3(1.0, 0.93, 0.82) * band * 0.45 * uIntensity;
    return col;
  }`,directionalWarp:`vec4 transition(vec2 uv) {
    float sm = 0.18;
    vec2 v = normalize(vec2(-1.0, 1.0)); v /= abs(v.x) + abs(v.y);
    float d = v.x * 0.5 + v.y * 0.5;
    float m = 1.0 - smoothstep(-sm, 0.0, v.x * uv.x + v.y * uv.y - (d - 0.5 + p * (1.0 + sm)));
    return mix(getFrom((uv - 0.5) * (1.0 - m) + 0.5), getTo((uv - 0.5) * m + 0.5), m);
  }`,radialSoft:`vec4 transition(vec2 uv) {
    vec2 c = (uv - 0.5) * aspectV();
    float a = fract(atan(c.x, c.y) / (2.0 * PI) + 1.0);
    float f = 0.1;
    float m = smoothstep(a, a + f, p * (1.0 + f));
    return mix(getFrom(uv), getTo(zoomUv(uv, 1.0 + 0.05 * uIntensity * (1.0 - p))), m);
  }`,cube3d:`vec2 cubeSkew(vec2 q, float persp, float center) {
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
  }`,tilt3d:`vec3 plane(vec2 s, float a, float shift, float sc) {
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
  }`,doorway:`vec4 transition(vec2 uv) {
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
  }`,squircle:`vec4 transition(vec2 uv) {
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
  }`,bubbles:`vec4 transition(vec2 uv) {
    vec2 g = vec2(14.0, 14.0 * uRes.y / uRes.x);
    vec2 cell = floor(uv * g); vec2 f = fract(uv * g) - 0.5;
    float delay = (cell.x / g.x * 0.6 + (1.0 - cell.y / g.y) * 0.4) * 0.5;
    float lp = clamp((p - delay) / 0.5, 0.0, 1.0);
    lp = lp * lp * (3.0 - 2.0 * lp);
    float rad = lp * 0.76;
    float m = 1.0 - smoothstep(rad - 0.05, rad + 0.02, length(f));
    return mix(getFrom(uv), getTo(zoomUv(uv, 1.0 + 0.04 * (1.0 - p))), m);
  }`,crossZoom:`vec4 transition(vec2 uv) {
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
  }`,zoomSpin:`vec4 transition(vec2 uv) {
    float b = bell(p); float k = uIntensity;
    vec2 asp = aspectV();
    float z = 1.0 + 0.3 * k * b;
    vec2 cf = rot2((uv - 0.5) * asp, p * 0.2 * k) / asp / z + 0.5;
    vec2 ct = rot2((uv - 0.5) * asp, -(1.0 - p) * 0.2 * k) / asp / z + 0.5;
    vec4 col = mix(getFromL(cf, 3.0 * b), getToL(ct, 3.0 * b), smoothstep(0.4, 0.6, p));
    return col + vec4(vec3(pow(b, 6.0) * 0.18 * k), 0.0);
  }`,swirlSoft:`vec4 transition(vec2 uv) {
    float b = bell(p);
    vec2 asp = aspectV();
    vec2 c = (uv - 0.5) * asp;
    float r = length(c);
    float ang = b * 2.4 * uIntensity * (1.0 - smoothstep(0.0, 0.9, r));
    vec2 q = rot2(c, ang) / asp + 0.5;
    q = zoomUv(q, 1.0 + 0.1 * b);
    return mix(getFromL(q, 2.0 * b), getToL(q, 2.0 * b), smoothstep(0.35, 0.65, p));
  }`,fade:`vec4 transition(vec2 uv) {
    vec4 a = getFrom(zoomUv(uv, 1.0 + p * 0.06));
    vec4 b = getTo(zoomUv(uv, 1.06 - p * 0.06));
    return mix(a, b, smoothstep(0.0, 1.0, p));
  }`,zoomBlur:`vec4 transition(vec2 uv) {
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
  }`,liquid:`vec4 transition(vec2 uv) {
    float n = fbm(uv * 3.0 + vec2(uTime * 0.05, 0.0));
    vec2 d = vec2(fbm(uv * 4.0 + 7.1), fbm(uv * 4.0 + 3.7)) - 0.5;
    vec4 a = getFrom(uv + d * p * 0.35);
    vec4 b = getTo(uv - d * (1.0 - p) * 0.35);
    float m = smoothstep(p - 0.12, p + 0.12, n * 0.5 + (1.0 - p) * 0.0 + (1.0 - uv.y) * 0.25 + 0.1);
    return mix(b, a, m);
  }`,circleReveal:`vec4 transition(vec2 uv) {
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
  }`,slices:`vec4 transition(vec2 uv) {
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
  }`,glitch:`vec4 transition(vec2 uv) {
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
  }`,pixelDissolve:`vec4 transition(vec2 uv) {
    float s = sin(p * PI);
    float cells = mix(uRes.x, 36.0, pow(s, 0.6));
    vec2 grid = vec2(cells, cells * uRes.y / uRes.x);
    vec2 q = (floor(uv * grid) + 0.5) / grid;
    vec2 blocks = vec2(48.0, 48.0 * uRes.y / uRes.x);
    float r = hash(floor(uv * blocks));
    bool showTo = r < p * 1.15 - 0.075;
    vec2 sampleUv = s > 0.02 ? q : uv;
    return showTo ? getTo(sampleUv) : getFrom(sampleUv);
  }`,softWipe:`vec4 transition(vec2 uv) {
    vec2 dir = normalize(vec2(1.0, 0.45));
    float d = dot(uv - 0.5, dir) + 0.5;
    float w = 0.18;
    float m = smoothstep(p * (1.0 + 2.0 * w) - w, p * (1.0 + 2.0 * w) - w + w, d);
    vec4 b = getTo(uv + dir * (1.0 - p) * 0.04);
    vec4 a = getFrom(uv - dir * p * 0.04);
    return mix(b, a, m);
  }`,inkBleed:`vec4 transition(vec2 uv) {
    float n = fbm(uv * 5.0) * 0.75 + fbm(uv * 13.0) * 0.25;
    float th = p * 1.3 - 0.15;
    float m = smoothstep(th - 0.04, th + 0.04, n);
    float inkEdge = (1.0 - smoothstep(0.0, 0.05, abs(n - th))) * sin(p * PI);
    vec4 col = mix(getTo(zoomUv(uv, 1.05 - p * 0.05)), getFrom(uv), m);
    return col * (1.0 - inkEdge * 0.65);
  }`,parallaxSlide:`vec4 transition(vec2 uv) {
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
  }`,ripple:`vec4 transition(vec2 uv) {
    vec2 asp = vec2(uRes.x / uRes.y, 1.0);
    vec2 d = (uv - 0.5) * asp;
    float dist = length(d);
    float amp = sin(p * PI) * 0.035;
    vec2 off = normalize(d + 1e-5) * sin(dist * 42.0 - p * 22.0) * amp / asp;
    return mix(getFrom(uv + off), getTo(uv + off), smoothstep(0.25, 0.75, p));
  }`,dreamWave:`vec4 transition(vec2 uv) {
    float amp = sin(p * PI) * 0.03;
    vec2 off = vec2(sin(uv.y * 18.0 + p * 10.0) * amp, cos(uv.x * 14.0 + p * 8.0) * amp * 0.5);
    vec4 a = getFrom(uv + off);
    vec4 b = getTo(uv - off);
    vec4 col = mix(a, b, smoothstep(0.15, 0.85, p));
    return col + vec4(vec3(sin(p * PI) * 0.06), 0.0);
  }`,cardSwap:`vec4 transition(vec2 uv) {
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
  }`,lightLeak:`vec4 transition(vec2 uv) {
    float f = sin(p * PI);
    vec2 c = vec2(mix(-0.2, 1.2, p), 0.35 + 0.2 * sin(p * 3.0));
    vec2 asp = vec2(uRes.x / uRes.y, 1.0);
    float g = exp(-pow(length((uv - c) * asp) * 1.6, 2.0));
    vec3 warm = mix(vec3(1.0, 0.55, 0.2), vec3(1.0, 0.85, 0.6), g);
    vec4 base = mix(getFrom(uv), getTo(uv), smoothstep(0.35, 0.65, p));
    vec3 col = base.rgb + warm * g * f * 1.25 + vec3(f * f * 0.18);
    return vec4(col, 1.0);
  }`,chromaPunch:`vec4 transition(vec2 uv) {
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
  }`,gridFlip:`vec4 transition(vec2 uv) {
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
  }`};function i(e){return t+(r[e]||r.fade)+n}Object.keys(r).filter(e=>e!==`idle`);var a={cover:0,contain:1,stretch:2,center:3},o={linear:e=>e,easeInOutCubic:e=>e<.5?4*e*e*e:1-(-2*e+2)**3/2,easeInOutQuint:e=>e<.5?16*e**5:1-(-2*e+2)**5/2,easeOutExpo:e=>e===1?1:1-2**(-10*e),easeInOutSine:e=>-(Math.cos(Math.PI*e)-1)/2,easeOutBack:e=>1+2.20158*(e-1)**3+1.20158*(e-1)**2,easeOutQuart:e=>1-(1-e)**4,easeInOutExpo:e=>e<=0?0:e>=1?1:e<.5?2**(20*e-10)/2:(2-2**(-20*e+10))/2,spring:e=>e>=1?1:(1-(1+9*e)*Math.exp(-9*e))/(1-10*Math.exp(-9)),springBounce:e=>e>=1?1:1-Math.exp(-6.5*e)*Math.cos(9.5*e)+e*Math.exp(-6.5)*Math.cos(9.5),apple:e=>s(.25,.1,.25,1,e)};function s(e,t,n,r,i){let a=3*e,o=3*(n-e)-a,s=1-a-o,c=3*t,l=3*(r-t)-c,u=1-c-l,d=i;for(let e=0;e<6;e++){let e=((s*d+o)*d+a)*d-i,t=(3*s*d+2*o)*d+a;if(Math.abs(t)<1e-6)break;d-=e/t}return d=Math.min(1,Math.max(0,d)),((u*d+l)*d+c)*d}var c=class{gl;tex;width=1;height=1;animated=!1;mips=!1;kbStart=performance.now();kbSeed=Math.random()*1e3;video=null;decoder=null;frame=null;frameIndex=0;frameCount=0;nextFrameAt=0;decoding=!1;disposed=!1;needsUpload=!1;constructor(e){this.gl=e,this.tex=e.createTexture(),e.bindTexture(e.TEXTURE_2D,this.tex),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.LINEAR),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.LINEAR),e.texImage2D(e.TEXTURE_2D,0,e.RGBA,1,1,0,e.RGBA,e.UNSIGNED_BYTE,new Uint8Array([0,0,0,255]))}async load(e,t,n,r){if(this.mips=r,e.type===`video`)return this.loadVideo(e.url);if(e.type===`gif`&&`ImageDecoder`in window)try{return await this.loadAnimated(e.url,`image/gif`)}catch{}let i=await fetch(e.url);if(!i.ok)throw Error(`HTTP ${i.status}`);let a=await i.blob();if(e.url.toLowerCase().includes(`.webp`)&&`ImageDecoder`in window)try{let t=window.ImageDecoder,n=new t({data:await a.arrayBuffer(),type:`image/webp`});if(await n.tracks.ready,n.tracks.selectedTrack&&n.tracks.selectedTrack.frameCount>1)return n.close(),await this.loadAnimated(e.url,`image/webp`);n.close()}catch{}let o=await createImageBitmap(a),s=o.width,c=o.height,l=Math.min(s/t,c/n),u=o;if(l>1.25){let e=1.1/l;s=Math.round(s*e),c=Math.round(c*e),u=await createImageBitmap(o,{resizeWidth:s,resizeHeight:c,resizeQuality:`high`}),o.close()}this.width=s,this.height=c,this.upload(u),u.close()}upload(e){let t=this.gl;t.bindTexture(t.TEXTURE_2D,this.tex),t.pixelStorei(t.UNPACK_FLIP_Y_WEBGL,!1),t.pixelStorei(t.UNPACK_PREMULTIPLY_ALPHA_WEBGL,!1),t.texImage2D(t.TEXTURE_2D,0,t.RGBA,t.RGBA,t.UNSIGNED_BYTE,e),this.mips?(t.generateMipmap(t.TEXTURE_2D),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MIN_FILTER,t.LINEAR_MIPMAP_LINEAR)):t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MIN_FILTER,t.LINEAR)}loadVideo(e){return new Promise((t,n)=>{let r=document.createElement(`video`);r.muted=!0,r.loop=!0,r.playsInline=!0,r.preload=`auto`,r.crossOrigin=`anonymous`,r.src=e;let i=()=>{r.removeEventListener(`loadeddata`,i),this.video=r,this.animated=!0,this.width=r.videoWidth||1920,this.height=r.videoHeight||1080,this.mips=!1,r.play().catch(()=>{}),this.upload(r),t()};r.addEventListener(`loadeddata`,i),r.addEventListener(`error`,()=>n(Error(`Não foi possível decodificar o vídeo (use MP4 H.264 ou WebM).`)),{once:!0})})}async loadAnimated(e,t){let n=window.ImageDecoder,r=new n({data:await(await fetch(e)).arrayBuffer(),type:t});await r.tracks.ready,await r.completed.catch(()=>{}),this.decoder=r,this.frameCount=r.tracks.selectedTrack?r.tracks.selectedTrack.frameCount:1,this.animated=this.frameCount>1,this.mips=!1;let i=await r.decode({frameIndex:0});this.frame=i.image,this.width=this.frame.displayWidth,this.height=this.frame.displayHeight,this.upload(this.frame),this.nextFrameAt=performance.now()+Math.max(20,(this.frame.duration||1e5)/1e3)}tick(e){!this.disposed&&this.animated&&(this.video?this.video.readyState>=2&&!this.video.paused&&this.upload(this.video):(this.decoder&&!this.decoding&&e>=this.nextFrameAt&&(this.decoding=!0,this.frameIndex=(this.frameIndex+1)%this.frameCount,this.decoder.decode({frameIndex:this.frameIndex}).then(e=>{if(this.disposed){e.image.close();return}this.frame&&this.frame.close(),this.frame=e.image,this.needsUpload=!0;let t=Math.max(20,(this.frame.duration||1e5)/1e3);this.nextFrameAt=Math.max(performance.now(),this.nextFrameAt+t)}).catch(()=>{}).finally(()=>{this.decoding=!1})),this.needsUpload&&this.frame&&(this.needsUpload=!1,this.upload(this.frame))))}setPaused(e){this.video&&(e?this.video.pause():this.video.play().catch(()=>{})),!e&&this.decoder&&(this.nextFrameAt=performance.now())}dispose(){this.disposed=!0;try{this.gl.deleteTexture(this.tex)}catch{}if(this.video&&=(this.video.pause(),this.video.removeAttribute(`src`),this.video.load(),null),this.frame)try{this.frame.close()}catch{}if(this.decoder)try{this.decoder.close()}catch{}}},l=class{canvas;gl;programs=new Map;from=null;to=null;transition=`idle`;tStart=0;tDuration=1;easing=o.easeInOutCubic;seed=Math.random()*100;raf=0;paused=!1;fit=`cover`;kenBurns=!0;intensity=1;lru=[];loadToken=0;firstFrameSent=!1;onFirstFrame=null;reloadOnLoss=!0;onError=null;constructor(e){this.canvas=e;let t=e.getContext(`webgl2`,{antialias:!1,alpha:!1,premultipliedAlpha:!1,preserveDrawingBuffer:!1,powerPreference:`high-performance`});if(!t)throw Error(`WebGL2 indisponível`);this.gl=t;let n=t.createBuffer();t.bindBuffer(t.ARRAY_BUFFER,n),t.bufferData(t.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),t.STATIC_DRAW),e.addEventListener(`webglcontextlost`,e=>{e.preventDefault(),this.reloadOnLoss&&location.reload()}),this.resize(),this.ro=new ResizeObserver(()=>{this.resize(),this.kick()}),this.ro.observe(e)}ro;destroy(){this.ro.disconnect(),cancelAnimationFrame(this.raf),this.raf=0,this.from?.dispose(),this.to?.dispose(),this.from=null,this.to=null,this.gl.getExtension(`WEBGL_lose_context`)?.loseContext()}resize(){let e=window.devicePixelRatio||1,t=Math.max(1,Math.round((this.canvas.clientWidth||window.innerWidth)*e)),n=Math.max(1,Math.round((this.canvas.clientHeight||window.innerHeight)*e));(this.canvas.width!==t||this.canvas.height!==n)&&(this.canvas.width=t,this.canvas.height=n)}program(t){let n=this.programs.get(t);if(n)return this.touch(t),n;let r=this.gl,a=(e,n)=>{let i=r.createShader(e);if(r.shaderSource(i,n),r.compileShader(i),!r.getShaderParameter(i,r.COMPILE_STATUS))throw Error(`shader ${t}: ${r.getShaderInfoLog(i)}`);return i},o=r.createProgram();if(r.attachShader(o,a(r.VERTEX_SHADER,e)),r.attachShader(o,a(r.FRAGMENT_SHADER,i(t))),r.bindAttribLocation(o,0,`aPos`),r.linkProgram(o),!r.getProgramParameter(o,r.LINK_STATUS))throw Error(`link ${t}: ${r.getProgramInfoLog(o)}`);let s=[`uFrom`,`uTo`,`uFromSize`,`uToSize`,`uRes`,`uProgress`,`uTime`,`uSeed`,`uFit`,`uFromZoom`,`uToZoom`,`uFromPan`,`uToPan`,`uHasFrom`,`uFromMips`,`uToMips`,`uIntensity`],c={};for(let e of s)c[e]=r.getUniformLocation(o,e);return n={prog:o,loc:c},this.programs.set(t,n),this.touch(t),n}touch(e){this.lru=[e,...this.lru.filter(t=>t!==e)];let t=new Set([`idle`,this.transition,e]);for(let e=this.lru.length-1;e>=0&&this.lru.length>7;e--){let n=this.lru[e];if(t.has(n))continue;let r=this.programs.get(n);r&&(this.gl.deleteProgram(r.prog),this.programs.delete(n)),this.lru.splice(e,1)}}warmup(e){for(let t of[`idle`,...e])try{this.program(t)}catch(e){this.onError?.(String(e.message||e))}}setSettings(e){e.fit&&e.fit in a&&(this.fit=e.fit),typeof e.kenBurns==`boolean`&&(this.kenBurns=e.kenBurns),typeof e.intensity==`number`&&Number.isFinite(e.intensity)&&(this.intensity=Math.max(.2,Math.min(2,e.intensity))),this.kick()}setPaused(e){this.paused=e,this.from?.setPaused(e),this.to?.setPaused(e),e||this.kick()}async show(e){let t=++this.loadToken,n=new c(this.gl);try{await n.load(e,this.canvas.width,this.canvas.height,!0)}catch(t){n.dispose(),this.onError?.(`Falha ao carregar ${decodeURIComponent(e.url.split(`/`).pop()||``)}: ${t.message||t}`);return}if(t!==this.loadToken){n.dispose();return}this.from&&this.from!==this.to&&this.from.dispose(),this.from=this.to,this.to=n,this.paused&&n.setPaused(!0);let r=!!e.instant||!this.from;this.transition=r?`idle`:e.transition||`fade`;try{this.program(this.transition)}catch(e){this.onError?.(String(e.message||e)),this.transition=r?`idle`:`fade`}r&&this.from&&(this.from.dispose(),this.from=null),this.easing=o[e.easing]||o.easeInOutCubic,this.tDuration=Math.max(150,e.duration||1600),this.tStart=performance.now(),this.seed=Math.random()*100,this.kick()}kick(){this.raf||=requestAnimationFrame(e=>this.frame(e))}kb(e,t){if(!this.kenBurns)return{zoom:1,pan:[0,0]};let n=(t-e.kbStart)/1e3;return{zoom:1+.045*(.5-.5*Math.cos(n/70*Math.PI*2)),pan:[Math.sin(n/53+e.kbSeed)*.012,Math.cos(n/61+e.kbSeed*1.3)*.008]}}frame(e){if(this.raf=0,!this.to)return;let t=this.gl;this.resize();let n=this.transition!==`idle`,r=1;if(n&&(r=Math.min(1,(e-this.tStart)/this.tDuration),r>=1&&(this.transition=`idle`,this.from&&=(this.from.dispose(),null))),this.paused&&!n&&this.firstFrameSent)return;this.from?.tick(e),this.to.tick(e);let i;try{i=this.program(n?this.transition:`idle`)}catch(e){this.onError?.(String(e.message||e)),this.transition=`idle`,i=this.program(`idle`)}t.viewport(0,0,this.canvas.width,this.canvas.height),t.useProgram(i.prog),t.enableVertexAttribArray(0),t.vertexAttribPointer(0,2,t.FLOAT,!1,0,0);let o=i.loc;t.activeTexture(t.TEXTURE0),t.bindTexture(t.TEXTURE_2D,this.from?this.from.tex:this.to.tex),t.uniform1i(o.uFrom,0),t.activeTexture(t.TEXTURE1),t.bindTexture(t.TEXTURE_2D,this.to.tex),t.uniform1i(o.uTo,1);let s=this.from||this.to;t.uniform2f(o.uFromSize,s.width,s.height),t.uniform2f(o.uToSize,this.to.width,this.to.height),t.uniform2f(o.uRes,this.canvas.width,this.canvas.height),t.uniform1f(o.uProgress,n?this.easing(r):1),t.uniform1f(o.uTime,e/1e3),t.uniform1f(o.uSeed,this.seed),t.uniform1i(o.uFit,a[this.fit]);let c=this.kb(s,e),l=this.kb(this.to,e);t.uniform1f(o.uFromZoom,c.zoom),t.uniform1f(o.uToZoom,l.zoom),t.uniform2f(o.uFromPan,c.pan[0],c.pan[1]),t.uniform2f(o.uToPan,l.pan[0],l.pan[1]),t.uniform1f(o.uHasFrom,+!!this.from),t.uniform1f(o.uFromMips,+!!s.mips),t.uniform1f(o.uToMips,+!!this.to.mips),t.uniform1f(o.uIntensity,this.intensity),t.drawArrays(t.TRIANGLES,0,3),this.firstFrameSent||(this.firstFrameSent=!0,requestAnimationFrame(()=>this.onFirstFrame?.()));let u=this.to.animated||(this.from?.animated??!1);(!this.paused&&(this.transition!==`idle`||this.kenBurns||u)||this.paused&&this.transition!==`idle`)&&this.kick()}};export{l as t};