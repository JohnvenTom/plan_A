// enemies.js — enemy fighters: patrol/pursue/evade state machine + wave spawner
import * as THREE from 'three';
import { clamp, wrapAngle } from './utils.js';
import { GROUND_CLEAR_AGL } from './utils.js';
import { buildJet } from './jet.js';
import { terrainHeightAt, SEA_LEVEL } from './terrain.js';

const _local = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _qInv = new THREE.Quaternion();

class Enemy {
  constructor(scene, spawnPos, heading, wave) {
    this.scene = scene;
    this.model = buildJet({ paint: 0x5a5f66, accent: 0x8f3a2e });
    scene.add(this.model.group);
    this.obj = new THREE.Object3D();
    this.obj.position.copy(spawnPos);
    this.obj.rotation.y = heading;
    this.speed = 190 + Math.random() * 60;
    this.agility = clamp(0.75 + wave * 0.08, 0.75, 1.35);
    this.hp = Math.min(130, 100 + wave * 5);   // one missile (60) leaves it smoking
    this.pilotHit = false;
    this.state = 'pursue';
    this.stateTime = 0;
    this.evadeDir = new THREE.Vector3();
    this.fireCooldown = 1.5 + Math.random() * 2;
    this.missileCooldown = 5 + Math.random() * 6;
    this.gunBurst = 0;
    this.dying = false;
    this.dead = false;
    this.deadTime = 0;
    this.isTarget = false;
    this.rollRate = 0;
    this.wp = new THREE.Vector3();
    this.pickWaypoint();
  }

  pickWaypoint() {
    const a = Math.random() * Math.PI * 2;
    const r = 1500 + Math.random() * 5000;
    this.wp.set(Math.cos(a) * r, 1200 + Math.random() * 3200, Math.sin(a) * r);
  }

  get position() { return this.obj.position; }

  applyDamage(n) {
    if (this.dying) return false;
    this.hp -= n;
    if (this.hp <= 0) {
      this.dying = Math.random() < 0.55;   // some spiral down, some pop
      if (!this.dying) this.dead = true;
      return true;
    }
    return false;
  }

  steerToward(dir, dt, rollAggr = 1.0, pitchMul = 1.0) {
    // convert world desired-direction into local steering
    _qInv.copy(this.obj.quaternion).invert();
    _local.copy(dir).applyQuaternion(_qInv).normalize();
    const yawIn = clamp(_local.x * 2.2, -1, 1);
    const pitchIn = clamp(_local.y * 2.6, -1, 1) * pitchMul;
    // bank into the turn, level out when aligned
    const rollIn = clamp(yawIn * 1.6 * rollAggr - this.bankError() * 0.7, -1, 1);
    const e = new THREE.Euler(pitchIn * 1.05 * this.agility * dt,
                              yawIn * 0.38 * this.agility * dt,
                              rollIn * 3.1 * this.agility * dt, 'XYZ');
    const q = new THREE.Quaternion().setFromEuler(e);
    this.obj.quaternion.multiply(q).normalize();
  }

  bankError() {  // roll angle away from level (roughly)
    _fwd.set(0, 0, -1).applyQuaternion(this.obj.quaternion);
    _tmp.set(1, 0, 0).applyQuaternion(this.obj.quaternion);
    return _tmp.y;
  }

