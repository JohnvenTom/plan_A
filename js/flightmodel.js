// flightmodel.js — full-aerodynamics rigid flight body, shared by player and
// enemies. Control surfaces produce TORQUES (angular accelerations), rotation
// carries inertia and aerodynamic damping; velocity is an independent 3-D
// vector, so angle of attack and sideslip emerge naturally and lift acts
// perpendicular to the airflow.
//
// Body frame: X right, Y up, Z backward (forward = -Z), matching the jet model.
// omega is the body-frame angular rate: {x: pitch (+nose up), y: yaw (+nose
// left), z: roll (+roll left)}.
import * as THREE from 'three';
import { clamp } from './utils.js';

// --- atmosphere & aero coefficients (accelerations fold area/mass into KA) ---
const G0 = 9.81;
const KA = 0.00299;        // force factor: a_lift = q * KA * CL (tuned so the
                          // G-limit / alpha-limit crossing — the corner speed —
                          // lands at exactly 1000 km/h at sea level)
const CLA = 5.2;           // lift-curve slope per rad
const ALPHA_MAX = 15 * Math.PI / 180;   // stall angle
const ALPHA_TRIM = 1.5 * Math.PI / 180; // hands-off trim AOA (level cruise)
const CD0 = 0.026;         // parasite drag coefficient
const KIND = 0.12;         // induced drag: CD += KIND * CL^2
const CSIDE = 0.25;        // sideslip side-force coefficient
const PITCH_POWER = 4.2;   // rad/s^2 elevator authority at reference q
const ROLL_POWER = 20.0;
const YAW_POWER = 1.6;
const K_ALPHA = 1.15;      // pitch stability: nose seeks trim AOA
const K_BETA = 1.25;       // weathervane: nose seeks the airflow
const CX_DAMP = 2.0, CY_DAMP = 2.4, CZ_DAMP = 4.2;   // rate damping
const Q_REF = 26000;       // dynamic pressure at ~240 m/s sea-adjacent
const G_LIMIT = 16;
export const CORNER_SPEED_KMH = 1000;   // max-G speed (design spec)

const _qInv = new THREE.Quaternion();
const _vb = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();
const _velDir = new THREE.Vector3();
const _liftDir = new THREE.Vector3();
const _acc = new THREE.Vector3();
const _dq = new THREE.Quaternion();
const _axis = new THREE.Vector3();
const _aim = new THREE.Vector3();

export class FlightBody {
  constructor(opts = {}) {
    this.pos = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.vel = new THREE.Vector3(0, 0, -240);
    this.omega = new THREE.Vector3();        // body rates (rad/s)
    this.ctl = { pitch: 0, roll: 0, yaw: 0 }; // stick -1..1
    this.throttle = 0.65;
    this.burner = 0;                          // 0..1 afterburner fraction
    this.thrustMax = opts.thrustMax ?? 9.0;
    this.burnerExtra = opts.burnerExtra ?? 8.0;
    this.power = opts.power ?? 1;             // authority multiplier (enemy agility)

    // flight state (refreshed each update)
    this.airspeed = 240;
    this.alpha = 0;        // AOA (rad, + = airflow from below)
    this.beta = 0;         // sideslip (rad, + = flow from right)
    this.q = Q_REF;        // dynamic pressure
    this.gLoad = 1;        // lift G
    this.stall = 0;        // 0..1 stall depth
    this.rho = 1;

    // instructor hysteresis through the atan2 singularity
    this._phiSign = 1;
    this._eUpF = 0;      // slow path-trim filter state (aim-vs-path vertical)
  }

  forward(out) { return out.set(0, 0, -1).applyQuaternion(this.quat); }
  upVec(out) { return out.set(0, 1, 0).applyQuaternion(this.quat); }
  rightVec(out) { return out.set(1, 0, 0).applyQuaternion(this.quat); }
  get speed() { return this.airspeed; }

  setState(pos, heading, speed) {
    this.pos.copy(pos);
    this.quat.identity();
    this.quat.setFromAxisAngle(_axis.set(0, 1, 0), heading);
    this.forward(_fwd);
    this.vel.copy(_fwd).multiplyScalar(speed);
    this.omega.set(0, 0, 0);
    this.ctl = { pitch: 0, roll: 0, yaw: 0 };
  }

