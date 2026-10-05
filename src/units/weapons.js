// weapons.js — guns (tracer pool + segment collision) and lock-on homing missiles
//
// TWO missile flight models, picked on the start page (weapons.setMode):
//  'arcade' — the classic kinematics: constant boost to a scripted max speed,
//    fixed turn rate, velocity glued to the body axis. Sealed as-is.
//  'real'   — energy-managed point mass: true velocity vector, motor
//    boost/sustain/burnout, drag k*rho*v^2 in the shared atmosphere, gravity,
//    PN guidance (N=4 + 1G bias) clamped by a dynamic-pressure-scaled G limit,
//    rail-rigid dead time, carrier-velocity inheritance, low-speed self-destruct.
//    IR seekers add the blind-state machine: decoyed/cone-broken shots coast on
//    an extrapolated ghost of the target, then re-open on pure heat sources
//    (aircraft AND burning flares) every 0.5 s until they bite or die.
//    Radar rounds broken by a pure beam/mask (no chaff) go ACTIVE: a short
//    blind, then the same 0.5 s re-scan loop on a wider/longer cone — only
//    a chaff-sealed break is permanent (the IR/RADAR counterplay differs:
//    hold the beam or escape the cone vs. make the break stick).
import * as THREE from 'three';
import { clamp } from '../core/utils.js';
import { AIRCRAFT_HIT_R, MISSILE_FUSE_R } from '../core/utils.js';
import { terrainSurfaceAt, SEA_LEVEL } from '../world/terrain.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _r = new THREE.Vector3();      // real mode: LOS vector
const _vr = new THREE.Vector3();     // real mode: relative velocity
const _om = new THREE.Vector3();     // real mode: LOS rotation rate
const _ac = new THREE.Vector3();     // real mode: lateral accel command
const _tp = new THREE.Vector3();     // real mode: apparent aim point
const ZERO = new THREE.Vector3();
const ALT_UP = new THREE.Vector3(0, 0, 1);   // lookAt fallback near vertical flight
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);

// seeker warmup machine (both kinds): cold --(SPACE/ALT)--> warming (0.7 s)
// --(auto)--> hot (8 s hold window) --> cold. ALT is the ONLY cancel.
const MSL_WARM_TIME = 0.7;
export { MSL_WARM_TIME };
const MSL_HOT_WINDOW = 8.0;
// 120° front cone (±60° off the FUSELAGE axis, not the sight): radar locks
// hold only inside it, IR shots may only leave the rail inside it.
// Lock/bite ACQUISITION still requires the ±8° head-sight basket.
const ENV_DOT = Math.cos(60 * Math.PI / 180);
const CONE_GRACE = 2;                               // s outside the envelope before the lock drops
const BASKET_DOT = Math.cos(8 * Math.PI / 180);   // head-sight basket ±8°
// the head-sight lock is a RADAR lock for BOTH kinds — 20 km acquire/hold;
// for IR missiles the radar lock is nothing but a guidance source (the
// seeker keeps its own shorter heat-source detection range)
const LOCK_RANGE = 20000;
const SEEKER_RANGE = 5200;                        // IR seeker heat detection
const AMMO_REGEN = { ir: 5.5, radar: 8 };         // s per missile, per pool

// ---------- realistic-mode bodies (B calibration) ----------
// boost/sustain thrust (m/s^2) and durations, drag factor k (a_drag = k*rho*v^2
// in the SAME atmosphere the jets fly), rated G with the dynamic-pressure
// reference speed (full authority at vRef, ~25% at half speed, floored),
// rail-rigid dead time, hard ttl. Sea-level figures: an IR round launched hot
// (M1.5 carrier) burns out near 1000 m/s; the radar round sustains ~900 m/s at
// sea level and ~1200 m/s up high; the AA wall round equilibrates at ~1369.
const PN_N = 4;                                   // proportional navigation constant
const G0 = 9.81;
const CONE_DOT = Math.cos(35 * Math.PI / 180);    // IR seeker cone (+/-35 deg)
const HEAT_RANGE = 6000;                          // re-open scan range (real IR)
const RESCAN_T = 0.5;                             // searching re-open period
const LOW_SPD = 140;                              // burnt-out brick threshold
const REAL_BODIES = {
  ir:    { boost: 240, boostT: 2.4, sus: 0,   susT: 0,  k: 7.9e-5, gRate: 40, vRef: 300, gFloor: 0.12, rigid: 0.3, ttl: 15 },
  radar: { boost: 220, boostT: 3.2, sus: 81,  susT: 6,  k: 1.0e-4, gRate: 30, vRef: 350, gFloor: 0.12, rigid: 0.6, ttl: 30 },
  aa:    { boost: 320, boostT: 4.0, sus: 150, susT: 12, k: 8.0e-5, gRate: 70, vRef: 300, gFloor: 0.20, rigid: 0.5, ttl: 40 },
};
// enemy rounds fly the same bodies ~50 m/s slower at burnout and 15% less G
function realSpec(kind, fromPlayer) {
  const s = REAL_BODIES[kind];
  if (fromPlayer || kind === 'aa') return s;
  return { ...s, boost: (s.boost * s.boostT - 50) / s.boostT, gRate: s.gRate * 0.85 };
}

// a guidance target counts only while it is a LIVE body: enemies flag death
// with dying/dead, the player with alive, flares with neither (they die by
// leaving flareList). A corpse that sets only one convention — notably the
// 70% instant kill (dead without dying) — must not hold locks or steer
// missiles into orbit around its frozen position.
function liveTarget(t) {
  return !!t && !t.dying && !t.dead && t.alive !== false;
}

function tracerMaterial() {
  return new THREE.MeshBasicMaterial({
    color: 0xffc866, transparent: true, opacity: 0.95,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
}

function buildMissileMesh(scene) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.16, 0.16, 2.6, 6),
    new THREE.MeshStandardMaterial({ color: 0xd8dde2, roughness: 0.5, metalness: 0.3 })
  );
  body.rotation.x = Math.PI / 2;
  g.add(body);
  const tip = new THREE.Mesh(
    new THREE.ConeGeometry(0.16, 0.55, 6),
    new THREE.MeshStandardMaterial({ color: 0x8f2f22, roughness: 0.6 })
  );
  tip.rotation.x = -Math.PI / 2;
  tip.position.z = -1.55;
  g.add(tip);
  for (const s of [1, -1]) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.05, 0.5),
      new THREE.MeshStandardMaterial({ color: 0x8f2f22 }));
    fin.position.z = 1.0;
    fin.rotation.z = s * Math.PI / 4;
    g.add(fin);
  }
  g.visible = false;
  g.traverse(o => { o.frustumCulled = false; });
  scene.add(g);
  return g;
}

