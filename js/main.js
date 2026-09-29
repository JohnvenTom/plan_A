// main.js — bootstrap, game states, wiring, and the ?t=N freeze harness
import * as THREE from 'three';
import { Input } from './input.js';
import { Sky } from './sky.js';
import { buildTerrain, buildOcean } from './terrain.js';
import { Player } from './player.js';
import { EnemyManager } from './enemies.js';
import { Weapons } from './weapons.js';
import { Effects } from './effects.js';
import { HUD } from './hud.js';
import { GameAudio } from './audio.js';
import { clamp } from './utils.js';

const q = new URLSearchParams(location.search);
const FREEZE_T = q.has('t') ? Math.max(0, parseFloat(q.get('t')) || 0) : null;
const DEBUG = q.has('debug');
// debug hook for headless probes
window.__game = null;

// ---------- renderer / scene (single output owner: ACES + sRGB here) ----------
const canvas = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.75));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.18;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(66, innerWidth / innerHeight, 0.6, 72000);

const sky = new Sky(scene);
buildTerrain(scene);
const ocean = buildOcean(scene);
const effects = new Effects(scene);
const player = new Player(scene, camera);
const weapons = new Weapons(scene, effects);
const enemies = new EnemyManager(scene);
const hud = new HUD(document.getElementById('hud'));
const audio = new GameAudio();
const input = new Input();
weapons.playerRef = player;
weapons.audio = audio;

const flashEl = document.getElementById('flash');
const titleEl = document.getElementById('title');
const goEl = document.getElementById('gameover');

// ---------- game state ----------
const G = {
  state: 'title',           // title | playing | gameover
  kills: 0, score: 0,
  time: 0, deathTimer: 0, paused: false,
  contrailT: 0, smokeT: 0,
};

const killCtx = {
  effects,
  onKill(enemy, crashed) {
    G.kills++; G.score += 250 + enemies.wave * 25;
    hud.announce('击坠确认', `TARGET DESTROYED  +${250 + enemies.wave * 25}`, 2.4);
    audio.kill();
    flashKill();
  },
  enemyGun: (e, p) => weapons.enemyGun(e, p),
  enemyMissile: (e, p) => weapons.enemyMissile(e, p),
};

function flashKill() {
  flashEl.style.transition = 'none';
  flashEl.style.opacity = '0.25';
  requestAnimationFrame(() => {
    flashEl.style.transition = 'opacity .6s ease';
    flashEl.style.opacity = '0';
  });
}

function resetAll() {
  G.kills = 0; G.score = 0; G.time = 0; G.deathTimer = 0; G.paused = false;
  player.reset();
  enemies.reset();
  weapons.reset();
  hud.msgQueue.length = 0;
  hud.announce('任务开始', 'OPERATION GOLDEN HOUR', 3.0);
}

function startGame() {
  audio.init(); audio.resume();
  resetAll();
  G.state = 'playing';
  titleEl.classList.add('hidden');
  goEl.classList.add('hidden');
}

function gameOver() {
  G.state = 'gameover';
  document.getElementById('go-score').textContent = String(G.kills);
  const win = false;
  document.getElementById('go-title').textContent = 'MISSION FAILED';
  document.getElementById('go-sub').textContent = player.crashed ? '机体触地坠毁' : '机体损毁';
  goEl.classList.remove('hidden');
}

// ---------- per-frame simulation ----------
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

function update(dt) {
  G.time += dt;

  if (G.state === 'playing' && !G.paused) {
    player.update(dt, input, {});
    if (!player.alive) {
      if (G.deathTimer === 0) {
        effects.explosion(player.position, 2.2);
        audio.explosion(1);
        player.model.group.visible = false;
      }
      G.deathTimer += dt;
      if (G.deathTimer > 2.4) gameOver();
    }

    // out-of-area enforcement
    if (player.outOfAreaTime > 15) player.applyDamage(999);

    // player weapons
    const firing = input.down('Space') || input.mouse(0);
    weapons.playerGun(player, dt, firing && player.alive, enemies.enemies);
    const wantMissile = input.pressed('KeyF') || input.mousePressed(2);
    if (wantMissile) weapons.playerMissile(player, true);
    weapons.updateLock(dt, player, enemies.enemies);

    // world
    enemies.update(dt, player, player.alive ? killCtx : { effects });
    weapons.update(dt, player, enemies.enemies, effects);

    // drain enemy-manager events into HUD announcements
    for (const ev of enemies.events) {
      if (ev.type === 'wave') hud.announce(`WAVE ${ev.wave}`, `敌机接近 — ${ev.count} 机`, 3.0);
      else if (ev.type === 'waveClear') hud.announce('WAVE CLEAR', '敌机全灭 — 下一波接近中', 2.6);
    }
    enemies.events.length = 0;

    // player contrails + damage smoke
    G.contrailT += dt;
    const turning = input.down('KeyA') || input.down('KeyD') || input.down('ArrowLeft') || input.down('ArrowRight');
    if (G.contrailT > 0.03 && (player.speed > 360 || turning) && player.position.y > 1600) {
      G.contrailT = 0;
      player.model.anchors.wingL.getWorldPosition(_v);
      player.model.anchors.wingR.getWorldPosition(_v2);
      effects.contrail(_v); effects.contrail(_v2);
    }
    G.smokeT += dt;
    if (player.hp < 55 && G.smokeT > 0.06 && player.alive) {
      G.smokeT = 0;
      player.model.anchors.tail.getWorldPosition(_v);
      effects.damageSmoke(_v, _v2.set(0, 0, 0), player.hp < 25);
    }
    for (const e of enemies.enemies) {
      if (e.hp < 22 && !e.dying && Math.random() < 0.5) {
        e.model.anchors.tail.getWorldPosition(_v);
        effects.damageSmoke(_v, _v2.set(0, 0, 0), true);
      }
    }

    audio.update(dt, player, weapons);
  }

  effects.update(dt);
  sky.update(dt, camera.position);

  // ocean follows the camera; uniforms stay in sync with the one atmosphere model
  ocean.mesh.position.x = camera.position.x;
  ocean.mesh.position.z = camera.position.z;
  ocean.mat.uniforms.uCamPos.value.copy(camera.position);
  ocean.mat.uniforms.uTime.value = G.time;
  ocean.mat.uniforms.uSunDir.value.copy(sky.sunDir);
  ocean.mat.uniforms.uFogColor.value.copy(scene.fog.color);
  ocean.mat.uniforms.uFogDensity.value = scene.fog.density;
}

