// main.js — bootstrap, game states, wiring, and the ?t=N freeze harness
import * as THREE from 'three';
import { Input, DEFAULT_BINDINGS, ACTION_LABELS, codeLabel } from './input.js';
import { Sky } from './sky.js';
import { Weather } from './weather.js';
import { buildTerrain, buildOcean } from './terrain.js';
import { Player } from './player.js';
import { loadF14 } from './f14.js';
import { EnemyManager } from './enemies.js';
import { Weapons } from './weapons.js';
import { Effects } from './effects.js';
import { HUD } from './hud.js';
import { GameAudio } from './audio.js';
import { clamp, smoothstep } from './utils.js';

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
const camera = new THREE.PerspectiveCamera(66, innerWidth / innerHeight, 2.5, 72000);

const sky = new Sky(scene);
const weather = new Weather(scene, sky, renderer);
buildTerrain(scene);
const ocean = buildOcean(scene);
const effects = new Effects(scene);
const player = new Player(scene, camera);
// async F-14 GLB: swaps in whenever it arrives; falls back silently to the
// procedural jet if the asset is absent (freeze mode waits for the verdict)
const f14Ready = loadF14();
f14Ready.then(m => { if (m) player.swapModel(m); });
const weapons = new Weapons(scene, effects);
const enemies = new EnemyManager(scene);
const hud = new HUD(document.getElementById('hud'));
window.__hud = hud;   // debug hook
window.__weapons = weapons;   // debug hook
window.__player = player;     // debug hook
window.__enemies = enemies;   // debug hook
window.__weather = weather;   // debug hook
window.__scene = scene;       // debug hook (screenshot harness: __renderer.render(__scene, __player.camera))
window.__renderer = renderer; // debug hook
const audio = new GameAudio();
const input = new Input();
weapons.playerRef = player;
weapons.audio = audio;
weapons.hud = hud;

const flashEl = document.getElementById('flash');
const titleEl = document.getElementById('title');
const goEl = document.getElementById('gameover');

// ---------- game state ----------
const G = {
  state: 'title',           // title | playing | gameover
  kills: 0, score: 0,
  time: 0, deathTimer: 0, paused: false, menuOpen: false,
  contrailT: 0, smokeT: 0,
};