export class Weapons {
  constructor(scene, effects) {
    this.scene = scene;
    this.effects = effects;
    this.audio = null;               // wired by main
    this.mode = 'arcade';            // 'arcade' | 'real' — set by main at launch

    // player state — split missile pools: 6 IR light AAMs, 4 radar rounds
    this.ammo = { ir: 6, radar: 4 };
    this.ammoMax = { ir: 6, radar: 4 };
    this.ammoRegen = { ir: 0, radar: 0 };
    this.gunHeat = 0;
    this.lockState = { target: null, locked: false };
    this.mslKind = 'ir';       // selected missile type: 'ir' | 'radar' (R key)
    this.manualTarget = null;  // X-key head-sight lock target (instant)
    // seeker warmup: 'cold' | 'warming' (t counts up to 1 s) | 'hot' (t = window left)
    this.warm = { state: 'cold', t: 0 };
    this.irSeek = null;        // IR seeker bite: nearest heat source in basket
    this.lockConeDot = null;   // lock target's nose-cone dot (HUD edge warning)
    this.hitLog = [];         // damage-direction log for the HUD threat flashes:
                              // {dir (world, from player), kind: gun|msl|near, t}
    this.seekConeDot = null;   // IR bite's nose-cone dot
    this.guideConeDot = null;  // current guidance-relevant cone dot (HUD)
    this.hud = null;           // wired by main (transient hint line)
    this.flares = 90;          // regenerating countermeasure stock
    this.flareRegenT = 0;
    this.flareList = [];       // live flare entities (decoy IR seekers)
    this.chaffList = [];       // live chaff clouds  (decoy radar seekers)

    this.rounds = [];                // tracers (both sides)
    this.missiles = [];
    this.events = [];                // {type:'crit'} drained by main -> HUD popup
    this.inboundWarning = false;
    this.inboundDir = new THREE.Vector3();

    // tracer pool — 0.42 m core is sub-pixel past ~300 m at 1080p, which
    // reads as rounds hitting an invisible wall; the update loop widens the
    // cross-section with distance so the stream stays visible out to burnout
    this.tracerPool = [];
    const tracerGeo = new THREE.BoxGeometry(0.42, 0.42, 17);
    this.tracerMatP = tracerMaterial();
    this.tracerMatE = tracerMaterial(); this.tracerMatE.color.setHex(0xff7040);
    // push both over 1.0 so the bloom pass catches them (distant rounds glow
    // instead of aliasing away to nothing)
    this.tracerMatP.color.multiplyScalar(1.7);
    this.tracerMatE.color.multiplyScalar(1.7);
    for (let i = 0; i < 90; i++) {
      const m = new THREE.Mesh(tracerGeo, this.tracerMatP);
      m.visible = false;
      m.frustumCulled = false;
      m.layers.set(1);   // FX layer: drawn over clouds, depth-tested vs opaque
      scene.add(m);
      this.tracerPool.push(m);
    }
    // missile pool
    this.missilePool = [];
    for (let i = 0; i < 30; i++) this.missilePool.push(buildMissileMesh(scene));
  }

  reset() {
    this.gunHeat = 0;
    this.lockState = { target: null, locked: false };
    this.flares = 90;
    this.flareRegenT = 0;
    this.flareList.length = 0;
    this.chaffList.length = 0;
    this.mslKind = 'ir';
    this.manualTarget = null;
    this.warm = { state: 'cold', t: 0 };
    this.irSeek = null;
    this.lockConeDot = null;
    this.seekConeDot = null;
    this.guideConeDot = null;
    for (const k of Object.keys(this.ammo)) {
      this.ammo[k] = this.ammoMax[k];
      this.ammoRegen[k] = 0;
    }
    for (const r of this.rounds) this.freeTracer(r.mesh);
    for (const ms of this.missiles) this.freeMissile(ms);
    this.rounds.length = 0;
    this.missiles.length = 0;
    this.events.length = 0;
  }

  freeTracer(mesh) { mesh.visible = false; mesh.scale.set(1, 1, 1); }
  freeMissile(ms) { ms.mesh.visible = false; ms.mesh.scale.setScalar(1); }

  // flight-model switch, called once per mission start (main.js); live rounds
  // carry the flag they launched with
  setMode(m) { this.mode = m === 'real' ? 'real' : 'arcade'; }

  // ---------- guns ----------
  fireGun(origin, dir, speed, fromPlayer, dmg, spread) {
    const mesh = this.tracerPool.find(m => !m.visible);
    if (!mesh) return;
    mesh.material = fromPlayer ? this.tracerMatP : this.tracerMatE;
    mesh.visible = true;
    const d = dir.clone();
    if (spread > 0) {
      d.x += (Math.random() - 0.5) * spread;
      d.y += (Math.random() - 0.5) * spread;
      d.z += (Math.random() - 0.5) * spread;
      d.normalize();
    }
    this.rounds.push({
      pos: origin.clone(),
      prev: origin.clone(),
      vel: d.multiplyScalar(speed),
      life: 1.4,
      fromPlayer, dmg,
      mesh,
    });
    this.effects.spawn(this.effects.add, {
      pos: origin, life: 0.05,
      c0: [3, 2.2, 0.9], c1: [1.5, 0.6, 0.1], s0: 4, s1: 1.5,
    });
    if (this.audio) this.audio.gun(fromPlayer);
  }

  playerGun(player, dt, firing, enemies) {
    if (this.gunHeat > 0) this.gunHeat = Math.max(0, this.gunHeat - dt * 0.55);
    if (!firing || this.gunHeat >= 1 || !player.alive) return;
    this.gunCooldown = (this.gunCooldown ?? 0) - dt;
    if (this.gunCooldown > 0) return;
    this.gunCooldown = 1 / 15;
    this.gunHeat = Math.min(1, this.gunHeat + 0.028);
    const fwd = player.forward(new THREE.Vector3());
    const origin = player.position.clone().addScaledVector(fwd, 11).add(new THREE.Vector3(0, -0.4, 0));
    this.fireGun(origin, fwd, 1080 + player.speed, true, 5, 0.006);
    player.camShake = Math.min(player.camShake + 0.06, 0.35);
  }

  enemyGun(enemy, player) {
    if (Math.random() < 0.35) return;   // per-frame gate -> ~9 rps
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(enemy.quaternion);
    const origin = enemy.position.clone().addScaledVector(fwd, 10);
    const aim = player.position.clone()
      .addScaledVector(player.vel, player.speed > 0 ? 0.4 : 0)
      .sub(origin).normalize();
    this.fireGun(origin, aim, 950 + enemy.speed, false, 3, 0.016);
  }

