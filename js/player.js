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
    this.viewMode = 1;               // 0 near, 1 mid (default), 2 far
    this.outOfAreaTime = 0;
    this.hitFlash = 0;
    this.camShake = 0;
    this.boosting = false;
    this.aimDir = new THREE.Vector3(0, 0, -1);  // WORLD-ANCHORED aim direction
    this._flAim = new THREE.Vector3(0, 0, -1);  // chase target frozen at C-press
    this._flWasHeld = false;
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
    this.lookYaw = 0;        // free-look offsets (C held)
    this.lookPitch = 0;
    this.zoomed = false;     // Z toggles magnification
    this._zoomK = 0;         // smoothed 0..1 zoom-boom factor (camera pull-back)
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

  // hot-swap the visual (procedural jet → F-14 GLB once it finishes loading);
  // keeps the current transform and visibility so it is safe mid-flight
  swapModel(m) {
    if (!m || !m.group || m === this.model) return;
    const old = this.model;
    this.scene.remove(old.group);
    this.model = m;
    m.group.position.copy(old.group.position);
    m.group.quaternion.copy(old.group.quaternion);
    m.group.visible = old.group.visible;
    this.scene.add(m.group);
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

  // stall / departure warning state: limiter-fighting AOA (past the FBW soft
  // cap, into the hard-cap zone), actual post-stall departure, or the
  // low-speed pusher regime — any of these flashes the HUD warning
  get stalling() {
    const b = this.body;
    return this.alive && (b.stall > 0.05 || b.alpha > 0.22 || b.airspeed < 155);
  }

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
    // zoomed-in aiming scales down with the FOV so the sight stays steady
    const sens = AIM_SENS * clamp(this.camera.fov / 66, 0.25, 1.2);
    dx = dx * (sens / AIM_SENS); dy = dy * (sens / AIM_SENS);
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

    // ---- mouse: free look (C held) orbits the camera, and the world-
    //      anchored aim is PINNED to the free view's screen center (set in
    //      the camera block once viewDir is built) — the sight swings
    //      anywhere the view goes, beyond the 120° envelope included, while
    //      the jet holds its heading. Locking still requires the target
    //      inside the envelope (see weapons.headLockAttempt). On release the
    //      camera returns and the nose resumes chasing the aim. ----
    this._freeLook = input.down('freeLook');
    if (this._freeLook && !this._flWasHeld) {
      // C press: freeze the CHASE TARGET, not the stick — the instructor
      // keeps steering toward where the sight pointed at the press, so the
      // maneuver in progress continues smoothly. (Freezing the ctl itself
      // would turn steady-flight's small converging corrections into a
      // constant deflection and the jet would wobble all over the sky.)
      this._flAim.copy(this.aimDir);
    }
    this._flWasHeld = this._freeLook;
    if (input.pressed('zoom')) this.zoomed = !this.zoomed;
    if (this._freeLook) {
      const sens = AIM_SENS * clamp(this.camera.fov / 66, 0.25, 1.2);
      this.lookYaw -= input.aimDX * sens;
      // the pitch orbit axis is camera-LEFT (viewDir × up, negated), so the
      // stick sign runs opposite the yaw axis — += keeps mouse-up = look-up
      this.lookPitch = clamp(this.lookPitch + input.aimDY * sens, -1.5, 1.5);
    } else {
      this.rotateAim(input.aimDX, input.aimDY);
    }

    this._keyOverride = (input.down('rollLeft') ? 1 : 0) - (input.down('rollRight') ? 1 : 0);
    this._keyYaw = (input.down('rudderLeft') ? 1 : 0) - (input.down('rudderRight') ? 1 : 0);
    this._keyPitch = (input.down('pitchPull') ? 1 : 0) - (input.down('pitchPush') ? 1 : 0);

    const kbActive = this._keyOverride !== 0 || this._keyPitch !== 0 || this._keyYaw !== 0;
    if (this._freeLook && !kbActive) {
      // C held: keep chasing the aim point frozen at the press — the turn in
      // progress completes naturally and steady flight stays steady, while
      // the sight is fully decoupled from the flight path
      b.aimAt(this._flAim, dt);
      this.aimLocal = null;
    } else if (kbActive) {
      // view/aim lets go of the plane while the stick is worked manually
      b.ctl.pitch = this._keyPitch;
      b.ctl.roll = this._keyOverride;
      b.ctl.yaw = this._keyYaw;
      this.aimLocal = null;
    } else {
      b.aimAt(this.aimDir, dt);
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
    // view anchors to the AIM direction; camera rides the aim axis behind.
    // Free-look (C held) adds yaw/pitch offsets on top and orbits the camera
    // around the jet; releasing springs the offsets back to zero.
    // F-14 framing: ~30% further back than the old procedural jet (longer,
    // bulkier airframe fills the frame at the legacy distances).
    // V mode changes EASE between rigs (~0.4 s dolly) instead of snapping:
    // only the rig scalars are damped — the camera still sits exactly on the
    // view axis every frame, so the rigid-orbit no-cut-through guarantee holds
    const distT = [12.5, 17.5, 30][this.viewMode];
    const hOffT = [3.1, 4.9, 9.8][this.viewMode];
    const fovT = [62, 66, 70][this.viewMode];
    if (this._vDist === undefined) { this._vDist = distT; this._vHOff = hOffT; this._vFov = fovT; }
    this._vDist = damp(this._vDist, distT, 6, dt);
    this._vHOff = damp(this._vHOff, hOffT, 6, dt);
    this._vFov = damp(this._vFov, fovT, 6, dt);
    const dist = this._vDist, hOff = this._vHOff;
    // Z zoom boom: pull back+up along the view axis so the bubble canopy drops
    // below the gunsight line; damped at the FOV's rate for one smooth motion
    this._zoomK = damp(this._zoomK, this.zoomed ? 1 : 0, 6, dt);
    const boom = 1 + 0.6 * this._zoomK;
    const lift = 1.5 * this._zoomK;
    const lag = this._freeLook ? 12 : [7, 5.5, 4.5][this.viewMode];

    if (!this._freeLook) {
      this.lookYaw = damp(this.lookYaw, 0, 10, dt);
      this.lookPitch = damp(this.lookPitch, 0, 10, dt);
    }

    if (!this._camDirInit) { this.camDir.copy(this.aimDir); this._camDirInit = true; }
    // frozen while free-looking: the view rides the look offsets alone, so
    // the pinned aim and the view never feed back into each other
    if (!this._freeLook) this.camDir.lerp(this.aimDir, 1 - Math.exp(-6 * dt)).normalize();

    // view direction = followed aim rotated by the free-look offsets
    const viewDir = this._vTmp.copy(this.camDir);
    if (this.lookYaw !== 0) {
      this._qTmp.setFromAxisAngle(this._v2.set(0, 1, 0), this.lookYaw);
      viewDir.applyQuaternion(this._qTmp).normalize();
    }
    if (this.lookPitch !== 0) {
      this._v2.crossVectors(viewDir, new THREE.Vector3(0, 1, 0)).normalize().negate(); // camera right
      this._qTmp.setFromAxisAngle(this._v2, this.lookPitch);
      viewDir.applyQuaternion(this._qTmp).normalize();
    }
    // the sight IS the free view's screen center — it may point anywhere,
    // well outside the 120° envelope; locking stays envelope-gated
    if (this._freeLook) this.aimDir.copy(viewDir).normalize();

    // NOTE: viewDir lives in _vTmp — use _v2 for the desired position so the
    // view direction is not mutated before lookAt uses it.
    // RIGID ORBIT (WT-style): the camera sits exactly on the view axis behind
    // the jet every frame. Smoothing comes from camDir/freeLook themselves —
    // damping the POSITION in world space would cut a straight line through
    // the jet on big swings and throw it out of frame.
    const desired = this._v2.copy(viewDir).multiplyScalar(-dist * boom).add(this.body.pos);
    desired.y += hOff + lift;
    this.camPos.copy(desired);
    const ground = Math.max(terrainHeightAt(this.camPos.x, this.camPos.z), SEA_LEVEL);
    if (this.camPos.y < ground + 4) this.camPos.y = ground + 4;

    this.upVec(this._v2);
    // camera never rolls with the plane (level horizon); the jet's up is only
    // used as a fallback when the view points near straight up/down
    const upBlend = Math.abs(viewDir.y) > 0.95 ? 1 : 0;
    const up = new THREE.Vector3(0, 1, 0).lerp(this._v2, upBlend).normalize();

    if (this.camShake > 0) {
      this.camShake = Math.max(0, this.camShake - dt * 2.2);
      const s = this.camShake * this.camShake * 0.9;
      this.camPos.x += (Math.random() - 0.5) * s;
      this.camPos.y += (Math.random() - 0.5) * s;
    }
    this.camera.position.copy(this.camPos);
    this.camera.up.copy(up);
    this.camLook.copy(this.camPos).addScaledVector(viewDir, 100);
    this.camera.lookAt(this.camLook);
    const targetFov = this.zoomed ? 22 : this._vFov + clamp((this.body.airspeed - 240) / 480, 0, 1) * 14;
    this.camera.fov = damp(this.camera.fov, targetFov, 6, dt);
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
