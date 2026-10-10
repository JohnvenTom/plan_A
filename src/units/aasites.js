// aasites.js — anti-air batteries: the map-boundary enforcers.
// While the player is outside the combat area the nearest battery fires
// groups of five missiles (one per second) with an endless motor and a
// seeker nothing can spoof — leaving the battle is not an escape option.
// Batteries themselves are indestructible part of the map.
//
// Circle maps (classic 24 km): six platforms ride the combat ring, random
// style each. Edge maps (80 km continent): the whole map is the combat area
// and EIGHT distinct fortresses — one of every style — stand on the rim,
// guarding the world's edge. Styles: Aegis arsenal ship, drilling-platform
// fortress, domed monster turret, coastal SAM sea-fort, twin-tower base,
// flat-deck barge, stepped pyramid bunker, ring sea-fort.
// Every launch is staged: the cell hatch opens, a round rises from the cell,
// then it ignites with a flash and a smoke column.
import * as THREE from 'three';
import { terrainSurfaceAt, SEA_LEVEL } from '../world/terrain.js';
import { activeMap } from '../world/maps.js';

const FIRE_MARGIN = 800;              // leniency: batteries hold fire until
                                      // the intruder is THIS deep past the rim
const RWR_SITE_R = 6000;              // RWR new-contact ring around a battery
const SALVO = 5;                      // missiles per group
const SALVO_GAP = 1.0;                // one launch per second inside a group
const RELOAD = 4.0;                   // pause between groups
const PRELAUNCH = 0.7;                // hatch open + round rise before ignition

// ---- shared materials (created once) ----
const MAT = {
  hull: new THREE.MeshStandardMaterial({ color: 0x5a636e, roughness: 0.8, metalness: 0.4 }),
  deck: new THREE.MeshStandardMaterial({ color: 0x454c54, roughness: 0.85, metalness: 0.3 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x23272b, roughness: 0.9 }),
  accent: new THREE.MeshStandardMaterial({ color: 0x8f3a2e, roughness: 0.7 }),
  array: new THREE.MeshStandardMaterial({ color: 0x2a3440, roughness: 0.5, metalness: 0.6, emissive: 0x1d3a52, emissiveIntensity: 0.7 }),
  gold: new THREE.MeshStandardMaterial({ color: 0x9a7a2a, roughness: 0.5, metalness: 0.6, emissive: 0x6a4a10, emissiveIntensity: 0.8 }),
  concrete: new THREE.MeshStandardMaterial({ color: 0x8a8f94, roughness: 0.95 }),
  light: new THREE.MeshStandardMaterial({ color: 0xff2a1a, emissive: 0xff2a1a, emissiveIntensity: 2 }),
  foam: new THREE.MeshBasicMaterial({ color: 0xdfeef2, transparent: true, opacity: 0.35, depthWrite: false }),
  round: new THREE.MeshStandardMaterial({ color: 0xd8dde2, roughness: 0.5, metalness: 0.3 }),
};

function bx(g, w, h, d, mat, x, y, z, ry = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.rotation.y = ry;
  g.add(m);
  return m;
}
function cyl(g, rt, rb, h, seg, mat, x, y, z) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat);
  m.position.set(x, y, z);
  g.add(m);
  return m;
}
function blinker(g, x, y, z, r = 0.5) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 6, 5), MAT.light);
  m.position.set(x, y, z);
  g.add(m);
  return m;
}
// small decorative round that rises out of a cell before igniting
function decoyRound(g, muzzle) {
  const d = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 3.4, 8), MAT.round);
  d.add(body);
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.45, 1.1, 8), MAT.accent);
  tip.position.y = 2.2;
  d.add(tip);
  d.position.copy(muzzle);
  d.visible = false;
  g.add(d);
  return d;
}