  // ---- countermeasures: drop n flares from owner, roll decoy per flare ----
  // ---- countermeasures: one press, auto-matched payload. Ejected DOWNWARD
  // from belly dispensers (alternating left/right) with full aircraft
  // velocity inheritance plus a pyrotechnic kick along body-down — the
  // realistic throw. Flares decoy IR seekers, chaff clouds decoy nothing
  // directly (they widen the radar notch window). ----
  deployFlares(owner, n) {
    const isPlayer = owner === this.playerRef;
    if (isPlayer) {
      n = Math.min(n, this.flares);
      if (n <= 0) return 0;
      this.flares -= n;
    }
    const fwd = owner.forward(new THREE.Vector3());
    const down = owner.upVec(new THREE.Vector3()).multiplyScalar(-1);
    const right = new THREE.Vector3().crossVectors(fwd, down).normalize();
    for (let i = 0; i < n; i++) {
      // alternate dispensers under the left/right rear fuselage
      const side = (this._cmSide = !this._cmSide) ? 1 : -1;
      const pos = owner.position.clone().addScaledVector(fwd, 2.5).addScaledVector(right, side * 1.1);
      pos.addScaledVector(down, 1.4);
      const kick = 18 + Math.random() * 10;
      const vel = owner.vel.clone()
        .addScaledVector(down, kick)
        .addScaledVector(right, side * (2 + Math.random() * 4));
      this.flareList.push({ pos, vel, life: 0, ttl: 2.6, owner, rollT: 0.55, rolls: 2, kind: 'ir', emitT: 0, isFlare: true });
      // chaff: lighter bundles — same downward throw, ejected slightly apart
      const cvel = vel.clone().addScaledVector(down, 4 + Math.random() * 4);
      this.chaffList.push({ pos: pos.clone().addScaledVector(right, side * 0.4), vel: cvel, life: 0, ttl: 3.2, owner, rollT: 0.55, rolls: 0, kind: 'radar', emitT: 0 });
    }
    if (this.audio && isPlayer) this.audio.flare();
    return this._rollDecoys(owner, n, 'ir');
  }

  // n independent decoy rolls against missiles of the given KIND homing on
  // the owner — flares seduce IR seekers, chaff seduces radar seekers
  _rollDecoys(owner, n, kind) {
    let decoyed = 0;
    const fwd = owner.forward(_v3);
    for (const ms of this.missiles) {
      if (ms.kind !== kind) continue;
      if (ms.target !== owner || ms.blind > 0) continue;
      if (ms.pos.distanceTo(owner.position) > 1800) continue;
      const aspect = _v2.copy(ms.pos).sub(owner.position).normalize().dot(fwd);
      const p = aspect > 0.5 ? 0.9 : aspect < -0.5 ? 0.2 : 0.5;
      for (let i = 0; i < n; i++) {
        if (Math.random() < p) {
          this._breakLock(ms, 1.8);
          decoyed++;
          break;
        }
      }
    }
    return decoyed;
  }

  // lose the track the RIGHT way for the flight model: arcade just nulls the
  // reference, real IR first snapshots the target state so the round can coast
  // on the extrapolated ghost until its seeker re-opens
  _breakLock(ms, blindT) {
    if (ms.real && ms.kind === 'ir' && liveTarget(ms.target)) {
      ms.mem = {
        pos: (ms.target.position ?? ms.target.pos).clone(),
        vel: (ms.target.vel ?? ZERO).clone(),
        t: ms.life,
      };
    }
    ms.target = null;
    ms.blind = Math.max(ms.blind, blindT);
    ms.inCone = false;
  }

  // X key: HEAD-SIGHT lock TOGGLE. With no lock: INSTANT lock on the enemy
  // closest to the sight circle inside the ±8° basket and the current
  // missile's range — no acquisition delay, 锁得上就是锁上了. With a lock:
  // drops it (and kills a warming radar seeker — 断锁即熄火). No passive
  // auto-lock: nothing locks without the explicit command.
  headLockAttempt(player, enemies) {
    if (this.manualTarget) {
      this.manualTarget = null;
      this.lockState = { target: null, locked: false };
      this._lockOutT = 0;
      if (this.mslKind === 'radar') this.cancelWarm();
      return;
    }
    const aim = player.aimDir;
    const range = LOCK_RANGE;
    let best = null, bestDot = BASKET_DOT;
    const consider = (t) => {
      _v.copy(t.position ?? t.pos).sub(player.position);
      const dist = _v.length();
      if (dist > range || dist < 90) return;
      _v.divideScalar(dist);
      // the free-look sight may point beyond the envelope, but ACQUIRING a
      // lock is still gated by the 120° nose cone (锁定只在外圈之内)
      if (_v.dot(player.forward(_v2)) < ENV_DOT) return;
      if (_v.dot(aim) > bestDot) { bestDot = _v.dot(aim); best = t; }
    };
    for (const e of enemies) {
      if (!liveTarget(e)) continue;
      consider(e);
    }
    // anti-missile intercept: hostile rounds are lockable radar targets too
    // (X picks whatever sits closest to the sight center — plane or missile)
    for (const m of this.missiles) {
      if (m.fromPlayer) continue;
      consider(m);
    }
    if (best) {
      this.manualTarget = best;
      this._lockOutT = 0;
      this.lockState = { target: best, locked: true };
      if (this.audio) this.audio.lock();
    }
    // X with nothing (new) in the basket is a no-op
  }

  // 120° front cone: is this world point inside ±60° of the NOSE
  // (the missile leaves the rail along the fuselage axis, not the sight)?
  _inEnvelope(player, pos) {
    _v.copy(pos).sub(player.position);
    const d = _v.length() || 1;
    return _v.divideScalar(d).dot(player.forward(_v2)) > ENV_DOT;
  }

  // after a decoy blind period, the missile may re-acquire ANY aircraft.
  // IR re-opens narrow and near; a radar round gone ACTIVE re-scans a
  // wider, longer cone — but never re-picks its launcher or the shooter
  reacquire(ms, player, enemies) {
    _v.set(0, 0, -1).applyQuaternion(ms.quat);
    const radar = ms.kind === 'radar';
    let best = null, bestDot = radar ? Math.SQRT1_2 : 0.87;   // ±45° / ±29° cone
    const consider = (t) => {
      if (!liveTarget(t)) return;
      if (t === ms.owner) return;                 // seeker ignores the launcher
      if (ms.fromPlayer && t === player) return;   // no self-hits
      _v2.copy(t.position).sub(ms.pos);
      const d = _v2.length();
      if (d > (radar ? 9000 : 2600) || d < 60) return;
      const dot = _v2.divideScalar(d).dot(_v);
      if (dot > bestDot) { bestDot = dot; best = t; }
    };
    consider(player);
    for (const e of enemies) consider(e);
    ms.target = best;
  }

  // ---------- lock maintenance (locks are INSTANT, acquired by X) ----------
  // A lock holds while the target stays alive, in range, and inside the nose
  // envelope — with cone GRACE: leaving the envelope no longer dumps the lock
  // on the spot; the HUD frame blinks with a countdown for CONE_GRACE s and
  // re-entry resets the clock (death / over-range still cut instantly).
  // Dropping the lock kills a radar seeker that is warming or hot
  // (断锁即熄火, re-lock means re-warm); the grace window still fires.
  updateLock(dt, player, enemies) {
    const t = this.manualTarget;
    if (!t) {
      this.lockState = { target: null, locked: false };
      this.lockConeDot = null;
      return;
    }
    const range = LOCK_RANGE;
    _v.copy(t.position ?? t.pos).sub(player.position);
    const d = _v.length() || 1;
    this.lockConeDot = _v.divideScalar(d).dot(player.forward(_v2));
    const hardOK = liveTarget(t) &&
      !(t.kind && !this.missiles.includes(t)) &&   // intercept target died elsewhere
      (t.position ?? t.pos).distanceTo(player.position) < range;
    this._lockOutT = this.lockConeDot > ENV_DOT ? 0 : (this._lockOutT ?? 0) + dt;
    if (!hardOK || this._lockOutT >= CONE_GRACE) {
      this.manualTarget = null;
      this.lockState = { target: null, locked: false };
      this.lockConeDot = null;
      this._lockOutT = 0;
      if (this.mslKind === 'radar') this.cancelWarm();
    } else {
      // grace: REMAINING seconds outside the envelope (0 while inside — the
      // HUD countdown and the launch gate both read this)
      this.lockState = { target: t, locked: true, grace: this._lockOutT > 0 ? CONE_GRACE - this._lockOutT : 0 };
    }
  }

