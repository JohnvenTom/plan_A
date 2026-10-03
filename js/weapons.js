// weapons.js — guns (tracer pool + segment collision) and lock-on homing missiles
import * as THREE from 'three';
import { clamp } from './utils.js';
import { AIRCRAFT_HIT_R, MISSILE_FUSE_R } from './utils.js';
import { terrainHeightAt, SEA_LEVEL } from './terrain.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);

// seeker warmup machine (both kinds): cold --(SPACE/ALT)--> warming (1 s)
// --(auto)--> hot (8 s hold window) --> cold. ALT is the ONLY cancel.
const MSL_WARM_TIME = 1.0;
const MSL_HOT_WINDOW = 8.0;
// 120° front cone (±60° off the FUSELAGE axis, not the sight): radar locks
// hold only inside it, IR shots may only leave the rail inside it.
// Lock/bite ACQUISITION still requires the ±8° head-sight basket.
const ENV_DOT = Math.cos(60 * Math.PI / 180);
const BASKET_DOT = Math.cos(8 * Math.PI / 180);   // head-sight basket ±8°
// the head-sight lock is a RADAR lock for BOTH kinds — 20 km acquire/hold;
// for IR missiles the radar lock is nothing but a guidance source (the
// seeker keeps its own shorter heat-source detection range)
const LOCK_RANGE = 20000;
const SEEKER_RANGE = 5200;                        // IR seeker heat detection
const AMMO_REGEN = { ir: 5.5, radar: 8 };         // s per missile, per pool

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
    this.lastHit = null;       // {dir, age} — where the latest hit on the player came from
    this.now = 0;              // presentation clock for hit-direction fading
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
          ms.target = null;
          ms.blind = 1.8;
          decoyed++;
          break;
        }
      }
    }
    return decoyed;
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
      if (this.mslKind === 'radar') this.cancelWarm();
      return;
    }
    const aim = player.aimDir;
    const range = LOCK_RANGE;
    let best = null, bestDot = BASKET_DOT;
    for (const e of enemies) {
      if (!liveTarget(e)) continue;
      _v.copy(e.position).sub(player.position);
      const dist = _v.length();
      if (dist > range || dist < 90) continue;
      _v.divideScalar(dist);
      // the free-look sight may point beyond the envelope, but ACQUIRING a
      // lock is still gated by the 120° nose cone (锁定只在外圈之内)
      if (_v.dot(player.forward(_v2)) < ENV_DOT) continue;
      if (_v.dot(aim) > bestDot) { bestDot = _v.dot(aim); best = e; }
    }
    if (best) {
      this.manualTarget = best;
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

  // after a decoy blind period, the missile may re-acquire ANY aircraft
  reacquire(ms, player, enemies) {
    _v.set(0, 0, -1).applyQuaternion(ms.quat);
    let best = null, bestDot = 0.87;   // ~29 deg seeker cone
    const consider = (t) => {
      if (!liveTarget(t)) return;
      if (t === ms.owner) return;                 // seeker ignores the launcher
      if (ms.fromPlayer && t === player) return;   // no self-hits
      _v2.copy(t.position).sub(ms.pos);
      const d = _v2.length();
      if (d > 2600 || d < 60) return;
      const dot = _v2.divideScalar(d).dot(_v);
      if (dot > bestDot) { bestDot = dot; best = t; }
    };
    consider(player);
    for (const e of enemies) consider(e);
    ms.target = best;
  }

  // ---------- lock maintenance (locks are INSTANT, acquired by X) ----------
  // A lock holds while the target stays alive, in range, and inside the 80°
  // nose envelope. Breaking it drops the lock — and a radar seeker that is
  // warming or hot dies with it (断锁即熄火, re-lock means re-warm).
  updateLock(dt, player, enemies) {
    const t = this.manualTarget;
    if (!t) {
      this.lockState = { target: null, locked: false };
      this.lockConeDot = null;
      return;
    }
    const range = LOCK_RANGE;
    _v.copy(t.position).sub(player.position);
    const d = _v.length() || 1;
    this.lockConeDot = _v.divideScalar(d).dot(player.forward(_v2));
    const valid = liveTarget(t) &&
      t.position.distanceTo(player.position) < range &&
      this.lockConeDot > ENV_DOT;
    if (!valid) {
      this.manualTarget = null;
      this.lockState = { target: null, locked: false };
      this.lockConeDot = null;
      if (this.mslKind === 'radar') this.cancelWarm();
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
  // the radar designation (radar-guided IR shot)
  _fireGate() {
    const k = this.mslKind;
    if (this.ammo[k] <= 0) { this._hint('导弹耗尽'); return false; }
    if (k === 'radar' && !this.lockState.locked) { this._hint('未锁定'); return false; }
    if (k === 'ir' && !this.irSeek && !this.lockState.locked) { this._hint('无热源 · 未锁定'); return false; }
    return true;
  }

  _hint(text) { if (this.hud) this.hud.hint(text); }

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
    // per-kind bodies: radar missiles are slower, heavier, longer-legged,
    // wider-locking (20 km) and turn more lazily than IR missiles; AA rounds
    // (map-boundary batteries) never run out of motor and turn far too hard
    // to outmaneuver — the boundary is a wall, not a duel
    const body = kind === 'aa'
      ? { maxSpeed: 900, turn: 4.5, dmg: 60, ttl: Infinity, lockRange: 0 }
      : kind === 'radar'
      ? { maxSpeed: fromPlayer ? 780 : 650, turn: fromPlayer ? 2.5 : 2.2, dmg: fromPlayer ? 80 : 55, ttl: 16, lockRange: 20000 }
      : { maxSpeed: fromPlayer ? 880 : 700, turn: fromPlayer ? 3.4 : 2.55, dmg: fromPlayer ? 60 : 38, ttl: 8.5, lockRange: 5200 };
    this.missiles.push({
      pos: origin.clone(),
      quat: quat.clone(),
      vel: fwd.clone().multiplyScalar(200),
      speed: 200,
      life: 0,
      ttl: body.ttl,
      fromPlayer,
      kind,
      maxSpeed: body.maxSpeed,
      turnRate: body.turn,
      dmg: body.dmg,
      target,
      mesh,
      smokeT: 0,
      blind: 0,            // >0: decoyed/notched, flying straight
      notchT: 0,           // sustained beam/terrain time (radar only)
      owner: owner || null,          // launcher: immune to its own missile
      armT: 0.35,                    // fuse arming time (s) after launch
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
      _v.copy(tp).addScaledVector(ms.target.vel, tLead).sub(ms.pos).normalize();
      _m.lookAt(ms.pos, _v2.copy(ms.pos).add(_v), UP);   // -Z of the matrix faces the aim point
      _q.setFromRotationMatrix(_m);
      const maxTurn = ms.turnRate * (ms.life > 0.35 ? 1 : 0.25);
      ms.quat.rotateTowards(_q, maxTurn * dt);
    }
    ms.vel.copy(_v.set(0, 0, -1).applyQuaternion(ms.quat)).multiplyScalar(ms.speed);
    ms.pos.addScaledVector(ms.vel, dt);
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
            this.events.push({ type: 'hitTing' });
            effects.hitSpark(r.pos);
            if (killed) { effects.explosion(t.position, 1.0); effects.wreckBurst?.(t.position, t.body.vel, 1.0); }   // every kill detonates
          } else {
            player.applyDamage(r.dmg);
            effects.hitSpark(r.pos);
            this.lastHit = { dir: _v3.copy(r.pos).sub(player.position).normalize().clone(), age: 0 };
          }
          break;
        }
      }
      // ground hit
      if (!hit && r.pos.y < Math.max(terrainHeightAt(r.pos.x, r.pos.z), SEA_LEVEL)) {
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
    this.now += dt;
    if (this.lastHit) {
      this.lastHit.age += dt;
      if (this.lastHit.age > 2) this.lastHit = null;
    }
    for (let i = this.missiles.length - 1; i >= 0; i--) {
      const ms = this.missiles[i];
      ms.life += dt;
      // near-miss: an inbound missile swung past the player inside 70 m
      // without fusing — one-shot camera whip event
      if (!ms.fromPlayer && player.alive) {
        const d2 = ms.pos.distanceTo(player.position);
        if (d2 < (ms._minD ?? 1e9)) ms._minD = d2;
        else if (!ms._whipped && ms._minD < 70 && d2 > ms._minD + 6) {
          ms._whipped = true;
          this.events.push({ type: 'nearMiss', dir: _v3.copy(ms.pos).sub(player.position).normalize().clone() });
        }
      }
      // a missile biting a flare chases it until the flare burns out, then
      // goes decoyed-blind (IR re-acquires after 1.8 s — anyone, any aircraft)
      if (ms.target && ms.target.isFlare && !this.flareList.includes(ms.target)) {
        ms.target = null;
        if (ms.kind === 'ir') ms.blind = Math.max(ms.blind, 1.8);
      }
      if (ms.blind > 0) {
        ms.blind -= dt;
        // IR seekers re-acquire after the blind period; a radar missile that
        // got notched or terrain-masked stays dumb permanently (blind = 1e9)
        if (ms.blind <= 0 && ms.kind === 'ir') this.reacquire(ms, player, enemies);
      }
      // radar guidance environment: the 三九 notch and terrain masking.
      // WITHOUT chaff the beam must be near-perfect (±17°); WITH a chaff
      // cloud from the target near the engagement, the window relaxes to a
      // lazy ±33° beam ("48 机动") and locks faster — chaff enables the
      // maneuver, it never decoys the seeker by itself.
      if (ms.kind === 'radar' && liveTarget(ms.target)) {
        _v.copy(ms.target.pos ?? ms.target.position).sub(ms.pos);
        const losLen = _v.length() || 1;
        _v.divideScalar(losLen);
        _v2.copy(ms.target.vel);
        const vLen = _v2.length() || 1;
        const beam = Math.abs(_v2.divideScalar(vLen).dot(_v));
        let masked = false;
        if (losLen > 900) {
          for (let t = 0.2; t <= 0.7; t += 0.25) {
            const px = ms.pos.x + (ms.target.position.x - ms.pos.x) * t;
            const py = ms.pos.y + (ms.target.position.y - ms.pos.y) * t;
            const pz = ms.pos.z + (ms.target.position.z - ms.pos.z) * t;
            if (terrainHeightAt(px, pz) > py + 15) { masked = true; break; }
          }
        }
        let chaffNear = false;
        for (const ch of this.chaffList) {
          if (ch.owner === ms.target && ch.pos.distanceTo(ms.pos) < 1500) { chaffNear = true; break; }
        }
        const beamLimit = chaffNear ? 0.6 : 0.3;
        const needTime = chaffNear ? 0.7 : 0.9;
        if (beam < beamLimit || masked) ms.notchT += dt; else ms.notchT = 0;
        if (ms.notchT > needTime) {
          ms.target = null;
          ms.blind = 1e9;    // permanent lock loss
        }
      }
      this.steerMissile(ms, dt);
      ms.mesh.position.copy(ms.pos);
      ms.mesh.quaternion.copy(ms.quat);
      // same sub-pixel cure as tracers: a 0.16 m fuselage vanishes past
      // ~1.5 km; grow it mildly with range (PIP rides close, stays ~1x)
      ms.mesh.scale.setScalar(Math.min(2.6, Math.max(1, ms.pos.distanceTo(player.position) / 900)));
      ms.smokeT += dt;
      if (ms.smokeT > 0.016) {
        ms.smokeT = 0;
        effects.missileTrail(ms.pos, ms.vel.clone().multiplyScalar(-0.02));
      }
      if (!ms.fromPlayer && player.alive && (ms.target === player || (ms.blind > 0 && ms.blind < 5))) {
        if (ms.kind === 'radar') this.radarInbound = true;
        else this.inboundWarning = true;
        this.inboundDir.copy(ms.pos).sub(player.position).normalize();
      }

      // proximity fuse against EVERY aircraft (decoyed/blind missiles can
      // hit anyone — friendly fire included), but only after arming and
      // never against the launcher itself
      let boom = false, boomPos = ms.pos.clone();
      const armed = ms.life > ms.armT;
      const fuseHit = (t) => {
        if (!liveTarget(t)) return;
        if (t === ms.owner) return;               // launcher immunity
        if (ms.fromPlayer && t === player) return;
        if (!armed) return;
        if (ms.pos.distanceToSquared(t.position) < MISSILE_FUSE_R * MISSILE_FUSE_R) {
          boom = true;
          if (t === player) {
            player.applyDamage(ms.dmg);
            this.lastHit = { dir: _v3.copy(ms.pos).sub(player.position).normalize().clone(), age: 0 };
          } else if (ms.fromPlayer) {
            t.flashT = 0.12;
            this.events.push({ type: 'hitTing' });
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
      const ground = Math.max(terrainHeightAt(ms.pos.x, ms.pos.z), SEA_LEVEL);
      if (!boom && ms.pos.y < ground) boom = true;
      if (!boom && ms.life > ms.ttl) boom = true;
      if (boom) {
        const overSea = terrainHeightAt(boomPos.x, boomPos.z) < SEA_LEVEL + 1;
        if (overSea) effects.waterColumn?.(boomPos, 1.2);
        else effects.explosion?.(boomPos, 0.8);
        this.freeMissile(ms);
        this.missiles.splice(i, 1);
      }
    }
  }
}
