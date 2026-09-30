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

    // player state
    this.ammo = 8;
    this.ammoMax = 8;
    this.ammoRegen = 0;
    this.gunHeat = 0;
    this.lockState = { target: null, progress: 0, locked: false };
    this.mslKind = 'ir';       // selected missile type: 'ir' | 'radar' (R key)
    this.manualTarget = null;  // X-key cycled lock target
    this.flares = 90;          // regenerating countermeasure stock
    this.flareRegenT = 0;
    this.flareList = [];       // live flare entities (decoy IR seekers)
    this.chaffList = [];       // live chaff clouds  (decoy radar seekers)

    this.rounds = [];                // tracers (both sides)
    this.missiles = [];
    this.events = [];                // {type:'crit'} drained by main -> HUD popup
    this.inboundWarning = false;
    this.inboundDir = new THREE.Vector3();

    // tracer pool
    this.tracerPool = [];
    const tracerGeo = new THREE.BoxGeometry(0.24, 0.24, 10);
    this.tracerMatP = tracerMaterial();
    this.tracerMatE = tracerMaterial(); this.tracerMatE.color.setHex(0xff7040);
    for (let i = 0; i < 90; i++) {
      const m = new THREE.Mesh(tracerGeo, this.tracerMatP);
      m.visible = false;
      m.frustumCulled = false;
      scene.add(m);
      this.tracerPool.push(m);
    }
    // missile pool
    this.missilePool = [];
    for (let i = 0; i < 18; i++) this.missilePool.push(buildMissileMesh(scene));
  }

  reset() {
    this.ammo = this.ammoMax;
    this.gunHeat = 0;
    this.lockState = { target: null, progress: 0, locked: false };
    this.flares = 90;
    this.flareRegenT = 0;
    this.flareList.length = 0;
    this.chaffList.length = 0;
    this.mslKind = 'ir';
    this.manualTarget = null;
    for (const r of this.rounds) this.freeTracer(r.mesh);
    for (const ms of this.missiles) this.freeMissile(ms);
    this.rounds.length = 0;
    this.missiles.length = 0;
    this.events.length = 0;
  }

  freeTracer(mesh) { mesh.visible = false; }
  freeMissile(ms) { ms.mesh.visible = false; }

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
      this.flareList.push({ pos, vel, life: 0, ttl: 2.6, owner, rollT: 0.55, rolls: 2, kind: 'ir', emitT: 0 });
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

  // X key: HEAD-SIGHT lock attempt — the aim circle (引导圈) is the helmet
  // sight. Pressing X tries to lock the enemy closest to the circle center
  // inside the ±8° head basket (and inside the current missile's lock range).
  // No passive auto-lock: nothing locks without the explicit command.
  headLockAttempt(player, enemies) {
    const aim = player.aimDir;
    const range = this.mslKind === 'radar' ? 10000 : 5200;
    let best = null, bestDot = 0.990;            // ±8° basket around the circle
    for (const e of enemies) {
      if (e.dying) continue;
      _v.copy(e.position).sub(player.position);
      const dist = _v.length();
      if (dist > range || dist < 90) continue;
      _v.divideScalar(dist);
      const dot = _v.dot(aim);
      if (dot > bestDot) { bestDot = dot; best = e; }
    }
    if (best && best !== this.manualTarget) {
      this.manualTarget = best;
      this.lockState.target = best;
      this.lockState.progress = 0;
      this.lockState.locked = false;
      if (this.audio) this.audio.lockTick();
    }
    // pressing X with nothing (new) in the basket is a no-op: an ongoing or
    // completed lock is kept — X never breaks what it already has
  }

  // after a decoy blind period, the missile may re-acquire ANY aircraft
  reacquire(ms, player, enemies) {
    _v.set(0, 0, -1).applyQuaternion(ms.quat);
    let best = null, bestDot = 0.87;   // ~29 deg seeker cone
    const consider = (t) => {
      if (!t || t.dying || t.alive === false) return;
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

  // ---------- lock-on (head-sight): the lock only exists because X put it
  // there; it holds while the target stays in range and inside ±25° of the
  // VIEW (the pilot's head still points at it). No automatic acquisition. ----------
  updateLock(dt, player, enemies) {
    const ls = this.lockState;
    const aim = player.aimDir;                     // head reference = aim circle
    const range = this.mslKind === 'radar' ? 10000 : 5200;
    if (this.manualTarget) {
      const t = this.manualTarget;
      const valid = !t.dying && t.alive !== false &&
        t.position.distanceTo(player.position) < range &&
        _v.copy(t.position).sub(player.position).normalize().dot(aim) > 0.906;   // ±25° of view
      if (!valid) this.manualTarget = null;
    }
    const best = this.manualTarget;
    if (best !== ls.target) {
      ls.target = best;
      ls.progress = 0;
      ls.locked = false;
    }
    if (best) {
      ls.progress = Math.min(1, ls.progress + dt / 1.15);
      if (ls.progress >= 1 && !ls.locked) {
        ls.locked = true;
        if (this.audio) this.audio.lock();
      }
    } else {
      ls.progress = 0;
      ls.locked = false;
    }
  }

  // ---------- missiles ----------
  launchMissile(origin, quat, fromPlayer, target, owner, kind = 'ir') {
    const mesh = this.missilePool.find(m => !m.visible);
    if (!mesh) return;
    mesh.visible = true;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(quat);
    // per-kind bodies: radar missiles are slower, heavier, longer-legged,
    // wider-locking (10 km) and turn more lazily than IR missiles
    const body = kind === 'radar'
      ? { maxSpeed: fromPlayer ? 780 : 650, turn: fromPlayer ? 2.5 : 2.2, dmg: fromPlayer ? 80 : 55, ttl: 16, lockRange: 10000 }
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

  playerMissile(player, wantFire) {
    if (!wantFire || !player.alive || this.ammo <= 0) return false;
    const ls = this.lockState;
    // spawn under the wing, pointed forward
    const side = (this._side = !(this._side));
    const origin = player.position.clone()
      .addScaledVector(player.forward(new THREE.Vector3()), 2)
      .add(new THREE.Vector3(side ? 3.4 : -3.4, -1.1, 1.5).applyQuaternion(player.quaternion));
    this.launchMissile(origin, player.quaternion, true, ls.locked ? ls.target : null, player, this.mslKind);
    this.ammo--;
    if (ls.locked) ls.progress = 0.35;   // re-lock quickly for the next shot
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
    const hasTarget = ms.target && !ms.target.dying && ms.target.alive !== false;
    if (hasTarget) {
      const dist = ms.pos.distanceTo(ms.target.position);
      const tLead = clamp(dist / 800, 0, 2.0);
      // both sides expose their true velocity vector on the flight body
      _v.copy(ms.target.position).addScaledVector(ms.target.vel, tLead).sub(ms.pos).normalize();
      _m.lookAt(ms.pos, _v2.copy(ms.pos).add(_v), UP);   // -Z of the matrix faces the aim point
      _q.setFromRotationMatrix(_m);
      const maxTurn = ms.turnRate * (ms.life > 0.35 ? 1 : 0.25);
      ms.quat.rotateTowards(_q, maxTurn * dt);
    }
    ms.vel.copy(_v.set(0, 0, -1).applyQuaternion(ms.quat)).multiplyScalar(ms.speed);
    ms.pos.addScaledVector(ms.vel, dt);
  }

  update(dt, player, enemies, effects) {
    // ammo regen
    if (this.ammo < this.ammoMax && player.alive) {
      this.ammoRegen += dt;
      if (this.ammoRegen > 5.5) { this.ammoRegen = 0; this.ammo++; }
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
            effects.hitSpark(r.pos);
            if (killed && !t.dying) effects.explosion(t.position, 1.0);
          } else {
            player.applyDamage(r.dmg);
            effects.hitSpark(r.pos);
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
    for (let i = this.missiles.length - 1; i >= 0; i--) {
      const ms = this.missiles[i];
      ms.life += dt;
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
      if (ms.kind === 'radar' && ms.target && !ms.target.dying && ms.target.alive !== false) {
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
        if (!t || t.dying || t.alive === false) return;
        if (t === ms.owner) return;               // launcher immunity
        if (ms.fromPlayer && t === player) return;
        if (!armed) return;
        if (ms.pos.distanceToSquared(t.position) < MISSILE_FUSE_R * MISSILE_FUSE_R) {
          boom = true;
          if (t === player) {
            player.applyDamage(ms.dmg);
          } else if (ms.fromPlayer) {
            const killed = t.applyDamage(ms.dmg);
            if (killed && !t.dying) {
              effects.explosion(t.position, 1.2);
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
        effects.explosion(boomPos, 0.8);
        this.freeMissile(ms);
        this.missiles.splice(i, 1);
      }
    }
  }
}