  // ---------- seeker warmup machine (both kinds share one warm state) ----------
  // SPACE when cold starts the warmup too; ALT toggles it off at any stage
  // (the ONLY way to cancel). Firing consumes the warm seeker: the next
  // missile is cold again.
  mslWarmPress() {
    if (this.warm.state === 'cold') this._startWarm();
    else {
      this.cancelWarm();
      if (this.audio) this.audio.warmCancel();
    }
  }

  // SPACE handler: cold -> start warming; warming -> rejected; hot -> fire gate
  mslFirePress(player) {
    if (!player.alive) return false;
    if (this.warm.state === 'cold') { this._startWarm(); return false; }
    if (this.warm.state === 'warming') { this._hint('预热中…'); return false; }
    if (!this._fireGate()) return false;
    return this.playerMissile(player, true);
  }

  _startWarm() {
    if (this.ammo[this.mslKind] <= 0) { this._hint('导弹耗尽'); return; }
    this.warm = { state: 'warming', t: 0 };
    if (this.audio) this.audio.warmStart();
  }

  cancelWarm() {
    if (this.warm.state === 'cold') return;
    this.warm = { state: 'cold', t: 0 };
    this.irSeek = null;
  }

  _updateWarm(dt) {
    const w = this.warm;
    if (w.state === 'warming') {
      w.t += dt;
      if (w.t >= MSL_WARM_TIME) {
        this.warm = { state: 'hot', t: MSL_HOT_WINDOW };
        if (this.audio) this.audio.warmReady();
      }
    } else if (w.state === 'hot') {
      w.t -= dt;
      if (w.t <= 0) this.cancelWarm();
    }
  }

  // gate for a HOT seeker: radar needs the lock; IR needs the seeker bite OR
  // the radar designation (radar-guided IR shot). The cone is the LAUNCH
  // gate: a lock riding its grace window still steers the HUD, but the rail
  // stays closed until the target is back inside the envelope
  _fireGate() {
    const k = this.mslKind;
    if (this.ammo[k] <= 0) { this._hint('导弹耗尽'); return false; }
    const lockOK = this.lockState.locked && !(this.lockState.grace > 0);
    if (k === 'radar' && !lockOK) {
      this._hint(this.lockState.locked ? '目标出锥 · 禁射' : '未锁定'); return false;
    }
    if (k === 'ir' && !this.irSeek && !lockOK) {
      this._hint(this.lockState.locked ? '目标出锥 · 禁射' : '无热源 · 未锁定'); return false;
    }
    return true;
  }

  _hint(text) { if (this.hud) this.hud.hint(text); }

  // damage-direction log entry for the HUD threat flashes: world direction
  // from the player to the source, tagged by kind ('gun' | 'msl' | 'near');
  // capped so sustained gunfire can't grow it without bound
  _logHit(player, pos, kind) {
    this.hitLog.push({ dir: _v3.copy(pos).sub(player.position).normalize().clone(), kind, t: 0 });
    if (this.hitLog.length > 12) this.hitLog.shift();
  }

  // ---------- IR seeker scan (runs while IR is warming or hot) ----------
  // Bites the NEAREST heat source inside the ±8° sight basket AND the 80°
  // nose envelope — burning flares count exactly like aircraft (fully
  // physical: a decoy drifting between you and the bandit bites first).
  _updateSeeker(player, enemies) {
    const prev = this.irSeek;
    this.irSeek = null;
    if (this.mslKind !== 'ir' || this.warm.state === 'cold') return;
    const aim = player.aimDir;
    let best = null, bestDist = Infinity, bestCone = null;
    const consider = (pos, src) => {
      _v.copy(pos).sub(player.position);
      const d = _v.length();
      if (d > SEEKER_RANGE || d < 60) return;
      _v.divideScalar(d);
      if (_v.dot(aim) < BASKET_DOT) return;
      const cone = _v.dot(player.forward(_v2));
      if (cone < ENV_DOT) return;
      if (d < bestDist) { bestDist = d; best = src; bestCone = cone; }
    };
    for (const e of enemies) {
      if (!liveTarget(e)) continue;
      consider(e.position, e);
    }
    for (const f of this.flareList) consider(f.pos, f);
    // hostile missile plumes are heat sources too: an IR round goes up
    // against an inbound missile with NO radar lock — basket it, let the
    // seeker bite the flame, fire
    for (const m of this.missiles) {
      if (m.fromPlayer || m.life < 0.4) continue;
      consider(m.pos, m);
    }
    this.irSeek = best;
    this.seekConeDot = best ? bestCone : null;
    if (best && best !== prev && this.audio) this.audio.seekBite();
  }

  // per-frame fire control: lock maintenance + warm machine + seeker scan
  updateFireControl(dt, player, enemies) {
    this.updateLock(dt, player, enemies);
    this._updateWarm(dt);
    this._updateSeeker(player, enemies);
    // the cone dot of whatever would actually guide a shot right now —
    // the HUD paints the edge warning on THIS target
    this.guideConeDot = this.mslKind === 'ir'
      ? (this.irSeek ? this.seekConeDot : this.lockConeDot)
      : this.lockConeDot;
  }

