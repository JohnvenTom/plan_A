// terrain.js — procedural island-chain heightfield + ocean
// One noise field, sampled identically for geometry and for gameplay collision.
import * as THREE from 'three';
import { makeNoise2D, makeFbm2D, clamp, smoothstep } from './utils.js';

const WORLD_SIZE = 24000;      // meters, centered at origin
const SEGMENTS = 168;          // grid cells per side (~143 m per cell)
export const SEA_LEVEL = 0;

// --- one height model: ridged fbm islands, radial mask sinks the edges ---
const noise2D = makeNoise2D(20260929);
const fbm = makeFbm2D(noise2D, 5);

export function terrainHeightAt(x, z) {
  const s = 1 / 3400;
  let nx = x * s, nz = z * s;
  // ridged: 1-|n| gives sharp crests
  let ridge = 0, amp = 0.55, freq = 1;
  for (let o = 0; o < 4; o++) {
    ridge += amp * (1 - Math.abs(noise2D(nx * freq + 7.3, nz * freq - 4.1)));
    amp *= 0.5; freq *= 2.1;
  }
  const base = fbm(nx * 0.7 + 3.7, nz * 0.7 - 9.2) * 0.5 + 0.5; // continental shelf shape
  // island-chain mask: several lobes instead of one blob
  const r = Math.hypot(x, z) / (WORLD_SIZE * 0.5);
  const chain = 0.5 + 0.5 * Math.sin(Math.atan2(z, x) * 3 + fbm(nx * 0.4, nz * 0.4) * 2.2);
  const mask = clamp(1.25 - r * (1.55 - 0.5 * chain), 0, 1);
  const h = (ridge * 1750 + base * 700 - 320) * smoothstep(0.02, 0.45, mask);
  return h;
}

function heightColor(h, slope, out) {
  // golden-hour tinted vertex colors (scene-linear, painted to taste)
  if (h < 6)            { out.setRGB(0.72, 0.62, 0.42); }             // beach sand
  else if (h < 90)      { out.setRGB(0.24, 0.34, 0.14); }             // lowland grass
  else if (h < 420)     { out.setRGB(0.20, 0.27, 0.12); }
  else if (h < 1050)    { out.setRGB(0.30, 0.26, 0.22); }             // rock
  else                  { out.setRGB(0.80, 0.80, 0.86); }             // snow caps
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
    heightColor(h, slope, c);
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
  vec3 N = normalize(vec3((n1 - 0.5) * 0.22, 1.0, (n2 - 0.5) * 0.22));
  vec3 V = normalize(uCamPos - vWorld);

  float fres = pow(1.0 - clamp(dot(V, N), 0.0, 1.0), 3.0);
  vec3 deep = vec3(0.015, 0.075, 0.115);
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
    uniforms: {
      uSunDir: { value: new THREE.Vector3(0, 0.3, -1) },
      uCamPos: { value: new THREE.Vector3() },
      uTime: { value: 0 },
      uFogColor: { value: new THREE.Color(0.72, 0.60, 0.47) },
      uFogDensity: { value: 0.000042 },
    },
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(46000, 46000), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = SEA_LEVEL;
  mesh.frustumCulled = false;
  mesh.renderOrder = -6;
  scene.add(mesh);
  return { mesh, mat };
}
