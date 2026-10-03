// effects.js — pooled particle system: explosions, smoke, contrails, sparks
// Two Points layers: additive (fire/spark/flash) + alpha smoke. Seeded RNG keeps
// the ?t=N freeze harness reproducible.
import * as THREE from 'three';
import { SEA_LEVEL, terrainHeightAt } from './terrain.js';

const _wp = new THREE.Vector3();
const _rp = new THREE.Vector3();
const _rv = new THREE.Vector3();
import { mulberry32, lerp, clamp } from './utils.js';

const MAX_ADD = 1400, MAX_SMOKE = 1600;

// radial falloff texture for the explosion halo sprites (bright core + skirt).
// The falloff must reach EXACTLY zero before the texture border — additive
// blending shows any leftover brightness as a visible square quad edge.
function makeHaloTexture() {
  const N = 64, data = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dx = (x / (N - 1)) * 2 - 1, dy = (y / (N - 1)) * 2 - 1;
    const d = Math.sqrt(dx * dx + dy * dy), d2 = dx * dx + dy * dy;
    let v = Math.exp(-d2 * 10) * 0.85 + Math.exp(-d2 * 3.4) * 0.30;
    // hard window: fully dark by d = 0.97 so the quad edge can never show
    const t = Math.min(1, Math.max(0, (d - 0.68) / 0.29));
    v *= 1 - t * t * (3 - 2 * t);
    const i = (y * N + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = (v * 255) | 0;
    data[i + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, N, N);
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

const PT_VERT = /* glsl */`
attribute float size;
attribute vec4 pcolor;
varying vec4 vColor;
void main() {
  vColor = pcolor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = clamp(size * (620.0 / -mv.z), 1.0, 260.0);
  gl_Position = projectionMatrix * mv;
}`;

const PT_FRAG = /* glsl */`
precision highp float;
varying vec4 vColor;
uniform float uSoft;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, uSoft, d) * vColor.a;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor.rgb, a);
}`;

class ParticleLayer {
  constructor(scene, max, blending, soft) {
    this.max = max;
    this.list = [];
    this.geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 4);
    this.size = new Float32Array(max);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('pcolor', new THREE.BufferAttribute(this.col, 4));
    this.geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1));
    this.mat = new THREE.ShaderMaterial({
      vertexShader: PT_VERT, fragmentShader: PT_FRAG,
      transparent: true, depthWrite: false,
      blending, uniforms: { uSoft: { value: soft } },
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  push(p) {
    if (this.list.length >= this.max) this.list.shift();
    this.list.push(p);
  }

  update(dt) {
    const L = this.list;
    for (let i = L.length - 1; i >= 0; i--) {
      const p = L[i];
      p.age += dt;
      if (p.age >= p.life) { L.splice(i, 1); continue; }
      if (p.age < 0) continue;               // delayed birth: hold still
      p.vel.multiplyScalar(Math.pow(p.drag, dt * 60));
      p.vel.y -= p.gravity * dt;
      p.pos.addScaledVector(p.vel, dt);
      if (p.turb) {
        p.pos.x += Math.sin(p.age * p.turb + p.seed * 37) * dt * p.turb * 2;
        p.pos.y += Math.cos(p.age * p.turb * 0.8 + p.seed * 91) * dt * p.turb;
      }
    }
    const n = L.length;
    for (let i = 0; i < n; i++) {
      const p = L[i];
      if (p.age < 0) { this.size[i] = 0; this.col[i * 4 + 3] = 0; continue; }
      const t = p.age / p.life;
      this.pos[i * 3] = p.pos.x; this.pos[i * 3 + 1] = p.pos.y; this.pos[i * 3 + 2] = p.pos.z;
      this.col[i * 4] = lerp(p.c0[0], p.c1[0], t);
      this.col[i * 4 + 1] = lerp(p.c0[1], p.c1[1], t);
      this.col[i * 4 + 2] = lerp(p.c0[2], p.c1[2], t);
      this.col[i * 4 + 3] = lerp(p.a0, p.a1, t);
      this.size[i] = lerp(p.s0, p.s1, t);
    }
    for (let i = n; i < this.max; i++) { this.size[i] = 0; }
    this.geo.setDrawRange(0, n);
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.pcolor.needsUpdate = true;
    this.geo.attributes.size.needsUpdate = true;
  }
}

// --- vortex ribbons: one camera-facing strip per wingtip replaces the old
// per-particle vortices. Zero particle-pool pressure, the whole scene's
// ribbons share one mesh / one draw call, and the strip is continuous by
// construction (history points recorded at the wingtip each frame). ---
const VR_PAIRS = 14;    // player + up to 13 enemies, 2 wingtips each
const VR_SEG = 56;      // point budget per ribbon (decimated as the trail ages)
const VR_WINDOW = 4.0;  // seconds a recorded point lives — the binding lifetime
const VR_MAXLEN = 800;  // meters before the tail is trimmed
const VR_FAR2 = 1500 * 1500;  // distance² beyond which ribbons sample every 2nd point
const VR_DRIFT = 1.1;   // m/s vortex dissipation drift, accelerating with age
const VR_FADE0 = VR_MAXLEN * 0.72;  // path length where the tail fade begins

const VR_VERT = `
attribute float aA; attribute float aT; attribute float aU;
varying float vA; varying float vT; varying float vU;
void main() {
  vA = aA; vT = aT; vU = aU;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const VR_FRAG = `
varying float vA; varying float vT; varying float vU;
void main() {
  float edge = 1.0 - abs(vU * 2.0 - 1.0); edge *= edge;      // soft across width
  float a = vA * edge * pow(max(0.0, 1.0 - vT), 1.15);       // + fade to tail
  vec3 col = mix(vec3(0.97, 0.98, 1.0), vec3(0.82, 0.84, 0.88), vT);
  gl_FragColor = vec4(col, a);
}`;

class VortexRibbons {
  constructor(scene) {
    this.clock = 0;
    this.camPos = new THREE.Vector3();
    this.pairs = new Map();          // id -> { i, L, R, lastFed }
    this.free = [];
    for (let i = 0; i < VR_PAIRS; i++) this.free.push(i);
    const rp = VR_PAIRS * 2, verts = rp * VR_SEG * 2;
    this.vpos = new Float32Array(verts * 3);
    this.vA = new Float32Array(verts);
    this.vT = new Float32Array(verts);
    this.vU = new Float32Array(verts);
    const idx = new Uint16Array(rp * VR_SEG * 6);
    let q = 0;
    for (let r = 0; r < rp; r++) {
      const base = r * VR_SEG * 2;
      for (let s = 0; s < VR_SEG - 1; s++) {
        const a = base + s * 2;
        idx[q++] = a; idx[q++] = a + 1; idx[q++] = a + 2;
        idx[q++] = a + 1; idx[q++] = a + 3; idx[q++] = a + 2;
      }
      for (let s = 0; s < VR_SEG * 2; s++) this.vU[base + s] = (s & 1);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.vpos, 3));
    geo.setAttribute('aA', new THREE.BufferAttribute(this.vA, 1));
    geo.setAttribute('aT', new THREE.BufferAttribute(this.vT, 1));
    geo.setAttribute('aU', new THREE.BufferAttribute(this.vU, 1));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      vertexShader: VR_VERT, fragmentShader: VR_FRAG,
      transparent: true, depthWrite: false, blending: THREE.NormalBlending,
    }));
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(1);       // FX layer: after cloud blend, depth-tested
    scene.add(this.mesh);
    this._t = new THREE.Vector3(); this._s = new THREE.Vector3();
    this._v1 = new THREE.Vector3(); this._v2 = new THREE.Vector3();
    this._cum = new Float32Array(VR_SEG);
  }

  _newRibbon() {
    // ring buffer of recorded wingtip points: pos/intensity/stall/birth time
    // plus a per-point random drift vector used for dissipation
    return {
      cx: new Float32Array(VR_SEG * 3), a: new Float32Array(VR_SEG),
      st: new Uint8Array(VR_SEG), born: new Float32Array(VR_SEG),
      dx: new Float32Array(VR_SEG), dy: new Float32Array(VR_SEG), dz: new Float32Array(VR_SEG),
      head: -1, len: 0, attached: false, lastX: 0, lastY: 0, lastZ: 0,
      lastT: -1, ph: this.rngPhase(),
    };
  }
  rngPhase() { return Math.random() * 100; }

  // call every frame per jet: id, both wingtip world positions, 0..1
  // intensity, stall flag. k < 0.05 detaches the head (trail dissipates).
  feed(id, tipL, tipR, k, stall) {
    let pair = this.pairs.get(id);
    if (!pair) {
      const i = this.free.pop();
      if (i === undefined) return;                    // pool exhausted: skip
      pair = { i, L: this._newRibbon(), R: this._newRibbon(), lastFed: this.clock };
      this.pairs.set(id, pair);
    }
    pair.lastFed = this.clock;
    this._feedRibbon(pair.L, tipL, k, stall);
    this._feedRibbon(pair.R, tipR, k, stall);
  }

  // point budget full: keep every 2nd point (head-anchored) so the ring
  // always spans the full lifetime window — resolution halves with age,
  // which the thin faded tail tolerates perfectly
  _decimate(rb) {
    const cp = (src, dst) => {
      if (src === dst) return;
      rb.cx[dst * 3] = rb.cx[src * 3]; rb.cx[dst * 3 + 1] = rb.cx[src * 3 + 1]; rb.cx[dst * 3 + 2] = rb.cx[src * 3 + 2];
      rb.a[dst] = rb.a[src]; rb.st[dst] = rb.st[src]; rb.born[dst] = rb.born[src];
      rb.dx[dst] = rb.dx[src]; rb.dy[dst] = rb.dy[src]; rb.dz[dst] = rb.dz[src];
    };
    let kept = 0;
    for (let n = 0; n < rb.len; n += 2) {
      const src = (rb.head - n + VR_SEG * 2) % VR_SEG;
      const dst = (rb.head - kept + VR_SEG * 2) % VR_SEG;
      cp(src, dst);
      kept++;
    }
    rb.len = kept;
  }

  _feedRibbon(rb, tip, k, stall) {
    const active = k > 0.05;
    if (!active) { rb.attached = false; return; }
    if (!rb.attached) {                              // fresh attach: clear history
      rb.len = 0; rb.head = -1;
      rb.attached = true;
    }
    const moved = rb.head < 0 ||
      Math.abs(tip.x - rb.lastX) + Math.abs(tip.y - rb.lastY) + Math.abs(tip.z - rb.lastZ) > 2.2;
    const timed = this.clock - rb.lastT > 0.04;
    if (rb.head >= 0 && !moved && !timed) {          // just refresh head pos
      const h = rb.head;
      rb.cx[h * 3] = tip.x; rb.cx[h * 3 + 1] = tip.y; rb.cx[h * 3 + 2] = tip.z;
      return;
    }
    if (rb.len >= VR_SEG) this._decimate(rb);        // make room, keep time span
    // record new head point; stall buffet is baked in as frozen jitter so it
    // stays behind in the air instead of wiggling with the jet
    let x = tip.x, y = tip.y, z = tip.z;
    if (stall) {
      const w = this.clock * 9 + rb.ph;
      x += Math.sin(w * 1.7) * (0.5 + 1.5 * Math.random());
      y += Math.sin(w * 2.3 + 1.3) * (0.5 + 1.5 * Math.random());
      z += Math.cos(w * 1.9) * (0.5 + 1.5 * Math.random());
    }
    // per-point dissipation direction: random unit-ish vector
    let ux = Math.random() * 2 - 1, uy = Math.random() * 2 - 1, uz = Math.random() * 2 - 1;
    const ul = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
    rb.head = (rb.head + 1) % VR_SEG;
    rb.cx[rb.head * 3] = x; rb.cx[rb.head * 3 + 1] = y; rb.cx[rb.head * 3 + 2] = z;
    rb.a[rb.head] = k; rb.st[rb.head] = stall ? 1 : 0;
    rb.born[rb.head] = this.clock;
    rb.dx[rb.head] = ux / ul; rb.dy[rb.head] = uy / ul; rb.dz[rb.head] = uz / ul;
    rb.len++;
    rb.lastX = tip.x; rb.lastY = tip.y; rb.lastZ = tip.z; rb.lastT = this.clock;
  }

  // vortex dissipation: recorded points wander with age, so the trail
  // slowly dissolves in the air instead of staying a frozen curve
  _driftRibbon(rb, dt) {
    for (let n = 0; n < rb.len; n++) {
      const i = (rb.head - n + VR_SEG * 2) % VR_SEG;
      const age = Math.min(1, (this.clock - rb.born[i]) / VR_WINDOW);
      const kk = dt * VR_DRIFT * (0.25 + 0.75 * age);
      rb.cx[i * 3] += rb.dx[i] * kk; rb.cx[i * 3 + 1] += rb.dy[i] * kk; rb.cx[i * 3 + 2] += rb.dz[i] * kk;
    }
  }

  update(dt, camera) {
    this.clock += dt;
    if (camera) this.camPos.copy(camera.position);
    // release pairs whose jet stopped feeding (killed / despawned)
    for (const [id, pair] of this.pairs) {
      if (this.clock - pair.lastFed > VR_WINDOW) {
        this.pairs.delete(id); this.free.push(pair.i);
      }
    }
    const V = this.vpos, A = this.vA, T = this.vT;
    for (const pair of this.pairs.values()) {
      this._driftRibbon(pair.L, dt);
      this._driftRibbon(pair.R, dt);
      this._buildRibbon(pair.L, pair.i * 2);
      this._buildRibbon(pair.R, pair.i * 2 + 1);
    }
    this.mesh.geometry.attributes.position.needsUpdate = true;
    this.mesh.geometry.attributes.aA.needsUpdate = true;
    this.mesh.geometry.attributes.aT.needsUpdate = true;
  }

  _buildRibbon(rb, slot) {
    const base = slot * VR_SEG * 2;
    const V = this.vpos, A = this.vA, T = this.vT;
    if (rb.len < 2) {
      for (let s = 0; s < VR_SEG * 2; s++) { A[base + s] = 0; T[base + s] = 0; }
      return;
    }
    // walk tail-ward once: cumulative path length per point (drives the
    // length-based fade) + trim beyond VR_MAXLEN meters / VR_WINDOW seconds
    const cum = this._cum;
    cum[0] = 0;
    let plen = 0;
    for (let n = 1; n < rb.len; n++) {
      const ia = (rb.head - n + VR_SEG * 2) % VR_SEG;         // tail-ward
      const ib = (rb.head - n + 1 + VR_SEG * 2) % VR_SEG;     // one newer
      const dx = rb.cx[ia * 3] - rb.cx[ib * 3], dy = rb.cx[ia * 3 + 1] - rb.cx[ib * 3 + 1], dz = rb.cx[ia * 3 + 2] - rb.cx[ib * 3 + 2];
      plen += Math.sqrt(dx * dx + dy * dy + dz * dz);
      cum[n] = plen;
      if (plen > VR_MAXLEN || this.clock - rb.born[ib] > VR_WINDOW) {
        rb.len = n + 1;
        break;
      }
    }
    const t = this._t, side = this._s, view = this._v1;
    // distance LOD: past ~1.5 km a ribbon spans too few pixels for
    // per-point resolution — sample every 2nd point to halve vertex writes
    const hx = rb.cx[rb.head * 3], hy = rb.cx[rb.head * 3 + 1], hz = rb.cx[rb.head * 3 + 2];
    const camD2 = (hx - this.camPos.x) ** 2 + (hy - this.camPos.y) ** 2 + (hz - this.camPos.z) ** 2;
    const stride = camD2 > VR_FAR2 ? 2 : 1;
    let j = 0, px = 0, py = 0, pz = 0;             // previous side, for coherence
    for (let n = 0; n < rb.len; n += stride) {
      const i = (rb.head - n + VR_SEG * 2) % VR_SEG;
      const age = Math.min(1, (this.clock - rb.born[i]) / VR_WINDOW);
      const a = rb.a[i], st = rb.st[i];
      // hybrid width: thin filament at light intensity; with age the band
      // both widens and fades — reading as the vortex spreading into air
      const w = (0.35 + Math.pow(a, 1.3) * (2.2 + st * 1.6)) * (0.5 + 1.9 * age) * 0.5;
      // tangent always points tail-ward: from an older neighbor normally,
      // or (current - newer) at the tail-most point — a sign flip here puts
      // the final quad on the wrong side of the path (twisted tail segment)
      let n0, flip = false;
      if (n + stride > rb.len - 1 && n > 0) { n0 = n - stride; flip = true; }
      else n0 = n + stride;
      const j0 = (rb.head - n0 + VR_SEG * 2) % VR_SEG;
      if (flip) t.set(rb.cx[i * 3] - rb.cx[j0 * 3], rb.cx[i * 3 + 1] - rb.cx[j0 * 3 + 1], rb.cx[i * 3 + 2] - rb.cx[j0 * 3 + 2]);
      else t.set(rb.cx[j0 * 3] - rb.cx[i * 3], rb.cx[j0 * 3 + 1] - rb.cx[i * 3 + 1], rb.cx[j0 * 3 + 2] - rb.cx[i * 3 + 2]);
      view.set(rb.cx[i * 3] - this.camPos.x, rb.cx[i * 3 + 1] - this.camPos.y, rb.cx[i * 3 + 2] - this.camPos.z);
      side.crossVectors(t, view);
      // orientation coherence: keep each offset on the same side as the
      // previous point — when the path curves across the view axis the raw
      // perpendicular flips sign and would twist the band edge-to-edge
      if (j > 0 && (side.x * px + side.y * py + side.z * pz) < 0) side.negate();
      const sl = side.length();
      if (sl > 1e-4) side.multiplyScalar(1 / sl); else side.set(px, py, pz);
      px = side.x; py = side.y; pz = side.z;
      const o = base + j * 2;
      V[o * 3] = rb.cx[i * 3] + side.x * w; V[o * 3 + 1] = rb.cx[i * 3 + 1] + side.y * w; V[o * 3 + 2] = rb.cx[i * 3 + 2] + side.z * w;
      V[(o + 1) * 3] = rb.cx[i * 3] - side.x * w; V[(o + 1) * 3 + 1] = rb.cx[i * 3 + 1] - side.y * w; V[(o + 1) * 3 + 2] = rb.cx[i * 3 + 2] - side.z * w;
      // length-based fade envelope: whichever limit cuts the tail (meters or
      // seconds), the last stretch of trail eases to zero alpha so the cut
      // itself is never visible — no hard edge, no stepping retraction
      let tf = 1;
      const d = cum[n];
      if (d > VR_FADE0) {
        const u = Math.min(1, (d - VR_FADE0) / (VR_MAXLEN - VR_FADE0));
        tf = 1 - u * u * (3 - 2 * u);           // smoothstep down to 0
      }
      const alpha = (0.16 + 0.5 * Math.pow(a, 1.2)) * tf;
      A[o] = alpha; A[o + 1] = alpha;
      T[o] = age; T[o + 1] = age;
      j++;
    }
    // degenerate any leftover slots from a shrunken or LOD-strided ribbon
    for (let k = j; k < VR_SEG; k++) {
      const o = base + k * 2;
      A[o] = 0; A[o + 1] = 0;
    }
  }
}

export class Effects {
  constructor(scene) {
    this.rng = mulberry32(0xC0FFEE);
    const V = () => new THREE.Vector3();
    this.add = new ParticleLayer(scene, MAX_ADD, THREE.AdditiveBlending, 0.02);
    this.smoke = new ParticleLayer(scene, MAX_SMOKE, THREE.NormalBlending, 0.12);
    // FX live on layer 1: drawn AFTER the cloud blend with opaque-depth
    // testing, so nearer smoke/fire is never covered by farther clouds
    this.add.points.layers.set(1);
    this.smoke.points.layers.set(1);
    this.vort = new VortexRibbons(scene);
    this._v = V();
    this.scene = scene;
    // shockwave rings: flat expanding circles hugging the sea/ground
    this.rings = [];
    this.ringPool = [];
    const ringGeo = new THREE.RingGeometry(0.86, 1, 48);
    for (let i = 0; i < 8; i++) {
      const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
        color: 0xcfe8ff, transparent: true, opacity: 0, side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      m.rotation.x = -Math.PI / 2;
      m.visible = false;
      m.frustumCulled = false;
      m.layers.set(1);
      scene.add(m);
      this.ringPool.push(m);
    }
    // debris chunks: small dark tumbling tetra shards
    this.debrisList = [];   // NOT `debris` — that name is the emitter method
    this.debrisPool = [];
    const chunkGeo = new THREE.TetrahedronGeometry(0.7);
    const chunkMat = new THREE.MeshStandardMaterial({ color: 0x2c3036, roughness: 0.9, flatShading: true });
    for (let i = 0; i < 48; i++) {
      const m = new THREE.Mesh(chunkGeo, chunkMat);
      m.visible = false;
      m.layers.set(1);
      scene.add(m);
      this.debrisPool.push(m);
    }
    // fire glow pool: up to 4 concurrent orange point lights claimed by
    // explosions and crash-site fires (fireFlash steals the closest-to-out)
    this.fireLights = [];
    for (let i = 0; i < 4; i++) {
      const L = new THREE.PointLight(0xff8a3a, 0, 1700, 2);
      L.visible = false;
      L.layers.enable(1);   // fire glow lights the FX layer too
      scene.add(L);
      this.fireLights.push({ L, t: 0, dur: 1, k: 0 });
    }
    // persistent crash-site burners (see groundFire)
    this.fireEmitters = [];
    // WRECK CHUNKS: big irregular burnt-metal pieces thrown by a kill —
    // they tumble, drag fire trails, and detonate a small fx at their landing
    this.bigChunks = [];
    const chunkGeos = [
      new THREE.BoxGeometry(2.8, 0.5, 1.0),
      new THREE.BoxGeometry(1.7, 0.4, 1.5),
      new THREE.BoxGeometry(0.8, 0.8, 2.4),
      new THREE.TetrahedronGeometry(1.5),
    ];
    this.chunkMatBig = new THREE.MeshStandardMaterial({
      color: 0x1c1f24, roughness: 0.85, metalness: 0.35, flatShading: true,
      emissive: 0x3a1405, emissiveIntensity: 1,
    });
    for (let i = 0; i < 16; i++) {
      const m = new THREE.Mesh(chunkGeos[i % 4], this.chunkMatBig);
      m.visible = false;
      m.frustumCulled = false;
      m.layers.set(1);
      scene.add(m);
      this.bigChunks.push({ m, v: new THREE.Vector3(), spin: new THREE.Vector3(), t: 0, life: 0, burnT: 0, on: false });
    }
    // blast-kit toggle (wired from the settings panel by main; the streak
    // half of the kit is gated HUD-side via state)
    this.blastGhosts = true;
    // explosion HALOS: a hot round core only — the anamorphic pair (wide
    // horizontal streaks) lives on the HUD glass now, screen-space like
    // the sun kit's, so it reads full-width at any range. Core color is
    // the fireball's own white-gold.
    this.halos = [];
    this.killFlares = [];   // big booms -> HUD lens kit (drained by main)
    const haloTex = makeHaloTexture();
    for (let i = 0; i < 4; i++) {
      const g = new THREE.Group();
      const mat = new THREE.SpriteMaterial({
        map: haloTex, color: new THREE.Color(3.2, 2.3, 1.2),
        blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0,
      });
      const round = new THREE.Sprite(mat);
      g.add(round);
      g.visible = false;
      g.traverse(o => o.layers.set(1));
      g.layers.set(1);
      scene.add(g);
      this.halos.push({ g, round, t: 0, dur: 0.42, size: 200 });
    }
  }

  spawn(layer, o) {
    layer.push({
      pos: o.pos.clone(), vel: o.vel || new THREE.Vector3(),
      age: -(o.delay ?? 0), life: o.life,
      c0: o.c0, c1: o.c1, a0: o.a0 ?? 1, a1: o.a1 ?? 0,
      s0: o.s0, s1: o.s1 ?? o.s0,
      drag: o.drag ?? 1, gravity: o.gravity ?? 0,
      turb: o.turb ?? 0, seed: this.rng(),
    });
  }

  explosion(pos, scale = 1) {
    const r = this.rng;
    // white-hot core flash (HDR -> bloom rolls it off)
    this.spawn(this.add, {
      pos, life: 0.22, c0: [5.0, 4.2, 3.0], c1: [2.2, 1.1, 0.4],
      s0: 24 * scale, s1: 58 * scale,
    });
    // FIREBALL: a ball of flame that INFLATES and BURNS ~1 s — slow speeds,
    // buoyant rise, growing sizes, colors held hot (bright orange -> deep red)
    // so the fire reads instead of winking out under the smoke
    for (let i = 0; i < 18; i++) {
      const v = new THREE.Vector3(r() - 0.5, r() * 0.7 + 0.15, r() - 0.5).normalize()
        .multiplyScalar((5 + r() * 14) * scale);
      this.spawn(this.add, {
        pos, vel: v, life: 0.8 + r() * 0.55, drag: 0.87, gravity: -7,
        c0: [3.4, 1.75, 0.45], c1: [1.5, 0.32, 0.05],
        s0: (9 + r() * 12) * scale, s1: (30 + r() * 24) * scale,
      });
    }
    // delayed fuel smoke: born 0.2-0.5 s in, so the fireball owns the first
    // beat and the black column rises out of a fire, not over a flash
    for (let i = 0; i < 16; i++) {
      const v = new THREE.Vector3(r() - 0.5, r() * 0.6 + 0.2, r() - 0.5).normalize()
        .multiplyScalar((6 + r() * 18) * scale);
      this.spawn(this.smoke, {
        pos, vel: v, delay: 0.2 + r() * 0.3, life: 2.4 + r() * 1.6, drag: 0.94, gravity: -3, turb: 2.2,
        c0: [0.10, 0.09, 0.09], c1: [0.30, 0.29, 0.29], a0: 0.68, a1: 0,
        s0: (10 + r() * 10) * scale, s1: (46 + r() * 30) * scale,
      });
    }
    // sparks
    for (let i = 0; i < 16; i++) {
      const v = new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize()
        .multiplyScalar((60 + r() * 150) * scale);
      this.spawn(this.add, {
        pos, vel: v, life: 0.4 + r() * 0.5, drag: 0.965, gravity: 60,
        c0: [3.0, 2.2, 0.9], c1: [1.2, 0.3, 0.05],
        s0: 2.4 * scale, s1: 0.4,
      });
    }
    this.fireFlash(pos, scale, 0.55 + 0.25 * Math.min(scale, 2));
    this.halo(pos, scale);
  }

  // anamorphic blast glow: hot core flash, inflates fast then gutters out
  // (~0.4 s). EVERY explosion also rings the HUD lens kit (streak + ghost
  // train; ghost size scales with the blast).
  halo(pos, scale = 1) {
    let h = this.halos.find(x => x.t <= 0);
    if (!h) h = this.halos[0];
    h.t = h.dur;
    h.size = 190 * (0.7 + scale * 0.55);
    h.g.position.copy(pos);
    h.g.visible = true;
    if (this.blastGhosts && this.killFlares.length < 4) {
      this.killFlares.push({ pos: pos.clone(), t: 0, k: Math.min(1.6, scale) });
    }
  }

  // the airframe breaks apart: 4-6 big burning chunks fork out along the
  // plane's velocity axis (+/-30-60 deg), tumble, trail fire, and pop a
  // small fx where they land
  wreckBurst(pos, vel, scale = 1) {
    const r = this.rng;
    const ax = vel.clone();
    if (ax.lengthSq() < 100) ax.set(r() - 0.5, -0.25, r() - 0.5);
    ax.normalize();
    const side = new THREE.Vector3().crossVectors(ax, Math.abs(ax.y) > 0.9
      ? _wp.set(1, 0, 0) : _wp.set(0, 1, 0)).normalize();
    const up = new THREE.Vector3().crossVectors(side, ax).normalize();
    const n = 4 + (r() * 3 | 0);
    let used = 0;
    for (const c of this.bigChunks) {
      if (used >= n) break;
      if (c.on) continue;
      used++;
      const ang = (0.5 + r() * 0.55) * (r() < 0.5 ? -1 : 1);   // fork angle rad
      const dir = ax.clone().multiplyScalar(Math.cos(ang))
        .addScaledVector(side, Math.sin(ang))
        .addScaledVector(up, (r() - 0.5) * 0.9)
        .normalize();
      c.on = true;
      c.t = 0; c.life = 2.6 + r() * 1.7; c.burnT = 0;
      c.v.copy(dir).multiplyScalar((40 + r() * 58) * scale);
      c.spin.set((r() - 0.5) * 16, (r() - 0.5) * 16, (r() - 0.5) * 16);
      c.m.position.copy(pos);
      c.m.rotation.set(r() * 6.28, r() * 6.28, r() * 6.28);
      c.m.scale.setScalar(0.7 + r() * 0.9);
      c.m.visible = true;
    }
    this.debris(pos, 12);   // small sparks-and-scrap flurry rides along
  }

  // dynamic fire glow: claims one of the pooled point lights (steals the
  // one closest to burning out if all busy) — sells the fire at night
  fireFlash(pos, scale = 1, dur = 0.6) {
    let slot = this.fireLights.find(f => f.t <= 0);
    if (!slot) {
      slot = this.fireLights[0];
      for (const f of this.fireLights) if (f.t < slot.t) slot = f;
    }
    slot.t = dur; slot.dur = dur;
    slot.k = 130000 * scale;
    slot.L.position.copy(pos);
    slot.L.visible = true;
  }

  // licking flame on a falling wreck — pairs with the black damageSmoke trail
  wreckFire(pos, vel) {
    this.spawn(this.add, {
      pos, vel, life: 0.28 + this.rng() * 0.26, drag: 0.9, gravity: -14,
      c0: [3.0, 1.5, 0.4], c1: [1.1, 0.25, 0.04],
      s0: 1.8 + this.rng() * 1.8, s1: 5 + this.rng() * 4,
    });
  }

  // crash site keeps burning for a few seconds: licking flames + fuel-black
  // smoke column + flickering glow. onSea = floating fuel slick (flatter,
  // wider, hugging the water) instead of a ground pillar
  groundFire(pos, onSea = false, scale = 1) {
    this.fireEmitters.push({
      pos: pos.clone(), t: 4.5 + this.rng() * 1.5, onSea, scale,
      fa: 0, sa: 0, la: 0,
    });
  }

  missileTrail(pos, vel) {
    this.spawn(this.smoke, {
      pos, vel, life: 1.9 + this.rng() * 0.5, drag: 0.92, gravity: -1.2, turb: 1.2,
      c0: [0.88, 0.86, 0.84], c1: [0.55, 0.54, 0.53], a0: 0.62, a1: 0,
      s0: 3.2, s1: 26,
    });
    this.spawn(this.add, {
      pos, life: 0.07, c0: [3.2, 1.9, 0.7], c1: [1.2, 0.5, 0.1], s0: 8, s1: 3,
    });
  }

  damageSmoke(pos, vel, dark) {
    this.spawn(this.smoke, {
      pos, vel, life: 1.3 + this.rng() * 0.6, drag: 0.95, gravity: -3, turb: 2,
      c0: dark ? [0.08, 0.08, 0.08] : [0.2, 0.19, 0.18], c1: [0.3, 0.3, 0.3], a0: 0.55, a1: 0,
      s0: 2.5, s1: 16,
    });
  }

  // rain on the airframe: droplet streaks born across the lift surfaces and
  // swept aft along the relative wind — AC7 chase-cam rain flight feel
  rainOnAirframe(anchors, airVel, rain) {
    if (rain < 0.25) return;
    const pts = [anchors.nose, anchors.wingL, anchors.wingR, anchors.tail];
    const n = Math.min(10, Math.floor(rain * 10));
    for (let i = 0; i < n; i++) {
      const a = pts[(this.rng() * pts.length) | 0];
      if (!a) continue;
      a.getWorldPosition(_rp);
      _rp.x += (this.rng() - 0.5) * 7;
      _rp.y += (this.rng() - 0.5) * 1.6 + 0.5;
      _rp.z += (this.rng() - 0.5) * 7;
      // streak velocity: mostly the relative wind, slightly outward
      const back = _rv.copy(airVel).multiplyScalar(-0.55);
      back.y += 4;
      this.spawn(this.add, {
        pos: _rp, vel: back,
        life: 0.1 + this.rng() * 0.08, drag: 1, gravity: 0,
        c0: [0.75, 0.85, 0.95], c1: [0.4, 0.5, 0.62], a0: 0.5, a1: 0,
        s0: 1.1, s1: 0.35,
      });
    }
  }

  hitSpark(pos) {
    for (let i = 0; i < 7; i++) {
      const v = new THREE.Vector3(this.rng() - 0.5, this.rng() - 0.5, this.rng() - 0.5)
        .normalize().multiplyScalar(35 + this.rng() * 90);
      this.spawn(this.add, {
        pos, vel: v, life: 0.18 + this.rng() * 0.22, drag: 0.95, gravity: 40,
        c0: [3.0, 2.3, 1.0], c1: [1.3, 0.4, 0.1], s0: 2.2, s1: 0.4,
      });
    }
  }

  gunTrailAir(pos) {   // airburst puff for missed gun rounds
    // rounds die 1.5-2 km out where a 1.5 m puff is sub-pixel — start big
    // enough that the miss cue actually reads at range
    this.spawn(this.smoke, {
      pos, life: 0.5, c0: [0.6, 0.6, 0.62], c1: [0.5, 0.5, 0.52], a0: 0.25, a1: 0,
      s0: 3.5, s1: 11,
    });
  }

  chaff(pos, vel) {
    // chaff bundle: silver strips blooming into a slow-hanging wide cloud
    this.spawn(this.add, {
      pos, vel, life: 0.25, drag: 0.9, gravity: 0,
      c0: [2.2, 2.2, 2.4], c1: [0.8, 0.8, 0.9], s0: 3, s1: 6,
    });
    for (let i = 0; i < 5; i++) {
      this.spawn(this.smoke, {
        pos, vel, life: 2.6 + this.rng() * 0.5, drag: 0.93, gravity: 3, turb: 3,
        c0: [0.78, 0.8, 0.85], c1: [0.6, 0.62, 0.66], a0: 0.55, a1: 0,
        s0: 2.5, s1: 20,
      });
    }
  }

  // continuous trail emitter for countermeasures, called along the real
  // (drag-bent) trajectory: hot glow streak for flares, silver wisps for
  // chaff, plus smoke that lingers, rises buoyantly and disperses
  cmTrail(pos, vel, isFlare) {
    if (isFlare) {
      this.spawn(this.add, {
        pos, vel, life: 0.22, drag: 0.985, gravity: 0,
        c0: [4.2, 3.2, 1.9], c1: [2.0, 0.75, 0.2],
        s0: 3.6, s1: 1.1,
      });
      this.spawn(this.smoke, {
        pos, vel, life: 2.8 + this.rng() * 1.2, drag: 0.995, gravity: -1.6, turb: 2.2,
        c0: [0.62, 0.60, 0.58], c1: [0.42, 0.42, 0.44], a0: 0.34, a1: 0,
        s0: 1.6, s1: 10,
      });
    } else {
      this.spawn(this.smoke, {
        pos, vel, life: 3.2 + this.rng() * 0.8, drag: 0.997, gravity: -1.1, turb: 2.6,
        c0: [0.8, 0.82, 0.86], c1: [0.55, 0.57, 0.6], a0: 0.3, a1: 0,
        s0: 1.4, s1: 14,
      });
    }
  }

  flare(pos, vel) {
    // bright burning countermeasure: hot white-orange core that fades
    this.spawn(this.add, {
      pos, vel, life: 2.3, drag: 0.995, gravity: 22, turb: 1.2,
      c0: [4.0, 3.0, 1.8], c1: [1.6, 0.5, 0.15],
      s0: 4.2, s1: 1.4,
    });
    this.spawn(this.smoke, {
      pos, vel, life: 1.8, drag: 0.99, gravity: 14, turb: 1.5,
      c0: [0.55, 0.52, 0.48], c1: [0.4, 0.4, 0.4], a0: 0.3, a1: 0,
      s0: 1.8, s1: 9,
    });
  }

  // expanding flat shockwave ring at (sea/ground) level
  ring(pos, scale = 1) {
    const m = this.ringPool.find(r => !r.visible);
    if (!m) return;
    m.visible = true;
    m.position.set(pos.x, SEA_LEVEL + 1.2, pos.z);
    m.scale.setScalar(2);
    m.material.opacity = 0.65;
    this.rings.push({ m, t: 0, scale });
  }

  // debris chunks thrown out of a destruction
  debris(pos, n = 10) {
    for (let i = 0; i < n; i++) {
      const m = this.debrisPool.find(d => !d.visible);
      if (!m) return;
      m.visible = true;
      m.position.copy(pos);
      const v = new THREE.Vector3(this.rng() - 0.5, this.rng() * 0.8 + 0.2, this.rng() - 0.5)
        .normalize().multiplyScalar(30 + this.rng() * 80);
      this.debrisList.push({ m, v, t: 0, life: 1.4 + this.rng() * 0.8, spin: new THREE.Vector3(this.rng() * 8, this.rng() * 8, this.rng() * 8) });
    }
  }

  // ocean impact: tall white plume + base ring (no fireball over water)
  waterColumn(pos, scale = 1) {
    for (let i = 0; i < 20; i++) {
      const up = 55 + this.rng() * 90;
      this.spawn(this.smoke, {
        pos: _wp.set(pos.x + (this.rng() - 0.5) * 8, SEA_LEVEL + 2, pos.z + (this.rng() - 0.5) * 8),
        vel: new THREE.Vector3((this.rng() - 0.5) * 16, up * scale, (this.rng() - 0.5) * 16),
        life: 1.1 + this.rng() * 1.0, drag: 0.965, gravity: -14, turb: 1.6,
        c0: [0.92, 0.96, 0.98], c1: [0.68, 0.74, 0.78], a0: 0.66, a1: 0,
        s0: (5 + this.rng() * 7) * scale, s1: (26 + this.rng() * 18) * scale,
      });
    }
    this.spawn(this.add, {
      pos: _wp.set(pos.x, SEA_LEVEL + 3, pos.z), life: 0.3,
      c0: [2.2, 2.6, 2.8], c1: [0.8, 1.0, 1.1], s0: 30 * scale, s1: 8 * scale,
    });
    this.ring(pos, 1.3 * scale);
  }

  // per-jet, per-frame wingtip vortex feeding (see VortexRibbons.feed)
  vortexFeed(id, tipL, tipR, k, stall) {
    this.vort.feed(id, tipL, tipR, k, stall);
  }

  update(dt, camera) {
    this.add.update(dt);
    this.smoke.update(dt);
    this.vort.update(dt, camera);    // pooled fire glows decay to zero
    for (const f of this.fireLights) {
      if (f.t <= 0) continue;
      f.t -= dt;
      if (f.t <= 0) { f.L.visible = false; f.L.intensity = 0; continue; }
      const u = f.t / f.dur;
      const flick = 0.78 + 0.22 * Math.sin(f.t * 47.0) * Math.sin(f.t * 31.0);
      f.L.intensity = f.k * u * u * flick;
    }
    // crash-site burners: licking flames + fuel-black column + flicker glow
    const r = this.rng;
    for (let i = this.fireEmitters.length - 1; i >= 0; i--) {
      const f = this.fireEmitters[i];
      f.t -= dt;
      if (f.t <= 0) { this.fireEmitters.splice(i, 1); continue; }
      const k = Math.min(1, f.t / 1.2);            // die-down envelope
      const base = Math.max(terrainHeightAt(f.pos.x, f.pos.z), SEA_LEVEL);
      f.fa += dt; f.sa += dt; f.la += dt;
      if (f.fa > 0.05) {
        f.fa = 0;
        this.spawn(this.add, {
          pos: _wp.set(f.pos.x + (r() - 0.5) * 14 * f.scale, base + 2 + r() * 3, f.pos.z + (r() - 0.5) * 14 * f.scale),
          vel: new THREE.Vector3((r() - 0.5) * 5, (f.onSea ? 8 : 13) + r() * 8, (r() - 0.5) * 5),
          life: 0.3 + r() * 0.28, drag: 0.9, gravity: -16,
          c0: [3.2, 1.6, 0.42], c1: [1.2, 0.28, 0.05],
          s0: (2.6 + r() * 2.4) * f.scale * k, s1: (7 + r() * 5) * f.scale * k,
        });
      }
      if (f.sa > 0.11) {
        f.sa = 0;
        this.spawn(this.smoke, {
          pos: _wp.set(f.pos.x + (r() - 0.5) * 10 * f.scale, base + 3, f.pos.z + (r() - 0.5) * 10 * f.scale),
          vel: new THREE.Vector3((r() - 0.5) * 6, 9 + r() * 7, (r() - 0.5) * 6),
          life: 2.6 + r() * 1.2, drag: 0.95, gravity: -2.5, turb: 1.8,
          c0: [0.09, 0.08, 0.08], c1: [0.3, 0.29, 0.29], a0: 0.6, a1: 0,
          s0: (5 + r() * 4) * f.scale, s1: (34 + r() * 22) * f.scale,
        });
      }
      if (f.la > 0.3) {                            // flickering glow while it burns
        f.la = 0;
        this.fireFlash(f.pos, 0.85 * f.scale * k, 0.42);
      }
    }
    // halos: core inflates fast then gutters out (streaks live on the HUD)
    for (const h of this.halos) {
      if (h.t <= 0) continue;
      h.t -= dt;
      if (h.t <= 0) { h.g.visible = false; continue; }
      const k = 1 - h.t / h.dur;                       // 0 -> 1
      const e = 1 - Math.pow(1 - k, 3);                // ease-out inflate
      const s = h.size * (0.3 + 0.7 * e);
      h.round.scale.set(s, s, 1);
      h.round.material.opacity = Math.pow(1 - k, 1.6) * 0.95;
    }
    // kill flares: age the HUD ghost-chain events, prune after their fade
    for (let i = this.killFlares.length - 1; i >= 0; i--) {
      const f = this.killFlares[i];
      f.t += dt;
      if (f.t > 0.5) this.killFlares.splice(i, 1);
    }
    // wreck chunks: fly, tumble, trail fire, pop where they land
    const r2 = this.rng;
    for (const c of this.bigChunks) {
      if (!c.on) continue;
      c.t += dt;
      c.v.y -= 42 * dt;
      c.v.multiplyScalar(Math.pow(0.998, dt * 60));
      c.m.position.addScaledVector(c.v, dt);
      c.m.rotation.x += c.spin.x * dt;
      c.m.rotation.y += c.spin.y * dt;
      c.m.rotation.z += c.spin.z * dt;
      // fire + smoke trail
      c.burnT += dt;
      if (c.burnT > 0.05) {
        c.burnT = 0;
        this.spawn(this.add, {
          pos: c.m.position, life: 0.22 + r2() * 0.14, drag: 0.9, gravity: -8,
          c0: [2.6, 1.3, 0.35], c1: [0.9, 0.2, 0.03],
          s0: 2.0 + r2() * 1.6, s1: 4.5 + r2() * 2,
        });
        if (r2() < 0.3) this.spawn(this.smoke, {
          pos: c.m.position, life: 1.4 + r2(), drag: 0.95, gravity: -2.5, turb: 1.5,
          c0: [0.1, 0.09, 0.09], c1: [0.3, 0.29, 0.29], a0: 0.5, a1: 0,
          s0: 2.5, s1: 16 + r2() * 10,
        });
      }
      // landing: sea splash or a small ground fire; timeout just fades out
      const g = Math.max(terrainHeightAt(c.m.position.x, c.m.position.z), SEA_LEVEL);
      if (c.m.position.y < g + 1.2) {
        if (g <= SEA_LEVEL + 1) this.waterColumn(c.m.position, 0.45);
        else { this.explosion(c.m.position, 0.5); this.groundFire(c.m.position, false, 0.7); }
        c.on = false; c.m.visible = false;
      } else if (c.t > c.life) {
        c.on = false; c.m.visible = false;
      }
    }
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.t += dt / 0.6;
      if (r.t >= 1) { r.m.visible = false; this.rings.splice(i, 1); continue; }
      const e = 1 - Math.pow(1 - r.t, 2.4);
      r.m.scale.setScalar(2 + e * 68 * r.scale);
      r.m.material.opacity = 0.65 * (1 - r.t);
    }
    for (let i = this.debrisList.length - 1; i >= 0; i--) {
      const d = this.debrisList[i];
      d.t += dt;
      if (d.t >= d.life) { d.m.visible = false; this.debrisList.splice(i, 1); continue; }
      d.v.y -= 60 * dt;
      d.v.multiplyScalar(Math.pow(0.985, dt * 60));
      d.m.position.addScaledVector(d.v, dt);
      d.m.rotation.x += d.spin.x * dt;
      d.m.rotation.y += d.spin.y * dt;
      d.m.rotation.z += d.spin.z * dt;
    }
  }
}