  // ---------- missiles ----------
  launchMissile(origin, quat, fromPlayer, target, owner, kind = 'ir') {
    const mesh = this.missilePool.find(m => !m.visible);
    if (!mesh) return;
    mesh.visible = true;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(quat);
    const real = this.mode === 'real';
    // per-kind bodies. ARCADE: radar missiles are slower, heavier,
    // longer-legged, wider-locking (20 km) and turn more lazily than IR
    // missiles; AA rounds (map-boundary batteries) never run out of motor and
    // turn far too hard to outmaneuver — the boundary is a wall, not a duel.
    // REAL: same personalities re-expressed as energy (see REAL_BODIES) —
    // the AA wall keeps its job through crushing numbers, not cheats
    const spec = real ? realSpec(kind, fromPlayer) : null;
    const body = real
      ? { maxSpeed: 0, turn: 0,
          dmg: kind === 'aa' ? 60 : fromPlayer ? (kind === 'radar' ? 80 : 60) : (kind === 'radar' ? 55 : 38),
          ttl: spec.ttl,
          lockRange: kind === 'aa' ? 0 : kind === 'radar' ? 20000 : 5200 }
      : kind === 'aa'
      ? { maxSpeed: 900, turn: 4.5, dmg: 60, ttl: Infinity, lockRange: 0 }
      : kind === 'radar'
      ? { maxSpeed: fromPlayer ? 780 : 650, turn: fromPlayer ? 2.5 : 2.2, dmg: fromPlayer ? 80 : 55, ttl: 16, lockRange: 20000 }
      : { maxSpeed: fromPlayer ? 880 : 700, turn: fromPlayer ? 3.4 : 2.55, dmg: fromPlayer ? 60 : 38, ttl: 8.5, lockRange: 5200 };
    // launch velocity: arcade rails everything out at a fixed 200 m/s; real
    // rounds inherit the carrier's full velocity plus a small separation kick
    // along the rail (AA cells eject at ~50 m/s before ignition)
    const vel = real
      ? (owner && owner.vel ? owner.vel.clone().addScaledVector(fwd, 30) : fwd.clone().multiplyScalar(50))
      : fwd.clone().multiplyScalar(200);
    this.missiles.push({
      pos: origin.clone(),
      prev: origin.clone(),   // last-frame position: segment fuse reference
      quat: quat.clone(),
      vel,
      speed: vel.length(),
      life: 0,
      ttl: body.ttl,
      fromPlayer,
      kind,
      real,
      spec,                                 // realistic body card (null in arcade)
      motorEnd: spec ? spec.boostT + spec.susT : 0,
      maxSpeed: body.maxSpeed,
      turnRate: body.turn,
      dmg: body.dmg,
      target,
      mesh,
      smokeT: 0,
      blind: 0,            // decoyed/notched, flying blind
      notchT: 0,           // sustained beam/terrain time (radar only)
      mpF: 0,              // multipath strength 0..1 (target hugging the deck)
      mpT: 0,              // multipath lock-decay accumulator (radar only)
      owner: owner || null,          // launcher: immune to its own missile
      armT: 0.35,                    // fuse arming time (s) after launch
      mem: null,            // real IR ghost snapshot {pos, vel, t}
      rescanT: 0,           // real IR searching re-open countdown
      inCone: false,        // real IR edge-triggered seeker-cone state
    });
    // only the PLAYER'S own launches are audible in first person
    if (this.audio && fromPlayer) {
      if (kind === 'radar') this.audio.radarLaunch(); else this.audio.missileLaunch();
    }
  }

  // force=true bypasses the warm/gate checks (freeze harness scripted shots)
  playerMissile(player, wantFire, force = false) {
    if (!wantFire || !player.alive) return false;
    const kind = this.mslKind;
    if (!force) {
      if (this.warm.state !== 'hot') return false;
      if (!this._fireGate()) return false;
    }
    if (this.ammo[kind] <= 0) return false;
    // spawn under the wing, pointed forward
    const side = (this._side = !(this._side));
    const origin = player.position.clone()
      .addScaledVector(player.forward(new THREE.Vector3()), 2)
      .add(new THREE.Vector3(side ? 3.4 : -3.4, -1.1, 1.5).applyQuaternion(player.quaternion));
    // guidance: for IR the seeker bite BEATS the radar designation (fully
    // physical — even a radar-guided IR shot dives at the nearest heat
    // source, flare included); radar lock guides when the seeker has nothing
    const target = kind === 'ir'
      ? (this.irSeek || this.lockState.target)
      : this.lockState.target;
    this.launchMissile(origin, player.quaternion, true, target, player, kind);
    this.ammo[kind]--;
    this.cancelWarm();   // the warmed missile is gone; the next one is cold
    this.fxPunch = 0.55; // radial speed-blur punch on launch
    return true;
  }

  enemyMissile(enemy, player) {
    const origin = enemy.position.clone().addScaledVector(
      new THREE.Vector3(0, 0, -1).applyQuaternion(enemy.quaternion), 2);
    this.launchMissile(origin, enemy.quaternion, false, player, enemy, enemy.mslKind || 'ir');
  }

  steerMissile(ms, dt) {
    if (ms.real) return this._stepReal(ms, dt);
    // accelerate, then steer toward a lead point with a turn-rate clamp
    ms.speed = Math.min(ms.speed + 620 * dt, ms.maxSpeed);
    if (ms.blind > 0) {
      // decoyed: seeker confused, motor runs, flies straight
      ms.vel.copy(_v.set(0, 0, -1).applyQuaternion(ms.quat)).multiplyScalar(ms.speed);
      ms.pos.addScaledVector(ms.vel, dt);
      return;
    }
    const hasTarget = liveTarget(ms.target);
    if (hasTarget) {
      const tp = ms.target.position ?? ms.target.pos;   // flares carry .pos
      const dist = ms.pos.distanceTo(tp);
      const tLead = clamp(dist / 800, 0, 2.0);
      // both sides expose their true velocity vector on the flight body
      _v.copy(tp).addScaledVector(ms.target.vel, tLead).sub(ms.pos);
      // multipath mirror: seeker centroid drifts toward the reflected image
      // below the surface — the aim point sinks with how low the target files
      if (ms.kind === 'radar' && ms.mpF > 0) _v.y -= ms.mpF * (30 + Math.min(60, 800 / Math.max(dist, 1)) * 14);
      _v.normalize();
      _m.lookAt(ms.pos, _v2.copy(ms.pos).add(_v), UP);   // -Z of the matrix faces the aim point
      _q.setFromRotationMatrix(_m);
      const maxTurn = ms.turnRate * (ms.life > 0.35 ? 1 : 0.25);
      ms.quat.rotateTowards(_q, maxTurn * dt);
    }
    ms.vel.copy(_v.set(0, 0, -1).applyQuaternion(ms.quat)).multiplyScalar(ms.speed);
    ms.pos.addScaledVector(ms.vel, dt);
  }

