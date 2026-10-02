// postfx.js — hand-rolled post-processing stack (three core has no composer
// vendored). One scene render into an HDR-ish target with depth, then a chain
// of fullscreen passes: bright-extract → separable blur (bloom) → composite.
// The composite pass does everything cheap in one sweep: bloom add, radial
// speed blur, god rays from the sun's screen position, camera-velocity
// motion smear, cinematic depth-of-field (kill-cam/intro only), auto
// exposure, time-of-day/weather color grading, heat-distortion points, and
// a soft vignette.
//
// All knobs arrive per-frame via `state` — the game owns the intent, this
// module only knows shaders.
import * as THREE from 'three';

const QUAD_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const BRIGHT_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tScene;
uniform float uThreshold;
void main() {
  vec3 c = texture2D(tScene, vUv).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float k = max(0.0, l - uThreshold) / max(l, 0.0001);
  gl_FragColor = vec4(c * k, 1.0);
}`;

const BLUR_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uDir;          // (1,0) horizontal, (0,1) vertical, in texels
void main() {
  vec3 sum = texture2D(tSrc, vUv).rgb * 0.227027;
  sum += texture2D(tSrc, vUv + uDir * 1.3846).rgb * 0.316216;
  sum += texture2D(tSrc, vUv - uDir * 1.3846).rgb * 0.316216;
  sum += texture2D(tSrc, vUv + uDir * 3.2308).rgb * 0.070270;
  sum += texture2D(tSrc, vUv - uDir * 3.2308).rgb * 0.070270;
  gl_FragColor = vec4(sum, 1.0);
}`;

const COMPOSITE_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform sampler2D tDepth;
uniform vec2 uRes;
uniform float uNear, uFar;

uniform float uExposure;      // auto-exposure, multiplies after ACES
uniform float uBloom;         // bloom intensity
uniform float uRadial;        // radial speed blur amount (0..1)
uniform vec2 uRadialC;        // its center in uv
uniform float uGodray;        // sun-shaft amount
uniform vec2 uSunUV;          // sun screen pos
uniform float uSunVis;        // 0..1 sun visibility factor
uniform vec2 uMotionDir;      // motion-blur smear dir (uv/tx)
uniform float uMotionAmt;     // smear amount
uniform float uDofAmt;        // depth-of-field strength (cine only)
uniform float uDofFocus;      // focus distance (m, view space)
uniform float uTime;
uniform vec3 uWarm;           // grading: warm/cool tint
uniform float uSat;           // grading: saturation
uniform float uVignette;      // vignette strength
uniform vec4 uHeat[2];        // xy screen pos, z radius(uv), w strength
uniform float uFlash;         // lightning white flash
uniform float uCloud;         // cloud immersion 0..1 — AC7 whiteout
uniform float uRain;          // lens rain droplet amount
uniform float uDropT;         // droplet animation clock

float linDepth(vec2 uv) {
  float z = texture2D(tDepth, uv).x;
  float ndc = z * 2.0 - 1.0;
  float lin = (2.0 * uNear * uFar) / (uFar + uNear - ndc * (uFar - uNear));
  return lin;   // view-space meters
}

float dhash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
vec2 dhash2(vec2 p){ return vec2(dhash(p), dhash(p + 31.7)); }