  update(dt, player, ctx) {
    this.stateTime += dt;
    const toPlayer = _tmp.copy(player.position).sub(this.obj.position);
    const dist = toPlayer.length();
    toPlayer.normalize();

    if (this.dying) {
      this.deadTime += dt;
      // uncontrolled spiral
      const e = new THREE.Euler(-0.9 * dt, 0.3 * dt, 3.4 * dt, 'XYZ');
      this.obj.quaternion.multiply(new THREE.Quaternion().setFromEuler(e));
      _fwd.set(0, 0, -1).applyQuaternion(this.obj.quaternion);
      this.speed = Math.min(320, this.speed + 40 * dt);
      this.obj.position.addScaledVector(_fwd, this.speed * dt);
      if (ctx && ctx.effects && Math.random() < 0.75) {
        ctx.effects.damageSmoke(this.obj.position, _fwd.clone().multiplyScalar(-0.3), true);
      }
      const ground = Math.max(terrainHeightAt(this.obj.position.x, this.obj.position.z), SEA_LEVEL);
      if (this.obj.position.y < ground + GROUND_CLEAR_AGL || this.deadTime > 7) {
        this.dead = true;
        if (ctx && ctx.effects) ctx.effects.explosion(this.obj.position, 1.4);
        if (ctx && ctx.onKill) ctx.onKill(this, true);
      }
      this.syncModel();
      return;
    }

    // --- state selection ---
    const behindDot = toPlayer.dot(player.forward(_fwd.set(0, 0, -1))) ; // player's forward vs enemy direction
    const playerAimingAtMe = player.forward(new THREE.Vector3()).dot(toPlayer.clone().negate()) > 0.94 && dist < 1300;
    if (this.state === 'evade') {
      if (this.stateTime > 2.6 + (this.seedH ?? 0.9)) { this.state = 'pursue'; this.stateTime = 0; }
    } else if (playerAimingAtMe && Math.random() < 0.9) {
      this.state = 'evade';
      this.stateTime = 0;
      this.seedH = Math.random() * 1.2;
      this.evadeDir.set(Math.random() - 0.5, Math.random() < 0.5 ? -0.6 : 0.75, Math.random() - 0.5)
        .applyQuaternion(player.quaternion).normalize();
    } else if (dist > 4500) {
      this.state = 'patrol';
    } else {
      this.state = 'pursue';
    }

    // --- steering by state ---
    if (this.state === 'evade') {
      this.steerToward(this.evadeDir, dt, 1.4, 1.25);
      this.speed = Math.min(330, this.speed + 55 * dt);
    } else if (this.state === 'pursue') {
      // lead pursuit: aim ahead of the player's motion
      const lead = _local.copy(player.position).addScaledVector(player.forward(new THREE.Vector3()), player.speed * 0.55);
      _tmp.copy(lead).sub(this.obj.position).normalize();
      this.steerToward(_tmp, dt, 1.0);
      this.speed += (dist < 900 ? -30 : 35) * dt;
    } else {
      if (this.obj.position.distanceTo(this.wp) < 700 || this.stateTime > 12) { this.pickWaypoint(); this.stateTime = 0; }
      _tmp.copy(this.wp).sub(this.obj.position).normalize();
      this.steerToward(_tmp, dt, 0.7);
      this.speed += 20 * dt;
    }
    this.speed = clamp(this.speed, 130, 340);

    // --- ground avoidance override ---
    const ground = Math.max(terrainHeightAt(this.obj.position.x, this.obj.position.z), SEA_LEVEL);
    const agl = this.obj.position.y - ground;
    if (agl < 420) {
      const climb = _tmp.set(this.obj.position.x - 500, this.obj.position.y + 3000, this.obj.position.z - 500).sub(this.obj.position).normalize();
      this.steerToward(climb, dt, 0.5, 1.0);
    }

    // --- integrate ---
    _fwd.set(0, 0, -1).applyQuaternion(this.obj.quaternion);
    this.obj.position.addScaledVector(_fwd, this.speed * dt);

    // --- weapons ---
    this.fireCooldown -= dt;
    this.missileCooldown -= dt;
    if (!player.alive) return this.syncModel();
    const aimDot = _fwd.dot(toPlayer);
    if (this.state === 'pursue' && dist < 1100 && aimDot > 0.990 && this.fireCooldown <= 0) {
      this.gunBurst = 0.5;
      this.fireCooldown = 1.6 + Math.random() * 2.2;
    }
    if (this.gunBurst > 0 && ctx && ctx.enemyGun) {
      this.gunBurst -= dt;
      ctx.enemyGun(this, player);
    }
    if (this.missileCooldown <= 0 && dist < 2600 && aimDot > 0.90 && this.state !== 'patrol') {
      this.missileCooldown = 7 + Math.random() * 7;
      if (ctx && ctx.enemyMissile) ctx.enemyMissile(this, player);
    }
    this.syncModel();
  }

  syncModel() {
    this.model.group.position.copy(this.obj.position);
    this.model.group.quaternion.copy(this.obj.quaternion);
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