  // ---------- realistic-mode integrator: point-mass true-vector flight ------
  // Thrust acts along the flight line, drag is k*rho*v^2 against it, gravity
  // always pulls; steering is a LATERAL acceleration from pure PN (a = N·Ω×v)
  // plus a 1G gravity bias, clamped by the dynamic-pressure-scaled G limit.
  // Speed, turn radius, coast-out and the terminal dive all fall out of the
  // forces — nothing here is scripted. Guidance sources: live target, or (IR
  // only, after a break) the ghost extrapolated from the snapshot in ms.mem.
  _stepReal(ms, dt) {
    const sp = ms.spec;
    const v = ms.vel.length();
    const rho = 1 - clamp(ms.pos.y / 15000, 0, 1) * 0.6;   // the jets' atmosphere
    const vDir = v > 1 ? _v.copy(ms.vel).multiplyScalar(1 / v)
      : _v.set(0, 0, -1).applyQuaternion(ms.quat);

    // motor: boost, sustain, then silence
    const aT = ms.life < sp.boostT ? sp.boost
      : ms.life < sp.boostT + sp.susT ? sp.sus : 0;

    // ---- lateral command ----
    _ac.set(0, 0, 0);
    let guiding = false;
    if (ms.life >= sp.rigid) {                 // rail-rigid dead time first
      const live = liveTarget(ms.target);
      if (live) {
        _tp.copy(ms.target.position ?? ms.target.pos);
        guiding = true;
      } else if (ms.mem && ms.kind === 'ir') {
        _tp.copy(ms.mem.pos).addScaledVector(ms.mem.vel, ms.life - ms.mem.t);
        guiding = true;
      }
      if (guiding) {
        // radar multipath: the seeker centroid sinks toward the mirror image
        if (ms.kind === 'radar' && ms.mpF > 0) {
          const d = ms.pos.distanceTo(_tp);
          _tp.y -= ms.mpF * (30 + Math.min(60, 800 / Math.max(d, 1)) * 14);
        }
        _r.copy(_tp).sub(ms.pos);
        const rl = _r.length();
        if (rl > 4) {
          _vr.copy(live ? ms.target.vel : ms.mem.vel).sub(ms.vel);
          _om.copy(_r).cross(_vr).divideScalar(rl * rl);      // LOS rate
          _ac.copy(_om).cross(ms.vel).multiplyScalar(PN_N);   // always ⊥ velocity
        }
        _ac.y += G0;   // gravity bias: hold the line without spending turn G
      }
    }
    // available G falls with dynamic pressure — a slow round flies like one
    const gAvail = sp.gRate * clamp((v / sp.vRef) * (v / sp.vRef), sp.gFloor, 1);
    const aMax = gAvail * G0;
    const al = _ac.length();
    if (al > aMax) _ac.multiplyScalar(aMax / al);
    _ac.addScaledVector(vDir, -_ac.dot(vDir));   // lateral only: rotate, don't brake

    // ---- forces & integration ----
    const drag = sp.k * rho * v * v;
    ms.vel.addScaledVector(vDir, (aT - drag) * dt);
    ms.vel.y -= G0 * dt;
    ms.vel.addScaledVector(_ac, dt);
    ms.pos.addScaledVector(ms.vel, dt);
    ms.speed = ms.vel.length();
    // body chases the velocity vector (rendering + seeker boresight)
    if (ms.speed > 25) {
      const up = Math.abs(ms.vel.y / ms.speed) > 0.98 ? ALT_UP : UP;
      _m.lookAt(_v2.set(0, 0, 0), _v3.copy(ms.vel), up);
      ms.quat.setFromRotationMatrix(_m);
    }
  }

  // real-mode IR seeker re-open: pure heat-source scan — every aircraft AND
  // every burning flare inside the +/-35 deg cone, angle-closest wins, the
  // original target holds no privilege (a still-burning flare gets re-bitten)
  scanHeat(ms, player, enemies) {
    _v.set(0, 0, -1).applyQuaternion(ms.quat);   // boresight = velocity line
    let best = null, bestDot = CONE_DOT;
    const consider = (pos, src) => {
      _v2.copy(pos).sub(ms.pos);
      const d = _v2.length();
      if (d > HEAT_RANGE || d < 60) return;
      const dot = _v2.divideScalar(d).dot(_v);
      if (dot > bestDot) { bestDot = dot; best = src; }
    };
    const considerBody = (t) => {
      if (!liveTarget(t) || t === ms.owner) return;
      if (ms.fromPlayer && t === player) return;   // no self-hits
      consider(t.position, t);
    };
    considerBody(player);
    for (const e of enemies) considerBody(e);
    for (const f of this.flareList) consider(f.pos, f);
    return best;
  }

