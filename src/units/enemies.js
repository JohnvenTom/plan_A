// enemies.js — enemy fighters on the SAME full-aerodynamics FlightBody as the
// player. The AI computes a world aim direction per state; aimAt() turns the
// stick toward it. Dying aircraft just hold hard stick and let physics spiral.
import * as THREE from 'three';
import { clamp } from '../core/utils.js';
import { GROUND_CLEAR_AGL } from '../core/utils.js';
import { buildJet } from './jet.js';
import { FlightBody } from './flightmodel.js';
import { terrainSurfaceAt, SEA_LEVEL } from '../world/terrain.js';
import { activeMap } from '../world/maps.js';

const _aim = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _fwd = new THREE.Vector3();

// RWR new-contact picket: fixed range where the receiver first hears an
// airframe's emissions (waves spawn just beyond it, so contacts ring as
// they cross in — one chirp per aircraft, re-armed if it leaves and returns)
const RWR_PICKET = 15000;

class Enemy {
  constructor(scene, spawnPos, heading, wave, ace = false) {
    this.scene = scene;
    this.ace = ace;
    this.model = ace
      ? buildJet({ paint: 0x2b2f36, accent: 0xd8b23a })   // ace: charcoal + gold trim
      : buildJet({ paint: 0x5a5f66, accent: 0x8f3a2e });
    scene.add(this.model.group);
    this._mats = [];                                       // for hit-flash emissive pulse
    this.model.group.traverse(o => { if (o.material && o.material.emissive) this._mats.push(o.material); });
    this.flashT = 0;

    const agility = clamp(0.75 + wave * 0.08, 0.75, 1.3) + (ace ? 0.18 : 0);
    this.basePower = agility;
    this.baseThrust = 8.2;
    this.body = new FlightBody({ power: agility, thrustMax: this.baseThrust });
    this.body.setState(spawnPos, heading, 190 + Math.random() * 60);
    this.body.throttle = 0.72;

    this.hp = ace ? 210 : Math.min(130, 100 + wave * 5);   // one missile (60) leaves it smoking
    this.hpMax = this.hp;
    this.updateDamageState();
    this.pilotHit = false;
    this.flareCount = 18;
    this.flareT = 0;
    this.jinkPhase = Math.random() * Math.PI * 2;
    this.jinkFreq = (1.6 + Math.random() * 1.6) * (ace ? 1.35 : 1);
    this.extDir = new THREE.Vector3();
    this.state = 'pursue';
    this.stateTime = 0;
    this.evadeDir = new THREE.Vector3();
    this.fireCooldown = 1.5 + Math.random() * 2;
    this.missileCooldown = 5 + Math.random() * 6;
    this.gunBurst = 0;
    this.lockT = 0;            // missile lock hold time (same 1.15 s rule)
    this.warmT = 0;            // seeker warmup after the lock (1 s)
    // wave 2+: about half the flight carries 10 km radar missiles
    this.mslKind = (wave >= 2 && Math.random() < 0.5) ? 'radar' : 'ir';
    this.dying = false;
    this.dead = false;
    this.deadTime = 0;
    this.isTarget = false;
    this.wp = new THREE.Vector3();
    this.pickWaypoint();
    this.formSlot = null;   // set by spawnWave: offset from the wave leader
  }

  pickWaypoint(playerPos) {
    const a = Math.random() * Math.PI * 2;
    const r = 1500 + Math.random() * 3500;
    const cx = playerPos ? playerPos.x : 0;
    const cz = playerPos ? playerPos.z : 0;
    this.wp.set(cx + Math.cos(a) * r, 1200 + Math.random() * 3200, cz + Math.sin(a) * r);
  }

  // --- delegate to the flight body ---
  get position() { return this.body.pos; }
  get quaternion() { return this.body.quat; }
  get vel() { return this.body.vel; }
  get speed() { return this.body.airspeed; }
  forward(out) { return this.body.forward(out); }
  upVec(out) { return this.body.upVec(out); }