  // ---- instructor: turn the nose toward a world aim direction with
  // bank-first-then-pull geometry, G- and AOA-limited. Writes ctl. ----
  aimAt(aimDir, dt = 1 / 60) {
    _qInv.copy(this.quat).invert();
    _aim.copy(aimDir).applyQuaternion(_qInv).normalize();
    const offH = _aim.x, offV = _aim.y;
    const mag = Math.hypot(offH, offV);
    const bankErr = this.rightVec(_right).y;   // + = banked left

    // wings-level gate: leveling must wait until the LATERAL error is gone.
    // Without it the leveler fires on total-magnitude alone and chops the
    // turn a few degrees short — wings level, pause, then small corrections
    // re-bank to close the rest (the classic arrive-in-stages feel).
    const levelGate = clamp(1 - Math.abs(offH) / 0.05, 0, 1);

    let pitch, roll, yaw = 0;
    if (_aim.z > 0.25 && mag < 0.35) {
      // aim nearly behind the tail: roll hard and pull through the vertical
      roll = 1; pitch = 0.55;
    } else if (mag < 0.2 && offV < -0.02) {
      // aim just below the nose: pushing beats a 180 deg roll
      roll = clamp(-offH * 1.2 - bankErr * 1.5 * levelGate, -0.4, 0.4);
      pitch = clamp(offV * 1.8, -0.5, 0);
    } else {
      // unified continuous law: near center the commanded bank is PROPORTIONAL
      // to the offset (gentle bank + rudder cleanup, wings-level damping),
      // blending smoothly into the full bank-first pull-through geometry by
      // ~22° off. One formula — no dead zone, no snap at the old 3.4° gate.
      let phi;
      if (offV < 0 && Math.abs(offH) < 0.04) {
        phi = this._phiSign * Math.PI;
      } else {
        this._phiSign = offH >= 0 ? 1 : -1;
        // offV floor: just-below-nose aims must not demand >90° banks nearby
        phi = Math.atan2(offH, Math.max(offV, 0.035));
      }
      const s = clamp((mag - 0.03) / 0.25, 0, 1);
      const t = s * s * (3 - 2 * s);              // 0 at center → 1 at ~17° off:
                                                  // proportional bank takes over
                                                  // early enough to bleed turn
                                                  // rate before arrival (no
                                                  // overshoot-bounce)
      phi = clamp(offH * 5, -1.2, 1.2) * (1 - t) + phi * t;
      roll = clamp(-phi * 1.4 - bankErr * 2.5 * (1 - t) * levelGate, -1, 1);
      pitch = clamp(offV * 2.5, -0.3, 0.3) * (1 - t)
            + clamp(Math.max(0, offV) * 1.7, 0.08, 1) * t;
      yaw = clamp((-offH * 1.2 - this.beta * 2.0) * (1 - 0.75 * t), -0.3, 0.3);
    }

    // slow path trim: a nose-referenced law settles into a permanent glide
    // (nose on the aim, path sagging a couple of degrees below it). This
    // low-passed aim-vs-PATH term trims that DC bias out; the clamp keeps it
    // to trim scale so it can never fight a real maneuver.
    if (this.vel.lengthSq() > 1600) _velDir.copy(this.vel).normalize();
    else this.forward(_velDir);
    const eUp = aimDir.y - _velDir.y * aimDir.dot(_velDir);
    this._eUpF = clamp(this._eUpF + (eUp - this._eUpF) * Math.min(1, dt / 1.2), -0.01, 0.01);
    pitch = clamp(pitch + 4.0 * this._eUpF, -1, 1);

    // G / AOA protection: cap the pull so lift stays inside the limit
    const aAllow = clamp(G_LIMIT * G0 / Math.max(1, this.q * KA * CLA), 0.02, ALPHA_MAX);
    if (this.alpha > aAllow * 1.15) pitch = Math.min(pitch, -0.15);
    else if (this.alpha > aAllow) pitch = Math.min(pitch, 0.12);

    this.ctl.pitch = clamp(pitch, -1, 1);
    this.ctl.roll = clamp(roll, -1, 1);
    this.ctl.yaw = clamp(yaw, -1, 1);
  }

  // ---- one physics step (two substeps for rotational stability) ----
  update(dt) {
    const sub = 2, h = dt / sub;
    for (let s = 0; s < sub; s++) this.step(h);
  }

