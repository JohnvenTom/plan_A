// sky.js — one authored atmosphere model (skill: threejs-sky-atmosphere-and-haze, authored local branch)
// - Sky dome fragment shader: zenith->horizon gradient + sun disc + forward Mie glow
// - scene.fog (FogExp2) = distance haze, color matched to the horizon band
// - ONE sun direction shared by dome shader, directional light, hemisphere light
// - Output stays scene-linear HDR; renderer.toneMapping (ACES) is the single output owner
import * as THREE from 'three';
import { clamp } from './utils.js';

const _nc = new THREE.Color();
const _gc = new THREE.Color();

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
uniform float uNight;   // 0 day .. 1 full night

float hash21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

void main() {
  vec3 d = normalize(vDir);
  vec3 s = normalize(uSunDir);
  float h = clamp(d.y, -1.0, 1.0);
  float sunAmt = clamp(dot(d, s), 0.0, 1.0);

  // --- authored gradient (all values scene-linear) ---
  vec3 zenith   = vec3(0.045, 0.13, 0.40);
  vec3 mid      = vec3(0.22, 0.38, 0.70);
  // horizon gets warmer the lower the sun
  vec3 horizon  = mix(vec3(0.82, 0.80, 0.72), vec3(1.30, 0.68, 0.32), uSunElev);

  float upness = clamp(h, 0.0, 1.0);
  vec3 col = mix(mid, zenith, pow(upness, 0.9));
  float hz = pow(1.0 - upness, 4.0);                 // horizon band weight
  float azHeat = 0.45 + 0.55 * pow(sunAmt, 3.0);     // warmer toward sun azimuth
  col = mix(col, horizon, hz * azHeat);

  // --- forward Mie lobe (sign: glow hugs the SUN side, never opposite) ---
  col += vec3(1.15, 0.62, 0.30) * pow(sunAmt, 7.0)  * 0.42;
  col += vec3(1.30, 0.86, 0.55) * pow(sunAmt, 48.0) * 1.10;

  // --- sun disc, ~0.8 deg with soft limb (HDR value -> ACES rolls it off) ---
  float cosA = dot(d, s);
  float disc = smoothstep(0.99988, 0.99994, cosA);
  col += vec3(46.0, 33.0, 20.0) * disc;

  // below-horizon fade into sea haze so the dome meets the ocean cleanly
  col = mix(col, vec3(0.36, 0.40, 0.47), smoothstep(0.0, -0.14, h));

  // night blend: dark blue gradient with a faint horizon airglow, then stars
  vec3 nightCol = mix(vec3(0.015, 0.025, 0.06), vec3(0.05, 0.07, 0.12), hz);
  col = mix(col, nightCol, uNight);
  if (uNight > 0.02 && h > 0.02) {
    vec3 sd = normalize(vDir);
    vec2 sp = vec2(atan(sd.z, sd.x), asin(sd.y)) * 80.0;
    vec2 cell = floor(sp);
    float h1 = hash21(cell);
    float star = step(0.992, h1) * smoothstep(0.0, 0.12, sd.y) * uNight;
    col += vec3(0.72, 0.78, 0.95) * star * 1.5;
  }

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
uniform float uNight;   // 0 day .. 1 night: clouds go moonlit-dark
uniform float uAlpha;   // overall deck presence (weather)

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
  col *= 1.0 - uNight * 0.78;
  gl_FragColor = vec4(col, a * border * uAlpha);
}`;

export class Sky {
  constructor(scene) {
    this.scene = scene;
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
        uNight: { value: 0 },
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
          uNight: { value: 0 },
          uAlpha: { value: 0.85 * opacityMul },
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
    this.sun = new THREE.DirectionalLight(0xffd9a8, 2.9);
    this.sun.position.copy(this.sunDir).multiplyScalar(10000);
    scene.add(this.sun);
    this.hemi = new THREE.HemisphereLight(0x9db8e8, 0x9a7350, 1.3);
    scene.add(this.hemi);

    // --- distance haze (FogExp2), color = horizon band average ---
    scene.fog = new THREE.FogExp2(new THREE.Color(0.70, 0.56, 0.42), 0.000034);
    this.cloudTime = 0;
  }

  // ---- day/night cycle: day01 in 0..1 (0 sunrise, .25 noon, .5 sunset,
  //      .75 midnight). Rotates the shared sun direction, swaps to blue
  //      moonlight at night, dims clouds, and drives fog color/density
  //      together with the weather parameters. ----
  setCycle(day01, night01, weather) {
    const ang = day01 * Math.PI * 2;
    const elevSin = Math.sin(ang);
    const elev = Math.asin(clamp(elevSin, -1, 1) * 0.999);
    const az = (day01 * 360 + 200) * Math.PI / 180;
    this.sunDir.set(Math.sin(az) * Math.cos(elev), Math.sin(elev), -Math.cos(az) * Math.cos(elev)).normalize();
    this.sunElevSin = Math.max(-0.15, elevSin);
    this.domeMat.uniforms.uSunDir.value.copy(this.sunDir);
    this.domeMat.uniforms.uSunElev.value = this.sunElevSin;
    this.domeMat.uniforms.uNight.value = night01;

    const dim = weather ? weather.dim : 1;
    const dayF = clamp(elevSin * 4, 0, 1);
    if (dayF > 0.02) {
      this.sun.color.setRGB(1.0, 0.85 - night01 * 0.3, 0.66 - night01 * 0.4);
      this.sun.intensity = 2.9 * Math.pow(dayF, 0.6) * dim;
      this.sun.position.copy(this.sunDir).multiplyScalar(10000);
    } else {
      // moonlight: fixed blueish direction, faint
      this.sun.color.setHex(0x8fa8d8);
      this.sun.intensity = 0.4 * night01 * dim;
      this.sun.position.set(-3000, 6000, 2000);
    }
    this.hemi.intensity = (1.3 * dayF + 0.42 * night01) * dim;
    for (const m of this.cloudMats) m.uniforms.uNight.value = night01;

    // fog follows the sun height, the night, and the weather graying
    const fc = this.scene.fog.color;
    fc.setRGB(0.70, 0.56, 0.42).lerp(_nc.setRGB(0.045, 0.06, 0.1), night01);
    if (weather) {
      fc.lerp(_gc.setRGB(0.42, 0.44, 0.47).multiplyScalar(1 - night01 * 0.85), weather.gray);
      fc.multiplyScalar(dim);
    }
    this.scene.fog.density = 0.000034 * (weather ? weather.fogMul : 1);
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