  // damage debilitates continuously: control authority, engine thrust and the
  // AI's speed target all sag with the remaining hp fraction — a half-dead
  // jet flies like one (maneuver floors at 55%, thrust/speed at 75%)
  updateDamageState() {
    const r = clamp(this.hp / this.hpMax, 0, 1);
    this.hpR = r;
    // power band eased down two notches (was 0.55+0.45r): the aimAt fine-aim
    // retunes (snappy near-center bank tracking, then the rudder-first lineup
    // band) made the shared instructor's small-error tracking quicker for
    // everyone; this keeps enemy effective difficulty where it was
    this.body.power = this.basePower * (0.48 + 0.36 * r);
    this.body.thrustMax = this.baseThrust * (0.75 + 0.25 * r);
  }

  applyDamage(n) {
    if (this.dying) return false;
    this.hp -= n;
    this.updateDamageState();
    if (this.hp <= 0) {
      // 70% detonate on the spot, 30% fall out of the fireball in a spin
      this.dying = Math.random() < 0.30;
      if (!this.dying) this.dead = true;
      return true;
    }
    return false;
  }

  update(dt, player, ctx) {
    this.stateTime += dt;
    const b = this.body;
    b.forward(_fwd);
    const dist = _tmp.copy(player.position).sub(b.pos).length();
    // how well our nose points at the player (used by jink gating and weapons)
    const aimDot = b.forward(_fwd).dot(_tmp.copy(player.position).sub(b.pos).normalize());

    // RWR new-contact: a fixed 15 km picket — every airframe rings once as
    // it crosses in, and again if it leaves and comes back. Deliberately
    // decoupled from the HUD scope range (M cycles that): the receiver
    // hears the paint, not what the display happens to be showing
    if (!this.dying && player.alive) {
      const inPicket = dist < RWR_PICKET;
      if (inPicket && !this._rwrIn && ctx && ctx.rwrNewContact) ctx.rwrNewContact();
      this._rwrIn = inPicket;
    }

    if (this.dying) {
      this.deadTime += dt;
      this._rt = this._locked = false;   // a falling wreck radiates nothing
      // the kill is credited the moment the fatal hit lands: a plane falling
      // in flames has lost the fight — no waiting for the ground impact
      if (!this.killCredited && ctx && ctx.onKill) {
        this.killCredited = true;
        ctx.onKill(this, true);
      }
      b.ctl.pitch = -0.55; b.ctl.roll = 1; b.ctl.yaw = 0.35;
      b.throttle = 1;
      b.update(dt);
      if (ctx && ctx.effects && Math.random() < 0.75) {
        ctx.effects.damageSmoke(b.pos, _tmp.copy(b.vel).multiplyScalar(-0.02), 2);
        // the wreck BURNS: licking flame rides the black smoke trail
        // (fresh vector: spawn() keeps vel by reference, shared temps alias)
        if (Math.random() < 0.55) {
          ctx.effects.wreckFire?.(b.pos,
            new THREE.Vector3(b.vel.x * -0.015, b.vel.y * -0.015 + 3, b.vel.z * -0.015));
        }
      }
      // secondary explosions + debris while the wreck falls
      this.boomT = (this.boomT ?? 0.45) - dt;
      if (this.boomT <= 0) {
        this.boomT = 0.5 + Math.random() * 0.4;
        if (ctx && ctx.effects) {
          _tmp.set((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 8).add(b.pos);
          ctx.effects.explosion?.(_tmp, 0.55);
          ctx.effects.debris?.(_tmp, 4);
        }
      }
      const ground = Math.max(terrainSurfaceAt(b.pos.x, b.pos.z), SEA_LEVEL);
      if (b.pos.y < ground + GROUND_CLEAR_AGL || this.deadTime > 9) {
        this.dead = true;
        if (ctx && ctx.effects) {
          if (ground <= SEA_LEVEL + 1) {
            ctx.effects.waterColumn?.(b.pos, 1.6);
            // fuel keeps burning on the sea: a floating slick fire
            ctx.effects.groundFire?.(b.pos, true, 1.0);
          } else {
            ctx.effects.explosion?.(b.pos, 1.4);
            ctx.effects.debris?.(b.pos, 12);
            // crash site burns on: flame pillar + black column
            ctx.effects.groundFire?.(b.pos, false, 1.3);
          }
          ctx.effects.ring?.(b.pos, 1.4);
        }
        // (kill credit already fired at the fatal hit — impact is pure fx)
      }
      this.syncModel(dt);
      return;
    }

    // training drone: a passive flight over the sea range — no pursuit, no
    // weapons, no evasion; the multipath lesson IS the player's loadout call.
    // Custom-range drones carry a WAYPOINT CHAIN: they chase each waypoint
    // in order (per-leg speed/alt overrides live on the waypoint), then
    // either loop back to the first or settle into an orbit around the last
    if (this.training) {
      const T = this.training;
      let spd = T.speed;
      let useOrbit = true;   // ring courses + settled chains + bare targets
      if (T.path && T.path.length && !this._settle) {
        if (this._wpIdx === undefined) this._wpIdx = 0;
        let wp = T.path[this._wpIdx];
        if (Math.hypot(wp.x - b.pos.x, wp.z - b.pos.z) < 300) {   // captured
          if (this._wpIdx < T.path.length - 1) this._wpIdx++;
          else if (T.tail === 'loop' && T.path.length > 1) this._wpIdx = 0;
          else {
            // chain spent: settle into an orbit around the final waypoint
            this._settle = {
              center: { x: wp.x, z: wp.z },
              radius: clamp((wp.speed ?? T.speed) * 4, 800, 2000),
              phase: Math.atan2(b.pos.z - wp.z, b.pos.x - wp.x),
              alt: wp.alt ?? T.alt,
              speed: wp.speed ?? T.speed,
            };
          }
          wp = T.path[this._wpIdx];
        }
        if (!this._settle) {
          useOrbit = false;
          _aim.set(wp.x, wp.alt ?? T.alt, wp.z).sub(b.pos).normalize();
          spd = wp.speed ?? T.speed;
        }
      }
      if (useOrbit) {
        const O = this._settle || T;
        const R = O.radius || clamp((T.speed ?? 240) * 4, 800, 2000);
        this._orbitT = (this._orbitT || 0) + dt;
        // always chase a point ~20° AHEAD on the circle: the lead point
        // carries the correct altitude, so both axes self-correct (a pure
        // tangent aim has no vertical term — the path sags below the nose and
        // the instructor's DC trim eats any constant climb bias we add)
        const ang = (O.phase || 0) + this._orbitT * O.speed / R;
        const lead = ang + 0.35;
        _aim.set(O.center.x + Math.cos(lead) * R, O.alt, O.center.z + Math.sin(lead) * R)
          .sub(b.pos).normalize();
        spd = O.speed;
      }
      b.aimAt(_aim, dt);
      b.throttle = clamp(0.5 + (spd - b.airspeed) * 0.008, 0.15, 1);
      b.burner = 0;
      b.update(dt);
      // sea impact still counts (a drone that slices the water goes down)
      const groundHit = Math.max(terrainSurfaceAt(b.pos.x, b.pos.z), SEA_LEVEL);
      if (b.pos.y < groundHit + GROUND_CLEAR_AGL) {
        this.killCredited = true;
        this.dying = true;
        this.deadTime = 0;
      }
      // launcher drone (defense/intercept courses): periodic missile shots at
      // the player — the orbit itself stays passive, only the missiles bite
      if (T.launch && player.alive && ctx && ctx.enemyMissile
          && b.pos.distanceTo(player.position) < 12000) {
        this._launchT = (this._launchT ?? T.launch.interval * 0.5) - dt;
        if (this._launchT <= 0) {
          this._launchT = T.launch.interval;
          if (T.launch.kind === 'alt') this._altK = !this._altK;
          this.mslKind = T.launch.kind === 'alt' ? (this._altK ? 'ir' : 'radar')
            : (T.launch.kind || 'radar');
          ctx.enemyMissile(this, player);
        }
      }
      this.syncModel(dt);
      return;
    }

    // --- state selection: incoming missiles outrank everything (radar
    //     threats are "seen" much earlier — the AI has its own RWR) ---
    const inbound = ctx && ctx.weapons
      ? ctx.weapons.missiles.find(m => m.target === this && m.blind <= 0
          && m.pos.distanceTo(b.pos) < (m.kind === 'radar' ? 5200 : 2300))
      : null;
    const playerAimingAtMe = player.alive &&
      player.forward(_tmp).dot(_aim.copy(b.pos).sub(player.position).normalize()) > 0.94 && dist < 1300;
    if (this.state === 'dodgeMissile') {
      if (!inbound && this.stateTime > 1.2) { this.state = 'pursue'; this.stateTime = 0; }
    } else if (inbound) {
      this.state = 'dodgeMissile';
      this.stateTime = 0;
    } else if (this.state === 'evade') {
      if (this.stateTime > 2.6 + (this.seedH ?? 0.9)) { this.state = 'pursue'; this.stateTime = 0; }
    } else if (playerAimingAtMe) {
      this.state = 'evade';
      this.stateTime = 0;
      this.seedH = Math.random() * 1.2;
      this.evadeDir.set(Math.random() - 0.5, Math.random() < 0.5 ? -0.6 : 0.75, Math.random() - 0.5)
        .applyQuaternion(player.quaternion).normalize();
    } else if (this.state === 'extend') {
      if (this.stateTime > 2.8) { this.state = 'pursue'; this.stateTime = 0; }
    } else if (dist < 480) {
      // too close: overshoot and extend instead of ramming head-on
      this.state = 'extend';
      this.stateTime = 0;
      this.body.forward(this.extDir);
      this.extDir.applyAxisAngle(_tmp.set(0, 1, 0), (Math.random() < 0.5 ? 1 : -1) * (0.6 + Math.random() * 0.5));
    } else {
      // pursue at any range — with 10 km+ spawns, far contacts must close at
      // attack speed instead of drifting on patrol waypoints
      this.state = 'pursue';
    }

    // --- aim direction per state ---
    let targetSpeed = 300;
    if (this.state === 'dodgeMissile') {
      // beam the missile: fly perpendicular to its approach, vary the side
      const mDir = _tmp.copy(b.pos);
      if (inbound) mDir.sub(inbound.pos).normalize();
      else mDir.sub(player.position).normalize();
      const side = Math.sin(this.stateTime * 1.8 + this.jinkPhase) >= 0 ? 1 : -1;
      _aim.copy(mDir).cross(_fwd.set(0, 1, 0)).normalize().multiplyScalar(side);
      _aim.y = -0.15;
      _aim.normalize();
      targetSpeed = 370;
      this.flareT -= dt;
      if (this.flareT <= 0 && this.flareCount > 0) {
        this.flareT = 0.45;
        this.flareCount = Math.max(0, this.flareCount - 2);
        if (ctx && ctx.deployFlares) ctx.deployFlares(this, 2);
      }
    } else if (this.state === 'extend') {
      _aim.copy(this.extDir).normalize();
      targetSpeed = 360;
    } else if (this.state === 'evade') {
      _aim.copy(this.evadeDir);
      targetSpeed = 340;
    } else if (this.state === 'pursue') {
      // lead pursuit using the player's true velocity vector
      const tLead = clamp(dist / 800, 0, 2.0);
      _aim.copy(player.position).addScaledVector(player.vel, tLead).sub(b.pos).normalize();
      // far out with nobody threatened: slot into the leader's echelon —
      // the wave arrives as a formation (AC style), breaking up on contact
      if (this.formSlot && dist > 4200 && !inbound) {
        const lead = (this._leadRef && !this._leadRef.dead && !this._leadRef.dying)
          ? this._leadRef
          : (this._leadRef = (ctx && ctx.enemies ? ctx.enemies.find(x => !x.formSlot) : null));
        if (lead) {
          _tmp.copy(lead.position).add(this.formSlot);
          _aim.copy(_tmp).sub(b.pos).normalize();
        }
      }
      // jink on the way in: weave, don't charge in a straight line — but
      // stop weaving when lined up, or the pilot breaks their own lock
      if (dist > 700 && dist < 2600 && aimDot < 0.93) {
        b.rightVec(_fwd);
        b.upVec(_tmp);
        const w = Math.sin(this.stateTime * this.jinkFreq + this.jinkPhase);
        _aim.addScaledVector(_fwd, w * 0.28).addScaledVector(_tmp, Math.sin(this.stateTime * this.jinkFreq * 0.7) * 0.14).normalize();
      }
      // border spawns are far out: sprint at full military power until the
      // fight is near, then the normal close-in speed ladder applies
      targetSpeed = dist > 15000 ? 420 : dist < 700 ? 230 : dist < 1500 ? 290 : 380;
    } else {
      if (b.pos.distanceTo(this.wp) < 700 || this.stateTime > 12) { this.pickWaypoint(player.position); this.stateTime = 0; }
      _aim.copy(this.wp).sub(b.pos).normalize();
      targetSpeed = 230;
    }

    // --- ground avoidance override ---
    const ground = Math.max(terrainSurfaceAt(b.pos.x, b.pos.z), SEA_LEVEL);
    if (b.pos.y - ground < 450) {
      _aim.set(b.pos.x - _fwd.x * 800, b.pos.y + 3500, b.pos.z - _fwd.z * 800).sub(b.pos).normalize();
    }

    b.aimAt(_aim, dt);
    // wounded airframe: the AI also SETTLES for a lower speed it can sustain
    const tgtSpd = targetSpeed * (0.75 + 0.25 * (this.hpR ?? 1));
    b.throttle = clamp(0.5 + (tgtSpd - b.airspeed) * 0.008, 0.15, 1);
    // border raids burn afterburner on the long inbound leg (military power
    // alone tops out ~250 m/s level — the sprint needs the burner)
    b.burner = (this.state === 'pursue' && dist > 15000) ? 1 : 0;
    b.update(dt);

    // live plane flew into the dirt (avoidance can't always save it): ride the
    // existing wreck flow for the fall + impact fx, but no kill credit — the
    // ground shot it down, not the player
    const groundHit = Math.max(terrainSurfaceAt(b.pos.x, b.pos.z), SEA_LEVEL);
    if (b.pos.y < groundHit + GROUND_CLEAR_AGL) {
      this.killCredited = true;
      this.dying = true;
      this.deadTime = 0;
      return this.syncModel(dt);
    }

    // --- weapons ---
    this.fireCooldown -= dt;
    this.missileCooldown -= dt;
    if (!player.alive) {
      this._rt = this._locked = false;   // nobody left to paint
      return this.syncModel(dt);
    }
    if (this.state === 'pursue' && dist < 1100 && aimDot > 0.988 && this.fireCooldown <= 0) {
      this.gunBurst = 0.5;
      this.fireCooldown = 1.6 + Math.random() * 2.2;
    }
    if (this.gunBurst > 0 && ctx && ctx.enemyGun) {
      this.gunBurst -= dt;
      ctx.enemyGun(this, player);
    }
    // --- enemy missile lock: hold the target in the nose cone for 1.15 s,
    //     then warm the seeker for 1 s — 2.15 s total pre-launch telegraph
    //     (the player's own head-sight lock is instant; enemy fire control is
    //     deliberately conservative). Radar shooters track from 10 km, IR
    //     shooters from 2.6 km. Guns-only sparring partners skip all of it. ---
    if (!this.noMissile) {
      const lockRange = this.mslKind === 'radar' ? 10000 : 2600;
      const canTrack = (this.state !== 'patrol' || this.mslKind === 'radar') && dist < lockRange && aimDot > 0.90;
      // RWR ladder state: the radar's first sweep across us and the hard
      // lock that follows are PERSISTENT conditions — the manager aggregates
      // them per frame (rwrSwept/rwrLocked) and the audio loop keeps the
      // matching warning ringing until the threat drops. IR shooters carry
      // no radar to sweep with — they stay silent until the launch warning
      const rt = canTrack && this.mslKind === 'radar';
      this._rt = rt;
      if (canTrack) {
        this.lockT += dt;
        if (this.lockT >= 1.15) this.warmT += dt;
      } else {
        this.lockT = 0;
        this.warmT = 0;
      }
      this._locked = rt && this.lockT >= 1.15;
      if (this.missileCooldown <= 0 && this.warmT >= 1.0) {
        this.missileCooldown = 7 + Math.random() * 7;
        this.lockT = 0;
        this.warmT = 0;
        if (ctx && ctx.enemyMissile) ctx.enemyMissile(this, player);
      }
    } else {
      this._rt = this._locked = false;   // guns-only partners carry no radar
    }
    this.syncModel(dt);
  }

  syncModel(dt) {
    this.model.group.position.copy(this.body.pos);
    this.model.group.quaternion.copy(this.body.quat);
    if (this.model.setControlSurfaces) this.model.setControlSurfaces(this.body.ctl);
    // hit flash: white emissive pulse across the airframe
    if (this.flashT > 0) this.flashT -= dt;
    const f = Math.max(0, this.flashT / 0.12) * 0.85;
    for (const m of this._mats) m.emissive.setRGB(f, f, f);
  }

  dispose() {
    this.scene.remove(this.model.group);
    this.model.group.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
  }
}

export class EnemyManager {
  constructor(scene) {
    this.scene = scene;
    this.enemies = [];
    this.wave = 0;
    this.waveTimer = 0;
    this.waveActive = false;
    this.events = [];
    this.training = false;      // range mode: no waves, drones + respawns
    this.respawnQueue = [];     // [{at, spec}] pending drone respawns
    // per-frame RWR threat aggregate: is any radar shooter sweeping / hard
    // locking us right now — the audio loop reads these to keep the
    // warning ringing for as long as the threat persists
    this.rwrSwept = false;
    this.rwrLocked = false;
  }

