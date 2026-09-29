// enemies.js — enemy fighters on the SAME full-aerodynamics FlightBody as the
// player. The AI computes a world aim direction per state; aimAt() turns the
// stick toward it. Dying aircraft just hold hard stick and let physics spiral.
import * as THREE from 'three';
import { clamp } from './utils.js';
import { GROUND_CLEAR_AGL } from './utils.js';
import { buildJet } from './jet.js';
import { FlightBody } from './flightmodel.js';
import { terrainHeightAt, SEA_LEVEL } from './terrain.js';

const _aim = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _fwd = new THREE.Vector3();

class Enemy {
  constructor(scene, spawnPos, heading, wave) {
    this.scene = scene;
    this.model = buildJet({ paint: 0x5a5f66, accent: 0x8f3a2e });
    scene.add(this.model.group);

    const agility = clamp(0.75 + wave * 0.08, 0.75, 1.3);
    this.body = new FlightBody({ power: agility, thrustMax: 8.2 });
    this.body.setState(spawnPos, heading, 190 + Math.random() * 60);
    this.body.throttle = 0.72;

    this.hp = Math.min(130, 100 + wave * 5);   // one missile (60) leaves it smoking
    this.pilotHit = false;
    this.flareCount = 18;
    this.flareT = 0;
    this.jinkPhase = Math.random() * Math.PI * 2;
    this.jinkFreq = 1.6 + Math.random() * 1.6;
    this.extDir = new THREE.Vector3();
    this.state = 'pursue';
    this.stateTime = 0;
    this.evadeDir = new THREE.Vector3();
    this.fireCooldown = 1.5 + Math.random() * 2;
    this.missileCooldown = 5 + Math.random() * 6;
    this.gunBurst = 0;
    this.lockT = 0;            // missile lock hold time (same 1.15 s rule as the player)
    this.dying = false;
    this.dead = false;
    this.deadTime = 0;
    this.isTarget = false;
    this.wp = new THREE.Vector3();
    this.pickWaypoint();
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

  applyDamage(n) {
    if (this.dying) return false;
    this.hp -= n;
    if (this.hp <= 0) {
      this.dying = Math.random() < 0.55;
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

    if (this.dying) {
      this.deadTime += dt;
      b.ctl.pitch = -0.55; b.ctl.roll = 1; b.ctl.yaw = 0.35;
      b.throttle = 1;
      b.update(dt);
      if (ctx && ctx.effects && Math.random() < 0.75) {
        ctx.effects.damageSmoke(b.pos, _tmp.copy(b.vel).multiplyScalar(-0.02), true);
      }
      const ground = Math.max(terrainHeightAt(b.pos.x, b.pos.z), SEA_LEVEL);
      if (b.pos.y < ground + GROUND_CLEAR_AGL || this.deadTime > 9) {
        this.dead = true;
        if (ctx && ctx.effects) ctx.effects.explosion(b.pos, 1.4);
        if (ctx && ctx.onKill) ctx.onKill(this, true);
      }
      this.syncModel();
      return;
    }

    // --- state selection: incoming missiles outrank everything ---
    const inbound = ctx && ctx.weapons
      ? ctx.weapons.missiles.find(m => m.target === this && m.blind <= 0
          && m.pos.distanceTo(b.pos) < 2300)
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
    } else if (dist > 4500) {
      this.state = 'patrol';
    } else {
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
      // jink on the way in: weave, don't charge in a straight line — but
      // stop weaving when lined up, or the pilot breaks their own lock
      if (dist > 700 && dist < 2600 && aimDot < 0.93) {
        b.rightVec(_fwd);
        b.upVec(_tmp);
        const w = Math.sin(this.stateTime * this.jinkFreq + this.jinkPhase);
        _aim.addScaledVector(_fwd, w * 0.28).addScaledVector(_tmp, Math.sin(this.stateTime * this.jinkFreq * 0.7) * 0.14).normalize();
      }
      targetSpeed = dist < 700 ? 230 : dist < 1500 ? 290 : 380;   // close the gap hard, then settle
    } else {
      if (b.pos.distanceTo(this.wp) < 700 || this.stateTime > 12) { this.pickWaypoint(player.position); this.stateTime = 0; }
      _aim.copy(this.wp).sub(b.pos).normalize();
      targetSpeed = 230;
    }

    // --- ground avoidance override ---
    const ground = Math.max(terrainHeightAt(b.pos.x, b.pos.z), SEA_LEVEL);
    if (b.pos.y - ground < 450) {
      _aim.set(b.pos.x - _fwd.x * 800, b.pos.y + 3500, b.pos.z - _fwd.z * 800).sub(b.pos).normalize();
    }

    b.aimAt(_aim);
    b.throttle = clamp(0.5 + (targetSpeed - b.airspeed) * 0.008, 0.15, 1);
    b.burner = 0;
    b.update(dt);

    // --- weapons ---
    this.fireCooldown -= dt;
    this.missileCooldown -= dt;
    if (!player.alive) return this.syncModel();
    if (this.state === 'pursue' && dist < 1100 && aimDot > 0.988 && this.fireCooldown <= 0) {
      this.gunBurst = 0.5;
      this.fireCooldown = 1.6 + Math.random() * 2.2;
    }
    if (this.gunBurst > 0 && ctx && ctx.enemyGun) {
      this.gunBurst -= dt;
      ctx.enemyGun(this, player);
    }
    // --- enemy missile lock: SAME rule as the player's — hold the target in
    //     the nose cone for 1.15 s before launch (fairness parity) ---
    const canTrack = this.state !== 'patrol' && dist < 2600 && aimDot > 0.90;
    this.lockT = canTrack ? this.lockT + dt : 0;
    if (this.missileCooldown <= 0 && this.lockT >= 1.15) {
      this.missileCooldown = 7 + Math.random() * 7;
      this.lockT = 0;
      if (ctx && ctx.enemyMissile) ctx.enemyMissile(this, player);
    }
    this.syncModel();
  }

  syncModel() {
    this.model.group.position.copy(this.body.pos);
    this.model.group.quaternion.copy(this.body.quat);
    if (this.model.setControlSurfaces) this.model.setControlSurfaces(this.body.ctl);
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
  }

  reset() {
    for (const e of this.enemies) e.dispose();
    this.enemies.length = 0;
    this.wave = 0;
    this.waveActive = false;
    this.waveTimer = 2.5;
    this.events.length = 0;
  }

  spawnWave(player) {
    this.wave++;
    const count = Math.min(3 + Math.floor(this.wave * 0.8), 7);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 2600 + Math.random() * 2200;
      const pos = new THREE.Vector3(
        player.position.x + Math.cos(a) * r,
        clamp(player.position.y + (Math.random() - 0.5) * 1200, 1400, 5200),
        player.position.z + Math.sin(a) * r
      );
      const e = new Enemy(this.scene, pos, Math.random() * Math.PI * 2, this.wave);
      this.enemies.push(e);
    }
    this.waveActive = true;
    this.events.push({ type: 'wave', wave: this.wave, count });
  }

  update(dt, player, ctx) {
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      e.update(dt, player, ctx);
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
    if (!this.waveActive) {
      this.waveTimer -= dt;
      if (this.waveTimer <= 0 && player.alive) this.spawnWave(player);
    }
  }
}