  step(h) {
    this.forward(_fwd);
    this.upVec(_up);
    this.rightVec(_right);

    // --- airflow in body frame ---
    const V = this.vel.length();
    this.airspeed = V;
    _qInv.copy(this.quat).invert();
    _vb.copy(this.vel).applyQuaternion(_qInv);
    const u = Math.max(15, -_vb.z);           // forward airspeed (guarded)
    this.alpha = Math.atan2(-_vb.y, u);
    this.beta = Math.atan2(_vb.x, u);

    this.rho = 1 - clamp(this.pos.y / 15000, 0, 1) * 0.6;
    this.q = 0.5 * this.rho * V * V;

    // --- aero coefficients with soft post-stall decay ---
    const a = this.alpha, aa = Math.abs(a);
    let CL = CLA * a;
    this.stall = 0;
    if (aa > ALPHA_MAX) {
      const ex = Math.min(aa - ALPHA_MAX, 0.7);
      CL = Math.sign(a) * CLA * ALPHA_MAX * Math.max(0.4, 1 - ex * 0.85);
      this.stall = clamp(ex / 0.5, 0, 1);
    }
    const CD = CD0 + KIND * CL * CL + this.stall * 0.15;
    this.gLoad = this.q * KA * CL / G0;

    // --- forces (as accelerations; mass folded into coefficients) ---
    const thrust = (this.throttle * this.throttle * this.thrustMax + this.burner * this.burnerExtra) * this.rho;
    _velDir.copy(V > 1 ? this.vel : _fwd).divideScalar(Math.max(V, 1));
    _liftDir.copy(_right).cross(_velDir).normalize();
    _acc.set(0, -G0, 0)
      .addScaledVector(_fwd, thrust)
      .addScaledVector(_liftDir, this.q * KA * CL)
      .addScaledVector(_velDir, -this.q * KA * CD)
      .addScaledVector(_right, -this.q * KA * CSIDE * this.beta);
    this.vel.addScaledVector(_acc, h);

    // --- moments: stick torques + stability + damping. Control authority
    //     scales with dynamic pressure (soft when slow), but stability and
    //     damping keep a floor — a stalling plane must still respond and nose
    //     down. A soft AOA limiter prevents deep departure beyond ~17 deg. ---
    const qCtl = clamp(this.q / Q_REF, 0.05, 1.4);
    const qStab = clamp(this.q / 8000, 0.25, 1.4);
    const auth = qCtl * this.power * (1 - this.stall * 0.65);
    const aExcess = Math.max(0, aa - 0.30);
    // --- FBW soft-AOA protection: applies to ANY input source (stick or
    //     instructor), SYMMETRIC in AOA. Past ~13 deg the elevator drives
    //     back toward the airflow with a guaranteed authority floor. A
    //     low-speed pusher (stick shaker/pusher) trades altitude for airspeed
    //     before the energy bleeds to a departure — together they keep stalls
    //     mushy and recoverable, never a tumble. ---
    let pitchCmd = this.ctl.pitch;
    if (this.alpha > 0.19 && pitchCmd > 0.15) pitchCmd = 0.15;
    if (this.alpha < -0.19 && pitchCmd < -0.15) pitchCmd = -0.15;
    if (this.alpha > 0.24) pitchCmd = Math.min(pitchCmd, -0.3 - (this.alpha - 0.24) * 5);
    if (this.alpha < -0.24) pitchCmd = Math.max(pitchCmd, 0.3 + (-this.alpha - 0.24) * 5);
    if (V < 150) {
      const t = clamp((150 - V) / 55, 0, 1);
      pitchCmd = Math.min(pitchCmd, -0.25 - t * 0.6);
    }
    let dwx = Math.max(qCtl, 0.3) * this.power * PITCH_POWER * pitchCmd
            - qStab * (K_ALPHA * (this.alpha - ALPHA_TRIM)
                       + CX_DAMP * (1 + this.stall * 2) * this.omega.x)   // stall-rated damping: the AOA limiter must be well damped or the nose limit-cycles around the airflow
            - this.stall * 2.4
            - aExcess * 8.0;
    let dwy = auth * YAW_POWER * this.ctl.yaw
            - qStab * (K_BETA * this.beta + CY_DAMP * this.omega.y);
    let dwz = auth * ROLL_POWER * this.ctl.roll
            - qStab * CZ_DAMP * this.omega.z;
    this.omega.x = clamp(this.omega.x + dwx * h, -2.4, 2.4);
    this.omega.y = clamp(this.omega.y + dwy * h, -1.0, 1.0);
    this.omega.z = clamp(this.omega.z + dwz * h, -6.5, 6.5);

    // --- integrate attitude (body rates apply as local rotation) ---
    const w = this.omega.length();
    if (w > 1e-5) {
      _axis.copy(this.omega).divideScalar(w);
      _dq.setFromAxisAngle(_axis, w * h);
      this.quat.multiply(_dq).normalize();
    }

    // --- integrate position ---
    this.pos.addScaledVector(this.vel, h);
  }
}