  reset() {
    for (const e of this.enemies) e.dispose();
    this.enemies.length = 0;
    this.wave = 0;
    this.waveActive = false;
    this.waveTimer = 2.5;
    this.events.length = 0;
    this.training = false;
    this.respawnQueue.length = 0;
  }

  // training range: one passive drone inserted onto its orbit, already
  // flying the tangent so it settles in without a visible join. spec.launch
  // turns it into an orbiting missile launcher (defense/intercept courses)
  spawnTrainingDrone(spec) {
    let pos, heading;
    if (spec.path && spec.path.length) {
      // custom range: spawn ON the placed point, nose toward the first
      // waypoint (heading convention: 0 = -Z north, atan2(-dx,-dz))
      pos = new THREE.Vector3(spec.center.x, spec.alt, spec.center.z);
      const w = spec.path[0];
      heading = Math.atan2(-(w.x - pos.x), -(w.z - pos.z));
    } else {
      const ang = spec.phase || 0;
      pos = new THREE.Vector3(
        spec.center.x + Math.cos(ang) * (spec.radius || 0), spec.alt,
        spec.center.z + Math.sin(ang) * (spec.radius || 0));
      heading = Math.PI - ang;
    }
    const e = new Enemy(this.scene, pos, heading, 1, false);
    e.training = spec;
    e.respSpec = { kind: 'drone', spec };
    this.enemies.push(e);
  }

