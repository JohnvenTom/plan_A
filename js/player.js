// player.js — arcade flight model + War Thunder style mouse-aim (virtual instructor)
// The mouse position on screen becomes an aim point ~4 km out along the camera
// ray; an instructor steers pitch/roll/yaw to chase it, banking into turns and
// leveling the wings when the cursor recenters. A/D/Q/E remain manual overrides.
import * as THREE from 'three';
import { clamp, damp } from './utils.js';
import { GROUND_CLEAR_AGL } from './utils.js';
import { buildJet } from './jet.js';
import { terrainHeightAt, SEA_LEVEL } from './terrain.js';

const COMBAT_RADIUS = 14000;   // meters from world center
const AIM_DIST = 4000;         // draw/projection distance for the aim point
const AIM_SENS = 0.0013;       // rad per mouse px

// --- energy flight model (arcade but with real trade-offs) ---
const THRUST_MAX = 9.0;        // m/s^2 full dry throttle at sea level
const BURNER_EXTRA = 8.0;      // afterburner adds this much
const K_PARASITE = 2.96e-5;    // parasite drag: a = k * rho * v^2
const K_INDUCED = 2.2e4;       // induced drag:  a = k * G^2 / v^2 (capped)
const INDUCED_CAP = 25;        // m/s^2 cap so deep stalls stay recoverable
const G_CAP = 16;              // instructor G limit (arcade-high)
const ROLL_RATE = 4.5;         // rad/s at adequate speed (~258 deg/s)
const MIN_SPEED = 85, MAX_SPEED = 720;

export class Player {
  constructor(scene, camera) {
    this.scene = scene;
    this.camera = camera;
    this.model = buildJet({ paint: 0xa8b4c4, accent: 0x2e5fa3 });
    scene.add(this.model.group);

    this.obj = new THREE.Object3D();   // physics body (invisible)
    scene.add(this.obj);

    this.hp = 100;
    this.alive = true;
    this.viewMode = 0;               // 0 chase, 1 far, 2 close
    this.outOfAreaTime = 0;          // seconds spent beyond COMBAT_RADIUS
    this.hitFlash = 0;
    this.camShake = 0;
    this.gLoad = 1;                  // smoothed G (HUD + induced drag)
    this.boosting = false;
    this._lastFwd = new THREE.Vector3(0, 0, -1);
    this._lastFwdSet = false;
    this.ctl = { pitch: 0, roll: 0, yaw: 0 };   // last instructor outputs (-1..1)
    this.aimDir = new THREE.Vector3(0, 0, -1);  // WORLD-ANCHORED aim direction
    this._keyOverride = 0;   // manual roll override (-1..1, while A/D held)
    this._keyYaw = 0;        // manual rudder (-1..1, while Q/E held)
    this._keyPitch = 0;      // manual elevator (-1 push/dive, +1 pull/climb, W/S)
    this._phiSign = 1;       // remembered roll direction through the atan2 singularity

    this._qTmp = new THREE.Quaternion();
    this._qInv = new THREE.Quaternion();
    this._eTmp = new THREE.Euler();
    this._vTmp = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._aim = new THREE.Vector3();
    this._camRight = new THREE.Vector3();
    this._camUp = new THREE.Vector3();
    this._fwdTmp = new THREE.Vector3();
    this.camPos = new THREE.Vector3();
    this.camLook = new THREE.Vector3();
    this.camDir = new THREE.Vector3(0, 0, -1);   // damped view direction (chases aimDir)
    this._camInit = false;
    this._camDirInit = false;
  }

  reset() {
    this.hp = 100;
    this.alive = true;
    this.crashed = false;
    this.outOfAreaTime = 0;
    this.hitFlash = 0;
    this.speed = 240;
    this.throttle = 0.65;
    this.gLoad = 1;
    this._lastFwdSet = false;
    this.ctl = { pitch: 0, roll: 0, yaw: 0 };
    this.obj.position.set(0, 2600, 9000);
    this.obj.quaternion.identity();
    this.obj.rotateY(Math.PI);          // face -Z (toward the island chain)
    this.forward(this.aimDir);          // aim starts aligned with the nose
    this.model.group.visible = true;
    this._camInit = false;
    this._camDirInit = false;
  }