function renderHUD() {
  hud.draw(1 / 60, {
    state: G.state,
    player, camera,
    enemies: enemies.enemies,
    weapons,
    kills: G.kills, score: G.score, wave: enemies.wave,
    time: G.time,
  });
}

// ---------- freeze harness: deterministic still at ?t=N ----------
function freezeFrame() {
  titleEl.classList.add('hidden');
  goEl.classList.add('hidden');
  G.state = 'playing';
  resetAll();
  const dt = 1 / 60;
  const steps = Math.max(90, Math.round(FREEZE_T / dt));   // >=1.5 s so the camera settles
  let missileShots = 0;
  const shotTimes = [4.2, 9.0, 13.5];
  for (let i = 0; i < steps; i++) {
    update(dt);
    // scripted shots so stills can catch trails/impacts (freeze mode only)
    if (missileShots < shotTimes.length && G.time >= shotTimes[missileShots]) {
      missileShots++;
      if (weapons.lockState.target) weapons.playerMissile(player, true);
    }
  }
  renderer.render(scene, camera);
  renderHUD();
  window.__ready = true;
  window.__game = {
    time: G.time, state: G.state, kills: G.kills,
    enemies: enemies.enemies.map(e => ({
      hp: Math.round(e.hp), dying: e.dying, state: e.state,
      dist: Math.round(e.position.distanceTo(player.position)),
    })),
    missiles: weapons.missiles.map(m => ({
      fromPlayer: m.fromPlayer, age: Math.round(m.life * 10) / 10,
      hasTarget: !!m.target,
    })),
    lock: weapons.lockState.locked,
    ammo: weapons.ammo,
    playerPos: [Math.round(player.position.x), Math.round(player.position.y), Math.round(player.position.z)],
    playerAlive: player.alive,
  };
}

// ---------- live loop ----------
const clock = new THREE.Clock();
function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);

  if (G.state === 'title') {
    if (input.pressed('Enter') || input.mousePressed(0)) startGame();
    // idle orbit so the title screen isn't static
    G.time += dt;
    const a = G.time * 0.05;
    camera.position.set(Math.sin(a) * 5200, 1900 + Math.sin(a * 0.7) * 300, Math.cos(a) * 5200);
    camera.up.set(0, 1, 0);
    camera.lookAt(0, 900, 0);
    sky.update(dt, camera.position);
    ocean.mesh.position.x = camera.position.x;
    ocean.mesh.position.z = camera.position.z;
    ocean.mat.uniforms.uCamPos.value.copy(camera.position);
    ocean.mat.uniforms.uTime.value = G.time;
    ocean.mat.uniforms.uSunDir.value.copy(sky.sunDir);
    effects.update(dt);
    hud.draw(dt, { state: 'title' });
  } else {
    if (G.state === 'gameover' && input.pressed('Enter')) { startGame(); }
    else if (G.state === 'playing' && input.pressed('KeyP')) G.paused = !G.paused;
    if (G.paused) {
      hud.announce('PAUSED', '按 P 继续', 999);
    }
    update(dt);
    renderer.render(scene, camera);
    renderHUD();
    if (DEBUG) {
      window.__game = {
        time: G.time, state: G.state, kills: G.kills, alive: player.alive,
        hp: Math.round(player.hp), speed: Math.round(player.speed),
        enemies: enemies.enemies.map(e => ({
          hp: Math.round(e.hp), dying: e.dying, state: e.state,
          dist: Math.round(e.position.distanceTo(player.position)),
        })),
        missiles: weapons.missiles.map(m => ({ fromPlayer: m.fromPlayer, age: Math.round(m.life * 10) / 10 })),
        lock: weapons.lockState.locked, ammo: weapons.ammo,
      };
    }
  }
  input.endFrame();
  requestAnimationFrame(frame);
}

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

if (FREEZE_T !== null) {
  freezeFrame();
} else {
  player.reset();           // park the jet for the title backdrop
  frame();
}