// ---- REFRACTING lens droplets: each bead is a tiny ball lens that pulls
// its pixels from further out (minified, flipped feel) + a soft specular
// dot. Jittered 3x3 grid, per-cell life cycle so beads form and dry.
// Screen center stays near-dry so the sight area reads.
// Returns warped uv; spec lands in .z ----
vec3 dropletWarp(vec2 uv, out float spec, out float rim) {
  spec = 0.0;
  rim = 0.0;
  vec2 warped = uv;
  if (uRain < 0.22) return vec3(warped, 0.0);
  const float CELL = 52.0;                       // px per droplet cell
  vec2 g = uv * uRes / CELL;
  vec2 cell = floor(g);
  vec2 f = fract(g) - 0.5;
  vec2 acc = vec2(0.0);
  float amp = smoothstep(0.22, 0.75, uRain);
  // dry center: the middle of the screen (sight/HUD zone) stays readable
  float ctr = length((uv - vec2(0.5, 0.54)) * vec2(1.12, 1.0));
  float open = smoothstep(0.10, 0.32, ctr);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 o = vec2(float(i), float(j));
      vec2 h = dhash2(cell + o);
      // sparser + fainter toward the screen center
      float alive = step(0.55 + (1.0 - open) * 0.38, h.x);
      float life = fract(uDropT * 0.22 + h.y * 9.17);
      float fade = smoothstep(0.0, 0.1, life) * smoothstep(1.0, 0.82, life);
      vec2 center = (o + (h - 0.5) * 0.72);
      vec2 d = f - center;
      // droplets cling slightly elongated against the airstream (up-screen)
      d.y *= 0.82;
      float r = 0.075 + h.y * 0.085;
      float m = length(d) / r;
      if (m < 1.0 && alive > 0.5) {
        // BALL-LENS refraction at real strength: the sample displacement
        // approaches the drop's own radius (a lens-ball inverts & minifies
        // the world inside it) — a 2-3 px warp reads as nothing
        float lens = (0.35 + 0.65 * (1.0 - m)) * (1.0 - m * m);
        acc += normalize(d + 1e-5) * lens * r * 2.6 * amp * fade * (0.25 + 0.75 * open);
        // rim shading: the bead edge catches a darker meniscus
        spec = max(spec, smoothstep(0.42, 0.0, length(d + vec2(-r * 0.34, r * 0.34)) / r) * fade * amp * (0.3 + 0.7 * open));
        rim = max(rim, smoothstep(0.62, 1.0, m) * 0.5 * fade * amp * (0.3 + 0.7 * open));
      }
    }
  }
  warped += acc * CELL / uRes;
  return vec3(warped, spec);
}