  update(dt, player, enemies, effects) {
    // ammo regen: two independent pools (IR light AAM / radar heavy)
    if (player.alive) {
      for (const k of ['ir', 'radar']) {
        if (this.ammo[k] < this.ammoMax[k]) {
          this.ammoRegen[k] += dt;
          if (this.ammoRegen[k] > AMMO_REGEN[k]) { this.ammoRegen[k] = 0; this.ammo[k]++; }
        }
      }
    }

    // --- tracers ---
    for (let i = this.rounds.length - 1; i >= 0; i--) {
      const r = this.rounds[i];
      r.life -= dt;
      r.prev.copy(r.pos);
      r.pos.addScaledVector(r.vel, dt);
      r.vel.y -= 9.8 * dt * 0.35;
      // orient tracer mesh
      _v.copy(r.vel).normalize();
      _m.lookAt(r.pos, _v2.copy(r.pos).add(_v), UP);
      r.mesh.quaternion.setFromRotationMatrix(_m);
      r.mesh.position.copy(r.pos);
      // apparent-width compensation: widen the cross-section with range so
      // distant rounds keep ~1.5-2 px instead of dropping under a pixel
      const wScale = Math.min(4, Math.max(1, r.pos.distanceTo(player.position) / 350));
      r.mesh.scale.set(wScale, wScale, 1);

      let hit = false;
      const targets = r.fromPlayer ? enemies : (player.alive ? [player] : []);
      for (const t of targets) {
        if (t.dying) continue;
        // segment-sphere: |closest point on prev->pos to center| < r
        _v2.copy(t.position).sub(r.prev);
        const segLen = r.pos.distanceTo(r.prev) || 1;
        _v.copy(r.pos).sub(r.prev).divideScalar(segLen);
        const tProj = clamp(_v2.dot(_v), 0, segLen);
        const closest = _v2.copy(r.prev).addScaledVector(_v, tProj).sub(t.position);
        if (closest.lengthSq() < AIRCRAFT_HIT_R * AIRCRAFT_HIT_R) {
          hit = true;
          if (r.fromPlayer) {
            const killed = t.applyDamage(r.dmg);
            t.flashT = 0.12;
            this.events.push({ type: 'hitTing', pos: t.position, w: 'gun', tg: t });
            effects.hitSpark(r.pos);
            if (killed) { effects.explosion(t.position, 1.0); effects.wreckBurst?.(t.position, t.body.vel, 1.0); }   // every kill detonates
          } else {
            player.applyDamage(r.dmg);
            this.events.push({ type: 'playerHit', pos: r.pos.clone(), w: 'gun', dmg: r.dmg });
            effects.hitSpark(r.pos);
            this._logHit(player, r.pos, 'gun');
          }
          break;
        }
      }
      // ground hit
      if (!hit && r.pos.y < Math.max(terrainSurfaceAt(r.pos.x, r.pos.z), SEA_LEVEL)) {
        hit = true;
        effects.gunTrailAir(r.pos);
      }
      if (hit || r.life <= 0) {
        this.freeTracer(r.mesh);
        this.rounds.splice(i, 1);
      }
    }

    // --- countermeasure stock regen (1 per 5 s) + flare/chaff burn rolls ---
    if (this.flares < 90) {
      this.flareRegenT += dt;
      if (this.flareRegenT > 5) { this.flareRegenT = 0; this.flares++; }
    }
    // realistic countermeasure ballistics:
    //  - flares inherit full aircraft speed, then form drag bleeds the
    //    horizontal component (~0.55/s) while gravity pulls them to a
    //    ~50 m/s terminal fall — the classic arcing flare trail
    //  - chaff bundles are far lighter: drag strips their speed almost
    //    instantly and they hang, sinking slowly while they tumble
    const burnCloud = (list, kind) => {
      const dragPerSec = kind === 'ir' ? 0.55 : 0.10;
      const grav = kind === 'ir' ? 30 : 8;
      for (let i = list.length - 1; i >= 0; i--) {
        const fl = list[i];
        fl.life += dt;
        if (fl.life > fl.ttl) { list.splice(i, 1); continue; }
        fl.vel.y -= grav * dt;
        fl.vel.multiplyScalar(Math.pow(dragPerSec, dt));
        fl.pos.addScaledVector(fl.vel, dt);
        // trail emission: burning glow streaks + lingering smoke that the
        // flare leaves along its real (drag-bent) trajectory
        fl.emitT -= dt;
        if (fl.emitT <= 0) {
          fl.emitT = kind === 'ir' ? 0.035 : 0.11;
          if (this.effects) this.effects.cmTrail(fl.pos, fl.vel, kind === 'ir');
        }
        // burning flares keep seducing IR seekers; chaff clouds only persist
        fl.rollT -= dt;
        if (kind === 'ir' && fl.rollT <= 0 && fl.rolls > 0) {
          fl.rollT = 0.55;
          fl.rolls--;
          this._rollDecoys(fl.owner, 1, 'ir');
        }
      }
    };
    burnCloud(this.flareList, 'ir');
    burnCloud(this.chaffList, 'radar');

    // --- missiles ---
    this.inboundWarning = false;
    this.radarInbound = false;
    for (let i = this.hitLog.length - 1; i >= 0; i--) {
      this.hitLog[i].t += dt;
      if (this.hitLog[i].t > 1.5) this.hitLog.splice(i, 1);   // longest flash fade is 1.4 s
    }
    for (let i = this.missiles.length - 1; i >= 0; i--) {
      const ms = this.missiles[i];
      if (!ms || ms._dead) continue;   // intercept kill: swept after the loop
      ms.life += dt;
      // near-miss: an inbound missile swung past the player inside 70 m
      // without fusing — one-shot camera whip event
      if (!ms.fromPlayer && player.alive) {
        const d2 = ms.pos.distanceTo(player.position);
        if (d2 < (ms._minD ?? 1e9)) ms._minD = d2;
        else if (!ms._whipped && ms._minD < 70 && d2 > ms._minD + 6) {
          ms._whipped = true;
          this._logHit(player, ms.pos, 'near');
          this.events.push({ type: 'nearMiss', dir: _v3.copy(ms.pos).sub(player.position).normalize().clone(), pos: ms.pos.clone() });
        }
      }
      // a missile biting a flare chases it until the flare burns out, then
      // goes decoyed-blind (IR re-acquires after 1.8 s — anyone, any aircraft
      // in arcade; in real mode the burnt flare's ghost is snapshotted first)
      if (ms.target && ms.target.isFlare && !this.flareList.includes(ms.target)) {
        this._breakLock(ms, ms.kind === 'ir' ? 1.8 : 0);
      }
      if (ms.blind > 0) {
        ms.blind -= dt;
        // IR re-acquires after its blind; a radar round broken by pure
        // beam/mask (no chaff) re-opens after a SHORT blind and goes ACTIVE
        // — chaff-broken rounds never reach the radar branch (blind = 1e9
        // counts down forever)
        if (ms.blind <= 0 && ms.kind === 'ir') {
          if (ms.real) { ms.target = this.scanHeat(ms, player, enemies); ms.rescanT = RESCAN_T; }
          else this.reacquire(ms, player, enemies);
        } else if (ms.blind <= 0 && ms.kind === 'radar') {
          ms.rescanR = true; ms.rescanT = 0;   // go ACTIVE: first scan next tick
        }
      } else if (ms.rescanR && ms.kind === 'radar') {
        // ACTIVE re-scan: a notched-but-unchaffed radar round keeps hunting
        // — every RESCAN_T it grabs the best aircraft in its wider, longer
        // cone until a chaff-sealed break, the ttl or the ground ends it
        ms.rescanT -= dt;
        if (ms.rescanT <= 0) {
          ms.rescanT = RESCAN_T;
          this.reacquire(ms, player, enemies);
          if (ms.target) ms.rescanR = false;
        }
      } else if (ms.real && ms.kind === 'ir' && !liveTarget(ms.target)) {
        // SEARCHING: ghost-coasting with the seeker re-opening on pure heat
        // every RESCAN_T until something bites, the ttl or the ground does
        ms.rescanT -= dt;
        if (ms.rescanT <= 0) {
          ms.rescanT = RESCAN_T;
          ms.target = this.scanHeat(ms, player, enemies);
        }
      }
      // real IR seeker cone (±35°, edge-triggered: only LOSING a cone that
      // was held breaks the track — off-boresight launches may fly INTO it)
      if (ms.real && ms.kind === 'ir' && ms.blind <= 0 && ms.life >= ms.spec.rigid
        && liveTarget(ms.target) && !ms.target.isFlare) {
        _v.set(0, 0, -1).applyQuaternion(ms.quat);
        _v2.copy(ms.target.position ?? ms.target.pos).sub(ms.pos).normalize();
        const inCone = _v2.dot(_v) > CONE_DOT;
        if (ms.inCone && !inCone) this._breakLock(ms, 1.8);   // beamed out
        ms.inCone = inCone;
      } else if (ms.real && (!liveTarget(ms.target) || ms.target.isFlare)) {
        ms.inCone = false;
      }
      // radar guidance environment: the 三九 notch and terrain masking.
      // WITHOUT chaff the beam must be near-perfect (±17°); WITH a chaff
      // cloud from the target near the engagement, the window relaxes to a
      // lazy ±33° beam ("48 机动") and locks faster — chaff enables the
      // maneuver, it never decoys the seeker by itself.
      if (ms.kind === 'radar' && liveTarget(ms.target)) {
        const ntp = ms.target.pos ?? ms.target.position;   // missile targets carry .pos
        _v.copy(ntp).sub(ms.pos);
        const losLen = _v.length() || 1;
        _v.divideScalar(losLen);
        _v2.copy(ms.target.vel);
        const vLen = _v2.length() || 1;
        const beam = Math.abs(_v2.divideScalar(vLen).dot(_v));
        let masked = false;
        if (losLen > 900) {
          for (let t = 0.2; t <= 0.7; t += 0.25) {
            const px = ms.pos.x + (ntp.x - ms.pos.x) * t;
            const py = ms.pos.y + (ntp.y - ms.pos.y) * t;
            const pz = ms.pos.z + (ntp.z - ms.pos.z) * t;
            if (terrainSurfaceAt(px, pz) > py + 15) { masked = true; break; }
          }
        }
        let chaffNear = false;
        for (const ch of this.chaffList) {
          if (ch.owner === ms.target && ch.pos.distanceTo(ms.pos) < 1500) { chaffNear = true; break; }
        }
        const beamLimit = chaffNear ? 0.6 : 0.3;
        const needTime = chaffNear ? 0.7 : 0.9;
        if (beam < beamLimit || masked) ms.notchT += dt; else ms.notchT = 0;
        // multipath: a target hugging the deck (<120 m AGL) ghosts its mirror
        // image below the surface — the seeker chases the reflection down and
        // slowly loses the true track. Symmetric: works on the player's radar
        // missiles against low enemies exactly as it does on theirs. Own
        // accumulator: pure low flight must accumulate WITHOUT the notch
        // reset wiping it, and it bleeds off when the target pops back up.
        const tAGL = ntp.y - Math.max(terrainSurfaceAt(ntp.x, ntp.z), SEA_LEVEL);
        ms.mpF = tAGL < 120 ? clamp(1 - tAGL / 120, 0, 1) : 0;
        ms.mpT = ms.mpF > 0
          ? (ms.mpT || 0) + dt * 0.6 * ms.mpF
          : Math.max(0, (ms.mpT || 0) - dt * 1.5);   // pop-up: seeker recovers
        if (ms.notchT > needTime || ms.mpT > 1.0) {
          ms.target = null;
          // chaff SEALS the break — the cloud keeps the seeker confused for
          // good. A pure beam/mask/multipath break only blinds the active
          // seeker briefly: it re-opens and keeps re-scanning, so the beam
          // must be held or the geometry escaped (不一直三九就会被复锁)
          ms.blind = chaffNear ? 1e9 : 2.5;
          ms.notchT = 0; ms.mpT = 0;
        }
      }
      ms.prev.copy(ms.pos);
      this.steerMissile(ms, dt);
      ms.mesh.position.copy(ms.pos);
      ms.mesh.quaternion.copy(ms.quat);
      // same sub-pixel cure as tracers: a 0.16 m fuselage vanishes past
      // ~1.5 km; grow it mildly with range (PIP rides close, stays ~1x)
      ms.mesh.scale.setScalar(Math.min(2.6, Math.max(1, ms.pos.distanceTo(player.position) / 900)));
      // trail: thick smoke + flame while the motor burns; after burnout the
      // round leaves only a thin, broken strand — that IS the energy readout
      const burning = !ms.real || ms.life <= ms.motorEnd;
      ms.smokeT += dt;
      if (ms.smokeT > (burning ? 0.016 : 0.05)) {
        ms.smokeT = 0;
        effects.missileTrail(ms.pos, ms.vel.clone().multiplyScalar(-0.02), burning);
      }
      if (!ms.fromPlayer && player.alive && (ms.target === player || (ms.blind > 0 && ms.blind < 5))) {
        if (ms.kind === 'radar') this.radarInbound = true;
        else this.inboundWarning = true;
        this.inboundDir.copy(ms.pos).sub(player.position).normalize();
      }

      // proximity fuse against EVERY aircraft (decoyed/blind missiles can
      // hit anyone — friendly fire included), but only after arming and
      // never against the launcher itself. SEGMENT-sphere (prev->pos): two
      // missiles close head-on at ~1700 m/s = 28+ m per frame — a plain
      // per-frame sphere test tunnels straight through the intercept
      let boom = false, boomPos = ms.pos.clone();
      const armed = ms.life > ms.armT;
      const fuseHit = (t) => {
        if (!liveTarget(t) || t._dead || t === ms) return;
        if (t === ms.owner) return;               // launcher immunity
        if (ms.fromPlayer && t === player) return;
        if (!armed) return;
        const tp = t.position ?? t.pos;
        const fr = t.kind ? 12 : MISSILE_FUSE_R;  // vs a missile: tight 12 m fuse (hard intercept)
        _v2.copy(tp).sub(ms.prev);
        const segLen = ms.pos.distanceTo(ms.prev) || 1;
        _v.copy(ms.pos).sub(ms.prev).divideScalar(segLen);
        const tProj = clamp(_v2.dot(_v), 0, segLen);
        const closest = _v2.copy(ms.prev).addScaledVector(_v, tProj).sub(tp);
        if (closest.lengthSq() < fr * fr) {
          boom = true;
          if (t.kind) {
            // INTERCEPT: the incoming round detonates outright (missiles
            // carry no HP); removal is deferred to the sweep below so the
            // outer loop indices stay sane
            t._dead = true;
            effects.explosion?.(tp, 0.8);
            this.events.push({ type: 'intercept', pos: tp.clone() });
            return;
          }
          if (t === player) {
            player.applyDamage(ms.dmg);
            this.events.push({ type: 'playerHit', pos: ms.pos.clone(), w: 'msl', dmg: ms.dmg });
            this._logHit(player, ms.pos, 'msl');
          } else if (ms.fromPlayer) {
            t.flashT = 0.12;
            this.events.push({ type: 'hitTing', pos: t.position, w: 'msl', tg: t });
            const killed = t.applyDamage(ms.dmg);
            if (killed) {
              // EVERY kill detonates — the spiral-fall wrecks (30%) now drop
              // burning out of the fireball, and the airframe bursts apart
              effects.explosion(t.position, 1.2);
              effects.wreckBurst?.(t.position, t.body.vel, 1.2);
            } else if (!t.dying) {
              // missile struck the cockpit area but did not destroy it:
              // pilot hit — the plane starts smoking immediately
              t.pilotHit = true;
              this.events.push({ type: 'crit' });
            }
          } else {
            t.applyDamage(ms.dmg);   // enemy missile hits an enemy: friendly fire
          }
        }
      };
      fuseHit(player);
      for (const e of enemies) fuseHit(e);
      // anti-missile intercept: only the PLAYER's rounds fuse on hostile
      // missiles (snapshot the list — intercept kills mark targets _dead)
      if (ms.fromPlayer) for (const t of this.missiles.slice()) fuseHit(t);
      const ground = Math.max(terrainSurfaceAt(ms.pos.x, ms.pos.z), SEA_LEVEL);
      if (!boom && ms.pos.y < ground) boom = true;
      if (!boom && ms.life > ms.ttl) boom = true;
      // real mode, motor spent and dragging to a crawl: the round is debris —
      // detonate it instead of dragging a dead plume across the sky
      if (!boom && ms.real && ms.kind !== 'aa' && ms.life > ms.motorEnd && ms.vel.length() < LOW_SPD) boom = true;
      if (boom) {
        const overSea = terrainSurfaceAt(boomPos.x, boomPos.z) < SEA_LEVEL + 1;
        if (overSea) effects.waterColumn?.(boomPos, 1.2);
        else effects.explosion?.(boomPos, 0.8);
        this.freeMissile(ms);
        this.missiles.splice(i, 1);
      }
    }
    // sweep intercept kills AFTER the loop — splicing mid-loop while ms's
    // own boom also splices shrinks the array past the live indices
    for (let j = this.missiles.length - 1; j >= 0; j--) {
      if (this.missiles[j]._dead) {
        this.freeMissile(this.missiles[j]);
        this.missiles.splice(j, 1);
      }
    }
  }
}