  // guns-only sparring partner: full AI state machine, missiles removed
  spawnTrainingFighter(player, spec) {
    let pos;
    if (spec.x !== undefined) {
      // custom range: absolute map placement
      pos = new THREE.Vector3(spec.x, Math.min(spec.alt ?? 3000, 4200), spec.z);
    } else {
      const a = spec.phase ?? Math.random() * Math.PI * 2;
      const r = spec.range ?? 7000;
      pos = new THREE.Vector3(
        player.position.x + Math.cos(a) * r,
        Math.min(player.position.y + 600, 4200),
        player.position.z + Math.sin(a) * r);
    }
    const e = new Enemy(this.scene, pos, Math.random() * Math.PI * 2, 1, false);
    e.noMissile = true;
    e.respSpec = { kind: 'fighter', spec };
    this.enemies.push(e);
  }

  queueRespawn(rs) { this.respawnQueue.push({ at: 8, rs }); }

  spawnWave(player) {
    this.wave++;
    const count = Math.min(this.wave, 7);   // wave 1: a lone contact, then +1 per wave
    const aceIdx = this.wave >= 3 && Math.random() < 0.4 ? Math.floor(Math.random() * count) : -1;

    // edge maps (80 km): raids CROSS THE BORDER — a random point on the rim
    // (rolled 1.5 km outside so contacts visually enter the map), re-rolled
    // while it would pop up inside 8 km of the player. Circle maps (classic)
    // keep the player-centered 10–13 km ring so old pacing is untouched.
    let origin = null, bearing = 0, dist = 0;
    if (activeMap.combat.type === 'edge') {
      const rim = activeMap.combat.half + 1500;
      for (let tries = 0; tries < 10 && origin === null; tries++) {
        const side = Math.floor(Math.random() * 4);
        const u = Math.random() * 2 - 1;
        const p = side === 0 ? [ rim, u * rim]
                : side === 1 ? [-rim, u * rim]
                : side === 2 ? [u * rim,  rim]
                :             [u * rim, -rim];
        if (Math.hypot(p[0] - player.position.x, p[1] - player.position.z) >= 8000) origin = p;
      }
      if (origin === null) {   // rim-hugging player: send them from the far corner
        origin = [-Math.sign(player.position.x || 1) * rim, -Math.sign(player.position.z || 1) * rim];
      }
      // heading-tape bearing: SAME compass convention as player.headingDeg
      // (atan2(dx, −dz): 0° = −Z/north, 90° = +X/east) — the old atan2(dx, dz)
      // mirrored north/south, so "fly the announced heading" flew you away
      // from every raid that wasn't dead east/west
      bearing = (Math.atan2(origin[0] - player.position.x, -(origin[1] - player.position.z)) * 180 / Math.PI + 360) % 360;
      dist = Math.hypot(origin[0] - player.position.x, origin[1] - player.position.z) / 1000;
    }

    for (let i = 0; i < count; i++) {
      let pos, heading;
      if (origin) {
        pos = new THREE.Vector3(
          origin[0] + (Math.random() - 0.5) * 1200,                  // spread along the border
          clamp(player.position.y + (Math.random() - 0.5) * 1200, 1400, 5200),
          origin[1] + (Math.random() - 0.5) * 1200
        );
        // nose inbound (this sim's heading convention is atan2(−dx, −dz):
        // forward = −Z rotated about Y, same as startTraining's spawn math)
        heading = Math.atan2(-(player.position.x - pos.x), -(player.position.z - pos.z));
      } else {
        const a = Math.random() * Math.PI * 2;
        const r = 10000 + Math.random() * 3000;   // spawn beyond 10 km: contacts
        pos = new THREE.Vector3(                  // appear on radar, not on top of you
          player.position.x + Math.cos(a) * r,
          clamp(player.position.y + (Math.random() - 0.5) * 1200, 1400, 5200),
          player.position.z + Math.sin(a) * r
        );
        heading = Math.random() * Math.PI * 2;
      }
      const e = new Enemy(this.scene, pos, heading, this.wave, i === aceIdx);
      // echelon-right formation offsets behind the first-spawned leader
      e.formSlot = i === 0 ? null : new THREE.Vector3(i * 90, -i * 14, i * 110);
      this.enemies.push(e);
    }
    this.waveActive = true;
    this.events.push({ type: 'wave', wave: this.wave, count, bearing, dist });
    if (aceIdx >= 0) this.events.push({ type: 'ace' });
  }

