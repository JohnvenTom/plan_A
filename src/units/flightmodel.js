// flightmodel.js — full-aerodynamics rigid flight body, shared by player and
// enemies. Control surfaces produce TORQUES (angular accelerations), rotation
// carries inertia and aerodynamic damping; velocity is an independent 3-D
// vector, so angle of attack and sideslip emerge naturally and lift acts
// perpendicular to the airflow.
// Past the stall the model goes honest: lift collapses steeply, the airframe
// buffets, one wing drops (asymmetric stall), and a deep departure charges
// into a recoverable steep spin — or the near-unrecoverable flat spin. A
// togglable FBW soft-AOA limiter (player: F key) keeps limiter-on flight
// inside the envelope; there is no speed floor.
//
// Body frame: X right, Y up, Z backward (forward = -Z), matching the jet model.
// omega is the body-frame angular rate: {x: pitch (+nose up), y: yaw (+nose
// left), z: roll (+roll left)}.
import * as THREE from 'three';
import { clamp } from '../core/utils.js';

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
export const CORNER_SPEED_KMH = 1000;   // max-G speed design spec (sea level)
// corner speed at the CURRENT altitude (km/h): the G-limit / alpha-limit
// crossing rises as air density falls — 1000 at sea level, ~1066 @ 3 km
export function cornerSpeedKMH(alt) {
  const rho = 1 - clamp(alt / 15000, 0, 1) * 0.6;
  const q = G_LIMIT * G0 / (KA * CLA * ALPHA_MAX);
  return Math.round(Math.sqrt(2 * q / Math.max(rho, 0.1)) * 3.6 / 10) * 10;
}

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

    // FBW soft-AOA limiter (soft cap + pusher). Player-togglable with F;
    // enemies keep it on — their protection lives in aimAt, this is the
    // airframe-side backstop that keeps limiter-on flight mushy but upright.
    this.fbwOn = true;
    this.buffet = 0;       // 0..1 airframe buffet (pre-stall onset -> full)
    // departure / spin state machine: 0 upright, 1 steep spin, 2 flat spin
    this.spin = 0;
    this.spinDir = 1;      // signed rotation (+ = roll/yaw left)
    this.spinT = 0;        // seconds in the spin
    this.spinRec = 0;      // 0..1 recovery progress (HUD draws the bar)
    this._dep = 0;         // accumulated departure charge
    this._bias = 0;        // wing-drop asymmetry bias (slow OU re-roll)
    this._biasTarget = 0;
    this._biasT = 0;
    this._bt = 0;          // buffet noise timebase

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
    // fresh airframe: limiter back on, no departure state carried over
    this.fbwOn = true;
    this.spin = 0; this.spinT = 0; this.spinRec = 0; this._dep = 0;
    this.buffet = 0; this.stall = 0;
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

    // G / AOA protection — the INSTRUCTOR's own envelope sense, one layer
    // above the airframe FBW. Enemies keep fbwOn permanently so the AI is
    // always protected; a player who switches the limiter off also frees
    // the instructor to pull into a real departure (relinquish below then
    // takes over once the stall is deep).
    if (this.fbwOn) {
      const aAllow = clamp(G_LIMIT * G0 / Math.max(1, this.q * KA * CLA), 0.02, ALPHA_MAX);
      if (this.alpha > aAllow * 1.15) pitch = Math.min(pitch, -0.15);
      else if (this.alpha > aAllow) pitch = Math.min(pitch, 0.12);
    }

    // deep-stall / spin RELINQUISHMENT: a departed plane cannot be steered
    // onto an aim point — chasing it means pulling deeper into the stall.
    // The instructor hands off: fixed gentle push in a spin, and in a deep
    // stall a push is honored while pulls pass only partially (the mouse IS
    // the pilot's hand — holding it up keeps the mush deep, exactly like a
    // real pilot freezing the stick aft). Roll/rudder go neutral so the
    // natural dynamics (and the player's Q/E/W keys, which bypass aimAt
    // entirely in player.js) own the recovery.
    if (this.spin) {
      this.ctl.pitch = -0.25; this.ctl.roll = 0; this.ctl.yaw = 0;
      return;
    }
    if (this.stall > 0.35) {
      this.ctl.pitch = clamp(offV * 1.8, -1, 0.35);
      this.ctl.roll = 0;
      this.ctl.yaw = 0;
      return;
    }

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

    // --- aero coefficients with steep post-stall collapse ---
    // Past ALPHA_MAX the lift falls through ~35% within 10 deg and bottoms
    // out near zero: a departed wing carries almost nothing, so the nose
    // stops flying long before any recovery moment can hold it up.
    const a = this.alpha, aa = Math.abs(a);
    let CL = CLA * a;
    this.stall = 0;
    if (aa > ALPHA_MAX) {
      const ex = Math.min(aa - ALPHA_MAX, 0.7);
      CL = Math.sign(a) * CLA * ALPHA_MAX * Math.max(0.12, 1 - ex * 3.2);
      this.stall = clamp(ex / 0.5, 0, 1);
    }
    // buffet: onset at ~82% of stall AOA (the real pre-stall warning), full
    // authority in the stall itself — drives moments, camera and audio
    this.buffet = this.spin ? 1
      : Math.min(1, clamp((aa - ALPHA_MAX * 0.82) / (ALPHA_MAX * 0.18), 0, 1) * 0.55 + this.stall * 0.45);

    // --- wing-drop asymmetry: slow random bias + sideslip coupling ---
    // Re-rolled every few seconds (OU-relaxed toward the target) so each
    // departure drops a different wing; sideslip adds a deterministic lean.
    this._biasT -= h;
    if (this._biasT <= 0) {
      this._biasTarget = Math.random() * 2 - 1;
      this._biasT = 2 + Math.random() * 2;
    }
    this._bias += (this._biasTarget - this._bias) * Math.min(1, h / 1.5);

    // --- departure / spin state machine ---
    // Charge builds while deeply stalled AND rotating/slipping; relaxes
    // when unstalled. Past the threshold the plane departs: steep spin by
    // default, or the near-unrecoverable FLAT spin when slip is large and
    // the energy window is right (the F-14 easter egg).
    if (!this.spin) {
      // threshold below the sustained-stall line so alpha wobble (the
      // buffet) cannot dump the charge between dips; decay is slow for the
      // same reason — departures build over SECONDS of abuse, not frames
      if (this.stall > 0.30) {
        this._dep += (Math.abs(this.omega.z) * 0.5 + Math.abs(this.beta) * 3.0
          + Math.abs(this._bias) * 0.8) * this.stall * h * 1.2;
      } else {
        this._dep = Math.max(0, this._dep - h * 0.35);
      }
      if (this._dep > 1.6 && this.airspeed < 170) {
        // flat-spin gate: deep stall, low energy, AND extreme slip at the
        // departure instant — rare on purpose (a plain mush or wing-drop
        // departure stays steep); this is the near-unrecoverable F-14
        // easter egg branch
        this.spin = (this.stall > 0.75 && this.airspeed < 110
                     && Math.abs(this.beta) > 0.45) ? 2 : 1;
        this.spinDir = this.omega.z >= 0 ? 1 : -1;
        this.spinT = 0; this.spinRec = 0; this._dep = 0;
      }
    }

    // spin drag: flat spin presents the whole wing planform to the flow
    // (terminal sink ~80 m/s); steep spin is slimmer but still dirty
    const spinCD = this.spin === 2 ? 0.85 : this.spin ? 0.25 : 0;
    const CD = CD0 + KIND * CL * CL + this.stall * 0.15 + spinCD;
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

    // --- moments ---
    if (this.spin) {
      // Spin dynamics: body rates are attracted to a scripted rotation
      // target (steep: roll-dominated with the nose slicing around the
      // helix; flat: yaw-dominated, nose hung high) while the force model
      // above keeps the sink honest. Recovery = anti-spin RUDDER held
      // against the rotation with the stick unloaded/pushed — it buys
      // progress that arrests the spin. Flat spins barely respond (the
      // F-14 easter egg: entry needs big slip deep in the stall).
      this.spinT += h;
      const flat = this.spin === 2;
      const tx = flat ? -0.10 : 0.35,                                    // pitch rate
                ty = flat ? this.spinDir * 1.05 : this.spinDir * 0.6,    // yaw rate
                tz = flat ? this.spinDir * 0.75 : this.spinDir * 2.2;    // roll rate
      const anti = -this.spinDir * this.ctl.yaw;     // >0 when rudder opposes the rotation
      const relax = this.ctl.pitch < 0.35;           // stick unloaded or pushed
      const rate = flat ? 0.055 : 0.85;
      if (anti > 0.35 && relax) this.spinRec = Math.min(1, this.spinRec + h * rate * (0.5 + anti * 0.5));
      else if (relax && anti > -0.15)
        // hands off: a steep spin winds down by itself (the nose falls
        // through); a flat one barely does — that is the point of it
        this.spinRec = Math.min(1, this.spinRec + h * (flat ? 0.02 : 0.25));
      else this.spinRec = Math.max(0, this.spinRec - h * 0.35);
      const rec = 1 - this.spinRec * (flat ? 0.4 : 0.9);
      const k = 1 - Math.exp(-h * (flat ? 1.6 : 2.2));
      this.omega.x += (tx * rec - this.omega.x) * k;
      this.omega.y += (ty * rec - this.omega.y) * k;
      this.omega.z += (tz * rec - this.omega.z) * k;
      // exits: rotation arrested by the recovery, or the nose fell through
      // the stall AND the rotation is genuinely decayed — a still-spinning
      // plane dips through low alpha once per turn; that alone must not
      // read as recovered (this is what used to let flat spins slip out)
      if ((this.spinRec >= 1 && Math.abs(this.omega.z) < 0.5)
        || (this.alpha < 0.26 && V > 150 && Math.abs(this.omega.z) < 0.5)) {
        this.spin = 0;
        this.omega.z *= 0.4;
      }
    } else {
      // stick torques + stability + damping. Control authority scales with
      // dynamic pressure (soft when slow); stability and damping keep a
      // floor so a mushing plane still responds and noses down.
      const qCtl = clamp(this.q / Q_REF, 0.05, 1.4);
      const qStab = clamp(this.q / 8000, 0.25, 1.4);
      // stalled surfaces blank out (roll/elevator hit hardest; the rudder
      // keeps the most — it blows in the slipstream and IS the recovery
      // surface)
      const auth = qCtl * this.power * (1 - this.stall * 0.8);
      const authY = qCtl * this.power * (1 - this.stall * 0.45);
      const aExcess = Math.max(0, aa - 0.30);
      // FBW soft-AOA protection (togglable): applies to ANY input source,
      // SYMMETRIC in AOA. Past ~13 deg the elevator drives back toward the
      // airflow with a guaranteed authority floor. NO speed floor — with
      // the limiter on this keeps hard pulls mushy but upright; switched
      // off (player F key) the departure physics above take over.
      let pitchCmd = this.ctl.pitch;
      if (this.fbwOn) {
        if (this.alpha > 0.19 && pitchCmd > 0.15) pitchCmd = 0.15;
        if (this.alpha < -0.19 && pitchCmd < -0.15) pitchCmd = -0.15;
        if (this.alpha > 0.24) pitchCmd = Math.min(pitchCmd, -0.3 - (this.alpha - 0.24) * 5);
        if (this.alpha < -0.24) pitchCmd = Math.max(pitchCmd, 0.3 + (-this.alpha - 0.24) * 5);
      }
      let dwx = Math.max(qCtl, 0.3) * this.power * PITCH_POWER * pitchCmd
              - qStab * (K_ALPHA * (this.alpha - ALPHA_TRIM)
                         + CX_DAMP * (1 + this.stall * 2) * this.omega.x)   // stall-rated damping: the AOA limiter must be well damped or the nose limit-cycles around the airflow
              - this.stall * 1.4
              - aExcess * 2.6;
      // fin and rudder partially blank in the stall: the weathervane fades
      // and sideslip is allowed to GROW (departed planes fly crooked)
      let dwy = authY * YAW_POWER * this.ctl.yaw
              - qStab * (K_BETA * (1 - this.stall * 0.55) * this.beta
                         + CY_DAMP * (1 - this.stall * 0.35) * this.omega.y);
      let dwz = auth * ROLL_POWER * this.ctl.roll
              - qStab * CZ_DAMP * (1 - this.stall * 0.55) * this.omega.z;
      // unsteady buffet: smooth multi-frequency wobble on all three axes,
      // scaled by buffet depth — the airframe shudders before it departs
      if (this.buffet > 0.02) {
        const t2 = (this._bt += h);
        dwx += this.buffet * 2.6 * (Math.sin(t2 * 27.3) * 0.6 + Math.sin(t2 * 61.7 + 1.7) * 0.4);
        dwy += this.buffet * 1.1 * (Math.sin(t2 * 19.9 + 3.1) * 0.7 + Math.sin(t2 * 44.3) * 0.3);
        dwz += this.buffet * 4.0 * (Math.sin(t2 * 33.1 + 0.6) * 0.6 + Math.sin(t2 * 71.3 + 2.2) * 0.4);
      }
      // asymmetric stall: the wing-drop bias plus sideslip lean the plane
      // over while it is stalled — wing drop and a slice of nose yaw
      if (this.stall > 0.02) {
        const slip = Math.tanh(this.beta * 5);
        dwz += this.stall * (4.2 * this._bias + 1.8 * slip);
        dwy += this.stall * 0.8 * slip;
      }
      this.omega.x = clamp(this.omega.x + dwx * h, -2.4, 2.4);
      // yaw clamp widened: a flat spin yaw-rates past the old +-1.0 limit
      this.omega.y = clamp(this.omega.y + dwy * h, -2.2, 2.2);
      this.omega.z = clamp(this.omega.z + dwz * h, -6.5, 6.5);
    }

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