  get position() { return this.obj.position; }
  get quaternion() { return this.obj.quaternion; }

  forward(out) { return out.set(0, 0, -1).applyQuaternion(this.obj.quaternion); }
  upVec(out) { return out.set(0, 1, 0).applyQuaternion(this.obj.quaternion); }
  rightWingY() { return this._v2.set(1, 0, 0).applyQuaternion(this.obj.quaternion).y; }

  applyDamage(amount) {
    if (!this.alive) return;
    this.hp -= amount;
    this.hitFlash = Math.min(1, this.hitFlash + amount / 45);
    this.camShake = Math.min(1.4, this.camShake + amount / 60);
    if (this.hp <= 0) { this.hp = 0; this.alive = false; }
  }

  // world-space aim point (for HUD projection / debug)
  get aimPoint() {
    return this._aim.copy(this.aimDir).multiplyScalar(AIM_DIST).add(this.obj.position);
  }

  // ---- War Thunder mouse-aim: the aim direction is ANCHORED IN WORLD SPACE.
  // Mouse deltas rotate it in the camera frame; a stationary mouse leaves it
  // pinned to the world, so the nose CONVERGES onto it and then flies straight.
  rotateAim(dx, dy) {
    if (dx === 0 && dy === 0) return;
    this.camera.updateMatrixWorld();
    this._camRight.setFromMatrixColumn(this.camera.matrixWorld, 0).normalize();
    this._camUp.setFromMatrixColumn(this.camera.matrixWorld, 1).normalize();
    // mouse right -> aim right on screen; mouse up -> aim up
    this._qTmp.setFromAxisAngle(this._camUp, -dx * AIM_SENS);
    this.aimDir.applyQuaternion(this._qTmp);
    this._qTmp.setFromAxisAngle(this._camRight, -dy * AIM_SENS);
    this.aimDir.applyQuaternion(this._qTmp).normalize();
  }

  // ---- the virtual instructor: steer the nose toward the world-anchored aim ----
  instructor(dt) {
    this._vTmp.copy(this.aimDir);
    this._qInv.copy(this.obj.quaternion).invert();
    this._vTmp.applyQuaternion(this._qInv);                    // aim dir in plane space

    const offH = this._vTmp.x;      // + : aim to the right of the nose
    const offV = this._vTmp.y;      // + : aim above the nose
    const mag = Math.hypot(offH, offV);
    const bankErr = this.rightWingY();  // + : banked left

    let rollIn, pitchIn, yawIn = 0;
    if (this._vTmp.z > 0.25 && mag < 0.35) {
      // aim nearly behind the tail: roll hard and pull through the vertical
      rollIn = 1;
      pitchIn = 0.55;
    } else if (mag < 0.06) {
      // converged: level the wings; gentle rudder/pitch trims out the last deg
      rollIn = clamp(-bankErr * 2.0, -0.5, 0.5);
      pitchIn = clamp(offV * 2.0, -0.25, 0.25);
      yawIn = clamp(-offH * 0.9, -0.22, 0.22);
    } else if (mag < 0.2 && offV < -0.02) {
      // aim just below the nose: pushing down is cheaper than a 180 deg roll
      rollIn = clamp(-bankErr * 1.5, -0.4, 0.4);
      pitchIn = clamp(offV * 1.8, -0.5, 0);
    } else {
      // WT instructor: ROLL FIRST, THEN PULL.
      // Roll nulls the aim's bearing from plane-up (atan2(offH, offV)), which
      // puts the aim directly "above" the nose in the plane frame; then a pure
      // pull sweeps the nose onto it along the lift circle. NO rudder in the
      // turn — stepping into it skids the nose and worsens the drift.
      let phi;
      if (offV < 0 && Math.abs(offH) < 0.04) {
        phi = (this._phiSign || 1) * Math.PI;   // hold roll direction through the singularity
      } else {
        this._phiSign = offH >= 0 ? 1 : -1;
        phi = Math.atan2(offH, offV);
      }
      rollIn = clamp(-phi * 1.4, -1, 1);
      // pull only as the aim comes "above" the nose (offV): while rolling,
      // offV ~ 0 -> almost no pull; once aligned it ramps in. This is the
      // roll-FIRST-then-pull geometry and keeps the nose from sliding past.
      pitchIn = clamp(Math.max(0, offV) * 1.6, 0.08, 1);
      yawIn = 0;
    }

    // manual overrides (keyboard authority while held)
    if (this._keyOverride !== 0) rollIn = this._keyOverride;
    if (this._keyPitch !== 0) pitchIn = this._keyPitch;
    yawIn = clamp(yawIn + this._keyYaw, -1, 1);
    this.ctl.pitch = pitchIn;
    this.ctl.roll = rollIn;
    this.ctl.yaw = yawIn;
    this.aimLocal = { x: Math.round(offH * 1000) / 1000, y: Math.round(offV * 1000) / 1000, z: Math.round(this._vTmp.z * 1000) / 1000 };

    // apply with speed-dependent authority:
    //  - pitch is G-limited (fast planes turn wide) and mushy when slow
    //  - roll is fast, tapering only near stall
    //  - a deep stall pushes the nose down gently
    const mush = clamp((this.speed - 90) / 130, 0.3, 1);
    const maxPitch = Math.min(1.35 * mush, G_CAP * 9.81 / Math.max(this.speed, 120));
    const maxRoll = ROLL_RATE * clamp(this.speed / 160, 0.55, 1);
    const maxYaw = 0.5 * mush;
    let stallDrop = 0;
    if (this.speed < 125) stallDrop = (125 - this.speed) * 0.012;
    const e = this._eTmp.set(
      pitchIn * maxPitch * dt - stallDrop * dt,
      yawIn * maxYaw * dt,
      rollIn * maxRoll * dt, 'XYZ');
    this._qTmp.setFromEuler(e);
    this.obj.quaternion.multiply(this._qTmp).normalize();
  }

