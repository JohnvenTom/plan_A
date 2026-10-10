// maps.js — selectable war zones. Every map shares one clipmap renderer
// (terrain.js) and one collision model; this registry only supplies the
// height/biome fields plus the gameplay anchors (combat circle, sea-scan
// window, editor extent, campaign spawn) so both maps feel native.
//
// The classic 24 km island chain keeps its height math VERBATIM from the old
// single-mesh terrain.js — same seed, same constants — so old replays and
// editor scenarios stay terrain-identical.
import { makeNoise2D, makeFbm2D, clamp, smoothstep } from '../core/utils.js';

// ---------------------------------------------------------------------------
// classic 24 km — island chain (unchanged math)
// ---------------------------------------------------------------------------
const WORLD_SIZE = 24000;      // meters, centered at origin
const noise2D = makeNoise2D(20260929);
const fbm = makeFbm2D(noise2D, 5);
const biomeNoise = makeFbm2D(makeNoise2D(777), 3);

// biome weights at (x,z): temperate / desert / volcanic / alpine, blended
export function classicWeights(x, z) {
  const b = biomeNoise(x / 9500 + 3.1, z / 9500 - 1.7);   // -1..1-ish
  const w = { temperate: 0, desert: 0, volcanic: 0, alpine: 0 };
  const seg = (v, lo, hi) => clamp(1 - Math.abs((v - (lo + hi) / 2) / ((hi - lo) / 2)), 0, 1);
  w.temperate = seg(b, -1.05, -0.18);
  w.desert = seg(b, -0.32, 0.18);
  w.volcanic = seg(b, 0.08, 0.55);
  w.alpine = seg(b, 0.45, 1.05);
  return w;
}

export function classicHeightAt(x, z) {
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
  const w = classicWeights(x, z);
  const mod = w.alpine * 260 + w.volcanic * 60 - w.desert * 90;
  const dunes = w.desert * 26 * Math.sin(x / 210 + fbm(x / 1700, z / 1700) * 3) * Math.cos(z / 260);
  let h = (ridge * 1750 + base * 700 - 320 + detail * 0.6 + mod) * m + dunes * m;
  return h;
}

const CLASSIC_PALETTES = {
  temperate: [[0.72, 0.62, 0.42], [0.22, 0.33, 0.13], [0.19, 0.26, 0.11], [0.30, 0.26, 0.22], [0.80, 0.80, 0.86]],
  desert:    [[0.85, 0.74, 0.50], [0.78, 0.62, 0.36], [0.70, 0.52, 0.30], [0.62, 0.45, 0.28], [0.88, 0.82, 0.70]],
  volcanic:  [[0.45, 0.38, 0.32], [0.22, 0.17, 0.15], [0.16, 0.13, 0.12], [0.28, 0.14, 0.10], [0.35, 0.32, 0.33]],
  alpine:    [[0.60, 0.62, 0.58], [0.28, 0.36, 0.26], [0.36, 0.38, 0.34], [0.52, 0.52, 0.54], [0.92, 0.93, 0.97]],
};
const CLASSIC_LINES = { temperate: 1050, desert: 1600, volcanic: 1900, alpine: 620 };

// ---------------------------------------------------------------------------
// large 80 km — central continent + outer-sea island arc
// layout: continent blob around (-9.5, +8.5) km; the (+x, -z) quadrant is
// open ocean dotted with an island arc where the combat circle sits; the
// map edges sink into deep sea across the last ~8 km.
// 7 natural biomes: temperate / desert / volcanic / alpine / karst / snow /
// wetland, picked by a temperature × moisture field (plus range/volcano
// patch masks) so regions blend instead of striping.
// ---------------------------------------------------------------------------
const LARGE_HALF = 40000;
const lnA = makeFbm2D(makeNoise2D(91001), 5);      // continental base
const lnB = makeFbm2D(makeNoise2D(42007), 4);      // secondary shape / detail
const lnC = makeFbm2D(makeNoise2D(64013), 3);      // temperature
const lnD = makeFbm2D(makeNoise2D(23009), 3);      // moisture
const lnE = makeNoise2D(55021);                    // ridged mountains
const lnV = makeFbm2D(makeNoise2D(88003), 2);      // volcanic patches
const lnR = makeFbm2D(makeNoise2D(31017), 4);      // mountain-range mask
const lnK = makeNoise2D(77019);                    // karst towers

const lseg = (v, lo, hi) => clamp(1 - Math.abs((v - (lo + hi) / 2) / ((hi - lo) / 2)), 0, 1);
// half-ramps for the unbounded outer climate bands: flat 1 outside the ramp
// (a widened lseg tent would sag instead of clamping)
const below = (v, hi, r) => 1 - smoothstep(hi - r, hi, v);
const above = (v, lo, r) => smoothstep(lo, lo + r, v);

