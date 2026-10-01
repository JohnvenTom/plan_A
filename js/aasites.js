// aasites.js — anti-air batteries on the sea along the combat-radius edge.
// The map-boundary enforcers: while the player is outside the combat area
// the nearest battery fires groups of five missiles (one per second) with an
// endless motor and a seeker nothing can spoof — leaving the battle is not
// an escape option. Batteries themselves are indestructible part of the map.
import * as THREE from 'three';
import { terrainHeightAt, SEA_LEVEL } from './terrain.js';

const COMBAT_RADIUS = 14000;          // keep in sync with player.js
const SALVO = 5;                      // missiles per group
const SALVO_GAP = 1.0;                // one launch per second inside a group
const RELOAD = 4.0;                   // pause between groups

function buildSiteMesh(scene) {
  const g = new THREE.Group();
  const grey = new THREE.MeshStandardMaterial({ color: 0x3c4248, roughness: 0.85, metalness: 0.35 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x23272b, roughness: 0.9 });
  const base = new THREE.Mesh(new THREE.CylinderGeometry(9, 11, 5, 10), grey);
  base.position.y = 2;
  g.add(base);
  const turret = new THREE.Mesh(new THREE.BoxGeometry(5, 3.4, 6), dark);
  turret.position.y = 6.2;
  g.add(turret);
  for (let i = 0; i < 4; i++) {
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 5.2, 8), grey);
    tube.position.set(-1.8 + (i % 2) * 3.6, 8.2, -1.2 + Math.floor(i / 2) * 2.4);
    tube.rotation.x = -0.35;   // canted toward the horizon
    g.add(tube);
  }
  const mast = new THREE.Mesh(new THREE.BoxGeometry(0.4, 7, 0.4), dark);
  mast.position.set(4.5, 9, 0);
  g.add(mast);
  const dish = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.3, 1.1), dark);
  dish.position.set(4.5, 12.6, 0);
  g.add(dish);
  g.traverse(o => { o.frustumCulled = false; });
  scene.add(g);
  return { group: g, dish };
}

export class AASites {
  constructor(scene) {
    this.sites = [];
    // six batteries evenly spaced on the combat-radius circle, each nudged
    // along the circle until it floats on open water past the islands
    for (let k = 0; k < 6; k++) {
      let ang = k * Math.PI / 3;
      for (let t = 0; t < 12; t++) {
        const x = Math.cos(ang) * COMBAT_RADIUS, z = Math.sin(ang) * COMBAT_RADIUS;
        if (terrainHeightAt(x, z) < SEA_LEVEL + 1) break;
        ang += Math.PI / 36;   // nudge ~5° until sea
      }
      const x = Math.cos(ang) * COMBAT_RADIUS, z = Math.sin(ang) * COMBAT_RADIUS;
      const y = Math.max(terrainHeightAt(x, z), SEA_LEVEL);
      const mesh = buildSiteMesh(scene);
      mesh.group.position.set(x, y, z);
      this.sites.push({ pos: new THREE.Vector3(x, y, z), mesh, salvoLeft: SALVO, shotT: 0, reloadT: 0 });
    }
  }

  reset() {
    for (const s of this.sites) { s.salvoLeft = SALVO; s.shotT = 0; s.reloadT = 0; }
  }

  update(dt, player, weapons) {
    for (const s of this.sites) s.mesh.dish.rotation.y += dt * 1.4;   // search radar sweep
    if (!player.alive || !player.outOfArea) {
      // back inside: stand down and top off the launchers
      for (const s of this.sites) { s.salvoLeft = SALVO; s.shotT = 0; s.reloadT = 0; }
      return;
    }
    // the battery nearest the intruder engages; already-launched rounds keep
    // chasing even if the player ducks back inside
    let near = this.sites[0];
    for (const s of this.sites) {
      if (s.pos.distanceToSquared(player.position) < near.pos.distanceToSquared(player.position)) near = s;
    }
    near.shotT -= dt;
    near.reloadT -= dt;
    if (near.salvoLeft <= 0) {
      if (near.reloadT <= 0) { near.salvoLeft = SALVO; near.shotT = 0; }
      return;
    }
    if (near.shotT > 0) return;
    near.shotT = SALVO_GAP;
    near.salvoLeft--;
    const origin = near.pos.clone().add(new THREE.Vector3(0, 9, 0));
    const quat = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().lookAt(origin, player.position, new THREE.Vector3(0, 1, 0)));
    weapons.launchMissile(origin, quat, false, player, null, 'aa');
  }
}
