// player.js — arcade flight model + War Thunder style mouse-aim (virtual instructor)
// The mouse position on screen becomes an aim point ~4 km out along the camera
// ray; an instructor steers pitch/roll/yaw to chase it, banking into turns and
// leveling the wings when the cursor recenters. A/D/Q/E remain manual overrides.
import * as THREE from 'three';
import { clamp, damp, lerp, smoothstep } from './utils.js';
import { buildJet } from './jet.js';
import { terrainHeightAt, SEA_LEVEL } from './terrain.js';

const MIN_SPEED = 110, MAX_SPEED = 560, BOOST_SPEED = 680;
const COMBAT_RADIUS = 14000;   // meters from world center
const AIM_DIST = 4000;         // draw/projection distance for the aim point
const AIM_SENS = 0.0013;       // rad per mouse px
const AIM_MAX_OFF = 70 * Math.PI / 180;   // aim clamped to 70 deg of camera boresight

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
    this.ctl = { pitch: 0, roll: 0, yaw: 0 };   // last instructor outputs (-1..1)
    this.aimDir = new THREE.Vector3(0, 0, -1);  // WORLD-ANCHORED aim direction
    this._keyOverride = 0;   // manual roll override (-1..1, while A/D held)
    this._keyYaw = 0;        // manual rudder (-1..1, while Q/E held)

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
    this._camInit = false;
  }

  reset() {
    this.hp = 100;
    this.alive = true;
    this.crashed = false;
    this.outOfAreaTime = 0;
    this.hitFlash = 0;
    this.speed = 240;
    this.throttle = 0.65;
    this.ctl = { pitch: 0, roll: 0, yaw: 0 };
    this.obj.position.set(0, 2600, 9000);
    this.obj.quaternion.identity();
    this.obj.rotateY(Math.PI);          // face -Z (toward the island chain)
    this.forward(this.aimDir);          // aim starts aligned with the nose
    this.model.group.visible = true;
    this._camInit = false;
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

    // clamp within AIM_MAX_OFF of the camera boresight (keeps the reticle on screen)
    this._vTmp.set(0, 0, -1).applyQuaternion(this.camera.quaternion); // camera fwd
    const d = this.aimDir.dot(this._vTmp);
    const minD = Math.cos(AIM_MAX_OFF);
    if (d < minD) this.aimDir.lerp(this._vTmp, (minD - d) / (1 - d)).normalize();
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
    } else {
      // bank toward the aim; the turn bias fades out near alignment so the
      // nose settles instead of limit-cycling around the aim direction
      const bias = Math.sign(offH) * 0.14 * smoothstep(0.06, 0.25, Math.abs(offH));
      rollIn = clamp(-offH * 2.2 - bias, -1, 1);
      pitchIn = clamp(offV * 2.2 + Math.abs(offH) * 0.8, -0.6, 1);
      yawIn = clamp(-offH * 0.4, -0.3, 0.3);
    }

    // manual overrides (keyboard authority while held)
    if (this._keyOverride !== 0) rollIn = this._keyOverride;
    yawIn = clamp(yawIn + this._keyYaw, -1, 1);
    this.ctl.pitch = pitchIn;
    this.ctl.roll = rollIn;
    this.ctl.yaw = yawIn;
    this.aimLocal = { x: Math.round(offH * 1000) / 1000, y: Math.round(offV * 1000) / 1000, z: Math.round(this._vTmp.z * 1000) / 1000 };

    // apply with the same rate authority as manual flight
    const spdFac = clamp((this.speed - 85) / 240, 0.3, 1);
    const e = this._eTmp.set(
      pitchIn * 1.3 * spdFac * dt,
      yawIn * 0.5 * dt,
      rollIn * 3.0 * dt, 'XYZ');
    this._qTmp.setFromEuler(e);
    this.obj.quaternion.multiply(this._qTmp).normalize();
  }

  update(dt, input, params) {
    if (!this.alive) return;

    // ---- throttle: W/S (+ Shift/Ctrl muscle memory) + mouse wheel ----
    let thr = 0;
    if (input.down('KeyW') || input.down('ShiftLeft') || input.down('ShiftRight')) thr += 1;
    if (input.down('KeyS') || input.down('ControlLeft') || input.down('ControlRight')) thr -= 1;
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
    this.instructor(dt);

    // ---- speed dynamics: thrust vs drag + gravity exchange ----
    const boosting = this.throttle > 0.82;
    const targetSpeed = lerp(MIN_SPEED, boosting ? BOOST_SPEED : MAX_SPEED, this.throttle);
    this.speed = damp(this.speed, targetSpeed, boosting ? 0.55 : 0.85, dt);
    this.forward(this._vTmp);
    this.speed -= this._vTmp.y * 9.8 * dt * 1.35;      // dive faster, climb slower
    this.speed = clamp(this.speed, 85, 720);

    // ---- integrate ----
    this.obj.position.addScaledVector(this._vTmp, this.speed * dt);

    // ---- terrain & limits ----
    const ground = Math.max(terrainHeightAt(this.obj.position.x, this.obj.position.z), SEA_LEVEL);
    if (this.obj.position.y < ground + 7) {
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
    const abVis = boosting && this.speed > 260;
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
    const offs = [
      new THREE.Vector3(0, 4.2, 17),    // chase
      new THREE.Vector3(0, 9, 34),      // far
      new THREE.Vector3(0, 2.1, 8.5),   // close
    ][this.viewMode];
    const desired = this._vTmp.copy(offs).applyQuaternion(this.obj.quaternion).add(this.obj.position);

    if (!this._camInit) { this.camPos.copy(desired); this._camInit = true; }
    const lag = this.viewMode === 2 ? 10 : 4.6;
    this.camPos.x = damp(this.camPos.x, desired.x, lag, dt);
    this.camPos.y = damp(this.camPos.y, desired.y, lag, dt);
    this.camPos.z = damp(this.camPos.z, desired.z, lag, dt);

    const look = this._v2.set(0, 1.6, -42).applyQuaternion(this.obj.quaternion).add(this.obj.position);
    if (!this._camInit) this.camLook.copy(look);
    else {
      this.camLook.x = damp(this.camLook.x, look.x, 12, dt);
      this.camLook.y = damp(this.camLook.y, look.y, 12, dt);
      this.camLook.z = damp(this.camLook.z, look.z, 12, dt);
    }

    // camera up: blend world up with jet up so banks read on screen
    this.upVec(this._vTmp);
    const upBlend = this.viewMode === 2 ? 0.85 : 0.5;
    const up = new THREE.Vector3(0, 1, 0).lerp(this._vTmp, upBlend).normalize();

    // shake
    if (this.camShake > 0) {
      this.camShake = Math.max(0, this.camShake - dt * 2.2);
      const s = this.camShake * this.camShake * 0.9;
      this.camPos.x += (Math.random() - 0.5) * s;
      this.camPos.y += (Math.random() - 0.5) * s;
    }
    this.camera.position.copy(this.camPos);
    this.camera.up.copy(up);
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
