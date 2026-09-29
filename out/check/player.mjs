// player.js — WT mouse-aim pilot on top of the full-aerodynamics FlightBody.
// The mouse rotates a WORLD-ANCHORED aim direction; aimAt() turns stick torques
// toward it (bank first, then pull, G/AOA-limited); the camera anchors to the
// aim direction, not the nose. W/A/S/D give direct stick authority while held.
import * as THREE from 'three';
import { clamp, damp } from './utils.js';
import { GROUND_CLEAR_AGL } from './utils.js';
import { buildJet } from './jet.js';
import { FlightBody } from './flightmodel.js';
import { terrainHeightAt, SEA_LEVEL } from './terrain.js';

const COMBAT_RADIUS = 14000;   // meters from world center
const AIM_DIST = 4000;         // draw/projection distance for the aim point
const AIM_SENS = 0.0013;       // rad per mouse px

export class Player {
  constructor(scene, camera) {
    this.scene = scene;
    this.camera = camera;
    this.model = buildJet({ paint: 0xa8b4c4, accent: 0x2e5fa3 });
    scene.add(this.model.group);

    this.body = new FlightBody({});
    this.obj = new THREE.Object3D();   // synced render/anchor body
    scene.add(this.obj);

    this.hp = 100;
    this.alive = true;
    this.viewMode = 0;               // 0 near, 1 mid, 2 far
    this.outOfAreaTime = 0;
    this.hitFlash = 0;
    this.camShake = 0;
    this.boosting = false;
    this.aimDir = new THREE.Vector3(0, 0, -1);  // WORLD-ANCHORED aim direction
    this.aimLocal = null;
    this._keyOverride = 0; this._keyYaw = 0; this._keyPitch = 0;

    this._qTmp = new THREE.Quaternion();
    this._vTmp = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._camRight = new THREE.Vector3();
    this._camUp = new THREE.Vector3();
    this.camPos = new THREE.Vector3();
    this.camLook = new THREE.Vector3();
    this.camDir = new THREE.Vector3(0, 0, -1);
    this._camInit = false;
    this._camDirInit = false;
  }

  reset() {
    this.hp = 100;
    this.alive = true;
    this.crashed = false;
    this.outOfAreaTime = 0;
    this.hitFlash = 0;
    this.boosting = false;
    this.body.setState(new THREE.Vector3(0, 2600, 9000), Math.PI, 240);
    this.body.throttle = 0.65;
    this.forward(this.aimDir);
    this.model.group.visible = true;
    this._camInit = false;
    this._camDirInit = false;
  }

  // --- delegate the external surface area to the flight body ---
  get position() { return this.body.pos; }
  get quaternion() { return this.body.quat; }
  get vel() { return this.body.vel; }
  get speed() { return this.body.airspeed; }
  get alpha() { return this.body.alpha; }
  get gLoad() { return this.body.gLoad; }
  get ctl() { return this.body.ctl; }
  get throttle() { return this.body.throttle; }

  forward(out) { return this.body.forward(out); }
  upVec(out) { return this.body.upVec(out); }

  applyDamage(amount) {
    if (!this.alive) return;
    this.hp -= amount;
    this.hitFlash = Math.min(1, this.hitFlash + amount / 45);
    this.camShake = Math.min(1.4, this.camShake + amount / 60);
    if (this.hp <= 0) { this.hp = 0; this.alive = false; }
  }

  get aimPoint() {
    return this._v2.copy(this.aimDir).multiplyScalar(AIM_DIST).add(this.body.pos);
  }

  // ---- mouse rotates the world-anchored aim direction (camera frame) ----
  rotateAim(dx, dy) {
    if (dx === 0 && dy === 0) return;
    this.camera.updateMatrixWorld();
    this._camRight.setFromMatrixColumn(this.camera.matrixWorld, 0).normalize();
    this._camUp.setFromMatrixColumn(this.camera.matrixWorld, 1).normalize();
    this._qTmp.setFromAxisAngle(this._camUp, -dx * AIM_SENS);
    this.aimDir.applyQuaternion(this._qTmp);
    this._qTmp.setFromAxisAngle(this._camRight, -dy * AIM_SENS);
    this.aimDir.applyQuaternion(this._qTmp).normalize();
  }