void main() {
  vec2 uv = vUv;

  // --- refracting rain droplets on the lens (distorts the sampled scene) ---
  float dropSpec = 0.0;
  float dropRim = 0.0;
  vec3 dw = dropletWarp(uv, dropSpec, dropRim);
  uv = dw.xy;

  // --- heat shimmer: distort UVs near engine/missile exhaust points ---
  for (int i = 0; i < 2; i++) {
    vec4 h = uHeat[i];
    if (h.w <= 0.0) continue;
    vec2 d = uv - h.xy;
    float m = exp(-dot(d, d) / max(h.z * h.z, 1e-5));
    uv += vec2(sin(uv.y * 90.0 + uv.x * 70.0), cos(uv.x * 80.0)) * m * h.w * 0.004;
  }

  // --- radial speed blur + god rays share one radial sampling loop ---
  vec3 col;
  float radial = uRadial;
  float god = uGodray * uSunVis;
  if (radial > 0.001 || god > 0.001) {
    vec3 rc = vec3(0.0);
    vec3 gc = vec3(0.0);
    const int N = 8;
    for (int i = 0; i < N; i++) {
      float t = float(i) / float(N - 1);
      // radial blur: samples pulled toward the speed center
      vec2 ruv = mix(uv, uRadialC, t * 0.16 * radial);
      rc += texture2D(tScene, ruv).rgb;
      // god rays: samples along the sun direction, decay with distance;
      // DEPTH-OCCLUDED — terrain and sea write depth and swallow the shafts,
      // the sky dome (far clear depth) passes them: real Tyndall behavior
      vec2 guv = mix(uSunUV, uv, 1.0 - t * 0.85);
      vec3 g = texture2D(tScene, guv).rgb;
      float gd = linDepth(guv);
      float occ = smoothstep(8000.0, 24000.0, gd);
      float lum = dot(g, vec3(0.3333));
      gc += g * smoothstep(0.55, 1.0, lum) * (1.0 - t) * occ;
    }
    rc /= float(N);
    float gw = 0.0;
    for (int i = 1; i < N; i++) gw += (1.0 - float(i) / float(N - 1));
    gc /= max(gw, 0.001) * float(N) / float(N);   // ~normalized
    col = mix(texture2D(tScene, uv).rgb, rc, clamp(radial * 0.85, 0.0, 0.9));
    col += gc * god * 0.11 * vec3(1.15, 1.0, 0.72);
  } else {
    col = texture2D(tScene, uv).rgb;
  }

  // --- motion smear: subtle pixel-level ghosting along camera rotation ---
  if (uMotionAmt > 0.001) {
    vec3 m = col;
    for (int i = 1; i <= 3; i++) {
      float o = float(i) * uMotionAmt * 0.004;   // ~px offsets, not screen-width
      m += texture2D(tScene, uv + uMotionDir * o).rgb;
      m += texture2D(tScene, uv - uMotionDir * o).rgb;
    }
    col = mix(col, m / 7.0, clamp(uMotionAmt * 10.0, 0.0, 0.4));
  }

  // --- cinematic DOF: blur where |depth - focus| is large (kill-cam etc) ---
  if (uDofAmt > 0.001) {
    float d = linDepth(uv);
    float coc = clamp(abs(d - uDofFocus) / max(uDofFocus, 60.0), 0.0, 1.0);
    float need = coc * uDofAmt;
    if (need > 0.02) {
      vec2 px = need * 6.0 / uRes;
      vec3 b = vec3(0.0);
      b += texture2D(tScene, uv + vec2( px.x,  px.y)).rgb;
      b += texture2D(tScene, uv + vec2(-px.x,  px.y)).rgb;
      b += texture2D(tScene, uv + vec2( px.x, -px.y)).rgb;
      b += texture2D(tScene, uv + vec2(-px.x, -px.y)).rgb;
      col = mix(col, b * 0.25, clamp(need * 1.6, 0.0, 0.85));
    }
  }

  // --- bloom add ---
  col += texture2D(tBloom, uv).rgb * uBloom;

  // --- grading: exposure, warm/cool tint, saturation, flash ---
  col *= uExposure;
  col *= uWarm;
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(lum), col, uSat);
  col += uFlash * vec3(0.55, 0.6, 0.7);

  // --- cloud immersion: the AC7 whiteout — inside a deck the world melts
  // into wind-blown milk; geometry vanishes, only motion remains ---
  if (uCloud > 0.003) {
    float cl = uCloud * uCloud;
    vec2 q2 = vUv - 0.5;
    float edge = 1.0 - dot(q2, q2) * 0.9;          // slightly less at corners
    float gust = 0.94 + 0.06 * sin(vUv.y * 21.0 + uTime * 2.0);
    col = mix(col, vec3(0.86, 0.88, 0.92) * gust * edge, clamp(cl * 1.04, 0.0, 0.985));
  }

  // droplet specular sparkle + meniscus rim on top of everything
  col += dropSpec * 0.26 * vec3(0.9, 0.97, 1.0);
  col *= 1.0 - dropRim * 0.4;

  // --- vignette ---
  vec2 q = vUv - 0.5;
  float v = 1.0 - uVignette * dot(q, q) * 1.9;
  col *= clamp(v, 0.0, 1.0);

  gl_FragColor = vec4(col, 1.0);
}`;

// ---- TRUE volumetric clouds: half-res raymarch through two slabs
// (cumulus 2350-3220 m with a vertical billow profile + cirrus veil
// 4050-4560 m with stretched streak noise). Depth-aware - terrain and sea
// correctly occlude the march; silver lining via Henyey-Greenstein phase;
// two shadow taps toward the sun; coverage/darkness driven by weather.
const CLOUD_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform vec3 uCamPos;
uniform mat4 uInvVP;
uniform vec3 uSunDir;
uniform float uTime;
uniform float uCoverage;   // weather: 0 scattered .. 1 thick overcast
uniform float uDark;       // storm blackening
uniform float uNight;
uniform sampler2D tDepth;
uniform float uNear, uFar;

float hash3(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float noise3(vec3 p){
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash3(i), hash3(i + vec3(1,0,0)), u.x),
                 mix(hash3(i + vec3(0,1,0)), hash3(i + vec3(1,1,0)), u.x), u.y),
             mix(mix(hash3(i + vec3(0,0,1)), hash3(i + vec3(1,0,1)), u.x),
                 mix(hash3(i + vec3(0,1,1)), hash3(i + vec3(1,1,1)), u.x), u.y), u.z);
}
float fbm3(vec3 p){
  float v = 0.0, a = 0.55;
  for (int i = 0; i < 3; i++){ v += a * noise3(p); p = p * 2.07 + 13.7; a *= 0.5; }
  return v;
}

// clouds live ONLY over the island chain (full within 9 km of world center,
// gone past 12 km): the open sea keeps a clean sky, and the horizon can
// never cut the layer — the density is already zero at the mesh-edge zone
float islandMask(vec3 p) {
  return smoothstep(13000.0, 8000.0, length(p.xz));
}

float slab(vec3 p, out float hn) {
  float d = 0.0;
  hn = -1.0;
  float im = islandMask(p);
  if (p.y > 2330.0 && p.y < 3220.0) {
    float h = (p.y - 2330.0) / 890.0;
    vec3 q = vec3(p.x + uTime * 6.0, p.y, p.z + uTime * 1.5) * 0.00042;
    float n = fbm3(q) * 0.75 + fbm3(q * 3.1 + 31.0) * 0.25;
    float prof = smoothstep(0.0, 0.24, h) * smoothstep(1.0, 0.66, h);
    d += smoothstep(0.74 - uCoverage * 0.48, 0.74 - uCoverage * 0.48 + 0.34, n) * prof * im;
    hn = h;
  }
  if (p.y > 4050.0 && p.y < 4560.0) {
    vec3 q = vec3(p.x * 0.00009 + uTime * 0.004, p.y * 0.004, p.z * 0.00013);
    float n = fbm3(q);
    d += smoothstep(0.72 - uCoverage * 0.4, 0.72 - uCoverage * 0.4 + 0.18, n) * 0.38 * im;
  }
  return d;
}

float sceneDepth() {
  float z = texture2D(tDepth, vUv).x;
  float ndc = z * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - ndc * (uFar - uNear));
}

void main() {
  if (uCoverage < 0.02) { gl_FragColor = vec4(0.0); return; }
  vec4 farP = uInvVP * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  farP /= farP.w;
  vec3 rd = normalize(farP.xyz - uCamPos);
  float maxD = min(sceneDepth(), 34000.0) - 30.0;
  float t0 = 1e9, t1 = -1e9;
  if (abs(rd.y) > 0.001) {
    for (float yb = 2300.0; yb <= 4600.0; yb += 1150.0) {
      float t = (yb - uCamPos.y) / rd.y;
      if (t < 0.0) continue;
      t0 = min(t0, t); t1 = max(t1, t);
    }
    if (uCamPos.y > 2300.0 && uCamPos.y < 4600.0) t0 = 0.0;
  }
  t0 = max(t0, 0.0);
  t1 = min(t1, maxD);
  if (t1 <= t0) { gl_FragColor = vec4(0.0); return; }
  // NOTE: no binary island-zone cull anymore — the cliff between "marched"
  // and "skipped" pixels read as a seam cutting the layer when viewed edge-on.
  // The soft world-space mask below (plus the haze melt) carries it alone.

  const int N = 34;
  float stepLen = (t1 - t0) / float(N);
  float jitter = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  float t = t0 + stepLen * jitter;
  float mu = dot(rd, uSunDir);
  float hg = 0.72 * (1.0 - 0.2025) / (4.0 * 3.14159 * pow(1.2025 - 0.9 * mu, 1.5))
           + 0.28 * 0.25;
  vec3 sunCol = mix(vec3(1.3, 1.12, 0.95), vec3(0.25, 0.3, 0.42), uNight);
  vec3 amb = mix(vec3(0.52, 0.56, 0.64), vec3(0.08, 0.1, 0.15), uNight);
  vec3 acc = vec3(0.0);
  float T = 1.0;
  for (int i = 0; i < N; i++) {
    vec3 p = uCamPos + rd * t;
    float hn;
    float d = slab(p, hn);
    if (d > 0.003) {
      float sh = 1.0;
      float hnx;
      sh -= clamp(slab(p + uSunDir * 150.0, hnx), 0.0, 1.0) * 0.42;
      sh -= clamp(slab(p + uSunDir * 360.0, hnx), 0.0, 1.0) * 0.3;
      vec3 lum = sunCol * max(sh, 0.05) * (hg * 2.2 + 0.32) + amb * (0.55 + max(hn, 0.0) * 0.5);
      lum = mix(lum, lum * vec3(0.42, 0.44, 0.5), uDark);
      float a = 1.0 - exp(-d * stepLen * 0.011);
      acc += T * a * lum;
      T *= 1.0 - a;
      if (T < 0.05) break;
    }
    t += stepLen;
  }
  // horizon fog, PROPER: the window must FINISH before the island-zone
  // boundary (13 km) — a horizontal world-space edge viewed edge-on
  // compresses to ~2 px no matter how soft it is in world space, so the
  // only line-proof arrangement is: fog fully dissolves the layer BEFORE
  // the density edge can arrive. 6→14 km, alpha leads the color.
  float fog = smoothstep(5500.0, 12500.0, t0);   // fully fogged BEFORE the 13 km zone edge
  vec3 haze = mix(vec3(0.62, 0.66, 0.73), vec3(0.07, 0.09, 0.13), uNight);
  haze = mix(haze, haze * vec3(0.5, 0.52, 0.58), uDark);
  acc = mix(acc, haze, fog * 0.45);
  float alpha = (1.0 - T) * (1.0 - fog);          // fog=1 -> fully transparent
  gl_FragColor = vec4(acc, alpha);
}`;