// ---- style A: Aegis arsenal ship (~160 m, bow toward local -Z) ----
function buildAegis() {
  const g = new THREE.Group();
  bx(g, 16, 8, 148, MAT.hull, 0, 2, 0);
  const bow = new THREE.Mesh(new THREE.ConeGeometry(7.5, 30, 4), MAT.hull);
  bow.rotation.x = -Math.PI / 2;
  bow.rotation.y = Math.PI / 4;
  bow.position.set(0, 2, -86);
  g.add(bow);
  bx(g, 14, 1.2, 120, MAT.deck, 0, 6.6, 0);
  bx(g, 12, 6, 30, MAT.hull, 0, 10, 20);            // superstructure steps
  bx(g, 9, 5, 20, MAT.hull, 0, 15.5, 18);
  bx(g, 6, 4, 12, MAT.dark, 0, 20, 16);
  // phased-array panels on the bridge faces
  for (const [x, z, ry] of [[6.2, 18, Math.PI / 2], [-6.2, 18, Math.PI / 2], [0, 23.2, 0]]) {
    const p = new THREE.Mesh(new THREE.CylinderGeometry(4.2, 4.2, 0.5, 8), MAT.array);
    p.rotation.z = Math.PI / 2;
    p.rotation.y = ry;
    p.position.set(x, 15.5, z);
    if (ry === 0) { p.rotation.z = 0; p.rotation.x = Math.PI / 2; }
    g.add(p);
  }
  bx(g, 0.7, 10, 0.7, MAT.dark, 0, 27, 14);         // mast
  const bar = bx(g, 7, 0.5, 0.5, MAT.dark, 0, 31, 14);
  // VLS field fore of the bridge: 3 x 8 decorative hatches + 1 live cell
  const hatches = [];
  for (let r = 0; r < 3; r++) {
    for (let cI = 0; cI < 8; cI++) {
      const h = bx(g, 1.7, 0.35, 1.7, MAT.dark, -6.4 + cI * 1.82, 7.4, -30 + r * 2.4);
      hatches.push(h);
    }
  }
  const liveHatch = bx(g, 2.2, 0.4, 2.2, MAT.accent, 0, 7.5, -52);
  const muzzle = new THREE.Vector3(0, 8.2, -52);
  const round = decoyRound(g, muzzle);
  // bow/stern foam patches on the waterline
  const wake = new THREE.Mesh(new THREE.CircleGeometry(14, 12), MAT.foam);
  wake.rotation.x = -Math.PI / 2;
  wake.position.set(0, 0.4, -78);
  wake.scale.set(1, 2.4, 1);
  g.add(wake);
  const lights = [blinker(g, 0, 33, 14), blinker(g, 0, 7.5, 72), blinker(g, 0, 7.5, -72)];
  return { group: g, spinners: [{ obj: bar, speed: 1.6 }], hatches, liveHatch, muzzle, round, lights, tracked: null };
}

// ---- style B: drilling-platform fortress (~80 m wide, 55 m tall) ----
function buildRig() {
  const g = new THREE.Group();
  for (const [x, z] of [[-22, -16], [22, -16], [-22, 16], [22, 16]]) {
    cyl(g, 2.2, 2.9, 30, 8, MAT.hull, x, 11, z);
    bx(g, 40, 0.8, 1.2, MAT.dark, x / 2, 16, z);        // cross braces
    bx(g, 1.2, 0.8, 30, MAT.dark, x, 16, z / 2);
  }
  bx(g, 60, 4, 46, MAT.deck, 0, 26, 0);                 // main deck
  bx(g, 56, 1.2, 42, MAT.dark, 0, 28.6, 0);
  // derrick: tapering open cone
  const derrick = new THREE.Mesh(new THREE.ConeGeometry(9, 30, 4, 4, true),
    new THREE.MeshStandardMaterial({ color: 0x5a636e, roughness: 0.8, metalness: 0.4, side: THREE.DoubleSide, flatShading: true }));
  derrick.position.set(-12, 43, -8);
  derrick.rotation.y = Math.PI / 4;
  g.add(derrick);
  // rotating parabolic dish on the derrick top
  const dishPivot = new THREE.Group();
  dishPivot.position.set(-12, 58, -8);
  const dish = new THREE.Mesh(new THREE.SphereGeometry(7, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2.8),
    new THREE.MeshStandardMaterial({ color: 0xc8cdd2, roughness: 0.6, metalness: 0.5, side: THREE.DoubleSide }));
  dish.rotation.x = Math.PI / 2.4;
  dishPivot.add(dish);
  g.add(dishPivot);
  // crane arm
  const crane = new THREE.Group();
  crane.position.set(20, 30, 14);
  bx(crane, 1.4, 1.4, 26, MAT.accent, 0, 0, -8);
  cyl(crane, 1.2, 1.2, 6, 6, MAT.dark, 0, -3, 0);
  g.add(crane);
  // missile house with the live hatch
  bx(g, 14, 5, 10, MAT.hull, 8, 31, -6);
  const liveHatch = bx(g, 3, 0.5, 3, MAT.accent, 8, 33.8, -6);
  const muzzle = new THREE.Vector3(8, 34.5, -6);
  const round = decoyRound(g, muzzle);
  const lights = [blinker(g, -12, 59, -8), blinker(g, 26, 29, 20), blinker(g, -26, 29, 20)];
  return { group: g, spinners: [{ obj: dishPivot, speed: 0.8 }, { obj: crane, speed: 0.3 }], hatches: [], liveHatch, muzzle, round, lights, tracked: null };
}

