// player.js — arcade flight model (quaternion attitude, scalar speed) + chase camera
import * as THREE from 'three';
import { clamp, damp, lerp } from './utils.js';
import { buildJet } from './jet.js';
import { terrainHeightAt, SEA_LEVEL } from './terrain.js';

const MIN_SPEED = 110, MAX_SPEED = 560, BOOST_SPEED = 680;
const COMBAT_RADIUS = 14000;   // meters from world center

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

    this._qTmp = new THREE.Quaternion();
    this._eTmp = new THREE.Euler();
    this._vTmp = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this.camPos = new THREE.Vector3();
    this.camLook = new THREE.Vector3();
    this._camInit = false;
  }

  reset() {
    this.hp = 100;
    this.alive = true;
    this.outOfAreaTime = 0;
    this.hitFlash = 0;
    this.speed = 240;
    this.throttle = 0.65;
    this.obj.position.set(0, 2600, 9000);
    this.obj.quaternion.identity();
    this.obj.rotateY(Math.PI);          // face -Z (toward the island chain)
    this.obj.rotateZ(0);
    this.model.group.visible = true;
    this._camInit = false;
  }

  get position() { return this.obj.position; }
  get quaternion() { return this.obj.quaternion; }

  forward(out) { return out.set(0, 0, -1).applyQuaternion(this.obj.quaternion); }
  upVec(out) { return out.set(0, 1, 0).applyQuaternion(this.obj.quaternion); }

  applyDamage(amount) {
    if (!this.alive) return;
    this.hp -= amount;
    this.hitFlash = Math.min(1, this.hitFlash + amount / 45);
    this.camShake = Math.min(1.4, this.camShake + amount / 60);
    if (this.hp <= 0) { this.hp = 0; this.alive = false; }
  }

  update(dt, input, params) {
    if (!this.alive) return;
    const p = params;

    // ---- controls ----
    let pitchIn = 0, rollIn = 0, yawIn = 0;
    if (input.down('KeyW') || input.down('ArrowUp')) pitchIn -= 1;    // W = nose down (flight-stick push)? AC default: W pulls? Use W = nose up feels natural for arrows. Keep W = nose up.
    if (input.down('KeyS') || input.down('ArrowDown')) pitchIn += 1;
    if (input.down('KeyA') || input.down('ArrowLeft')) rollIn += 1;
    if (input.down('KeyD') || input.down('ArrowRight')) rollIn -= 1;
    if (input.down('KeyQ')) yawIn += 1;
    if (input.down('KeyE')) yawIn -= 1;
    pitchIn = clamp(pitchIn, -1, 1); rollIn = clamp(rollIn, -1, 1); yawIn = clamp(yawIn, -1, 1);

    if (input.down('ShiftLeft') || input.down('ShiftRight')) this.throttle += dt * 0.7;
    if (input.down('ControlLeft') || input.down('ControlRight')) this.throttle -= dt * 0.7;
    this.throttle = clamp(this.throttle, 0, 1);
    if (input.pressed('KeyC')) this.viewMode = (this.viewMode + 1) % 3;

    // ---- speed dynamics: thrust vs drag + gravity exchange ----
    const boosting = this.throttle > 0.82;
    const targetSpeed = lerp(MIN_SPEED, boosting ? BOOST_SPEED : MAX_SPEED, this.throttle);
    this.speed = damp(this.speed, targetSpeed, boosting ? 0.55 : 0.85, dt);
    // dive faster, climb slower
    this._vTmp.set(0, 0, -1).applyQuaternion(this.obj.quaternion);
    this.speed -= this._vTmp.y * 9.8 * dt * 1.35;
    this.speed = clamp(this.speed, 85, 720);

    // ---- attitude: local-space pitch/roll/yaw ----
    const spdFac = clamp((this.speed - 85) / 240, 0.25, 1);           // low speed = mushy controls
    const pitchRate = 1.25 * spdFac, rollRate = 3.0, yawRate = 0.42;
    const q = this._qTmp;
    this._eTmp.set(pitchIn * pitchRate * dt, yawIn * yawRate * dt, rollIn * rollRate * dt, 'XYZ');
    q.setFromEuler(this._eTmp);
    this.obj.quaternion.multiply(q);                                   // local-space compose
    this.obj.quaternion.normalize();

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
      this._eTmp.set(-0.12 * dt, 0, 0, 'XYZ'); q.setFromEuler(this._eTmp);
      this.obj.quaternion.multiply(q);
    }

    // ---- combat area warning ----
    const r = Math.hypot(this.obj.position.x, this.obj.position.z);
    this.outOfArea = r > COMBAT_RADIUS;
    this.outOfAreaTime = this.outOfArea ? this.outOfAreaTime + dt : 0;

    // ---- sync model ----
    this.model.group.position.copy(this.obj.position);
    this.model.group.quaternion.copy(this.obj.quaternion);
    // aileron-induced roll is in the physics quat already; add slight nose bob from pitch input
    this.model.group.rotateX(pitchIn * 0.0);

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
    this.updateCamera(dt, pitchIn, rollIn);
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
      desired.x += (Math.random() - 0.5) * s;
      desired.y += (Math.random() - 0.5) * s;
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
}
