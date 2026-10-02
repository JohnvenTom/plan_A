// terrain.js — procedural island-chain heightfield + ocean
// One noise field, sampled identically for geometry and for gameplay collision.
import * as THREE from 'three';
import { makeNoise2D, makeFbm2D, clamp, smoothstep } from './utils.js';

const WORLD_SIZE = 24000;      // meters, centered at origin
const SEGMENTS = 232;          // grid cells per side (~103 m per cell)
export const SEA_LEVEL = 0;

// --- one height model: ridged fbm islands + fine detail, radial mask sinks
// the edges. Sampled identically for geometry AND gameplay collision. ---
const noise2D = makeNoise2D(20260929);
const fbm = makeFbm2D(noise2D, 5);
// biome field: very low frequency, selects one of four regions with blends
const biomeNoise = makeFbm2D(makeNoise2D(777), 3);

// biome weights at (x,z): temperate / desert / volcanic / alpine, blended
export function biomeWeights(x, z) {
  const b = biomeNoise(x / 9500 + 3.1, z / 9500 - 1.7);   // -1..1-ish
  const w = { temperate: 0, desert: 0, volcanic: 0, alpine: 0 };
  const seg = (v, lo, hi) => clamp(1 - Math.abs((v - (lo + hi) / 2) / ((hi - lo) / 2)), 0, 1);
  w.temperate = seg(b, -1.05, -0.18);
  w.desert = seg(b, -0.32, 0.18);
  w.volcanic = seg(b, 0.08, 0.55);
  w.alpine = seg(b, 0.45, 1.05);
  return w;
}

export function terrainHeightAt(x, z) {
  const s = 1 / 3400;
  let nx = x * s, nz = z * s;
  // ridged: 1-|n| gives sharp crests
  let ridge = 0, amp = 0.55, freq = 1;
  for (let o = 0; o < 5; o++) {
    ridge += amp * (1 - Math.abs(noise2D(nx * freq + 7.3, nz * freq - 4.1)));
    amp *= 0.5; freq *= 2.1;
  }
  const base = fbm(nx * 0.7 + 3.7, nz * 0.7 - 9.2) * 0.5 + 0.5; // continental shelf shape
  // fine-scale relief (~330 m features) so close flight reads rough
  const detail = fbm(x / 330 + 11.2, z / 330 - 5.8) * 95;
  // island-chain mask: several lobes instead of one blob
  const r = Math.hypot(x, z) / (WORLD_SIZE * 0.5);
  const chain = 0.5 + 0.5 * Math.sin(Math.atan2(z, x) * 3 + fbm(nx * 0.4, nz * 0.4) * 2.2);
  const mask = clamp(1.25 - r * (1.55 - 0.5 * chain), 0, 1);
  const m = smoothstep(0.02, 0.45, mask);
  // biome height modifiers: alpine towers, desert flattens with dune ripples,
  // volcanic adds rugged spires; blends follow the biome weights
  const w = biomeWeights(x, z);
  const mod = w.alpine * 260 + w.volcanic * 60 - w.desert * 90;
  const dunes = w.desert * 26 * Math.sin(x / 210 + fbm(x / 1700, z / 1700) * 3) * Math.cos(z / 260);
  let h = (ridge * 1750 + base * 700 - 320 + detail * 0.6 + mod) * m + dunes * m;
  return h;
}

// biome palettes (scene-linear): per-height bands [beach, low, mid, high, peak]
const BIOME_PALETTES = {
  temperate: [[0.72, 0.62, 0.42], [0.22, 0.33, 0.13], [0.19, 0.26, 0.11], [0.30, 0.26, 0.22], [0.80, 0.80, 0.86]],
  desert:    [[0.85, 0.74, 0.50], [0.78, 0.62, 0.36], [0.70, 0.52, 0.30], [0.62, 0.45, 0.28], [0.88, 0.82, 0.70]],
  volcanic:  [[0.45, 0.38, 0.32], [0.22, 0.17, 0.15], [0.16, 0.13, 0.12], [0.28, 0.14, 0.10], [0.35, 0.32, 0.33]],
  alpine:    [[0.60, 0.62, 0.58], [0.28, 0.36, 0.26], [0.36, 0.38, 0.34], [0.52, 0.52, 0.54], [0.92, 0.93, 0.97]],
};
// snow/rock line per biome (meters)
const BIOME_LINES = { temperate: 1050, desert: 1600, volcanic: 1900, alpine: 620 };