// ---- style C: domed monster turret (90 m, turret tracks the intruder) ----
function buildDome() {
  const g = new THREE.Group();
  cyl(g, 45, 52, 10, 12, MAT.dark, 0, 3, 0);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(46, 1.4, 6, 28), MAT.gold);
  rim.rotation.x = Math.PI / 2;
  rim.position.y = 8;
  g.add(rim);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(24, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2), MAT.hull);
  dome.position.y = 8;
  g.add(dome);
  const pulse = new THREE.Mesh(new THREE.SphereGeometry(1.6, 8, 6), MAT.light.clone());
  pulse.position.set(0, 32.5, 0);
  g.add(pulse);
  // rotating turret with twin launch arms
  const turret = new THREE.Group();
  turret.position.y = 30;
  cyl(turret, 10, 12, 6, 10, MAT.deck, 0, 1, 0);
  for (const side of [-1, 1]) {
    bx(turret, 3.2, 3.2, 24, MAT.dark, side * 5, 5, -4);
    const pod = cyl(turret, 1.8, 1.8, 5, 8, MAT.accent, side * 5, 5, -15);
    pod.rotation.x = Math.PI / 2;
  }
  g.add(turret);
  const muzzle = new THREE.Vector3(0, 36, -18);   // between the arm tips
  const round = decoyRound(g, muzzle);
  const lights = [blinker(g, 30, 10, 0), blinker(g, -30, 10, 0)];
  return { group: g, spinners: [], hatches: [], liveHatch: null, muzzle, round, lights, tracked: turret, pulse };
}

// ---- style D: coastal SAM sea-fort (~70 m concrete) ----
function buildFort() {
  const g = new THREE.Group();
  bx(g, 64, 16, 52, MAT.concrete, 0, 6, 0);
  bx(g, 50, 6, 40, MAT.concrete, 0, 17, 2);
  bx(g, 34, 5, 26, MAT.concrete, 0, 22, 4);
  // antenna masts with crossbars
  for (const [x, z, h] of [[-12, -8, 16], [0, -10, 20], [12, -8, 14]]) {
    bx(g, 0.5, h, 0.5, MAT.dark, x, 24 + h / 2, z);
    bx(g, 4, 0.35, 0.35, MAT.dark, x, 24 + h * 0.7, z);
  }
  // four bunkers; the fore one is live
  const hatches = [];
  for (let i = 0; i < 4; i++) {
    bx(g, 10, 3, 8, MAT.deck, -13 + (i % 2) * 26, 26.8, 4 + Math.floor(i / 2) * 10);
  }
  const liveHatch = bx(g, 3.4, 0.6, 3.4, MAT.accent, 0, 28.6, 9);
  // angled launch rail + sweeping searchlight cone
  const rail = bx(g, 2.2, 0.5, 10, MAT.dark, 0, 27.5, -6);
  rail.rotation.x = -0.6;
  const lampPivot = new THREE.Group();
  lampPivot.position.set(14, 26, 8);
  const lampCone = new THREE.Mesh(new THREE.ConeGeometry(2.2, 12, 8, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xfff2c8, transparent: true, opacity: 0.18, depthWrite: false }));
  lampCone.rotation.x = -Math.PI / 2 - 0.5;
  lampCone.position.y = -5;
  lampPivot.add(lampCone);
  g.add(lampPivot);
  const muzzle = new THREE.Vector3(0, 29.4, 9);
  const round = decoyRound(g, muzzle);
  const lights = [blinker(g, -20, 22, 14), blinker(g, 20, 22, 14)];
  return { group: g, spinners: [{ obj: lampPivot, speed: 0.9 }], hatches, liveHatch, muzzle, round, lights, tracked: null };
}

