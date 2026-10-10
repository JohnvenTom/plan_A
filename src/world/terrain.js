// terrain.js — geometry-clipmap streamed terrain + ocean
//
// One renderer serves every map in maps.js: six concentric LOD rings follow
// the player. Each level is a fixed (N+1)² vertex grid at cell = 25 m · 2^L;
// the level's centre snaps to its own cell grid, and when the player crosses
// cells only the newly exposed strips are resampled (the untouched data is
// memmoved via copyWithin). The frame-shaped hole in every level is where the
// finer level already covers the world, and every junction carries a vertical
// skirt so resolution changes never show cracks.
//
// Gameplay collision (terrainSurfaceAt) reproduces the FINEST rendered
// resolution — barycentric interpolation over the same 25 m lattice and the
// same cell-diagonal split — via lazily built 625 m blocks with an LRU cap,
// keeping the "what you skim is what you hit" invariant without a full-world
// grid.
import * as THREE from 'three';
import { clamp } from '../core/utils.js';
import { activeMap } from './maps.js';

export const SEA_LEVEL = 0;

// active-map dispatchers (single source of truth lives in maps.js)
export function terrainHeightAt(x, z) { return activeMap.heightAt(x, z); }
export function biomeWeights(x, z) { return activeMap.weightsAt(x, z); }

// --- height → band color, blended across the active map's biome weights ---
const _bandC = new THREE.Color();
const _tmpC = new THREE.Color();
function heightColor(x, z, h, slope, out) {
  const w = activeMap.weightsAt(x, z);
  const pal = activeMap.palettes, lines = activeMap.lines;
  const band = (p, line) => {
    if (h < 6) return p[0];
    if (h < 90) return p[1];
    if (h < line * 0.42) return p[2];
    if (h < line) return p[3];
    return p[4];
  };
  let r = 0, g = 0, b = 0, tw = 0;
  for (const k of Object.keys(w)) {
    const wk = w[k];
    if (wk <= 0) continue;
    const c = band(pal[k], lines[k]);
    r += c[0] * wk; g += c[1] * wk; b += c[2] * wk;
    tw += wk;
  }
  // safety net: a (t, m) cell no biome claims falls back to temperate instead
  // of dividing by zero — NaN vertex colors render as black blocks
  if (tw < 1e-4) {
    const c = band(pal.temperate, lines.temperate);
    out.setRGB(c[0], c[1], c[2]);
  } else {
    out.setRGB(r / tw, g / tw, b / tw);
  }
  if (slope > 0.55 && h > 60) out.lerp(_bandC.setRGB(0.26, 0.22, 0.19), clamp((slope - 0.55) * 1.8, 0, 0.85));
  return out;
}

// ---------------------------------------------------------------------------
// clipmap levels
// ---------------------------------------------------------------------------
const LEVELS = 6;
const GRID = 128;          // cells per side
const VERTS = GRID + 1;    // 129
const BASE_CELL = 25;      // metres at level 0
// hole (covered by the finer level), LEVELS >= 1 only: cells 35..92 inclusive
// in both axes. The finer level spans ±32 cells of half size from a centre
// that can be half a cell offset, so its guaranteed coverage reaches 31.5
// cells; the hole edge at 29 leaves a 2.5-cell overlap hidden UNDER the fine
// mesh — enough to also swallow a frame or two of fine-level recenter lag.
// Level 0 has no finer level: it renders as a FULL square (a hole there
// would look straight through to the ocean plane right under the player).
const HOLE0 = 35, HOLE1 = 92;
const HOLE_V0 = HOLE0, HOLE_V1 = HOLE1 + 1;   // hole boundary vertex lines 35..93

