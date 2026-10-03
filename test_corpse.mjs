// test_corpse.mjs — regression: a target killed outright (dead without
// dying, the 70% instant-kill path) used to keep the player's lock and
// keep steering missiles, which orbited the frozen corpse position in
// ~260 m circles until timeout. The lock must drop and guidance must go
// dead; live targets and flares must keep guiding exactly as before.
import * as THREE from 'three';
import { Weapons } from './js/weapons.js';
import { Player } from './js/player.js';
import { Effects } from './js/effects.js';

const scene = { add() {}, remove() {}, traverse() {}, children: [], fog: { color: { r: 0, g: 0, b: 0 }, density: 0.00003 } };
const camera = new THREE.PerspectiveCamera(66, 1.78, 2.5, 72000);
const effects = new Effects(scene);
const player = new Player(scene, camera);
const weapons = new Weapons(scene, effects);
player.reset();

let fails = 0;
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) fails++; };

const fwd = player.forward(new THREE.Vector3());
const ahead = (d) => player.position.clone().addScaledVector(fwd, d);

// --- 1. the lock drops on a dead-without-dying corpse ---
const corpse = { dying: false, dead: true, position: ahead(3000), vel: new THREE.Vector3() };
weapons.manualTarget = corpse;
weapons.lockState = { target: corpse, locked: true };
weapons.updateLock(1 / 30, player, [corpse]);
check('lock drops on an instant-kill corpse', weapons.manualTarget === null && !weapons.lockState.locked);

// --- 2. a live enemy keeps the lock while in cone and range ---
const live = { dying: false, dead: false, position: ahead(3000), vel: new THREE.Vector3() };
weapons.manualTarget = live;
weapons.lockState = { target: live, locked: true };
weapons.updateLock(1 / 30, player, [live]);
check('lock holds on a live target', weapons.manualTarget === live && weapons.lockState.locked);

// --- 3. steering: launch along -Z from the origin with the target on the
// beam (+X, 90° off the nose) — any live guidance swings the heading hard,
// dead guidance keeps the launch heading exactly
const steer = (target) => {
  weapons.launchMissile(new THREE.Vector3(), new THREE.Quaternion(), true, target, player, 'ir');
  const ms = weapons.missiles[weapons.missiles.length - 1];
  ms.target = target;
  for (let i = 0; i < 60; i++) weapons.steerMissile(ms, 1 / 30);   // 2 s of flight
  weapons.missiles.pop();
  return new THREE.Vector3(0, 0, -1).applyQuaternion(ms.quat);
};
const LAUNCH_HDG = new THREE.Vector3(0, 0, -1);
const BEAM = new THREE.Vector3(3000, 0, 0);

const hdgCorpse = steer({ dying: false, dead: true, position: BEAM.clone(), vel: new THREE.Vector3() });
check(`corpse steers nothing (heading ${hdgCorpse.x.toFixed(3)},${hdgCorpse.y.toFixed(3)},${hdgCorpse.z.toFixed(3)})`,
  hdgCorpse.angleTo(LAUNCH_HDG) < 0.01);

const hdgLive = steer({ dying: false, dead: false, position: BEAM.clone(), vel: new THREE.Vector3() });
check('live target still steers the missile', hdgLive.angleTo(LAUNCH_HDG) > 0.5);

const hdgFlare = steer({ isFlare: true, pos: BEAM.clone(), vel: new THREE.Vector3() });
check('flare still steers the missile', hdgFlare.angleTo(LAUNCH_HDG) > 0.5);

console.log(fails ? `DONE — ${fails} failure(s)` : 'DONE — all pass');
process.exit(fails ? 1 : 0);