function heightColor(x, z, h, slope, out) {
  const w = biomeWeights(x, z);
  // pick the palette band for this height, then blend across biomes
  const band = (p, line) => {
    if (h < 6) return p[0];
    if (h < 90) return p[1];
    if (h < line * 0.42) return p[2];
    if (h < line) return p[3];
    return p[4];
  };
  const acc = [0, 0, 0];
  let tw = 0;
  for (const k of Object.keys(w)) {
    if (w[k] <= 0) continue;
    const b = band(BIOME_PALETTES[k], BIOME_LINES[k]);
    acc[0] += b[0] * w[k]; acc[1] += b[1] * w[k]; acc[2] += b[2] * w[k];
    tw += w[k];
  }
  out.setRGB(acc[0] / tw, acc[1] / tw, acc[2] / tw);
  if (slope > 0.55 && h > 60) out.lerp(new THREE.Color(0.26, 0.22, 0.19), clamp((slope - 0.55) * 1.8, 0, 0.85));
  return out;
}

export function buildTerrain(scene) {
  const geo = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, SEGMENTS, SEGMENTS);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  const step = WORLD_SIZE / SEGMENTS;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const h = terrainHeightAt(x, z);
    pos.setY(i, h);
    const hx = terrainHeightAt(x + step, z), hz = terrainHeightAt(x, z + step);
    const slope = Math.min(1, (Math.abs(hx - h) + Math.abs(hz - h)) / step * 1.6);
    heightColor(x, z, h, slope, c);
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true, flatShading: true, roughness: 0.96, metalness: 0.0,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = false;
  scene.add(mesh);
  return mesh;
}

// --- ocean: camera-following plane, fresnel + sun streak + manual exp2 haze ---
const OCEAN_VERT = /* glsl */`
varying vec3 vWorld;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const OCEAN_FRAG = /* glsl */`
precision highp float;
varying vec3 vWorld;
uniform vec3 uSunDir;
uniform vec3 uCamPos;
uniform float uTime;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uStorm;
uniform float uRain;

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1,0)), u.x),
             mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), u.x), u.y);
}

void main() {
  vec2 w = vWorld.xz;
  float n1 = noise(w * 0.012 + uTime * 0.35);
  float n2 = noise(w * 0.045 - uTime * 0.6);
  // rain: fine high-frequency dimple noise riding the swell
  float rr = (noise(w * 0.9 + uTime * 2.2) - 0.5) * uRain * 0.16;
  vec3 N = normalize(vec3((n1 - 0.5) * (0.22 + uStorm * 0.5) + rr, 1.0, (n2 - 0.5) * (0.22 + uStorm * 0.5) + rr));
  vec3 V = normalize(uCamPos - vWorld);

  float fres = pow(1.0 - clamp(dot(V, N), 0.0, 1.0), 3.0);
  vec3 deep = mix(mix(vec3(0.015, 0.075, 0.115), vec3(0.008, 0.045, 0.07), uStorm), vec3(0.01, 0.05, 0.075), uRain * 0.55);
  vec3 skyRef = vec3(0.36, 0.44, 0.55);
  vec3 warm = vec3(0.55, 0.38, 0.24);
  // reflectance warms toward the low sun azimuth
  float sunward = pow(clamp(dot(normalize(vec3(V.x, 0.0, V.z)), -normalize(vec3(uSunDir.x, 0.0, uSunDir.z))), 0.0, 1.0), 2.0);
  vec3 col = mix(deep, mix(skyRef, warm, sunward * 0.55), 0.25 + fres * 0.75);

  vec3 R = reflect(-V, N);
  float spec = pow(clamp(dot(R, uSunDir), 0.0, 1.0), 240.0);
  col += vec3(1.6, 1.0, 0.55) * spec * 2.2;

  // manual exp2 haze to match scene fog
  float dist = length(uCamPos - vWorld);
  float f = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
  col = mix(col, uFogColor, clamp(f, 0.0, 1.0));
  gl_FragColor = vec4(col, 1.0);
}`;

export function buildOcean(scene) {
  const mat = new THREE.ShaderMaterial({
    vertexShader: OCEAN_VERT,
    fragmentShader: OCEAN_FRAG,
    // polygonOffset: when the ocean and a shallow beach are near-coplanar at
    // the shoreline, depth ties resolve consistently for the water layer —
    // this (plus the -0.2 m bias below) kills the coastline z-fight shimmer
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    uniforms: {
      uSunDir: { value: new THREE.Vector3(0, 0.3, -1) },
      uCamPos: { value: new THREE.Vector3() },
      uTime: { value: 0 },
      uStorm: { value: 0 },
      uRain: { value: 0 },
      uNight: { value: 0 },
      uFogColor: { value: new THREE.Color(0.70, 0.56, 0.42) },
      uFogDensity: { value: 0.000034 },
    },
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(92000, 92000), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = SEA_LEVEL - 0.2;   // small bias below the terrain zero
  mesh.frustumCulled = false;
  mesh.renderOrder = -6;
  scene.add(mesh);
  return { mesh, mat };
}