  update(dt, input, params) {
    if (!this.alive) return;

    // ---- throttle: Shift/Ctrl (+ mouse wheel); W/S are the stick ----
    let thr = 0;
    if (input.down('ShiftLeft') || input.down('ShiftRight')) thr += 1;
    if (input.down('ControlLeft') || input.down('ControlRight')) thr -= 1;
    this.throttle = clamp(this.throttle + thr * dt * 0.55 + input.wheelDelta * 0.07, 0, 1);
    if (input.pressed('KeyC')) this.viewMode = (this.viewMode + 1) % 3;

    // ---- attitude: world-anchored mouse aim + keyboard overrides ----
    this.rotateAim(input.aimDX, input.aimDY);
    this._keyOverride = 0;
    if (input.down('KeyA') || input.down('ArrowLeft')) this._keyOverride = 1;
    if (input.down('KeyD') || input.down('ArrowRight')) this._keyOverride = -1;
    this._keyYaw = 0;
    if (input.down('KeyQ')) this._keyYaw = 1;
    if (input.down('KeyE')) this._keyYaw = -1;
    this._keyPitch = 0;                       // W = push (dive), S = pull (climb)
    if (input.down('KeyW') || input.down('ArrowUp')) this._keyPitch = -1;
    if (input.down('KeyS') || input.down('ArrowDown')) this._keyPitch = 1;
    this.instructor(dt);

    // ---- speed dynamics: energy model ----
    // thrust falls with air density; parasite drag grows with v^2; induced
    // drag grows with G^2/v^2 (hard pulls BLEED speed); gravity trades with
    // climb/dive. Boost flag drives the afterburner visuals.
    const density = 1 - clamp(this.obj.position.y / 15000, 0, 1) * 0.6;
    const burnerFrac = this.throttle > 0.82 ? (this.throttle - 0.82) / 0.18 : 0;
    this.boosting = burnerFrac > 0.1;
    const thrust = (this.throttle * this.throttle * THRUST_MAX + burnerFrac * BURNER_EXTRA) * density;
    this.forward(this._vTmp);
    // G-load from the actual nose rotation this frame (1 G baseline)
    const angVel = this._lastFwdSet ? this._lastFwd.angleTo(this._vTmp) / Math.max(dt, 1e-4) : 0;
    this.gLoad = damp(this.gLoad, 1 + angVel * this.speed / 9.81, 6, dt);
    this._lastFwd.copy(this._vTmp);
    this._lastFwdSet = true;
    const v2 = Math.max(10000, this.speed * this.speed);
    const induced = Math.min(K_INDUCED * this.gLoad * this.gLoad / v2, INDUCED_CAP);
    const drag = K_PARASITE * density * this.speed * this.speed + induced;
    this.speed += (thrust - drag - 9.81 * this._vTmp.y) * dt;
    this.speed = clamp(this.speed, MIN_SPEED, MAX_SPEED);

    // ---- integrate ----
    this.obj.position.addScaledVector(this._vTmp, this.speed * dt);

    // ---- terrain & limits ----
    const ground = Math.max(terrainHeightAt(this.obj.position.x, this.obj.position.z), SEA_LEVEL);
    if (this.obj.position.y < ground + GROUND_CLEAR_AGL) {
      this.applyDamage(999);   // crash
      this.crashed = true;
    }
    if (this.obj.position.y > 11500) {
      this.obj.position.y = 11500;
      this._eTmp.set(-0.12 * dt, 0, 0, 'XYZ');
      this._qTmp.setFromEuler(this._eTmp);
      this.obj.quaternion.multiply(this._qTmp);
    }

    // ---- combat area warning ----
    const r = Math.hypot(this.obj.position.x, this.obj.position.z);
    this.outOfArea = r > COMBAT_RADIUS;
    this.outOfAreaTime = this.outOfArea ? this.outOfAreaTime + dt : 0;

    // ---- sync model + articulated control surfaces ----
    this.model.group.position.copy(this.obj.position);
    this.model.group.quaternion.copy(this.obj.quaternion);
    if (this.model.setControlSurfaces) {
      this.model.setControlSurfaces(this.ctl);
    }

    // afterburner visual
    const abVis = this.boosting && this.speed > 260;
    for (const ab of this.model.afterburners) {
      ab.visible = abVis;
      if (abVis) {
        const s = 0.75 + Math.sin(performance.now() * 0.04) * 0.12 + (this.speed - 260) / 900;
        ab.scale.set(1, 1, s);
      }
    }

    this.hitFlash = Math.max(0, this.hitFlash - dt * 1.6);
    this.updateCamera(dt);
  }