// blend pass: volumetrics composite over the scene
const BLEND_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tScene;
uniform sampler2D tCloud;
void main() {
  vec3 s = texture2D(tScene, vUv).rgb;
  vec4 c = texture2D(tCloud, vUv);
  gl_FragColor = vec4(mix(s, c.rgb, clamp(c.a, 0.0, 1.0)), 1.0);
}`;

// missile-cam picture-in-picture: draws the missile RT on screen over
// everything, AC7-style top-right corner box
const PIP_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform float uOpen;         // 0..1 CRT power-on progress
uniform float uGlitch;       // transient signal-fault strength
uniform float uZoom;         // impact punch: zooms the PIP image
uniform float uTime;
uniform vec2 uBorderUV;      // frame thickness in uv (px / quad size)

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

void main() {
  // signal glitch: horizontal band jitter + rgb split + static burst
  float g = max(uGlitch, (1.0 - uOpen) * 0.8);
  float band = floor(vUv.y * 16.0 + uTime * 24.0);
  vec2 uv = mix(vec2(0.5), vUv, 1.0 / max(uZoom, 1.0));
  uv.x += (hash(vec2(band, floor(uTime * 22.0))) - 0.5) * 0.22 * g;
  uv = clamp(uv, 0.0, 1.0);
  float split = (0.002 + 0.016 * g) * (0.4 + 0.6 * abs(fract(uTime * 9.0) - 0.5) * 2.0);
  float rr = texture2D(tSrc, uv + vec2(split, 0.0)).r;
  vec4 gb = texture2D(tSrc, uv);
  vec3 c = vec3(rr, gb.g, gb.b);
  c *= vec3(0.92, 1.04, 0.98);                      // seeker tint
  c *= 0.88 + 0.12 * step(0.5, fract(vUv.y * 90.0)); // scanlines
  // static noise during the fault
  float n = hash(vUv * vec2(191.0, 113.0) + fract(uTime) * 43.0);
  c = mix(c, vec3(n * 1.15), clamp(g * 0.55, 0.0, 0.85));
  // frame: same quad as the picture — identical size by construction
  vec2 b = min(vUv, 1.0 - vUv);
  float edge = min(b.x, b.y);
  vec3 col = c;
  if (edge < uBorderUV.x * 2.0) col = vec3(0.03, 0.05, 0.07);
  else if (edge < uBorderUV.x * 2.0 + uBorderUV.y) col = vec3(0.62, 0.91, 1.0);
  // CRT beam: bright horizontal line riding the opening/closing edge
  float beam = exp(-abs(vUv.y - 0.5) * 42.0) * g * 0.9;
  col += beam * vec3(0.7, 0.95, 1.0);
  gl_FragColor = vec4(col * uOpen, uOpen);
}`;

