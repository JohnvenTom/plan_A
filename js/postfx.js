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

float linDepth(vec2 uv) {
  float z = texture2D(tDepth, uv).x;
  float ndc = z * 2.0 - 1.0;
  float lin = (2.0 * uNear * uFar) / (uFar + uNear - ndc * (uFar - uNear));
  return lin;   // view-space meters
}

void main() {
  vec2 uv = vUv;

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

  // --- vignette ---
  vec2 q = vUv - 0.5;
  float v = 1.0 - uVignette * dot(q, q) * 1.9;
  col *= clamp(v, 0.0, 1.0);

  gl_FragColor = vec4(col, 1.0);
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
      uTime: { value: 0 },
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
    this.bloomA.setSize(rw >> 1, rh >> 1);
    this.bloomB.setSize(rw >> 1, rh >> 1);
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
    u.uTime.value = performance.now() / 1000;
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
    this.pipPass.mat.uniforms.uBorderUV.value.set(4 / pxW, 2 / pxH);
  }

  // run the chain to the screen (PIP last, if tSrc bound)
  composite() {
    const r = this.r;
    // bright extract
    this.brightPass.mat.uniforms.tScene.value = this.sceneRT.texture;
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
    cu.tScene.value = this.sceneRT.texture;
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