  updateCamera(dt) {
    // WT third-person: the view anchors to the AIM (mouse) direction, not the
    // nose. The camera sits back along the aim axis so the jet stays near
    // screen center while it chases; the horizon stays mostly level and the
    // jet banks on screen. Orientation is damped so the reticle leads the
    // swing slightly instead of being glued to screen center.
    const dist = [17, 34, 8.5][this.viewMode];
    const hOff = [4.2, 9, 2.1][this.viewMode];

    const desired = this._vTmp.copy(this.aimDir).multiplyScalar(-dist).add(this.obj.position);
    desired.y += hOff;                       // world-up offset, horizon stays readable
    if (!this._camInit) { this.camPos.copy(desired); this._camInit = true; }
    const lag = this.viewMode === 2 ? 10 : 5.5;
    this.camPos.x = damp(this.camPos.x, desired.x, lag, dt);
    this.camPos.y = damp(this.camPos.y, desired.y, lag, dt);
    this.camPos.z = damp(this.camPos.z, desired.z, lag, dt);
    // keep the camera out of the ground / ocean
    const ground = Math.max(terrainHeightAt(this.camPos.x, this.camPos.z), SEA_LEVEL);
    if (this.camPos.y < ground + 4) this.camPos.y = ground + 4;

    if (!this._camDirInit) { this.camDir.copy(this.aimDir); this._camDirInit = true; }
    this.camDir.lerp(this.aimDir, 1 - Math.exp(-6 * dt)).normalize();

    // up: mostly world up with a hint of jet roll (full jet-up only if aiming
    // straight up/down, where world up degenerates)
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
    const fovBase = this.viewMode === 2 ? 74 : 66;
    const targetFov = fovBase + clamp((this.speed - 240) / 480, 0, 1) * 14;
    this.camera.fov = damp(this.camera.fov, targetFov, 3, dt);
    this.camera.updateProjectionMatrix();
  }

  get headingDeg() {
    const f = this.forward(this._vTmp);
    let h = Math.atan2(f.x, -f.z) * 180 / Math.PI;   // 0 = -Z (north)
    if (h < 0) h += 360;
    return h;
  }

  get bankDeg() {
    return Math.asin(clamp(this.rightWingY(), -1, 1)) * 180 / Math.PI; // + = banked left
  }
}