export function largeWeights(x, z) {
  // temperature rises toward +x (outer-sea side is tropical), moisture is its
  // own field; both 0..1-ish before banding. The five climate bands TILE the
  // whole (t, m) plane — outer bands are unbounded so no (t, m) combination
  // can leave every weight at zero (all-zero sums render as NaN black).
  const t = lnC(x / 15000 + 4.4, z / 15000 - 1.9) * 0.62 + 0.5 + 0.16 * (x / LARGE_HALF);
  const m = lnD(x / 13000 - 7.2, z / 13000 + 2.6) * 0.62 + 0.5;
  const w = { temperate: 0, desert: 0, volcanic: 0, alpine: 0, karst: 0, snow: 0, wetland: 0 };
  w.snow = below(t, 0.34, 0.10);                                    // cold: snowfield/tundra
  w.desert = above(t, 0.60, 0.10) * below(m, 0.68, 0.12);           // hot + dry
  w.karst = lseg(t, 0.20, 0.72) * below(m, 0.50, 0.12);             // dry-ish rock country
  w.wetland = above(t, 0.20, 0.10) * above(m, 0.68, 0.12);          // wet: lake marsh
  w.temperate = lseg(t, 0.24, 0.88) * lseg(m, 0.26, 0.88);          // broad mid band
  // overrides: mountain ranges go alpine, rare patches go volcanic
  const alpine = smoothstep(0.16, 0.34, lnR(x / 12000 + 8.1, z / 12000 + 3.3));
  const volc = smoothstep(0.60, 0.74, lnV(x / 6400 - 2.8, z / 6400 + 6.2));
  const damp = (1 - alpine) * (1 - volc);
  for (const k of ['temperate', 'desert', 'karst', 'snow', 'wetland']) w[k] *= damp;
  w.alpine = alpine;
  w.volcanic = volc;
  return w;
}

export function largeHeightAt(x, z) {
  const w = largeWeights(x, z);
  const s = 1 / 10500;
  // ridged mountains — amplitude scaled up inside alpine ranges
  let ridge = 0, amp = 0.55, freq = 1;
  for (let o = 0; o < 5; o++) {
    ridge += amp * (1 - Math.abs(lnE(x * s * freq * 1.6 + 7.3, z * s * freq * 1.6 - 4.1)));
    amp *= 0.5; freq *= 2.1;
  }
  const base = lnA(x / 11000 + 3.7, z / 11000 - 9.2) * 0.5 + 0.5;
  const detail = lnB(x / 380 + 11.2, z / 380 - 5.8) * 110;
  // continent mask: perturbed-radius blob around (-9.5, +8.5) km
  const dx = x + 9500, dz = z - 8500;
  const wob = lnB(x / 9000 + 5.1, z / 9000 - 3.7) * 5200;
  const cont = 1 - smoothstep(14500, 21500 + wob, Math.hypot(dx, dz));
  const m = smoothstep(0.04, 0.52, cont);
  // karst: clustered narrow towers (ridged^3 keeps them pillar-shaped)
  const tower = 1 - Math.abs(lnK(x / 620 + 2.2, z / 620 - 8.8));
  const karst = w.karst * 780 * tower * tower * tower;
  const relief = 0.30 + w.alpine * 1.75;
  let h = ridge * 620 * relief + base * 470 - 150 + detail * 0.6
    + w.alpine * 470 + karst + w.volcanic * 40 - w.desert * 70 - w.snow * 110;
  h *= m;
  // offshore: shelf sea floor
  h += (-175 - (lnA(x / 8000 - 6.6, z / 8000 + 1.1) * 0.5 + 0.5) * 90) * (1 - m);
  // wetland: carve lake basins a few meters below sea level — the infinite
  // ocean plane at y≈0 shows through them as free inland lakes. Gated to
  // lowlands (low `base`) so swamp weight never flattens a mountain range.
  if (w.wetland > 0.02) {
    const lowland = smoothstep(0.62, 0.38, base);
    const wW = w.wetland * 0.85 * m * lowland;
    if (wW > 0.01) {
      const basin = -9 - (lnB(x / 900 + 4.4, z / 900 + 7.7) * 0.5 + 0.5) * 22;
      h = h * (1 - wW) + basin * wW;
    }
  }
  // desert dune ripples
  if (w.desert > 0.02) h += w.desert * 24 * Math.sin(x / 230 + lnB(x / 1900, z / 1900) * 3) * Math.cos(z / 285) * m;
  // outer-sea island arc: lobed ring band around the combat circle
  const sx = x - 20500, sz = z + 16500;
  const sr = Math.hypot(sx, sz);
  const lobes = 0.5 + 0.5 * Math.sin(Math.atan2(sz, sx) * 4 + lnB(x / 7000 - 2.4, z / 7000 + 8.8) * 2.6);
  const band = clamp(1 - Math.abs(sr - 9800) / 3400, 0, 1) * lobes;
  const im = smoothstep(0.04, 0.5, band);
  if (im > 0) {
    let iridge = 0; amp = 0.55; freq = 1;
    for (let o = 0; o < 4; o++) {
      iridge += amp * (1 - Math.abs(lnE(x / 2400 * freq + 1.1, z / 2400 * freq + 5.5)));
      amp *= 0.5; freq *= 2.1;
    }
    const isl = iridge * 620 + 60;
    h = h * (1 - im) + isl * im;
  }
  // edge sink: everything fades to deep sea across the outer 8 km band
  const em = Math.min(
    clamp((LARGE_HALF - Math.abs(x)) / 8000, 0, 1),
    clamp((LARGE_HALF - Math.abs(z)) / 8000, 0, 1),
  );
  const e = em * em * (3 - 2 * em);
  return h * e - 210 * (1 - e);
}

