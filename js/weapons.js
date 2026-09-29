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
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(enemy.quaternion ?? enemy.obj.quaternion);
    const origin = enemy.position.clone().addScaledVector(fwd, 10);
    const aim = player.position.clone()
      .addScaledVector(player.forward(new THREE.Vector3()), player.speed * 0.4)
      .sub(origin).normalize();
    this.fireGun(origin, aim, 950 + enemy.speed, false, 3, 0.016);
  }

  // ---------- lock-on ----------
  updateLock(dt, player, enemies) {
    const ls = this.lockState;
    const fwd = player.forward(new THREE.Vector3());
    let best = null, bestDot = 0.905;   // ~25 deg cone
    for (const e of enemies) {
      if (e.dying) continue;
      _v.copy(e.position).sub(player.position);
      const dist = _v.length();
      if (dist > 5200 || dist < 90) continue;
      _v.divideScalar(dist);
      const dot = _v.dot(fwd);
      if (dot > bestDot) { bestDot = dot; best = e; }
    }
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
  launchMissile(origin, quat, fromPlayer, target) {
    const mesh = this.missilePool.find(m => !m.visible);
    if (!mesh) return;
    mesh.visible = true;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(quat);
    this.missiles.push({
      pos: origin.clone(),
      quat: quat.clone(),
      vel: fwd.clone().multiplyScalar(200),
      speed: 200,
      life: 0,
      ttl: 8.5,
      fromPlayer,
      target,
      mesh,
      smokeT: 0,
    });
    if (this.audio) this.audio.missileLaunch();
  }

  playerMissile(player, wantFire) {
    if (!wantFire || !player.alive || this.ammo <= 0) return false;
    const ls = this.lockState;
    // spawn under the wing, pointed forward
    const side = (this._side = !(this._side)); 
    const origin = player.position.clone()
      .addScaledVector(player.forward(new THREE.Vector3()), 2)
      .add(new THREE.Vector3(side ? 3.4 : -3.4, -1.1, 1.5).applyQuaternion(player.quaternion));
    this.launchMissile(origin, player.quaternion, true, ls.locked ? ls.target : null);
    this.ammo--;
    if (ls.locked) ls.progress = 0.35;   // re-lock quickly for the next shot
    return true;
  }

  enemyMissile(enemy, player) {
    const origin = enemy.position.clone().addScaledVector(
      new THREE.Vector3(0, 0, -1).applyQuaternion(enemy.obj.quaternion), 2);
    this.launchMissile(origin, enemy.obj.quaternion, false, player);
  }

  steerMissile(ms, dt) {
    // accelerate, then steer toward a lead point with a turn-rate clamp
    ms.speed = Math.min(ms.speed + 620 * dt, ms.fromPlayer ? 880 : 700);
    const hasTarget = ms.target && !ms.target.dying && ms.target.alive !== false;
    if (hasTarget) {
      const dist = ms.pos.distanceTo(ms.target.position);
      const tLead = clamp(dist / 800, 0, 2.0);
      // target velocity: enemies expose obj.quaternion, the player exposes forward()
      const tvel = ms.target.obj
        ? _v3.set(0, 0, -1).applyQuaternion(ms.target.obj.quaternion).multiplyScalar(ms.target.speed)
        : this.playerRef.forward(_v3).multiplyScalar(this.playerRef.speed);
      _v.copy(ms.target.position).addScaledVector(tvel, tLead).sub(ms.pos).normalize();
      _m.lookAt(ms.pos, _v2.copy(ms.pos).add(_v), UP);   // -Z of the matrix faces the aim point
      _q.setFromRotationMatrix(_m);
      const maxTurn = (ms.fromPlayer ? 3.4 : 2.55) * (ms.life > 0.35 ? 1 : 0.25);
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

    // --- missiles ---
    this.inboundWarning = false;
    for (let i = this.missiles.length - 1; i >= 0; i--) {
      const ms = this.missiles[i];
      ms.life += dt;
      this.steerMissile(ms, dt);
      ms.mesh.position.copy(ms.pos);
      ms.mesh.quaternion.copy(ms.quat);
      ms.smokeT += dt;
      if (ms.smokeT > 0.016) {
        ms.smokeT = 0;
        effects.missileTrail(ms.pos, ms.vel.clone().multiplyScalar(-0.02));
      }
      if (!ms.fromPlayer && player.alive) {
        this.inboundWarning = true;
        this.inboundDir.copy(ms.pos).sub(player.position).normalize();
      }

      // proximity fuse
      let boom = false, boomPos = ms.pos.clone();
      if (ms.target && !ms.target.dying && ms.target.alive !== false) {
        if (ms.pos.distanceToSquared(ms.target.position) < MISSILE_FUSE_R * MISSILE_FUSE_R) {
          boom = true;
          if (ms.fromPlayer) {
            const killed = ms.target.applyDamage(60);
            if (killed && !ms.target.dying) {
              effects.explosion(ms.target.position, 1.2);
            } else if (!ms.target.dying) {
              // missile struck the cockpit area but did not destroy it:
              // pilot hit — the plane starts smoking immediately
              ms.target.pilotHit = true;
              this.events.push({ type: 'crit' });
            }
          } else {
            player.applyDamage(38);
          }
        }
      }
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
