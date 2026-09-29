// sky.js — one authored atmosphere model (skill: threejs-sky-atmosphere-and-haze, authored local branch)
// - Sky dome fragment shader: zenith->horizon gradient + sun disc + forward Mie glow
// - scene.fog (FogExp2) = distance haze, color matched to the horizon band
// - ONE sun direction shared by dome shader, directional light, hemisphere light
// - Output stays scene-linear HDR; renderer.toneMapping (ACES) is the single output owner
import * as THREE from 'three';

const SKY_VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = position; // dome centered on camera; position IS the direction
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
}`;

const SKY_FRAG = /* glsl */`
precision highp float;
varying vec3 vDir;
uniform vec3 uSunDir;
uniform float uSunElev; // sin(elevation), used to warm the horizon as the sun lowers

void main() {
  vec3 d = normalize(vDir);
  vec3 s = normalize(uSunDir);
  float h = clamp(d.y, -1.0, 1.0);
  float sunAmt = clamp(dot(d, s), 0.0, 1.0);

  // --- authored gradient (all values scene-linear) ---
  vec3 zenith   = vec3(0.075, 0.19, 0.48);
  vec3 mid      = vec3(0.28, 0.46, 0.78);
  // horizon gets warmer the lower the sun
  vec3 horizon  = mix(vec3(0.82, 0.80, 0.72), vec3(1.10, 0.66, 0.36), uSunElev);

  float upness = clamp(h, 0.0, 1.0);
  vec3 col = mix(mid, zenith, pow(upness, 0.9));
  float hz = pow(1.0 - upness, 4.0);                 // horizon band weight
  float azHeat = 0.45 + 0.55 * pow(sunAmt, 3.0);     // warmer toward sun azimuth
  col = mix(col, horizon, hz * azHeat);

  // --- forward Mie lobe (sign: glow hugs the SUN side, never opposite) ---
  col += vec3(1.15, 0.62, 0.30) * pow(sunAmt, 7.0)  * 0.42;
  col += vec3(1.30, 0.86, 0.55) * pow(sunAmt, 48.0) * 1.10;

  // --- sun disc, ~0.4 deg with soft limb (HDR value -> ACES rolls it off) ---
  float cosA = dot(d, s);
  float disc = smoothstep(0.999972, 0.999991, cosA);
  col += vec3(46.0, 33.0, 20.0) * disc;

  // below-horizon fade into sea haze so the dome meets the ocean cleanly
  col = mix(col, vec3(0.36, 0.40, 0.47), smoothstep(0.0, -0.14, h));

  gl_FragColor = vec4(col, 1.0);
}`;

const CLOUD_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const CLOUD_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform float uTime;
uniform vec3 uColorLit;
uniform vec3 uColorShade;
uniform float uScale;
uniform float uThreshold;
uniform float uDrift;

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1,0)), u.x),
             mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), u.x), u.y);
}
float fbm(vec2 p){
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++){ v += a * noise(p); p = p * 2.03 + 11.7; a *= 0.5; }
  return v;
}

void main() {
  vec2 p = vUv * uScale + vec2(uTime * uDrift, uTime * uDrift * 0.22);
  float n = fbm(p);
  float n2 = fbm(p * 1.9 + 4.7);
  float a = smoothstep(uThreshold, uThreshold + 0.24, n * 0.72 + n2 * 0.28);
  // soft border fade so the deck has no visible edge
  vec2 c = vUv - 0.5;
  float border = smoothstep(0.5, 0.32, max(abs(c.x), abs(c.y)));
  vec3 col = mix(uColorShade, uColorLit, clamp(0.35 + n2 * 0.9, 0.0, 1.0));
  gl_FragColor = vec4(col, a * border * 0.85);
}`;

export class Sky {
  constructor(scene) {
    // ONE sun direction: elevation ~13 deg, azimuth +28 deg from -Z (ahead-right of player start)
    const el = 13 * Math.PI / 180, az = 28 * Math.PI / 180;
    this.sunDir = new THREE.Vector3(
      Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)
    ).normalize();
    this.sunElevSin = Math.sin(el);

    // --- sky dome (follows camera, never fogged) ---
    this.domeMat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uSunDir: { value: this.sunDir },
        uSunElev: { value: this.sunElevSin },
      },
    });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(30000, 48, 24), this.domeMat);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -10;
    scene.add(this.dome);

    // --- cloud deck: two translucent fbm planes for parallax ---
    this.cloudMats = [];
    const deck = (y, scale, thresh, drift, lit, shade, opacityMul) => {
      const mat = new THREE.ShaderMaterial({
        vertexShader: CLOUD_VERT,
        fragmentShader: CLOUD_FRAG,
        transparent: true, depthWrite: false, fog: false,
        side: THREE.DoubleSide,
        uniforms: {
          uTime: { value: 0 },
          uScale: { value: scale },
          uThreshold: { value: thresh },
          uDrift: { value: drift },
          uColorLit: { value: new THREE.Color(...lit) },
          uColorShade: { value: new THREE.Color(...shade) },
          uOpacityMul: { value: opacityMul },
        },
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(44000, 44000), mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = y;
      mesh.frustumCulled = false;
      mesh.renderOrder = -5;
      scene.add(mesh);
      this.cloudMats.push(mat);
      return mesh;
    };
    this.cloudLow = deck(2750, 7.0, 0.52, 0.0035, [1.35, 1.18, 1.02], [0.52, 0.50, 0.55], 1.0);
    this.cloudHigh = deck(4200, 4.2, 0.58, 0.0021, [1.45, 1.32, 1.20], [0.62, 0.62, 0.70], 0.7);

    // --- lighting: sun + sky hemisphere, one shared direction ---
    this.sun = new THREE.DirectionalLight(0xffd9a8, 2.6);
    this.sun.position.copy(this.sunDir).multiplyScalar(10000);
    scene.add(this.sun);
    this.hemi = new THREE.HemisphereLight(0x9db8e8, 0x8a6f52, 0.9);
    scene.add(this.hemi);

    // --- distance haze (FogExp2), color = horizon band average ---
    scene.fog = new THREE.FogExp2(new THREE.Color(0.72, 0.60, 0.47), 0.000042);
    this.cloudTime = 0;
  }

  update(dt, cameraPos) {
    this.cloudTime += dt;
    for (const m of this.cloudMats) m.uniforms.uTime.value = this.cloudTime;
    // dome + cloud decks ride with the camera (x,z only for clouds -> parallax against terrain)
    this.dome.position.copy(cameraPos);
    this.cloudLow.position.x = cameraPos.x;
    this.cloudLow.position.z = cameraPos.z;
    this.cloudHigh.position.x = cameraPos.x;
    this.cloudHigh.position.z = cameraPos.z;
  }

  dispose() {
    this.dome.geometry.dispose(); this.domeMat.dispose();
    for (const m of this.cloudMats) { /* geometries shared per-mesh */ }
    this.cloudLow.geometry.dispose(); this.cloudHigh.geometry.dispose();
    this.cloudMats.forEach(m => m.dispose());
  }
}
