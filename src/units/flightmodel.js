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
import { clamp, smoothstep } from '../core/utils.js';

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
const _dErr = new THREE.Vector3();   // aimAt: aim error ⊥ nose (world)
const _wRight = new THREE.Vector3(); // aimAt: world-horizontal right of nose
const _wUpD = new THREE.Vector3();   // aimAt: world-up projected ⊥ nose
const _upLift = new THREE.Vector3(); // aimAt: body-up axis (lift-plane sign)
const WORLD_UP = new THREE.Vector3(0, 1, 0);

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
    // lead-compensation state: previous body-frame aim errors and their
    // low-passed rates (aimAt)
    this._offHPrev = null;
    this._hDotF = 0;
    this._offVPrev = null;
    this._vDotF = 0;
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
    this._offHPrev = null; this._hDotF = 0;
    this._offVPrev = null; this._vDotF = 0;
    // fresh airframe: limiter back on, no departure state carried over
    this.fbwOn = true;
    this.spin = 0; this.spinT = 0; this.spinRec = 0; this._dep = 0;
    this.buffet = 0; this.stall = 0;
  }

  // ---- instructor: turn the nose toward a world aim direction with
  // bank-first-then-pull geometry, G- and AOA-limited. Writes ctl. ----
  // Channel frames are deliberately MIXED. The lateral channel is BODY-frame
  // (self-limiting geometry: as the plane banks into a lateral aim the error
  // projects into V, tapering the demand — a position feedback with no lag,
  // which is why this law is stable). The PITCH channel steers on the
  // WORLD-frame vertical error instead: at high bank the body-frame V is
  // largely the lateral slice seen through the rotating frame, and chasing
  // that contamination balloons the pitch channel, the unwind overshoots
  // through zero at the bank handoff, leaks into the lateral channel,
  // re-opens the error and re-banks the plane — arrive-in-stages, twice.
  // World-V kills the balloon at the source; a small position-driven slice
  // assist restores the pull's turn motor without any rate loop.
  aimAt(aimDir, dt = 1 / 60) {
    this.forward(_fwd);
    _qInv.copy(this.quat).invert();
    _aim.copy(aimDir).applyQuaternion(_qInv).normalize();
    const offH = _aim.x, offV = _aim.y;
    const mag = Math.hypot(offH, offV);
    const bankErr = this.rightVec(_right).y;   // + = banked left

    // world-frame aim error: the aim's offset along world-horizontal-right
    // and world-up, both projected perpendicular to the nose (pole fallback:
    // body axes for that frame). The VERTICAL one feeds the pitch channel —
    // at high bank the body-frame V is largely the lateral slice seen
    // through the rotating frame. The HORIZONTAL one feeds the slice assist
    // below — the body-frame H collapses into V at deep bank (the law's
    // built-in self-limiting), which would starve the assist exactly when
    // the turn needs its motor.
    _wRight.crossVectors(_fwd, WORLD_UP);
    let vErrW, hErrW;
    if (_wRight.lengthSq() > 1e-6) {
      _wRight.normalize();
      _wUpD.copy(WORLD_UP).addScaledVector(_fwd, -WORLD_UP.dot(_fwd)).normalize();
      _dErr.copy(aimDir).addScaledVector(_fwd, -aimDir.dot(_fwd));
      vErrW = _dErr.dot(_wUpD);
      hErrW = _dErr.dot(_wRight);
    } else {
      vErrW = offV;
      hErrW = offH;
    }

    // lead compensation: steer on the PREDICTED lateral error. The commanded
    // bank is proportional to the error, but the actual bank lags the command
    // by roll inertia — closing fast at 4-5°/s the nose sails PAST the aim,
    // every term flips sign, and the plane levels out and re-banks the other
    // way to come back (the classic arrive-in-stages). Feeding the near laws
    // H + Ḣ·τ_a collapses the bank command BEFORE the crossing, so wings
    // level exactly as the nose arrives — one motion. τ_a ramps with the
    // error scale: ZERO in the rudder/blend bands (their closures are short
    // and β-damped; even 0.12 s of lead pre-subtracts most of a fine-band
    // correction and leaves a crawl), full 0.45 s — the bank arrest time —
    // from ~6° out, where residual bank first carries enough rate to cross.
    // Raw Ḣ low-passed: buffet and single-frame mouse flicks must not spike
    // it. The far-field geometry (t-blend, atan2) keeps the raw error.
    let hDot = 0;
    if (this._offHPrev !== null && dt > 0) hDot = (offH - this._offHPrev) / dt;
    this._offHPrev = offH;
    this._hDotF += (hDot - this._hDotF) * Math.min(1, dt / 0.12);
    let offHL = offH + this._hDotF * 0.45 * smoothstep(0.03, 0.08, Math.abs(offH));
    // one-sided clamp: the lead may only CANCEL the command as the nose is
    // about to cross — never reverse it. A reversed predicted error commands
    // opposite bank mid-arrival and the plane wobbles wing-to-wing
    if (offH * offHL < 0) offHL = 0;
    // vertical-channel lead: at high bank the body-frame V is largely the
    // LATERAL slice seen through the rotating frame — the pitch law chasing
    // that contaminated signal couples into H and rings the arrival
    // (±3° V wobble re-opens H and re-banks the plane). Predicting V adds
    // damping to the handoff as the bank unwinds through 45°.
    let vDot = 0;
    if (this._offVPrev !== null && dt > 0) vDot = (vErrW - this._offVPrev) / dt;
    this._offVPrev = vErrW;
    this._vDotF += (vDot - this._vDotF) * Math.min(1, dt / 0.12);
    // gated like the lateral lead: only sizable V errors want the extra
    // damping — a small step's V left un-led keeps mid-size arrivals quick
    const offVL = vErrW + this._vDotF * 0.3 * smoothstep(0.04, 0.10, Math.abs(vErrW));

    // lift-plane sign: every PITCH command driven by the world-V error must
    // be read THROUGH the lift plane. Upright (body-up ≈ world-up) it is the
    // identity; inverted (body-up pointing at the ground) it FLIPS — an aim
    // below the world from inverted needs a hard pull (nose rolls under),
    // an aim above the world needs a push. tanh keeps the sign flip SMOOTH
    // through knife-edge (no stick jump rolling through 90° bank) while
    // staying ±1 outside a ~±20° band around it, so every upright-regime
    // gain is untouched.
    const liftSign = Math.tanh(this.upVec(_upLift).y * 3);
    const pullVL = offVL * liftSign;

    // wings-level gate: leveling must wait until the LATERAL error is gone.
    // Without it the leveler fires on total-magnitude alone and chops the
    // turn a few degrees short — wings level, pause, then small corrections
    // re-bank to close the rest (the classic arrive-in-stages feel).
    // Range kept TIGHT (±0.02 rad ≈ 1.1°): any wider and the leveler spends
    // its gain fighting the fine-aim bank commands — the old 0.05 range sat
    // permanently on top of every small correction and stretched the last
    // degree of pointing into a multi-second glide.
    const levelGate = clamp(1 - Math.abs(offHL) / 0.02, 0, 1);

    // rudder-first fine band: a fraction of a degree of lineup is a RUDDER
    // job — a boot-full pinches the nose across with the wings stayed level,
    // exactly like a real pilot's lineup correction. Bank-and-pull only
    // earns its efficiency past ~1.4° of offset. rW is the bank law's share:
    // 0 in the rudder band, 1 beyond, smooth in between. Judged on the RAW
    // error (band membership is where you ARE; the lead predicts where
    // you're GOING — mixing them lets a fast slice talk the bank law awake).
    const rW = smoothstep(0.006, 0.024, Math.abs(offH));

    let pitch, roll, yaw = 0;
    if (_aim.z > 0.25 && mag < 0.35) {
      // aim nearly behind the tail: roll hard and pull through the vertical
      roll = 1; pitch = 0.55;
    } else if (mag < 0.2 && offV < -0.04) {
      // aim just below the nose: pushing beats a 180 deg roll. Entry sits at
      // -2.3° on purpose: transient body-frame V dips that big happen while
      // a big lateral arrival unwinds (bank-projection geometry) and must
      // not hitch the law across branches mid-arrival. Lateral lineup
      // shares the rudder-first band with the main law (the old *1.2 with
      // zero rudder left this branch a lateral dead zone) — the aim DOES
      // park below the nose whenever the player dips the sight.
      roll = clamp(-offHL * 5 * rW - bankErr * 1.5 * levelGate, -0.7, 0.7);
      pitch = clamp(pullVL * 1.8, -0.5, 0);   // lift-signed: from inverted, below-BODY is a push
      yaw = clamp(-offHL * (2.0 + 16.0 * (1 - rW)) - this.beta * (2.0 - 1.5 * (1 - rW)), -0.3, 0.3);
    } else {
      // unified continuous law: near center the rudder points the nose
      // (wings held level), blending into the proportional-bank law by
      // ~1.4° off, then smoothly into the full bank-first pull-through
      // geometry by ~22° off. One formula — no dead zone, no snap.
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
      let phiNear = clamp(offHL * 14, -1.2, 1.2) * rW
        // slip-coordination mini-bank: a hard slice leaves the nose LEADING
        // the path (several ° of β) and the fine band then parks waiting for
        // the side force to walk the path over. Bank a couple of degrees
        // INTO the slip — the tilted lift turns the path 2-3× faster, like
        // a pilot centering the ball — fading out as β nulls.
        + clamp(-this.beta * 0.5, -0.06, 0.06) * (1 - rW);
      phi = phiNear * (1 - t) + phi * t;
      // near center the roll axis TRACKS the commanded bank (damps bank error
      // toward sin(phiNear), not toward zero): leveling toward wings-flat here
      // fought every fine-aim correction along the way. In the rudder band
      // phiNear IS zero, so this is the wings-leveler that keeps the fine
      // pointing a pure yaw affair; as the error closes, phiNear goes to zero
      // and wing leveling happens for free, never opposing the turn.
      roll = clamp(-phi * 1.4 - (bankErr + Math.sin(phiNear)) * 2.5 * (1 - t) * levelGate, -1, 1);
      // slice assist: at depth of bank a pull IS a lateral slice toward the
      // aim — the world-frame V channel no longer motors it, so restore the
      // pull's share from the WORLD azimuth error (stays full-size at deep
      // bank, unlike the body-frame H) times bank depth, only when the bank
      // is turned the way the error points. Position-driven and clamped:
      // it bleeds off with the error and runs no rate loop. The taper fades
      // it out through the last ~5°: pacing the ending to the coordinated
      // turn means the PATH arrives aligned with the nose — no β debt to
      // walk off after arrival (the old fast-slice arrival parked 0.3° out
      // for ten seconds waiting for the path).
      const slice = (hErrW * bankErr < 0)
        ? clamp(Math.abs(hErrW) * 1.2, 0, 0.35) * smoothstep(0.008, 0.09, Math.abs(hErrW))
          * Math.abs(bankErr) * t : 0;
      // lift-plane sign: the pull motor only sees the world-V error THROUGH
      // the lift plane. Inverted flight (body-up pointing at the ground)
      // flips which sign of world-V means "pull" — a below-world aim from
      // inverted needs a hard PULL (nose rolls under toward the aim), but
      // the raw max(0, offVL) gated it to the 0.08 floor, so the nose
      // barely chased the sight and the reticle drifted off-axis. At
      // knife-edge (body-up horizontal) the factor fades through zero
      // exactly where the slice assist takes over the turn motor.
      pitch = clamp(pullVL * 2.5, -0.3, 0.3) * (1 - t)
            + clamp(Math.max(0, pullVL) * 1.7, 0.08, 1) * t + slice;
      // fine-band rudder: pointing gain 18 (a 0.5° step closes in ~0.3 s at
      // ~0.6° peak sideslip). The β term is DAMPING here, not coordination —
      // at the bank law's 2.0 it over-damped and backed the rudder off,
      // parking the nose short of the aim (β/9 out) to wait for the path;
      // in the fine band holding a little β while the side force walks the
      // path over is exactly the point
      yaw = clamp((-offHL * (2.6 + 15.4 * (1 - rW)) - this.beta * (2.0 - 1.5 * (1 - rW))) * (1 - 0.75 * t), -0.3, 0.3);
    }

    // Pointing contract: the NOSE (= gun line) rides ON the aim; the flight
    // path settles α below it and the HUD flight-path marker shows that
    // honestly. (The old aim-vs-PATH slow trim tried to lift the path onto
    // the aim instead, but its ±0.01 rad clamp sat below the α-trim it was
    // fighting, so it railed permanently — parking the nose ~0.9° above the
    // aim AND routing cruise through the weak below-nose branch.)

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
