// GLSL ES 3.00 transitions. Every transition defines `vec4 transition(vec2 uv)`
// using getFrom(uv) / getTo(uv) and the eased progress `p`.

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

vec4 sampleMedia(sampler2D tex, vec2 size, vec2 uv, float zoom, vec2 pan, float mips) {
  vec2 sc = fitScale(size);
  vec2 q = (uv - 0.5) * sc / zoom + 0.5 + pan;
  bool inside = q.x >= 0.0 && q.x <= 1.0 && q.y >= 0.0 && q.y <= 1.0;
  if (inside || uFit == 0 || uFit == 2) {
    q = clamp(q, 0.0, 1.0);
    return texture(tex, vec2(q.x, 1.0 - q.y));
  }
  // Letterbox area (contain/center): blurred, darkened cover of the same image.
  float ca = uRes.x / uRes.y; float ma = size.x / max(size.y, 1.0);
  vec2 cs = vec2(1.0); if (ma > ca) cs.x = ca / ma; else cs.y = ma / ca;
  vec2 bq = clamp((uv - 0.5) * cs * 0.9 + 0.5, 0.0, 1.0);
  vec4 bg = mips > 0.5 ? textureLod(tex, vec2(bq.x, 1.0 - bq.y), 6.5) : texture(tex, vec2(bq.x, 1.0 - bq.y));
  return vec4(bg.rgb * 0.45, 1.0);
}

vec4 getFrom(vec2 uv) {
  if (uHasFrom < 0.5) return vec4(0.0, 0.0, 0.0, 1.0);
  return sampleMedia(uFrom, uFromSize, uv, uFromZoom, uFromPan, uFromMips);
}
vec4 getTo(vec2 uv) { return sampleMedia(uTo, uToSize, uv, uToZoom, uToPan, uToMips); }
vec2 zoomUv(vec2 uv, float z) { return (uv - 0.5) / z + 0.5; }
`;

const FOOTER = `
void main() {
  p = clamp(uProgress, 0.0, 1.0);
  outColor = vec4(transition(vUv).rgb, 1.0);
}`;

export const TRANSITIONS: Record<string, string> = {
  idle: `vec4 transition(vec2 uv) { return getTo(uv); }`,

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
  const body = TRANSITIONS[name] || TRANSITIONS.fade;
  return HEADER + body + FOOTER;
}

export const TRANSITION_NAMES = Object.keys(TRANSITIONS).filter((n) => n !== 'idle');