// fullscreen passes hard-code clip space; the PIP quad must respect its
// mesh scale/position (setPipRect) so it stays a corner box, not the screen
const QUAD_XF_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const _pm4 = new THREE.Matrix4();

function makePass(frag, uniforms, vert = QUAD_VERT) {
  const mat = new THREE.ShaderMaterial({
    vertexShader: vert,
    fragmentShader: frag,
    uniforms,
    depthTest: false, depthWrite: false,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  return { scene, cam, mat, mesh };
}

export class PostFX {
  constructor(renderer) {
    this.r = renderer;
    this.w = 1; this.h = 1;

    this.sceneRT = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      depthBuffer: true,
    });
    this.sceneRT.depthTexture = new THREE.DepthTexture(1, 1);
    this.sceneRT.depthTexture.type = THREE.UnsignedIntType;

    this.bloomA = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    this.bloomB = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    this.sceneRT2 = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    this.cloudRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });

    this.brightPass = makePass(BRIGHT_FRAG, {
      tScene: { value: null }, uThreshold: { value: 0.82 },
    });
    this.blurPass = makePass(BLUR_FRAG, {
      tSrc: { value: null }, uDir: { value: new THREE.Vector2() },
    });
    this.compPass = makePass(COMPOSITE_FRAG, {
      tScene: { value: null }, tBloom: { value: null }, tDepth: { value: null },
      uRes: { value: new THREE.Vector2() },
      uNear: { value: 2.5 }, uFar: { value: 72000 },
      uExposure: { value: 1 }, uBloom: { value: 0.7 },
      uRadial: { value: 0 }, uRadialC: { value: new THREE.Vector2(0.5, 0.5) },
      uGodray: { value: 0.5 }, uSunUV: { value: new THREE.Vector2(0.5, 0.5) }, uSunVis: { value: 0 },
      uMotionDir: { value: new THREE.Vector2() }, uMotionAmt: { value: 0 },
      uDofAmt: { value: 0 }, uDofFocus: { value: 800 },
      uWarm: { value: new THREE.Vector3(1, 1, 1) }, uSat: { value: 1 },
      uVignette: { value: 0.5 },
      uHeat: { value: [new THREE.Vector4(), new THREE.Vector4()] },
      uFlash: { value: 0 },
      uCloud: { value: 0 },
      uRain: { value: 0 }, uDropT: { value: 0 },
      uTime: { value: 0 },
    });
    this.cloudPass = makePass(CLOUD_FRAG, {
      uCamPos: { value: new THREE.Vector3() },
      uInvVP: { value: new THREE.Matrix4() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uTime: { value: 0 },
      uCoverage: { value: 0 },
      uDark: { value: 0 },
      uNight: { value: 0 },
      tDepth: { value: null },
      uNear: { value: 2.5 }, uFar: { value: 72000 },
    });
    this.blendPass = makePass(BLEND_FRAG, {
      tScene: { value: null }, tCloud: { value: null },
    });
    this.pipPass = makePass(PIP_FRAG, {
      tSrc: { value: null }, uOpen: { value: 0 }, uGlitch: { value: 0 },
      uZoom: { value: 1 }, uTime: { value: 0 },
      uBorderUV: { value: new THREE.Vector2(0.01, 0.008) },
    }, QUAD_XF_VERT);
    this._pipBase = { w: 0.3, h: 0.2 };

    this.setSize(innerWidth, innerHeight);
  }

  setSize(w, h) {
    this.w = w; this.h = h;
    const dpr = Math.min(devicePixelRatio || 1, 1.5);
    const rw = Math.max(2, Math.floor(w * dpr)), rh = Math.max(2, Math.floor(h * dpr));
    this.sceneRT.setSize(rw, rh);
    this.sceneRT2.setSize(rw, rh);
    this.bloomA.setSize(rw >> 1, rh >> 1);
    this.bloomB.setSize(rw >> 1, rh >> 1);
    this.cloudRT.setSize(Math.max(2, rw >> 1), Math.max(2, rh >> 1));   // half-res march
    this.compPass.mat.uniforms.uRes.value.set(rw, rh);
  }

  // feed intent every frame; see COMPOSITE_FRAG for the fields
  setState(s) {
    const u = this.compPass.mat.uniforms;
    if (s.exposure !== undefined) u.uExposure.value = s.exposure;
    if (s.bloom !== undefined) u.uBloom.value = s.bloom;
    if (s.radial !== undefined) u.uRadial.value = s.radial;
    if (s.radialC) u.uRadialC.value.set(s.radialC[0], s.radialC[1]);
    if (s.sunUV) u.uSunUV.value.set(s.sunUV[0], s.sunUV[1]);
    if (s.sunVis !== undefined) u.uSunVis.value = s.sunVis;
    if (s.godray !== undefined) u.uGodray.value = s.godray;
    if (s.motionDir) u.uMotionDir.value.set(s.motionDir[0], s.motionDir[1]);
    if (s.motionAmt !== undefined) u.uMotionAmt.value = s.motionAmt;
    if (s.dofAmt !== undefined) u.uDofAmt.value = s.dofAmt;
    if (s.dofFocus !== undefined) u.uDofFocus.value = s.dofFocus;
    if (s.warm) u.uWarm.value.set(s.warm[0], s.warm[1], s.warm[2]);
    if (s.sat !== undefined) u.uSat.value = s.sat;
    if (s.vignette !== undefined) u.uVignette.value = s.vignette;
    if (s.flash !== undefined) u.uFlash.value = s.flash;
    if (s.cloud !== undefined) u.uCloud.value = s.cloud;
    if (s.rain !== undefined) u.uRain.value = s.rain;
    u.uDropT.value = performance.now() / 1000;
    u.uTime.value = performance.now() / 1000;
    if (!s.cloudState) this.cloudPass.mat.uniforms.uCoverage.value = 0;
    if (s.cloudState) {
      const cu = this.cloudPass.mat.uniforms;
      cu.uCamPos.value.copy(s.cloudState.camPos);
      cu.uInvVP.value.copy(s.cloudState.invVP);
      cu.uSunDir.value.copy(s.cloudState.sunDir);
      cu.uCoverage.value = s.cloudState.coverage;
      cu.uDark.value = s.cloudState.dark;
      cu.uNight.value = s.cloudState.night;
      cu.tDepth.value = this.sceneRT.depthTexture;
    }
    if (s.heat) {
      for (let i = 0; i < 2; i++) {
        const hv = s.heat[i] || [0, 0, 0, 0];
        u.uHeat.value[i].set(hv[0], hv[1], hv[2], hv[3]);
      }
    }
  }

  // scene render goes here (renderer target = sceneRT)
  beginScene() {
    this.r.setRenderTarget(this.sceneRT);
    this.r.clear();
  }

  // missile-cam PIP texture source (set externally)
  setPipSource(rt) { this.pipPass.mat.uniforms.tSrc.value = rt?.texture ?? null; }

  // march + blend volumetric clouds into an EXTERNAL render target using an
  // arbitrary camera (the missile seeker). Saves/restores the main-camera
  // uniforms. Returns false when coverage is zero (caller keeps srcRT).
  renderPipClouds(srcRT, dstRT, camera) {
    const cu = this.cloudPass.mat.uniforms;
    if (!cu.uCoverage.value || cu.uCoverage.value <= 0.02) return false;
    const keepPos = cu.uCamPos.value.clone();
    const keepVP = cu.uInvVP.value.clone();
    const keepDepth = cu.tDepth.value;
    try {
      cu.uCamPos.value.copy(camera.position);
      cu.uInvVP.value.copy(_pm4.copy(camera.projectionMatrix).multiply(camera.matrixWorldInverse).invert());
      cu.tDepth.value = srcRT.depthTexture;
      this.r.setRenderTarget(this.cloudRT);
      this.r.render(this.cloudPass.scene, this.cloudPass.cam);
      this.blendPass.mat.uniforms.tScene.value = srcRT.texture;
      this.blendPass.mat.uniforms.tCloud.value = this.cloudRT.texture;
      this.r.setRenderTarget(dstRT);
      this.r.render(this.blendPass.scene, this.blendPass.cam);
      return true;
    } finally {
      cu.uCamPos.value.copy(keepPos);
      cu.uInvVP.value.copy(keepVP);
      cu.tDepth.value = keepDepth;
    }
  }
  setPip(open, zoom, glitch) {
    const u = this.pipPass.mat.uniforms;
    u.uOpen.value = open;
    u.uZoom.value = zoom;
    u.uGlitch.value = glitch;
    // CRT vertical expansion: near-zero open = collapsed bright line
    const e = open <= 0 ? 0 : (open >= 1 ? 1 : 1 - Math.pow(1 - open, 3));
    this.pipPass.mesh.scale.y = this._pipBase.h * Math.max(0.05, e);
    u.uBorderUV.value.set(
      4 / Math.max(2, this._pipBase.w * 0.5 * (innerWidth || 1)),
      2 / Math.max(2, this._pipBase.h * Math.max(0.05, e) * 0.5 * (innerHeight || 1)),
    );
  }
  // PIP on-screen rect (NDC), mesh scaled to it; border thickness follows
  // the quad's pixel size so it stays a 4px matte + 2px line at any window
  setPipRect(x, y, w, h) {
    this._pipBase = { w, h };
    this.pipPass.mesh.scale.set(w, h, 1);
    this.pipPass.mesh.position.set(x, y, 0);
    const pxW = Math.max(2, w * 0.5 * (innerWidth || 1));
    const pxH = Math.max(2, h * 0.5 * (innerHeight || 1));
    this.pipPass.mat.uniforms.uBorderUV.value.set(1.6 / pxW, 1.1 / pxH);   // ultra-thin
  }

  // run the chain to the screen (PIP last, if tSrc bound)
  composite() {
    const r = this.r;
    // volumetric clouds: march at half res, blend over the scene (full res)
    const work = (this.cloudPass.mat.uniforms.uCoverage.value > 0.02) ? this.sceneRT2 : this.sceneRT;
    if (work === this.sceneRT2) {
      this.cloudPass.mat.uniforms.uTime.value = performance.now() / 1000;
      r.setRenderTarget(this.cloudRT);
      r.render(this.cloudPass.scene, this.cloudPass.cam);
      this.blendPass.mat.uniforms.tScene.value = this.sceneRT.texture;
      this.blendPass.mat.uniforms.tCloud.value = this.cloudRT.texture;
      r.setRenderTarget(this.sceneRT2);
      r.render(this.blendPass.scene, this.blendPass.cam);
    }
    // bright extract
    this.brightPass.mat.uniforms.tScene.value = work.texture;
    r.setRenderTarget(this.bloomA);
    r.render(this.brightPass.scene, this.brightPass.cam);
    // two blur iterations (H+V) at half res
    const dir = this.blurPass.mat.uniforms.uDir.value;
    for (let i = 0; i < 2; i++) {
      dir.set(1.5 / this.bloomA.width, 0);
      this.blurPass.mat.uniforms.tSrc.value = this.bloomA.texture;
      r.setRenderTarget(this.bloomB);
      r.render(this.blurPass.scene, this.blurPass.cam);
      dir.set(0, 1.5 / this.bloomA.height);
      this.blurPass.mat.uniforms.tSrc.value = this.bloomB.texture;
      r.setRenderTarget(this.bloomA);
      r.render(this.blurPass.scene, this.blurPass.cam);
    }
    // composite to screen
    const cu = this.compPass.mat.uniforms;
    cu.tScene.value = work.texture;
    cu.tBloom.value = this.bloomA.texture;
    cu.tDepth.value = this.sceneRT.depthTexture;
    r.setRenderTarget(null);
    r.render(this.compPass.scene, this.compPass.cam);
    // PIP overlay (pipPass has its own scene, drawn over)
    this.pipPass.mat.uniforms.uTime.value = performance.now() / 1000;
    if (this.pipPass.mat.uniforms.tSrc.value) {
      r.autoClear = false;
      r.render(this.pipPass.scene, this.pipPass.cam);
      r.autoClear = true;
    }
  }
}