// ---- style E: twin-tower missile base (two lattice towers, bridge launcher) ----
function buildTwin() {
  const g = new THREE.Group();
  bx(g, 78, 6, 34, MAT.concrete, 0, 3, 0);          // shared base slab
  for (const x of [-26, 26]) {
    for (const [dx, dz] of [[-9, -9], [9, -9], [-9, 9], [9, 9]])
      cyl(g, 0.8, 0.8, 40, 6, MAT.dark, x + dx, 23, dz);   // lattice legs
    bx(g, 16, 3, 22, MAT.deck, x, 43, 0);           // tower caps
    bx(g, 4, 10, 4, MAT.hull, x, 49, -6);
    blinker(g, x, 55, -6, 0.7);
  }
  // launch bridge slung between the towers; three cells, centre one live
  bx(g, 52, 4, 14, MAT.hull, 0, 40, 0);
  const hatches = [];
  for (let i = 0; i < 3; i++) hatches.push(bx(g, 8, 1.5, 6, MAT.deck, -16 + i * 16, 42.7, 0));
  const liveHatch = bx(g, 3.2, 0.6, 3.2, MAT.accent, 0, 43.4, 0);
  const dish = cyl(g, 4.5, 0.6, 1.2, 10, MAT.array, 0, 47, 8);
  const muzzle = new THREE.Vector3(0, 44.2, 0);
  const round = decoyRound(g, muzzle);
  const lights = [blinker(g, -26, 45, 12), blinker(g, 26, 45, 12)];
  return { group: g, spinners: [{ obj: dish, speed: 1.1 }], hatches, liveHatch, muzzle, round, lights, tracked: null };
}

// ---- style F: flat-deck arsenal barge (~170 m, carrier silhouette) ----
function buildBarge() {
  const g = new THREE.Group();
  bx(g, 30, 10, 160, MAT.hull, 0, 3, 0);
  const bow = new THREE.Mesh(new THREE.ConeGeometry(14, 34, 4), MAT.hull);
  bow.rotation.x = -Math.PI / 2; bow.rotation.y = Math.PI / 4;
  bow.position.set(0, 3, -95);
  g.add(bow);
  bx(g, 28, 1.4, 150, MAT.deck, 0, 8.7, 0);
  bx(g, 7, 12, 26, MAT.hull, 9, 15, 26);            // island superstructure
  bx(g, 5, 4, 5, MAT.array, 9, 23, 26);             // radar slab
  bx(g, 0.6, 14, 0.6, MAT.dark, 9, 27, 20);         // mast
  // deck launch cells in two rows; port-forward one is live
  const hatches = [];
  for (let i = 0; i < 6; i++)
    hatches.push(bx(g, 5, 0.8, 5, MAT.deck, -8, 9.5, -52 + (i % 3) * 14 + Math.floor(i / 3) * 4));
  const liveHatch = bx(g, 3, 0.6, 3, MAT.accent, -8, 10, -48);
  const muzzle = new THREE.Vector3(-8, 10.8, -48);
  const round = decoyRound(g, muzzle);
  const lights = [blinker(g, -14, 10, 70), blinker(g, 9, 24, 34, 0.6)];
  return { group: g, spinners: [], hatches, liveHatch, muzzle, round, lights, tracked: null };
}

// ---- style G: stepped pyramid bunker (~90 m base) ----
function buildPyramid() {
  const g = new THREE.Group();
  for (let i = 0; i < 5; i++)
    bx(g, 88 - i * 16, 9, 88 - i * 16, MAT.concrete, 0, 4.5 + i * 9, 0);
  // launch cells cut into the top step; one live hatch
  const hatches = [];
  for (let i = 0; i < 4; i++)
    hatches.push(bx(g, 6, 1.2, 6, MAT.deck, -10 + (i % 2) * 20, 45.6, -10 + Math.floor(i / 2) * 20));
  const liveHatch = bx(g, 3.2, 0.6, 3.2, MAT.accent, 0, 46.2, 0);
  // crown: rotating seeker head on a short column
  const column = cyl(g, 2.2, 3, 8, 8, MAT.hull, 0, 50, 0);
  const head = new THREE.Mesh(new THREE.SphereGeometry(4.2, 10, 8), MAT.array);
  head.position.y = 56;
  g.add(head);
  const muzzle = new THREE.Vector3(0, 47, 0);
  const round = decoyRound(g, muzzle);
  const lights = [blinker(g, -34, 42, 34), blinker(g, 34, 42, -34)];
  return { group: g, spinners: [{ obj: head, speed: 0.7 }, { obj: column, speed: 0.7 }], hatches, liveHatch, muzzle, round, lights, tracked: null };
}