  update(dt, player, ctx) {
    this.rwrSwept = false;
    this.rwrLocked = false;
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      e.update(dt, player, ctx);
      if (e._rt) this.rwrSwept = true;
      if (e._locked) this.rwrLocked = true;
      if (e.dead) {
        if (!e.dying && ctx && ctx.onKill) ctx.onKill(e, false);
        e.dispose();
        this.enemies.splice(i, 1);
      }
    }
    if (this.waveActive && this.enemies.length === 0) {
      this.waveActive = false;
      this.waveTimer = 6;
      this.events.push({ type: 'waveClear', wave: this.wave });
    }
    if (!this.waveActive && !this.training) {
      this.waveTimer -= dt;
      if (this.waveTimer <= 0 && player.alive) this.spawnWave(player);
    }
    // training range: drones come back on their orbits after a beat
    for (let i = this.respawnQueue.length - 1; i >= 0; i--) {
      this.respawnQueue[i].at -= dt;
      if (this.respawnQueue[i].at <= 0) {
        const rs = this.respawnQueue[i].rs;
        if (rs.kind === 'drone') this.spawnTrainingDrone({ ...rs.spec, phase: Math.random() * Math.PI * 2 });
        else this.spawnTrainingFighter(player, rs.spec);
        this.respawnQueue.splice(i, 1);
      }
    }
  }
}