const LARGE_PALETTES = {
  temperate: [[0.70, 0.64, 0.44], [0.24, 0.34, 0.14], [0.18, 0.27, 0.12], [0.32, 0.28, 0.22], [0.82, 0.82, 0.88]],
  desert:    [[0.86, 0.75, 0.52], [0.80, 0.64, 0.38], [0.72, 0.54, 0.31], [0.63, 0.46, 0.29], [0.89, 0.83, 0.71]],
  volcanic:  [[0.42, 0.36, 0.31], [0.21, 0.16, 0.14], [0.15, 0.12, 0.11], [0.30, 0.13, 0.09], [0.36, 0.33, 0.34]],
  alpine:    [[0.58, 0.60, 0.57], [0.27, 0.35, 0.25], [0.37, 0.39, 0.36], [0.53, 0.53, 0.55], [0.93, 0.94, 0.98]],
  karst:     [[0.66, 0.63, 0.50], [0.42, 0.48, 0.28], [0.55, 0.54, 0.47], [0.44, 0.42, 0.40], [0.74, 0.76, 0.72]],
  snow:      [[0.78, 0.80, 0.82], [0.83, 0.86, 0.90], [0.80, 0.84, 0.90], [0.74, 0.78, 0.86], [0.94, 0.96, 1.00]],
  wetland:   [[0.48, 0.52, 0.40], [0.20, 0.30, 0.16], [0.16, 0.24, 0.12], [0.30, 0.32, 0.22], [0.60, 0.64, 0.58]],
};
const LARGE_LINES = { temperate: 1150, desert: 1650, volcanic: 1950, alpine: 640, karst: 1500, snow: 420, wetland: 900 };

// ---------------------------------------------------------------------------
// registry + active-map state
// ---------------------------------------------------------------------------
export const MAPS = {
  classic: {
    id: 'classic',
    name: '经典 24km', sub: 'ISLAND CHAIN',
    worldHalf: WORLD_SIZE / 2,
    heightAt: classicHeightAt,
    weightsAt: classicWeights,
    palettes: CLASSIC_PALETTES, lines: CLASSIC_LINES,
    // campaign combat circle: 6 naval AA batteries ride this ring
    combat: { type: 'circle', x: 0, z: 0, r: 14000 },
    // open-water scan window for the training range (findSeaRange)
    seaScan: { x: 0, z: 0, rMin: 12500, rMax: 15000 },
    editorHalf: 16000,          // tactical-map half extent
    // campaign spawn: original pose
    spawn: { x: 0, y: 2600, z: 9000, heading: Math.PI, speed: 240 },
  },
  large: {
    id: 'large',
    name: '超大 80km', sub: 'CONTINENTAL SHELF',
    worldHalf: LARGE_HALF,
    heightAt: largeHeightAt,
    weightsAt: largeWeights,
    palettes: LARGE_PALETTES, lines: LARGE_LINES,
    // the WHOLE map is the combat area: no interior circle, the rim is
    // guarded by eight distinct fortress platforms (aasites.js) and going
    // past the box edge starts the out-of-area countdown
    combat: { type: 'edge', half: LARGE_HALF },
    seaScan: { x: 20000, z: -17000, rMin: 4000, rMax: 9000 },
    editorHalf: 40000,
    // spawn high over the island arc, nose west toward the continent — kept
    // >8 km from every rim fortress so sorties start quiet (test-enforced)
    spawn: { x: 27000, y: 2600, z: -15500, heading: Math.atan2(-6500, -1000), speed: 240 },
  },
};

export let activeMap = MAPS.classic;

export function setActiveMap(id) {
  activeMap = MAPS[id] ?? MAPS.classic;
  return activeMap;
}