const killCtx = {
  effects,
  weapons,
  deployFlares: (owner, n) => weapons.deployFlares(owner, n),
  onKill(enemy, crashed) {
    G.kills++; G.score += 250 + enemies.wave * 25;
    hud.announce('摧毁目标', `TARGET DESTROYED  +${250 + enemies.wave * 25}`, 2.2, 'kill');
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
  hud.announce('任务开始', 'OPERATION GOLDEN HOUR', 3.0, 'info');
}

function startGame() {
  audio.init(); audio.resume(); audio.setRunning(true);
  resetAll();
  G.state = 'playing';
  titleEl.classList.add('hidden');
  goEl.classList.add('hidden');
  try { canvas.requestPointerLock?.(); } catch (_) { /* fallback: delta mode */ }
}

function setPaused(v) {
  if (G.paused === v) return;
  G.paused = v;
  audio.setRunning(!v);
  if (v) {
    hud.msgQueue.length = 0;
    hud.announce('已暂停', '按 P / ESC 或 点击 继续', 9999, 'info', true);
  } else {
    hud.clearSticky();
  }
}

function gameOver() {
  G.state = 'gameover';
  audio.setRunning(false);
  if (document.pointerLockElement) document.exitPointerLock();
  hud.msgQueue.length = 0;
  document.getElementById('go-score').textContent = String(G.kills);
  const win = false;
  document.getElementById('go-title').textContent = 'MISSION FAILED';
  document.getElementById('go-sub').textContent = player.crashed ? '机体触地坠毁' : '机体损毁';
  goEl.classList.remove('hidden');
}


// ---------- environment: 8-minute day/night cycle + dynamic weather ----------
const DAY_LEN = 480;                       // seconds for a full day
function updateEnvironment(dt) {
  weather.update(dt, camera);
  const day01 = (G.time / DAY_LEN + 0.46) % 1;   // missions start at golden hour
  const elevSin = Math.sin(day01 * Math.PI * 2);
  const night01 = 1 - smoothstep(-0.14, 0.09, elevSin);
  sky.setCycle(day01, night01, sky.weatherParams);
  ocean.mat.uniforms.uNight.value = night01;
  G.day01 = day01; G.night01 = night01;
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
        audio.setRunning(false, 1.6);   // engine fades under the death boom
        player.model.group.visible = false;
      }
      G.deathTimer += dt;
      if (G.deathTimer > 2.4) gameOver();
    }

    // out-of-area enforcement
    if (player.outOfAreaTime > 15) player.applyDamage(999);

    // player weapons
    const firing = input.down('fireGun');
    weapons.playerGun(player, dt, firing && player.alive, enemies.enemies);
    if (input.pressed('fireMissile')) weapons.mslFirePress(player);
    if (input.pressed('mslWarmup')) weapons.mslWarmPress();
    if (input.pressed('flares')) weapons.deployFlares(player, 3);
    if (input.pressed('cycleMissile')) {
      weapons.mslKind = weapons.mslKind === 'ir' ? 'radar' : 'ir';
      weapons.manualTarget = null;
      weapons.cancelWarm();   // warm state belongs to the selected kind
      hud.announce(weapons.mslKind === 'radar' ? '雷达弹' : '红外弹',
        weapons.mslKind === 'radar' ? 'RADAR — 10km 即时锁定 · 预热后发射 · 39/箔条可避' : 'IR — 热源导引 · 预热后发射 · 热诱弹可避', 1.2, 'info');
    }
    if (input.pressed('cycleTarget')) weapons.headLockAttempt(player, enemies.enemies);
    weapons.updateFireControl(dt, player, enemies.enemies);

    // world
    enemies.update(dt, player, player.alive ? killCtx : { effects });
    weapons.update(dt, player, enemies.enemies, effects);

    // weapon feedback events (crit hits) -> animated HUD stack
    for (const ev of weapons.events) {
      if (ev.type === 'crit') {
        hud.announce('致命攻击', 'CRITICAL HIT — 目标冒烟', 1.5, 'crit');
        audio.crit();
      }
    }
    weapons.events.length = 0;

    // drain enemy-manager events into HUD announcements
    for (const ev of enemies.events) {
      if (ev.type === 'wave') hud.announce(`WAVE ${ev.wave}`, `敌机接近 — ${ev.count} 机`, 3.0, 'wave');
      else if (ev.type === 'waveClear') hud.announce('WAVE CLEAR', '敌机全灭 — 下一波接近中', 2.6, 'info');
    }
    enemies.events.length = 0;

    // player contrails + damage smoke
    G.contrailT += dt;
    const turning = Math.abs(player.ctl.roll) > 0.25 || Math.abs(player.ctl.pitch) > 0.3;
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
      if ((e.hp < 25 || e.pilotHit) && !e.dying && Math.random() < 0.5) {
        e.model.anchors.tail.getWorldPosition(_v);
        effects.damageSmoke(_v, _v2.set(0, 0, 0), true);
      }
    }

    audio.update(dt, player, weapons);
  }

  effects.update(dt);
  sky.update(dt, camera.position);
  updateEnvironment(dt);

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
  const mins = Math.floor(((G.day01 ?? 0.46) * 24 + 6) % 24 * 60);
  const clock = `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
  hud.draw(G.paused ? 0 : 1 / 60, {
    state: G.state,
    paused: G.paused,
    player, camera,
    enemies: enemies.enemies,
    weapons,
    kills: G.kills, score: G.score, wave: enemies.wave,
    time: G.time,
    clock, weatherName: weather.name,
    enemyLock: enemies.enemies.reduce((m, e) => Math.max(m, e.lockT || 0), 0),
    enemyWarm: enemies.enemies.reduce((m, e) => Math.max(m, e.warmT || 0), 0),
    radarThreats: weapons.missiles
      .filter(m => !m.fromPlayer && m.kind === 'radar' && m.blind < 5)
      .map(m => {
        const dx = m.pos.x - player.position.x, dz = m.pos.z - player.position.z;
        return { brg: Math.atan2(dx, -dz), dist: Math.hypot(dx, dz) };
      }),
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
    // scripted shots so stills can catch trails/impacts (freeze mode only) —
    // force=true bypasses the warmup gate, the harness has no ALT key
    if (missileShots < shotTimes.length && G.time >= shotTimes[missileShots]) {
      missileShots++;
      if (weapons.lockState.target) weapons.playerMissile(player, true, true);
    }
  }
  renderer.render(scene, camera);
  renderHUD();
  window.__ready = true;
  window.__game = {
    time: G.time, state: G.state, kills: G.kills,
    clock: Math.round(((G.day01 ?? 0.46) * 24 + 6) % 24 * 60),
    night: Math.round((G.night01 ?? 0) * 100) / 100,
    weather: weather.name, rain: Math.round(weather.cur.rain * 100) / 100,
    heading: Math.round(player.headingDeg * 10) / 10,
    bank: Math.round(player.bankDeg * 10) / 10,
    ctl: {
      pitch: Math.round(player.ctl.pitch * 100) / 100,
      roll: Math.round(player.ctl.roll * 100) / 100,
      yaw: Math.round(player.ctl.yaw * 100) / 100,
    },
    aimOff: Math.round(Math.acos(clamp(player.forward(_v).dot(player.aimDir), -1, 1)) * 1800 / Math.PI) / 10,
    aimScreen: (() => {
      const p = player.aimPoint.project(camera);
      return [Math.round((p.x * 0.5 + 0.5) * 1000) / 1000, Math.round((-p.y * 0.5 + 0.5) * 1000) / 1000];
    })(),
    aimLocal: player.aimLocal || null,
    enemies: enemies.enemies.map(e => ({
      hp: Math.round(e.hp), dying: e.dying, state: e.state,
      dist: Math.round(e.position.distanceTo(player.position)),
    })),
    missiles: weapons.missiles.map(m => ({
      fromPlayer: m.fromPlayer, age: Math.round(m.life * 10) / 10,
      hasTarget: !!m.target,
    })),
    lock: weapons.lockState.locked,
    enemyScreens: enemies.enemies.slice(0, 5).map(e => {
      _v2.copy(e.position).project(camera);
      return [Math.round((_v2.x * 0.5 + 0.5) * 1000) / 1000, Math.round((-_v2.y * 0.5 + 0.5) * 1000) / 1000, _v2.z < 1];
    }),
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
    if (input.pressedRaw('Enter') || input.mousePressed(0)) startGame();
    // idle orbit so the title screen isn't static
    G.time += dt;
    const a = G.time * 0.05;
    camera.position.set(Math.sin(a) * 5200, 1900 + Math.sin(a * 0.7) * 300, Math.cos(a) * 5200);
    camera.up.set(0, 1, 0);
    camera.lookAt(0, 900, 0);
    sky.update(dt, camera.position);
    updateEnvironment(dt);
    ocean.mesh.position.x = camera.position.x;
    ocean.mesh.position.z = camera.position.z;
    ocean.mat.uniforms.uCamPos.value.copy(camera.position);
    ocean.mat.uniforms.uTime.value = G.time;
    ocean.mat.uniforms.uSunDir.value.copy(sky.sunDir);
    effects.update(dt);
    hud.draw(dt, { state: 'title' });
  } else {
    if (G.state === 'gameover' && input.pressedRaw('Enter')) { startGame(); }
    else if (G.state === 'playing' && input.pressed('pause')) setPaused(!G.paused);
    update(dt);
    renderer.render(scene, camera);
    renderHUD();
    if (DEBUG) {
      window.__game = {
        time: G.time, state: G.state, kills: G.kills, alive: player.alive,
        hp: Math.round(player.hp), speed: Math.round(player.speed),
        alt: Math.round(player.position.y),
        g: Math.round((player.gLoad || 1) * 10) / 10,
        clock: Math.round(((G.day01 ?? 0.46) * 24 + 6) % 24 * 60), night: Math.round((G.night01 ?? 0) * 100) / 100,
        weather: weather.name, rain: Math.round(weather.cur.rain * 100) / 100,
        alphaDeg: Math.round((player.alpha || 0) * 573) / 10,
        noseDeg: (() => { player.forward(_v2); return Math.round(Math.asin(clamp(_v2.y, -1, 1)) * 573) / 10; })(),
        omegaX: Math.round(player.body.omega.x * 100) / 100,
        boosting: !!player.boosting,
        ctlPitch: player.ctl.pitch, thr: Math.round(player.throttle * 100) / 100,
        heading: Math.round(player.headingDeg * 10) / 10,
        bank: Math.round(player.bankDeg * 10) / 10,
        ctl: {
          pitch: Math.round(player.ctl.pitch * 100) / 100,
          roll: Math.round(player.ctl.roll * 100) / 100,
          yaw: Math.round(player.ctl.yaw * 100) / 100,
        },
        aimOff: Math.round(Math.acos(clamp(player.forward(_v).dot(player.aimDir), -1, 1)) * 1800 / Math.PI) / 10,
        velAimOff: Math.round(Math.acos(clamp(player.vel.clone().normalize().dot(player.aimDir), -1, 1)) * 1800 / Math.PI) / 10,
        betaDeg: Math.round((player.body.beta || 0) * 573) / 10,
    planeScreen: (() => {
      const p = _v2.copy(player.position).project(camera);
      return [Math.round((p.x * 0.5 + 0.5) * 1000) / 1000, Math.round((-p.y * 0.5 + 0.5) * 1000) / 1000];
    })(),
    aimScreen: (() => {
      const p = player.aimPoint.project(camera);
      return [Math.round((p.x * 0.5 + 0.5) * 1000) / 1000, Math.round((-p.y * 0.5 + 0.5) * 1000) / 1000];
    })(),
    aimLocal: player.aimLocal || null,
        enemies: enemies.enemies.map(e => ({
          hp: Math.round(e.hp), dying: e.dying, state: e.state,
          dist: Math.round(e.position.distanceTo(player.position)),
          v: Math.round(e.speed), thr: Math.round(e.body.throttle * 100) / 100,
          k: e.mslKind,
        })),
        missiles: weapons.missiles.map(m => ({ fromPlayer: m.fromPlayer, age: Math.round(m.life * 10) / 10 })),
        lock: weapons.lockState.locked, warm: weapons.warm.state,
        irSeek: !!weapons.irSeek,
        enemyLocks: enemies.enemies.map(e => Math.round((e.lockT || 0) * 100) / 100),
        enemyWarms: enemies.enemies.map(e => Math.round((e.warmT || 0) * 100) / 100), ammo: weapons.ammo,
        enemyScreens: enemies.enemies.slice(0, 5).map(e => {
          _v2.copy(e.position).project(camera);
          return [Math.round((_v2.x * 0.5 + 0.5) * 1000) / 1000, Math.round((-_v2.y * 0.5 + 0.5) * 1000) / 1000, _v2.z < 1];
        }),
        gunRounds: weapons.rounds.length, gunHeat: Math.round(weapons.gunHeat * 100) / 100,
        audio: audio.ctx ? {
          state: audio.ctx.state,
          duck: Math.round(audio.duck.gain.value * 1000) / 1000,
          eng: Math.round(audio.engGain.gain.value * 1000) / 1000,
        } : null,
        msgs: hud.msgQueue.map(m => ({ t: m.text, y: Math.round(m.y || 0), slot: m.slot })),
        surf: player.model.group.children
          .filter(o => o.name && o.name.startsWith('surf_'))
          .map(o => o.name.slice(5) + ':' + (Math.round(o.rotation.x * 100) / 100)),
      };
    }
  }
  input.endFrame();
  requestAnimationFrame(frame);
}

// pointer lock lost (ESC) while flying -> auto-pause; click resumes + relocks
document.addEventListener('pointerlockchange', () => {
  if (!document.pointerLockElement && G.state === 'playing' && !G.menuOpen) setPaused(true);
});
canvas.addEventListener('click', () => {
  if (G.state === 'playing' && G.paused && !G.menuOpen) {
    setPaused(false);
    try { canvas.requestPointerLock?.(); } catch (_) {}
  }
});

// ---------- key binding menu ----------
const bindEl = document.getElementById('bindings');
const bindRows = document.getElementById('bind-rows');

function renderBindings() {
  bindRows.innerHTML = '';
  for (const [action, label] of Object.entries(ACTION_LABELS)) {
    const row = document.createElement('div');
    row.className = 'bind-row';
    const name = document.createElement('span');
    name.textContent = label;
    const key = document.createElement('span');
    key.className = 'key';
    key.textContent = codeLabel(input.bindings[action]);
    key.onclick = () => {
      document.querySelectorAll('.key.wait').forEach(k => k.classList.remove('wait'));
      key.classList.add('wait');
      key.textContent = '按下新键…';
      input.startCapture(action, (a, code) => {
        if (code !== 'Escape') input.setBinding(a, code);
        renderBindings();
      });
    };
    row.appendChild(name);
    row.appendChild(key);
    bindRows.appendChild(row);
  }
}

function openMenu() {
  if (G.menuOpen) return;
  G.menuOpen = true;
  input.cancelCapture();
  if (G.state === 'playing' && !G.paused) setPaused(true);
  bindEl.classList.remove('hidden');
  renderBindings();
}

function closeMenu() {
  if (!G.menuOpen) return;
  G.menuOpen = false;
  input.cancelCapture();
  bindEl.classList.add('hidden');
}

document.getElementById('bind-entry').addEventListener('click', openMenu);
document.getElementById('bind-close').addEventListener('click', closeMenu);
document.getElementById('bind-reset').addEventListener('click', () => {
  input.resetDefaults();
  renderBindings();
});
// ESC: closes the menu, otherwise toggles pause (when the pointer lock
// consumes ESC, the pointerlockchange handler pauses instead)
addEventListener('keydown', e => {
  if (e.code === 'Escape') {
    if (G.menuOpen) closeMenu();
    else if (G.state === 'playing') setPaused(!G.paused);
  }
});

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

if (FREEZE_T !== null) {
  f14Ready.then(() => freezeFrame());   // model swap resolved first, stills show the F-14
} else {
  player.reset();           // park the jet for the title backdrop
  frame();
}