class ClipLevel {
  constructor(index, material, scene) {
    this.cell = BASE_CELL * (1 << index);
    this.hasHole = index > 0;             // only coarser levels defer to a finer one
    this.gx = 0; this.gz = 0;             // origin cell: world x of vertex i = (gx+i)*cell
    this.pending = null;                  // { type:'shift', dgx, dgz } | { type:'refill', cursor }
    this.ready = false;                   // first full fill done (mesh hidden until then)

    // ---- vertex layout: main grid, then 4 outer (+ 4 inner) skirt strips ----
    const nMain = VERTS * VERTS;
    const strips = [];
    const pushStrip = (fixed, isRow, from, to) => {
      const s = [];
      for (let v = from; v <= to; v++)
        s.push(isRow ? v * VERTS + fixed : fixed * VERTS + v);
      strips.push(s);
    };
    pushStrip(0, false, 0, GRID);          // west outer edge  (i=0)
    pushStrip(GRID, false, 0, GRID);       // east outer edge
    pushStrip(0, true, 0, GRID);           // north outer edge (j=0)
    pushStrip(GRID, true, 0, GRID);        // south outer edge
    const outerStrips = strips.splice(0, 4);
    let innerStrips = [];
    if (this.hasHole) {
      pushStrip(HOLE_V0, false, HOLE_V0, HOLE_V1);   // hole west line
      pushStrip(HOLE_V1, false, HOLE_V0, HOLE_V1);
      pushStrip(HOLE_V0, true, HOLE_V0, HOLE_V1);
      pushStrip(HOLE_V1, true, HOLE_V0, HOLE_V1);
      innerStrips = strips.splice(0, 4);
    }
    // skirt vert -> { source main vert, drop }: laid out in strip order right
    // after the main grid so walls are consecutive pairs
    this.skirtMap = [];
    let sv = nMain;
    const outerDepth = Math.min(2.2 * this.cell, 520);
    const innerDepth = 1.4 * this.cell;
    for (const s of outerStrips) for (const m of s) this.skirtMap.push({ v: sv++, src: m, depth: outerDepth });
    for (const s of innerStrips) for (const m of s) this.skirtMap.push({ v: sv++, src: m, depth: innerDepth });

    // ---- buffers: x/z fixed forever; y + colors stream ----
    this.heights = new Float32Array(nMain);            // main-grid truth, skirts read it
    const pos = new Float32Array(sv * 3);
    for (let j = 0; j < VERTS; j++)
      for (let i = 0; i < VERTS; i++) {
        const v = j * VERTS + i;
        pos[v * 3] = (i - GRID / 2) * this.cell;
        pos[v * 3 + 2] = (j - GRID / 2) * this.cell;
      }
    const geo = new THREE.BufferGeometry();
    this.posArr = pos;
    this.colArr = new Float32Array(sv * 3);
    this.posAttr = new THREE.BufferAttribute(pos, 3);
    this.colAttr = new THREE.BufferAttribute(this.colArr, 3);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('color', this.colAttr);
    geo.setIndex(this._buildIndex(nMain));
    // generous static bounds (per-level frustum culling when looking away)
    const rad = Math.SQRT2 * (GRID / 2) * this.cell + 500;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 400, 0), rad);

    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.matrixAutoUpdate = false;
    this.mesh.receiveShadow = false;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  // frame indices (hole removed on levels >= 1) + skirt walls. Frame winding
  // faces +Y and splits cells along the same B–D diagonal as the collision
  // interpolator; skirt quads are emitted with BOTH windings so a wall can
  // never vanish.
  _buildIndex(nMain) {
    const idx = [];
    for (let j = 0; j < GRID; j++)
      for (let i = 0; i < GRID; i++) {
        if (this.hasHole && i >= HOLE0 && i <= HOLE1 && j >= HOLE0 && j <= HOLE1) continue;
        const A = j * VERTS + i, D = A + 1, B = A + VERTS, C = B + 1;
        idx.push(A, B, D, B, C, D);
      }
    for (let k = 0; k < this.skirtMap.length - 1; k++) {
      const cur = this.skirtMap[k], nxt = this.skirtMap[k + 1];
      const d = nxt.src - cur.src;   // column strips step by 1, row strips by VERTS
      if (d !== 1 && d !== VERTS) continue;   // strip break: no wall quad
      idx.push(cur.src, nxt.src, cur.v, nxt.src, nxt.v, cur.v);
      idx.push(cur.src, cur.v, nxt.src, nxt.src, cur.v, nxt.v);
    }
    return idx;
  }

  // sample one vertex: height + slope-from-neighbours + biome color
  _writeVertex(i, j, x, z) {
    const hAt = activeMap.heightAt;
    const h = hAt(x, z);
    const cell = this.cell;
    const hx = hAt(x + cell, z), hz = hAt(x, z + cell);
    const slope = Math.min(1, (Math.abs(hx - h) + Math.abs(hz - h)) / cell * 1.6);
    const v = j * VERTS + i;
    this.heights[v] = h;
    this.posArr[v * 3 + 1] = h;
    const c = heightColor(x, z, h, slope, _tmpC);
    this.colArr[v * 3] = c.r; this.colArr[v * 3 + 1] = c.g; this.colArr[v * 3 + 2] = c.b;
  }

  _flushStrirts() {
    for (const s of this.skirtMap) {
      const src3 = s.src * 3, v3 = s.v * 3;
      this.posArr[v3] = this.posArr[src3];
      this.posArr[v3 + 1] = this.heights[s.src] - s.depth;
      this.posArr[v3 + 2] = this.posArr[src3 + 2];
      this.colArr[v3] = this.colArr[src3];
      this.colArr[v3 + 1] = this.colArr[src3 + 1];
      this.colArr[v3 + 2] = this.colArr[src3 + 2];
    }
  }

  _commit() {
    this._flushStrirts();
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
    this.mesh.position.set((this.gx + GRID / 2) * this.cell, 0, (this.gz + GRID / 2) * this.cell);
    this.mesh.updateMatrix();
    this.ready = true;
    this.mesh.visible = true;
  }

  // fill columns [from, VERTS) — pure data fill, no commit; returns next
  // cursor. Checks the deadline with a one-column margin so a fill that
  // STARTS always finishes within the frame budget + one column.
  _fillColumns(from, deadline) {
    let i = from;
    for (; i < VERTS; i++) {
      if (deadline && performance.now() >= deadline - 1.5) break;
      const x = (this.gx + i) * this.cell;
      for (let j = 0; j < VERTS; j++) this._writeVertex(i, j, x, (this.gz + j) * this.cell);
    }
    return i;
  }

  // incremental recenter: memmove untouched data, sample only the new strips.
  // |dg| ≤ 6 cells per axis (bigger jumps become refill tasks).
  shift(dgx, dgz) {
    const pa = this.posArr;
    let kx = Math.abs(dgx);
    if (kx) {
      const sx = dgx > 0 ? 1 : -1;
      for (let j = 0; j < VERTS; j++) {
        const row = j * VERTS;
        if (sx > 0) {           // data slides toward i=0, fresh columns at the east edge
          this.heights.copyWithin(row, row + kx, row + VERTS);
          this.colArr.copyWithin(row * 3, (row + kx) * 3, (row + VERTS) * 3);
          for (let i = 0; i < VERTS - kx; i++) pa[(row + i) * 3 + 1] = pa[(row + i + kx) * 3 + 1];
        } else {
          this.heights.copyWithin(row + kx, row, row + VERTS - kx);
          this.colArr.copyWithin((row + kx) * 3, row * 3, (row + VERTS - kx) * 3);
          for (let i = VERTS - 1; i >= kx; i--) pa[(row + i) * 3 + 1] = pa[(row + i - kx) * 3 + 1];
        }
      }
      this.gx += dgx;
      const i0 = sx > 0 ? VERTS - kx : 0;
      for (let i = i0; i < i0 + kx; i++) {
        const x = (this.gx + i) * this.cell;
        for (let j = 0; j < VERTS; j++) this._writeVertex(i, j, x, (this.gz + j) * this.cell);
      }
    }
    let kz = Math.abs(dgz);
    if (kz) {
      const sz = dgz > 0 ? 1 : -1;
      const rowV = VERTS, rowC = VERTS * 3;
      if (sz > 0) {             // data slides toward j=0, fresh rows at the south edge
        this.heights.copyWithin(0, kz * rowV);
        this.colArr.copyWithin(0, kz * rowC);
        for (let v = 0; v < (VERTS - kz) * rowV; v++) pa[v * 3 + 1] = pa[(v + kz * rowV) * 3 + 1];
      } else {
        this.heights.copyWithin(kz * rowV, 0, (VERTS - kz) * rowV);
        this.colArr.copyWithin(kz * rowC, 0, (VERTS - kz) * rowC);
        for (let v = (VERTS - kz) * rowV - 1; v >= 0; v--) pa[(v + kz * rowV) * 3 + 1] = pa[v * 3 + 1];
      }
      this.gz += dgz;
      const j0 = sz > 0 ? VERTS - kz : 0;
      for (let j = j0; j < j0 + kz; j++) {
        const z = (this.gz + j) * this.cell;
        for (let i = 0; i < VERTS; i++) this._writeVertex(i, j, (this.gx + i) * this.cell, z);
      }
    }
    this._commit();
  }

  dispose(scene) {
    scene.remove(this.mesh);
    this.mesh.geometry.dispose();
  }
}