  update(dt, input) {
    if (!this.alive) return;
    const b = this.body;

    // ---- throttle: bound keys + wheel; burner above 82% ----
    let thr = 0;
    if (input.down('throttleUp')) thr += 1;
    if (input.down('throttleDown')) thr -= 1;
    b.throttle = clamp(b.throttle + thr * dt * 0.55 + input.wheelDelta * 0.07, 0, 1);
    const burnerFrac = b.throttle > 0.82 ? (b.throttle - 0.82) / 0.18 : 0;
    b.burner = burnerFrac;
    this.boosting = burnerFrac > 0.1;
    if (input.pressed('camera')) this.viewMode = (this.viewMode + 1) % 3;

    // ---- controls: mouse aim instructor, or direct keyboard stick ----
    this.rotateAim(input.aimDX, input.aimDY);
    this._keyOverride = (input.down('rollLeft') ? 1 : 0) - (input.down('rollRight') ? 1 : 0);
    this._keyYaw = (input.down('rudderLeft') ? 1 : 0) - (input.down('rudderRight') ? 1 : 0);
    this._keyPitch = (input.down('pitchPull') ? 1 : 0) - (input.down('pitchPush') ? 1 : 0);

    const kbActive = this._keyOverride !== 0 || this._keyPitch !== 0;
    if (kbActive) {
      // view/aim lets go of the plane while the stick is worked manually
      b.ctl.pitch = this._keyPitch;
      b.ctl.roll = this._keyOverride;
      b.ctl.yaw = this._keyYaw;
      this.aimLocal = null;
    } else {
      b.aimAt(this.aimDir);
    }

    // ---- physics ----
    b.update(dt);

    // ---- sync render body + articulated surfaces ----
    this.obj.position.copy(b.pos);
    this.obj.quaternion.copy(b.quat);
    this.model.group.position.copy(b.pos);
    this.model.group.quaternion.copy(b.quat);
    if (this.model.setControlSurfaces) this.model.setControlSurfaces(b.ctl);

    // ---- terrain & limits ----
    const ground = Math.max(terrainHeightAt(b.pos.x, b.pos.z), SEA_LEVEL);
    if (b.pos.y < ground + GROUND_CLEAR_AGL) {
      this.applyDamage(999);
      this.crashed = true;
    }

    // ---- combat area warning ----
    const r = Math.hypot(b.pos.x, b.pos.z);
    this.outOfArea = r > COMBAT_RADIUS;
    this.outOfAreaTime = this.outOfArea ? this.outOfAreaTime + dt : 0;

    // ---- afterburner visual ----
    const abVis = this.boosting && b.airspeed > 200;
    for (const ab of this.model.afterburners) {
      ab.visible = abVis;
      if (abVis) {
        const s = 0.75 + Math.sin(performance.now() * 0.04) * 0.12 + (b.airspeed - 200) / 900;
        ab.scale.set(1, 1, s);
      }
    }

    this.hitFlash = Math.max(0, this.hitFlash - dt * 1.6);
    this.updateCamera(dt);
  }

  updateCamera(dt) {
    // view anchors to the AIM direction; camera rides the aim axis behind
    const dist = [9.5, 14.5, 26][this.viewMode];
    const hOff = [2.4, 3.8, 7.5][this.viewMode];
    const lag = [7, 5.5, 4.5][this.viewMode];

    const desired = this._vTmp.copy(this.aimDir).multiplyScalar(-dist).add(this.body.pos);
    desired.y += hOff;
    if (!this._camInit) { this.camPos.copy(desired); this._camInit = true; }
    this.camPos.x = damp(this.camPos.x, desired.x, lag, dt);
    this.camPos.y = damp(this.camPos.y, desired.y, lag, dt);
    this.camPos.z = damp(this.camPos.z, desired.z, lag, dt);
    const ground = Math.max(terrainHeightAt(this.camPos.x, this.camPos.z), SEA_LEVEL);
    if (this.camPos.y < ground + 4) this.camPos.y = ground + 4;

    if (!this._camDirInit) { this.camDir.copy(this.aimDir); this._camDirInit = true; }
    this.camDir.lerp(this.aimDir, 1 - Math.exp(-6 * dt)).normalize();

    this.upVec(this._v2);
    const upBlend = Math.abs(this.camDir.y) > 0.95 ? 1 : 0.3;
    const up = new THREE.Vector3(0, 1, 0).lerp(this._v2, upBlend).normalize();

    if (this.camShake > 0) {
      this.camShake = Math.max(0, this.camShake - dt * 2.2);
      const s = this.camShake * this.camShake * 0.9;
      this.camPos.x += (Math.random() - 0.5) * s;
      this.camPos.y += (Math.random() - 0.5) * s;
    }
    this.camera.position.copy(this.camPos);
    this.camera.up.copy(up);
    this.camLook.copy(this.camPos).addScaledVector(this.camDir, 100);
    this.camera.lookAt(this.camLook);
    const fovBase = [62, 66, 70][this.viewMode];
    const targetFov = fovBase + clamp((this.body.airspeed - 240) / 480, 0, 1) * 14;
    this.camera.fov = damp(this.camera.fov, targetFov, 3, dt);
    this.camera.updateProjectionMatrix();
  }

  get headingDeg() {
    const f = this.forward(this._vTmp);
    let h = Math.atan2(f.x, -f.z) * 180 / Math.PI;
    if (h < 0) h += 360;
    return h;
  }

  get bankDeg() {
    const y = this.body.rightVec(this._v2).y;
    return Math.asin(clamp(y, -1, 1)) * 180 / Math.PI;
  }
}