// ---- style H: ring sea-fort (circular wall, keep in the middle) ----
function buildRing() {
  const g = new THREE.Group();
  const wall = new THREE.Mesh(new THREE.TorusGeometry(38, 6, 8, 28), MAT.concrete);
  wall.rotation.x = Math.PI / 2;
  wall.position.y = 4;
  g.add(wall);
  cyl(g, 30, 34, 8, 24, MAT.concrete, 0, 10, 0);    // courtyard deck
  bx(g, 18, 14, 18, MAT.hull, 0, 21, 0);            // central keep
  bx(g, 10, 5, 10, MAT.deck, 0, 30.5, 0);
  for (const a of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    bx(g, 6, 7, 12, MAT.hull, Math.sin(a) * 22, 17.5, Math.cos(a) * 22, a);
    blinker(g, Math.sin(a) * 30, 12, Math.cos(a) * 30, 0.55);
  }
  const hatches = [bx(g, 6, 0.9, 6, MAT.deck, -4, 28.5, 0), bx(g, 6, 0.9, 6, MAT.deck, 4, 28.5, 0)];
  const liveHatch = bx(g, 3.2, 0.6, 3.2, MAT.accent, 0, 33.4, 0);
  const dish = cyl(g, 3.8, 0.5, 1, 10, MAT.array, 7, 34.5, 7);
  const muzzle = new THREE.Vector3(0, 34, 0);
  const round = decoyRound(g, muzzle);
  const lights = [blinker(g, -9, 28, 9, 0.6), blinker(g, 9, 34, -9, 0.6)];
  return { group: g, spinners: [{ obj: dish, speed: 1.3 }], hatches, liveHatch, muzzle, round, lights, tracked: null };
}

const BUILDERS = [buildAegis, buildRig, buildDome, buildFort, buildTwin, buildBarge, buildPyramid, buildRing];

export class AASites {
  constructor(scene) {
    this.scene = scene;
    this.sites = [];
    this.t = 0;
    this._place();
  }

  // (re)build the batteries for the ACTIVE map — called on boot and on every
  // war-zone switch. Circle maps (classic): six naval platforms on the combat
  // ring. Edge maps (80 km): EIGHT distinct fortresses spaced around the map
  // rim — the whole interior is free combat airspace, the rim is the wall.
  _place() {
    const scene = this.scene;
    const combat = activeMap.combat;
    const edge = combat.type === 'edge';
    const count = edge ? 8 : 6;
    const ringR = edge ? combat.half - 1200 : combat.r;
    const cx = edge ? 0 : combat.x, cz = edge ? 0 : combat.z;
    for (let k = 0; k < count; k++) {
      let ang = (k + 0.5) * Math.PI * 2 / count;   // offset so no platform sits dead on an axis
      for (let t = 0; t < 12; t++) {
        const x = cx + Math.cos(ang) * ringR, z = cz + Math.sin(ang) * ringR;
        if (terrainSurfaceAt(x, z) < SEA_LEVEL + 1) break;
        ang += Math.PI / 36;   // nudge ~5° until sea
      }
      const x = cx + Math.cos(ang) * ringR, z = cz + Math.sin(ang) * ringR;
      const y = Math.max(terrainSurfaceAt(x, z), SEA_LEVEL);
      // edge maps give every fortress its own silhouette; circle maps roll
      const parts = (edge ? BUILDERS[k % BUILDERS.length] : BUILDERS[Math.floor(Math.random() * BUILDERS.length)])();
      parts.group.position.set(x, y, z);
      parts.group.rotation.y = Math.atan2(x - cx, z - cz);   // face the map centre
      scene.add(parts.group);
      const pos = new THREE.Vector3(x, y, z);
      const muzzleWorld = new THREE.Vector3();
      this.sites.push({
        pos, parts, muzzleWorld,
        salvoLeft: SALVO, shotT: 0, reloadT: 0, launchT: 0, hatch: 0, phase: Math.random() * 6,
      });
    }
  }

  reset() {
    for (const s of this.sites) {
      s.salvoLeft = SALVO; s.shotT = 0; s.reloadT = 0; s.launchT = 0; s.hatch = 0;
      s.parts.round.visible = false;
      s._rwrNear = false;   // re-arm the RWR new-contact ring for the next sortie
    }
  }

  // war-zone switch: drop the old batteries, place fresh ones for this map
  rebuild() {
    for (const s of this.sites) this.scene.remove(s.parts.group);
    this.sites = [];
    this.t = 0;
    this._place();
    this.reset();
  }