// ---------------------------------------------------------------------------
// engine: owns the shared material, the level set and the frame budget
// ---------------------------------------------------------------------------
function makeTerrainMaterial() {
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true, flatShading: true, roughness: 0.96, metalness: 0.0,
  });
  const fogTime = { value: 0 };   // shared clock for the drifting mist band
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = fogTime;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <fog_vertex>', '#include <fog_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vWPos;
uniform float uTime;
float thash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float tnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(thash(i), thash(i + vec2(1, 0)), u.x),
             mix(thash(i + vec2(0, 1)), thash(i + vec2(1, 1)), u.x), u.y);
}`)
      .replace('#include <fog_fragment>', `
  {
    float dist = length(cameraPosition - vWPos);
    float f = 1.0 - exp(-fogDensity * fogDensity * dist * dist);
    f = max(f, smoothstep(22000.0, 34000.0, dist) * 0.96);
    vec3 hazeCol = mix(fogColor * vec3(0.68, 0.84, 1.28), fogColor,
                       smoothstep(7000.0, 16000.0, dist));
    float band = exp(-max(vWPos.y, 0.0) / 420.0);
    float mist = tnoise(vWPos.xz * 0.00045 + uTime * vec2(0.006, 0.004));
    mist = band * smoothstep(0.35, 0.75, mist) * smoothstep(2500.0, 9000.0, dist);
    f = 1.0 - (1.0 - clamp(f, 0.0, 1.0)) * (1.0 - mist * 0.62);
    gl_FragColor.rgb = mix(gl_FragColor.rgb, hazeCol, f);
  }`);
  };
  mat.userData.fogTime = fogTime;
  return mat;
}

export function initTerrain(scene) {
  const mat = makeTerrainMaterial();
  let levels = [];
  const stats = { lastMs: 0, pending: 0, ready: 0 };

  // levels start empty (mesh hidden) and fill through update()'s budget
  const spawnLevels = () => {
    for (let i = 0; i < LEVELS; i++) {
      const L = new ClipLevel(i, mat, scene);
      L.pending = { type: 'refill', cursor: 0 };
      levels.push(L);
    }
  };
  spawnLevels();

  // per-frame streaming under a ms budget: cheap shifts first (finest level
  // first), then refill slices for teleports / initial builds
  const update = (px, pz, budgetMs = 3) => {
    const t0 = performance.now();
    const deadline = t0 + budgetMs;
    for (const L of levels) {
      if (L.pending) continue;
      const tgx = Math.round(px / L.cell) - GRID / 2;
      const tgz = Math.round(pz / L.cell) - GRID / 2;
      const dgx = tgx - L.gx, dgz = tgz - L.gz;
      if (dgx === 0 && dgz === 0) continue;
      if (Math.abs(dgx) > 6 || Math.abs(dgz) > 6 || !L.ready) {
        L.gx = tgx; L.gz = tgz;                    // retarget, fill from scratch
        // stale data would render torn at the new origin: hide until complete
        L.mesh.visible = false;
        L.pending = { type: 'refill', cursor: 0 };
      } else {
        L.pending = { type: 'shift', dgx, dgz };
      }
    }
    let pending = 0;
    for (const L of levels) {
      if (!L.pending) continue;
      pending++;
      // shifts run ONE cell per step so a multi-cell hop (movement hitch,
      // dt spike) can never blow the frame budget in a single atomic move;
      // leftover cells roll over to the next frame
      while (L.pending.type === 'shift' && performance.now() < deadline - 1.8) {
        const p = L.pending;
        const stepx = p.dgx ? Math.sign(p.dgx) : 0;
        const stepz = p.dgz ? Math.sign(p.dgz) : 0;
        L.shift(stepx, stepz);
        p.dgx -= stepx; p.dgz -= stepz;
        if (p.dgx === 0 && p.dgz === 0) { L.pending = null; break; }
      }
    }
    for (const L of levels) {
      if (!L.pending) continue;
      if (L.pending.type === 'refill' && performance.now() < deadline) {
        L.pending.cursor = L._fillColumns(L.pending.cursor, deadline);
        if (L.pending.cursor >= VERTS) { L.pending = null; L._commit(); }
      }
    }
    stats.lastMs = performance.now() - t0;
    stats.pending = pending;
    stats.ready = levels.reduce((n, L) => n + (L.ready && !L.pending ? 1 : 0), 0);
  };

  const setMap = () => {
    for (const L of levels) L.dispose(scene);
    levels = [];
    blocks.clear();         // collision cache is map-specific
    spawnLevels();
  };

  return { update, setMap, fogTime: mat.userData.fogTime, levels, stats };
}

// ---------------------------------------------------------------------------
// gameplay collision: lazily built 25 m blocks, same lattice + same triangle
// split as the finest clipmap level, so collision == rendered surface
// ---------------------------------------------------------------------------
const COL_CELL = 25;              // == BASE_CELL: lattice aligned with level 0
const BLOCK = 625;                // metres per collision block
const BV = BLOCK / COL_CELL + 1;  // 26 verts per side
const MAX_BLOCKS = 96;
const blocks = new Map();         // key -> Float32Array(BV*BV), LRU by insert order
let blocksMapId = null;           // blocks are terrain-bound: never serve one
                                 // map's heights after the active map changed

function blockKey(bx, bz) { return bx * 100003 + bz; }

function buildBlock(bx, bz) {
  const g = new Float32Array(BV * BV);
  const hAt = activeMap.heightAt;
  const ox = bx * BLOCK, oz = bz * BLOCK;
  for (let j = 0; j < BV; j++)
    for (let i = 0; i < BV; i++)
      g[j * BV + i] = hAt(ox + i * COL_CELL, oz + j * COL_CELL);
  blocks.set(blockKey(bx, bz), g);
  if (blocks.size > MAX_BLOCKS) {
    // evict oldest (Maps iterate in insertion order; re-set on touch keeps it LRU)
    blocks.delete(blocks.keys().next().value);
  }
  return g;
}

export function terrainSurfaceAt(x, z) {
  if (activeMap.id !== blocksMapId) { blocks.clear(); blocksMapId = activeMap.id; }
  const half = activeMap.worldHalf;
  // past the map bounds the only ground is the ocean plane (same contract as
  // the old single-mesh world)
  if (x < -half || x > half || z < -half || z > half) return SEA_LEVEL;
  const bx = Math.floor(x / BLOCK), bz = Math.floor(z / BLOCK);
  const key = blockKey(bx, bz);
  let g = blocks.get(key);
  if (g === undefined) g = buildBlock(bx, bz);
  else { blocks.delete(key); blocks.set(key, g); }   // LRU touch
  const lx = x - bx * BLOCK, lz = z - bz * BLOCK;
  const gx = lx / COL_CELL, gz = lz / COL_CELL;
  const i = clamp(Math.floor(gx), 0, BV - 2), j = clamp(Math.floor(gz), 0, BV - 2);
  const hA = g[j * BV + i];
  const hD = g[j * BV + i + 1];         // +x corner
  const hB = g[(j + 1) * BV + i];       // +z corner
  const hC = g[(j + 1) * BV + i + 1];
  const u = clamp(gx - i, 0, 1), v = clamp(gz - j, 0, 1);
  // same diagonal as the rendered grid (u+v=1): lower {A,B,D}, upper {B,C,D}
  if (u + v <= 1) return hA * (1 - u - v) + hD * u + hB * v;
  return hC * (u + v - 1) + hD * (1 - v) + hB * (1 - u);
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

  // layered distance haze (identical constants to the land shader + scene fog):
  // exp2 body -> far ramp that swallows the horizon into the fog color,
  // two-tone (blue-gray mid range -> warm horizon far) + a drifting
  // low-altitude mist band that keeps the far sea slightly patchy
  float dist = length(uCamPos - vWorld);
  float f = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
  f = max(f, smoothstep(22000.0, 34000.0, dist) * 0.96);
  vec3 hazeCol = mix(uFogColor * vec3(0.68, 0.84, 1.28), uFogColor,
                     smoothstep(7000.0, 16000.0, dist));
  float band = exp(-max(vWorld.y, 0.0) / 420.0);
  float mist = noise(vWorld.xz * 0.00045 + uTime * vec2(0.006, 0.004));
  mist = band * smoothstep(0.35, 0.75, mist) * smoothstep(2500.0, 9000.0, dist);
  f = 1.0 - (1.0 - clamp(f, 0.0, 1.0)) * (1.0 - mist * 0.62);
  col = mix(col, hazeCol, f);
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