  update(dt, player, weapons, effects) {
    this.t += dt;
    // the battery nearest the intruder engages; already-launched rounds keep
    // chasing even if the player ducks back inside
    let near = null;
    const cb = activeMap.combat;
    // circle maps: outside the ring. edge maps: past the map box rim
    const outside = cb.type === 'edge'
      ? Math.abs(player.position.x) > cb.half + FIRE_MARGIN || Math.abs(player.position.z) > cb.half + FIRE_MARGIN
      : Math.hypot(player.position.x - cb.x, player.position.z - cb.z) > cb.r + FIRE_MARGIN;
    if (player.alive && outside) {
      near = this.sites[0];
      for (const s of this.sites) {
        if (s.pos.distanceToSquared(player.position) < near.pos.distanceToSquared(player.position)) near = s;
      }
    }
    for (const s of this.sites) {
      const P = s.parts;
      // RWR new contact: skimming a battery's 6 km ring — sites sit on the
      // 14 km boundary circle, so only edge-hugging flight rings this; one
      // chirp per site, re-armed when you pull away
      const nearRing = player.alive && s.pos.distanceToSquared(player.position) < RWR_SITE_R * RWR_SITE_R;
      if (nearRing && !s._rwrNear) weapons.audio?.rwrNewContact?.();
      s._rwrNear = nearRing;
      // idle animation: radar sweeps, crane/lamp rotation, beacon blink
      for (const sp of P.spinners) sp.obj.rotation.y += dt * sp.speed;
      const blink = Math.sin(this.t * 3 + s.phase) > 0;
      for (const L of P.lights) L.visible = blink;
      if (P.pulse) P.pulse.material.emissiveIntensity = 1.2 + Math.sin(this.t * 5) * 1.1;
      // style C tracks the intruder with the whole turret
      if (P.tracked && player.alive) {
        const bearing = Math.atan2(player.position.x - s.pos.x, player.position.z - s.pos.z) - P.group.rotation.y;
        P.tracked.rotation.y += (bearing - P.tracked.rotation.y) * Math.min(1, dt * 2);
      }
      // launch choreography: hatch opens, the round rises, then ignition —
      // a committed round fires even if the player already left the area
      s.hatch += ((s.launchT > 0 ? 1 : 0) - s.hatch) * Math.min(1, dt * 5);
      if (P.liveHatch) P.liveHatch.rotation.x = -1.4 * s.hatch;
      if (s.launchT > 0) {
        s.launchT -= dt;
        const k = 1 - Math.max(0, s.launchT) / PRELAUNCH;
        P.round.visible = true;
        P.round.position.set(P.muzzle.x, P.muzzle.y + k * 12, P.muzzle.z);
        if (s.launchT <= 0) {
          P.round.visible = false;
          s.muzzleWorld.copy(P.muzzle).applyMatrix4(P.group.matrixWorld);
          const quat = new THREE.Quaternion().setFromRotationMatrix(
            new THREE.Matrix4().lookAt(s.muzzleWorld, player.position, new THREE.Vector3(0, 1, 0)));
          weapons.launchMissile(s.muzzleWorld.clone(), quat, false, player, null, 'aa');
          if (effects) {
            effects.explosion(s.muzzleWorld, 0.55);
            for (let i = 0; i < 3; i++) {
              _sv.set(0, 26 + i * 8, 0);
              effects.cmTrail(_sv2.copy(s.muzzleWorld).add(_sv3.set(0, i * 2.5, 0)), _sv, true);
            }
          }
        }
      }
      // salvo scheduling: only the nearest battery fires while the player
      // is out of bounds; everyone else stands down with topped-off launchers
      if (!near || s !== near) {
        if (s.launchT <= 0) { s.salvoLeft = SALVO; s.shotT = 0; s.reloadT = 0; }
        continue;
      }
      s.shotT -= dt;
      s.reloadT -= dt;
      if (s.launchT > 0) continue;   // a round is already rising
      if (s.salvoLeft <= 0) {
        if (s.reloadT <= 0) { s.salvoLeft = SALVO; s.shotT = 0; }
        continue;
      }
      if (s.shotT > 0) continue;
      s.shotT = SALVO_GAP;
      s.salvoLeft--;
      if (s.salvoLeft <= 0) s.reloadT = RELOAD;
      s.launchT = PRELAUNCH;
      // RWR special contact: the first round of a salvo is the moment the
      // battery commits — a missile site's hatch rising is its signature
      if (s.salvoLeft === SALVO - 1) weapons.audio?.rwrSpecial?.();
    }
  }
}

const _sv = new THREE.Vector3();
const _sv2 = new THREE.Vector3();
const _sv3 = new THREE.Vector3();
