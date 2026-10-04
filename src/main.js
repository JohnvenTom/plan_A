// main.js — bootstrap, game states, wiring, and the ?t=N freeze harness
import * as THREE from 'three';
import { Input, DEFAULT_BINDINGS, ACTION_LABELS, codeLabel } from './core/input.js';
import { Sky } from './world/sky.js';
import { Weather } from './world/weather.js';
import { buildTerrain, buildOcean, terrainHeightAt } from './world/terrain.js';
import { Player } from './units/player.js';
import { loadF14 } from './units/f14.js';
import { EnemyManager } from './units/enemies.js';
import { Weapons } from './units/weapons.js';
import { AASites } from './units/aasites.js';
import { Effects } from './world/effects.js';
import { HUD } from './ui/hud.js';
import { PostFX } from './world/postfx.js';
import { GameAudio } from './core/audio.js';
import { clamp, smoothstep, machOf } from './core/utils.js';
import { Recorder, parseRecord } from './replay/recorder.js';
import { Debrief } from './replay/debrief.js';

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
const terrain = buildTerrain(scene);
const ocean = buildOcean(scene);
const effects = new Effects(scene);
const player = new Player(scene, camera);
// async F-14 GLB: swaps in whenever it arrives; falls back silently to the
// procedural jet if the asset is absent (freeze mode waits for the verdict)
const f14Ready = loadF14();
f14Ready.then(m => { if (m) player.swapModel(m); });
const weapons = new Weapons(scene, effects);
const enemies = new EnemyManager(scene);
const aaSites = new AASites(scene);
const hud = new HUD(document.getElementById('hud'));
// flight recorder + the post-mission replay page it feeds
const recorder = new Recorder();
const debrief = new Debrief();
window.__hud = hud;   // debug hook
window.__weapons = weapons;   // debug hook
window.__player = player;     // debug hook
window.__enemies = enemies;   // debug hook
window.__aaSites = aaSites;   // debug hook
window.__weather = weather;   // debug hook
window.__scene = scene;       // debug hook (screenshot harness: __renderer.render(__scene, __player.camera))
window.__renderer = renderer; // debug hook
window.__recorder = recorder; // debug hook
window.__debrief = debrief;   // debug hook
const audio = new GameAudio();
// post-processing stack + missile-cam picture-in-picture rig
const postfx = new PostFX(renderer);
const mslCam = new THREE.PerspectiveCamera(58, 16 / 9, 2, 72000);
mslCam.layers.enable(1);   // seeker cam sees the FX layer (trails, tracers)
const mslRT = new THREE.WebGLRenderTarget(480, 270, { type: THREE.HalfFloatType });
mslRT.depthTexture = new THREE.DepthTexture(480, 270);
mslRT.depthTexture.type = THREE.UnsignedIntType;
const mslRT2 = new THREE.WebGLRenderTarget(480, 270, { type: THREE.HalfFloatType, depthBuffer: false });
window.__postfx = postfx;   // debug hook
const WX_EN = { '晴': 'CLEAR', '多云': 'CLOUDY', '阴': 'OVERCAST', '毛毛雨': 'DRIZZLE', '雨': 'RAIN', '雷暴': 'THUNDERSTORM', '浓雾': 'FOG', '狂风': 'GALE' };
weather.onChange = (name) => hud.announce('WEATHER CHANGE', WX_EN[name] || name, 1.6, 'info');
const input = new Input();
weapons.playerRef = player;
weapons.audio = audio;
weapons.hud = hud;

const flashEl = document.getElementById('flash');
const titleEl = document.getElementById('title');
const goEl = document.getElementById('gameover');

// ---------- game state ----------
const G = {
  state: 'title',           // title | intro | playing | gameover | debrief
  training: false,          // training range: drones over the sea, no threats
  trainMode: 'multipath',   // which course is loaded
  kills: 0, score: 0,
  time: 0, deathTimer: 0, paused: false, menuOpen: false,
  smokeT: 0,
  timeScale: 1,             // kill-cam micro slow-motion
  fxPunch: 0,               // radial-blur punch on our missile launch
  aceCut: 0,                // ace-intro letterbox timer
  pipOpen: 0,               // missile-cam CRT open progress
  pipGlitch: 0,             // missile-cam signal-fault burst
  pipZoom: 1,               // missile-cam impact zoom
  pipMsl: null,             // missile the PIP rides
  radarRange: 10000,        // bottom-right radar range: 5/10/20 km (M cycles)
  exposure: 1,              // smoothed auto-exposure
  introT: 0, introFrom: null,
  _mach: false,
};
const INTRO_INPUT = { down: () => false, pressed: () => false, wheelDelta: 0, aimDX: 0, aimDY: 0 };
window.__update = update;     // debug hook (kill-chain repro)
window.__G = G;               // debug hook

const killCtx = {
  effects,
  get enemies() { return enemies.enemies; },
  weapons,
  deployFlares: (owner, n) => weapons.deployFlares(owner, n),
  onKill(enemy, crashed) {
    G.kills++; G.score += (250 + enemies.wave * 25) * (enemy.ace ? 2 : 1);
    recorder.ev('kill', { victim: recorder.trackIdOf(enemy), ace: enemy.ace }, enemy.position);
    hud.announce('TARGET DESTROYED', '', 2.2, 'kill', false, { mult: enemy.ace ? 2 : 1, score: 250 + enemies.wave * 25 });
    audio.kill();
    effects.ring?.(enemy.position, 1.3);
    if (G.training && enemy.respSpec) enemies.queueRespawn(enemy.respSpec);
    else { G.timeScale = 0.25; flashKill(); }   // kill-cam only in real combat
  },
  enemyGun: (e, p) => { G._egunNow?.add(e); weapons.enemyGun(e, p); },   // + recorder burst diff
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
  G.kills = 0; G.score = 0; G.time = 0; G.deathTimer = 0; G.paused = false; G.training = false;
  player.reset();
  enemies.reset();
  weapons.reset();
  aaSites.reset();
  recorder.reset();
  hud.msgQueue.length = 0;
  hud.announce('OPERATION GOLDEN HOUR', 'MISSION START', 3.0, 'info');
}

function startGame() {
  audio.init(); audio.resume(); audio.setRunning(true);
  resetAll();
  recorder.start();
  debrief.hide();
  trainMenu?.classList.add('hidden');
  G.state = 'intro';
  G.introT = 3.2;
  G.timeScale = 1;
  // swoop starts ahead-right of the jet and settles into the chase camera
  G.introFrom = player.body.pos.clone()
    .add(new THREE.Vector3(-70, 14, 26).applyQuaternion(player.body.quat));
  titleEl.classList.add('hidden');
  goEl.classList.add('hidden');
  try { const r = canvas.requestPointerLock?.(); if (r && r.catch) r.catch(() => {}); } catch (_) { /* fallback: delta mode */ }
}

// ---------- training range over open water: six courses, one sea patch -----
// drones = passive orbits (spec.launch turns one into a missile launcher);
// fighters = full-AI guns-only sparring partners
const TRAINING_MODES = {
  multipath: {
    title: 'TRAINING RANGE', sub: 'MULTIPATH TEST — LOW TARGETS DEFEAT RADAR MISSILES',
    hot: 'TARGETS ON STATION — 50 / 90 / 200 M AGL',
    drones: [
      { alt: 50, radius: 1600, speed: 235 },   // deep in the multipath band
      { alt: 90, radius: 2300, speed: 250 },   // edge of the band
      { alt: 200, radius: 3000, speed: 270 },  // above 120 m AGL: radar works
    ],
  },
  defense: {
    title: 'DEFENSE COURSE', sub: 'INBOUND MIXED MISSILES — 39 / CHAFF / FLARE / DECK',
    hot: 'LAUNCHERS ON STATION — RADAR AND IR ALTERNATING',
    drones: [
      { alt: 900, radius: 2600, speed: 260, launch: { interval: 12, kind: 'alt' } },
      { alt: 1200, radius: 3000, speed: 260, launch: { interval: 12, kind: 'alt' } },
    ],
  },
  intercept: {
    title: 'INTERCEPT COURSE', sub: 'GUN THE INBOUND MISSILES DOWN',
    hot: 'STEADY RADAR MISSILE STREAM — WATCH THE RWR',
    drones: [
      { alt: 800, radius: 3000, speed: 280, launch: { interval: 8, kind: 'radar' } },
    ],
  },
  gunnery: {
    title: 'GUNNERY RANGE', sub: 'PREDICTABLE CIRCUITS — LEAD THE TRACERS',
    hot: 'THREE CIRCUITS AT DIFFERENT SPEEDS',
    drones: [
      { alt: 400, radius: 1800, speed: 180 },
      { alt: 700, radius: 2400, speed: 250 },
      { alt: 1000, radius: 3000, speed: 320 },
    ],
  },
  dogfight: {
    title: 'DOGFIGHT COURSE', sub: 'GUNS-ONLY BANDITS — NO MISSILES',
    hot: 'TWO SPARRING PARTNERS — THEY BITE BACK',
    fighters: [{ range: 7000 }, { range: 7600 }],
  },
  stall: {
    title: 'STALL COURSE', sub: 'STALL & SPIN RECOVERY — LIMITER OFF · DEPART · RECOVER',
    hot: 'F 关限器 — 拉过失速 · W推杆 · Q/E反舵改出',
    // high and slow: room to depart, spin and still pull out alive
    spawn: { alt: 4000, speed: 200 },
  },
  freeflight: {
    title: 'FREE FLIGHT', sub: 'OPEN RANGE — NO TARGETS',
    hot: 'OPEN WATER — FLY',
  },
};
// the range center must keep EVERY drone ring clear of terrain along its
// FULL circle — spot-checking a few points let islands sneak between samples
// and drones flew straight into them. The island chain is dense: inside
// r≈12 km NO clear ring exists at any size, so the range sits on the open
// ocean beyond it (the terrain mask sinks to pure sea out there).
function findSeaRange(cfg) {
  const rings = (cfg?.drones || []).map(d => ({ R: d.radius, floor: d.alt }));
  for (const clear of [70, 40, 10]) {
    for (let r = 12500; r <= 15000; r += 250)
      for (let a = 0; a < Math.PI * 2; a += Math.PI / 24) {
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        let ok = true;
        for (const g of rings) {
          for (let t = 0; t < Math.PI * 2; t += Math.PI / 48) {
            if (terrainHeightAt(x + Math.cos(t) * g.R, z + Math.sin(t) * g.R) > g.floor - clear) { ok = false; break; }
          }
          if (!ok) break;
        }
        // + player spawn patch: water or flat sea (the analytic ocean beyond
        // the chain is EXACTLY 0 — a strict < 0 test rejects the whole open
        // ocean, keep the bound above zero)
        if (ok && terrainHeightAt(x - 4200, z + 2600) < 5) return { x, z };
      }
  }
  return { x: 0, z: 13500 };   // last-ditch: dead ahead into open ocean
}
function startTraining(mode = 'multipath') {
  const cfg = TRAINING_MODES[mode] || TRAINING_MODES.multipath;
  G.trainMode = mode;
  audio.init(); audio.resume(); audio.setRunning(true);
  resetAll();
  recorder.start();
  debrief.hide();
  G.training = true;
  enemies.training = true;
  trainMenu.classList.add('hidden');
  const range = findSeaRange(cfg);
  // spawn SW of the ring at a safe height, nose pointed at its center;
  // courses can override the state (the stall course starts high and slow)
  const sp = cfg.spawn || {};
  const px = range.x - 4200, pz = range.z + 2600;
  const h = Math.atan2(-(range.x - px), -(range.z - pz));
  player.spawnAt(new THREE.Vector3(px, sp.alt ?? 750, pz), h, sp.speed ?? 280);
  (cfg.drones || []).forEach((d, i) => enemies.spawnTrainingDrone({ ...d, center: range, phase: i * 2.1 }));
  if (cfg.fighters) for (const f of cfg.fighters) enemies.spawnTrainingFighter(player, f);
  hud.msgQueue.length = 0;
  hud.announce(cfg.title, cfg.sub, 4.0, 'wave');
  G.trainHot = cfg.hot;
  G.state = 'intro';
  G.introT = 3.2;
  G.timeScale = 1;
  G.introFrom = player.body.pos.clone()
    .add(new THREE.Vector3(-70, 14, 26).applyQuaternion(player.body.quat));
  titleEl.classList.add('hidden');
  goEl.classList.add('hidden');
  try { const r = canvas.requestPointerLock?.(); if (r && r.catch) r.catch(() => {}); } catch (_) { /* fallback: delta mode */ }
}

function setPaused(v) {
  if (G.paused === v) return;
  G.paused = v;
  audio.setRunning(!v);
  if (v) {
    hud.msgQueue.length = 0;
    hud.announce('PAUSED', 'PRESS P / ESC OR CLICK TO RESUME', 9999, 'info', true);
  } else {
    hud.clearSticky();
  }
}

// death now leads straight into the replay debrief — the old DOM stats
// screen is retired (the debrief page carries the same numbers and more)
function gameOver() {
  enterDebrief('failed');
}

// seal the recording and open the flight-record replay page; outcome is
// 'failed' (shot down / crashed) or 'ended' (manual end from the pause menu)
function enterDebrief(outcome) {
  G.state = 'debrief';
  G.paused = false;
  closeMenu();
  audio.setRunning(false);
  if (document.pointerLockElement) document.exitPointerLock();
  hud.msgQueue.length = 0;
  hud.clearSticky?.();
  recorder.stop();
  recorder.setResult({
    outcome,
    kills: G.kills, score: G.score, wave: enemies.wave,
    time: recorder.time, crashed: !!player.crashed,
    gunFired: recorder.stats.gunFired, mslFired: recorder.stats.mslFired,
    hits: recorder.stats.hits,
    egunFired: recorder.stats.egunFired, pBursts: recorder.stats.pBursts, eBursts: recorder.stats.eBursts,
  });
  debrief.show(recorder.toRecord(), { onRestart: G.training ? () => startTraining(G.trainMode) : startGame, onTitle: backToTitle });
}

// an imported record file (title-page entry) skips the live recorder entirely
function showImportedRecord(rec) {
  G.state = 'debrief';
  titleEl.classList.add('hidden');
  goEl.classList.add('hidden');
  debrief.show(rec, { onRestart: startGame, onTitle: backToTitle });
}

function backToTitle() {
  debrief.hide();
  resetAll();          // park the jets so the title backdrop is a clean sky
  G.state = 'title';
  titleEl.classList.remove('hidden');
  trainMenu?.classList.add('hidden');
}


// ---------- environment: 8-minute day/night cycle + dynamic weather ----------
const DAY_LEN = 1200;                      // seconds for a full day (20 min)
function introStep(dt) {
  G.introT -= dt;
  player.update(dt, INTRO_INPUT);
  enemies.update(dt, player, { effects });
  effects.update(dt, camera);
  sky.update(dt, camera.position);
  updateEnvironment(dt);
  ocean.mesh.position.x = camera.position.x;
  ocean.mesh.position.z = camera.position.z;
  ocean.mat.uniforms.uCamPos.value.copy(camera.position);
  ocean.mat.uniforms.uTime.value = G.time;
  ocean.mat.uniforms.uSunDir.value.copy(sky.sunDir);
  const k = 1 - Math.max(0, G.introT) / 3.2;
  const e = 1 - Math.pow(1 - k, 3);
  camera.position.lerpVectors(G.introFrom, player.camPos, e);
  camera.up.set(0, 1, 0);
  camera.lookAt(player.body.pos.x, player.body.pos.y + 4, player.body.pos.z);
    if (G.introT <= 0) {
      G.state = 'playing';
      hud.announce(G.training ? 'RANGE HOT' : 'MISSION START',
        G.training ? G.trainHot : 'INTERCEPT THE INBOUND FORMATION', 2.2, 'wave');
    }
}

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
        recorder.ev('crash', { crashed: !!player.crashed }, player.position);
        recorder.stop();
        effects.explosion(player.position, 2.2);
        effects.wreckBurst?.(player.position, player.body.vel, 2.0);
        audio.explosion(1);
        audio.setRunning(false, 1.6);   // engine fades under the death boom
        player.model.group.visible = false;
      }
      G.deathTimer += dt;
      if (G.deathTimer > 2.4) gameOver();
    }

    // out-of-area enforcement (the training range is free flight)
    if (!G.training && player.outOfAreaTime > 15) player.applyDamage(999);

    // FBW limiter toggle feedback (F) + spin entry on the flight record
    if (player._fbwToggled) {
      player._fbwToggled = false;
      const on = player.body.fbwOn;
      hud.announce(on ? 'FBW LIMITER ON' : 'FBW LIMITER OFF',
        on ? '迎角限制恢复 — 失速保护生效' : '迎角限制解除 — 可拉入真失速/尾旋', 1.6, 'info');
      recorder.ev('limiter', { on }, player.position);
    }
    if (player.body.spin && !G._spinPrev) {
      recorder.ev('spin', { flat: player.body.spin === 2 }, player.position);
      if (player.body.spin === 2) hud.announce('FLAT SPIN', '蹬满反舵+顶杆 — 高度将损失殆尽', 3, 'info');
    }
    G._spinPrev = player.body.spin;

    // player weapons
    const firing = input.down('fireGun');
    weapons.playerGun(player, dt, firing && player.alive, enemies.enemies);
    // player gun burst edges -> flight recorder (per-burst, not per-round)
    const firingGun = firing && player.alive;
    if (firingGun !== G._pGunPrev) {
      recorder.gunBurst('p', firingGun, player.position, player);
      G._pGunPrev = firingGun;
    }
    if (input.pressed('fireMissile')) weapons.mslFirePress(player);
    if (input.pressed('mslWarmup')) weapons.mslWarmPress();
    if (input.pressed('flares')) {
      weapons.deployFlares(player, 3);
      recorder.ev('flare', {}, player.position);
    }
    if (input.pressed('cycleMissile')) {
      weapons.mslKind = weapons.mslKind === 'ir' ? 'radar' : 'ir';
      // the LOCK survives the kind switch — only the warm state is per-kind;
      // an IR shot may ride the same radar designation (and re-warm applies)
      weapons.cancelWarm();
      hud.announce(weapons.mslKind === 'radar' ? 'RADAR MISSILE' : 'IR MISSILE',
        weapons.mslKind === 'radar' ? '20KM INSTANT LOCK · PRE-HEAT TO FIRE · DEFEATABLE BY CHAFF' : 'HEAT SEEKING · PRE-HEAT TO FIRE · DEFEATABLE BY FLARE', 1.2, 'info');
    }
    if (input.pressed('cycleTarget')) weapons.headLockAttempt(player, enemies.enemies);
    if (input.pressed('radarRange')) {
      const steps = [5000, 10000, 20000];
      G.radarRange = steps[(steps.indexOf(G.radarRange ?? 10000) + 1) % steps.length];
      hud.announce('RADAR RANGE', `RNG ${G.radarRange / 1000} KM`, 1.2, 'info');
    }
    if (input.pressed('debugWeather')) {
      G._wxIdx = ((G._wxIdx ?? -1) + 1) % ['晴', '多云', '阴', '毛毛雨', '雨', '雷暴', '浓雾', '狂风'].length;
      const names = ['晴', '多云', '阴', '毛毛雨', '雨', '雷暴', '浓雾', '狂风'];
      const keys = ['clear', 'cloudy', 'overcast', 'drizzle', 'rain', 'storm', 'fog', 'gale'];
      weather.force(keys[G._wxIdx]);
      hud.announce('WEATHER CHANGE', `${(WX_EN[names[G._wxIdx]] || names[G._wxIdx])} (DEBUG)`, 1.2, 'info');
    }
    weapons.updateFireControl(dt, player, enemies.enemies);

    // world
    G._egunNow = new Set();          // who is firing guns this frame (filled by killCtx)
    enemies.update(dt, player, player.alive ? killCtx : { effects });
    // enemy gun burst edges: diff this frame's firing set against last frame's
    {
      const prev = G._egunPrev ?? (G._egunPrev = new Set());
      for (const e of G._egunNow) if (!prev.has(e)) recorder.gunBurst('e', true, e.position, e);
      for (const e of prev) if (!G._egunNow.has(e)) recorder.gunBurst('e', false, e.position, e);
      prev.clear();
      for (const e of G._egunNow) prev.add(e);
    }
    if (!G.training) aaSites.update(dt, player, weapons, effects);   // range mode: flak off
    weapons.update(dt, player, enemies.enemies, effects);

    // flight recorder: 20 Hz samples + entity bookkeeping, post-sim so every
    // position is the settled end-of-frame state
    recorder.sample(dt, { player, enemies: enemies.enemies, weapons });

    // weapon feedback events -> HUD stack / camera / audio (ONE drain: an
    // earlier blanket clear here silently ate the nearMiss/hitTing events);
    // the same drain feeds the flight recorder's combat-event log
    for (const ev of weapons.events) {
      if (ev.type === 'crit') {
        hud.announce('CRITICAL HIT', 'TARGET SMOKING', 1.5, 'crit');
        audio.crit();
      } else if (ev.type === 'nearMiss') {
        recorder.ev('nearMiss', {}, ev.pos);
        // the whip + letterbox are optional (settings panel); the whoosh,
        // shake and threat feel stay on regardless
        if (settings.nearMissWhip) {
          player.applyWhip(ev.dir);
          G.cineT = 1.15;            // letterbox rises for the whip moment
        }
        player.camShake = Math.min(1, player.camShake + 0.22);
        audio.nearMiss();
      } else if (ev.type === 'hitTing') {
        recorder.stats.hits++;
        recorder.ev('hit', { w: ev.w, victim: recorder.trackIdOf(ev.tg) }, ev.pos);
        audio.hitTing();
      } else if (ev.type === 'playerHit') {
        recorder.ev('damage', { w: ev.w, dmg: ev.dmg }, ev.pos);
      } else if (ev.type === 'intercept') {
        recorder.ev('intercept', {}, ev.pos);
        G.score += 100;
        hud.announce('MISSILE INTERCEPTED', '', 2.0, 'kill', false, { mult: 1, score: 100 });
        audio.kill();
      }
    }
    weapons.events.length = 0;

    // drain enemy-manager events into HUD announcements (+ timeline ticks)
    for (const ev of enemies.events) {
      if (ev.type === 'wave') { recorder.ev('wave', { n: ev.wave }); hud.announce(`WAVE ${ev.wave}`, `HOSTILES INBOUND — ${ev.count}`, 3.0, 'wave'); }
      else if (ev.type === 'waveClear') { recorder.ev('waveClear', { n: ev.wave }); hud.announce('WAVE CLEAR', 'ALL HOSTILES DOWN — NEXT WAVE INBOUND', 2.6, 'info'); }
      else if (ev.type === 'ace') { recorder.ev('ace'); hud.announce('ACE ENGAGED', 'HIGH AGILITY — DOUBLE REWARD', 3.2, 'wave'); G.aceCut = 1.6; }
    }
    enemies.events.length = 0;

    // supersonic boom: one-shot ring + thunder when crossing the sound
    // barrier; the vapor cone is the M 0.98-1.05 transonic band itself —
    // present the whole time the aircraft sits in it, gone outside it
    if (player.alive) {
      // Mach gate on the LOCAL speed of sound (standard atmosphere): the
      // crossing line drops from ~1225 km/h at sea level to ~1063 at 11 km+
      const pm = machOf(player.speed, player.position.y);
      if (!G._mach && pm > 1) { G._mach = true; effects.ring(player.position, 1.6); audio.sonicBoom(); }
      else if (G._mach && pm < 0.95) G._mach = false;
      effects.vaporCone(player, pm >= 0.98 && pm <= 1.05);
    } else effects.vaporCone(player, false);

    // --- wingtip vortices (AC7-style ribbons): intensity from lift, not
    // speed — hard pulls (G), low-speed high-AOA maneuvers, and full stall
    // all pull continuous white vortex strips off the wingtips ---
    const vortexOf = (b, stalling) => {
      const hiG = clamp((Math.max(0, b.gLoad) - 3.2) / 4.2, 0, 1);
      const hiAoa = clamp((b.alpha - 0.14) / 0.12, 0, 1);   // past ~8 deg AOA
      const v = Math.max(hiG * 0.9, hiAoa * 0.75);
      return stalling ? 1 : v;
    };
    if (player.alive) {
      const vI = vortexOf(player.body, player.stalling);
      player.model.anchors.wingL.getWorldPosition(_v);
      player.model.anchors.wingR.getWorldPosition(_v2);
      effects.vortexFeed('p', _v, _v2, vI, player.stalling);
    }
    G.smokeT += dt;
    if (player.hp < 80 && G.smokeT > 0.06 && player.alive) {
      // same three-band ladder as the enemies: white 80-55, grey 55-25, black 25
      G.smokeT = 0;
      player.model.anchors.tail.getWorldPosition(_v);
      effects.damageSmoke(_v, _v2.set(0, 0, 0),
        player.hp < 25 ? 2 : player.hp < 55 ? 1 : 0);
    }
    for (const e of enemies.enemies) {
      if (!e.dying) {
        const st = e.body.stall > 0.05 || Math.abs(e.body.alpha) > 0.22;
        e.model.anchors.wingL.getWorldPosition(_v);
        e.model.anchors.wingR.getWorldPosition(_v2);
        effects.vortexFeed(e, _v, _v2, vortexOf(e.body, st), st);
        // enemy transonic band M 0.98-1.05: cone held, visual only
        const em = machOf(e.speed, e.position.y);
        effects.vaporCone(e, em >= 0.98 && em <= 1.05);
      }
      if (!e.dying) {
        // damage smoke ramps in three bands: white wisps from 80% hp, grey
        // from 50%, black plume from 25%; cockpit crit smokes at least mid
        const r = e.hpR ?? 1;
        const lvl = r < 0.25 ? 2 : (r < 0.5 || e.pilotHit) ? 1 : r < 0.8 ? 0 : -1;
        if (lvl >= 0) {
          const k = lvl === 0 ? (0.8 - r) / 0.3 : lvl === 1 ? 1 : 1;
          if (Math.random() < 0.25 * k + 0.3 * lvl) {
            e.model.anchors.tail.getWorldPosition(_v);
            effects.damageSmoke(_v, _v2.set(0, 0, 0), lvl);
          }
        }
      }
    }

    // cinematic letterbox: animated rise/fall shared by ACE cut + near-miss
    G.cineT = Math.max(0, (G.cineT ?? 0) - dt);
    const barsTarget = (G.aceCut > 0 || G.cineT > 0) ? 1 : 0;
    const rate = barsTarget > (G.cineBars ?? 0) ? 4.2 : 2.6;   // rise fast, fall slower
    G.cineBars = (G.cineBars ?? 0) + clamp(barsTarget - (G.cineBars ?? 0), -rate * dt, rate * dt);

    // rain streaks sweeping off the airframe
    if (player.alive && weather.cur.rain > 0.25) {
      effects.rainOnAirframe(player.model.anchors, player.vel, weather.cur.rain);
    }
    // cloud-pass buffet: light turbulence shake scaling with immersion
    if ((G.cloud ?? 0) > 0.25 && player.alive) {
      player.camShake = Math.max(player.camShake, (G.cloud - 0.25) * 0.12);
    }
    audio.update(dt, player, weapons, G.cloud ?? 0);
  }

  effects.update(dt, camera);
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
  terrain.userData.fogTime.value = G.time;   // drifting valley-mist band
  ocean.mat.uniforms.uStorm.value = weather.seaT ?? 0;
  ocean.mat.uniforms.uRain.value = weather.cur.rain;
  // lightning lights the cloud decks from the strike column
  weather.boltT = Math.max(0, (weather.boltT ?? 0) - dt / 0.22);
  if (weather.boltT > 0) {
    for (const m of sky.cloudMats) {
      m.uniforms.uBoltPos.value.copy(weather.boltPos);
      m.uniforms.uBoltT.value = weather.boltT;
    }
  } else {
    for (const m of sky.cloudMats) m.uniforms.uBoltT.value = 0;
  }
}

// ---------- post-processing intent + missile-cam PIP ----------
const _pv = new THREE.Vector3();
const _pv2 = new THREE.Vector3();
const _pm = new THREE.Matrix4();   // scratch for view-projection inverses
function renderFrame(dt) {
  const playingLike = G.state === 'playing' || G.state === 'intro' || G.state === 'gameover';
  // --- missile cam: ride the newest live player missile that is guiding ---
  let pipSrc = null;
  if (playingLike) {
    let m = null;
    for (let i = weapons.missiles.length - 1; i >= 0; i--) {
      const c = weapons.missiles[i];
      if (c.fromPlayer && c.target && !c.target.dying) { m = c; break; }
    }
    // AC7 fault-open / fault-close: fast CRT expand on launch, glitchy
    // collapse when the missile (or its target) is gone
    if (m) {
      if (!G._pipWasLive) G.pipGlitch = 1;          // opening burst
      G._pipWasLive = true;
      G.pipMsl = m;
      G.pipOpen = Math.min(1, G.pipOpen + dt * 5.5);
      G.pipGlitch = Math.max(0, G.pipGlitch - dt * 2.2);
      G.pipZoom = 1;
    } else {
      if (G._pipWasLive) G.pipGlitch = 1;           // closing burst
      G._pipWasLive = false;
      G.pipOpen = Math.max(0, G.pipOpen - dt * 3.2);
      G.pipGlitch = Math.max(0, G.pipGlitch - dt * 2.6);
      G.pipZoom = Math.min(1.15, G.pipZoom + dt * 0.9);
    }
    // ride only a LIVE missile that still has a target — decoyed missiles
    // null their target and freed missiles may already be recycled
    const mm = G.pipMsl;
    if (G.pipOpen > 0.01 && mm && weapons.missiles.includes(mm) && mm.target) {
      _pv.copy(mm.vel).normalize();
      mslCam.position.copy(mm.pos).addScaledVector(_pv, 7.5).add(_pv2.set(0, 1.1, 0));
      _pv2.copy(mm.target.position ?? mm.target.pos);
      if (_pv2.distanceToSquared(mslCam.position) < 1) _pv2.copy(mslCam.position).addScaledVector(_pv, 100);
      mslCam.up.set(0, 1, 0);
      mslCam.lookAt(_pv2);
      renderer.setRenderTarget(mslRT);
      renderer.clear();
      renderer.render(scene, mslCam);
      renderer.setRenderTarget(null);
      // seeker view gets the same volumetric sky (cheap at 480x270)
      pipSrc = postfx.renderPipClouds(mslRT, mslRT2, mslCam) ? mslRT2 : mslRT;
    }
  } else {
    G.pipOpen = 0;
  }

  // --- cloud immersion: depth inside either deck (low 2750 / high 4200),
  // scaled by how much cloud the weather actually has ---
  let immerse = 0;
  if (playingLike) {
    const y = camera.position.y;
    const dens = clamp(0.25 + weather.cur.gray * 1.4 + (weather.cur.alpha - 0.85) * 1.5, 0, 1);
    // cumulus slab dominates the whiteout; the cirrus veil is thin: halved
    for (const [cy, half, w] of [[2775, 445, 1], [4305, 255, 0.45]]) {
      const k = 1 - Math.abs(y - cy) / half;
      if (k > 0) immerse = Math.max(immerse, k * dens * w);
    }
  }
  G.cloud = immerse;

  // --- auto exposure (smoothed): sun-facing / in-cloud / night ---
  let exT = 1.0;
  if (playingLike) {
    camera.getWorldDirection(_pv);
    const sunDot = _pv.dot(sky.sunDir);
    // facing the sun the eye STOPS DOWN hard (whole frame dims, sun itself
    // blooms) — kicks in from sunDot 0.2 and bottoms out around 0.6
    exT = 1.0 - Math.max(0, sunDot - 0.2) * 0.55 + immerse * 0.35 + (G.night01 ?? 0) * 0.18;
  }
  // pupil response: stop-down is FAST (~0.13 s — no glare window when you
  // turn into the sun), recovery is slow (~1.5 s) like a real eye opening
  G.exposure += (exT - G.exposure) * (exT < G.exposure ? 0.18 : 0.026);

  // --- grading: golden-hour warm / night cool / storm desaturated ---
  const day01 = G.day01 ?? 0.46;
  const elev = Math.sin(day01 * Math.PI * 2);
  const golden = Math.max(0, 1 - Math.abs(elev) * 3.2) * (1 - (G.night01 ?? 0));
  const warm = [
    1 + golden * 0.10,
    1 + golden * 0.01,
    1 - golden * 0.14 + (G.night01 ?? 0) * 0.06,
  ];
  const sat = 1 - weather.cur.gray * 0.28 - (G.night01 ?? 0) * 0.12;

  // --- radial speed blur: hard turns + our launch punch ---
  const omega = player.body ? player.body.omega.length() : 0;
  weapons.fxPunch = Math.max(0, (weapons.fxPunch ?? 0) - 0.02);
  // gentled: radial only on genuinely hard maneuvers, launch punch intact
  const radial = playingLike
    ? Math.min(0.5, Math.max(0, (omega - 1.3) * 0.22) + (weapons.fxPunch ?? 0))
    : 0;

  // --- motion smear direction from roll/pitch rates (heavy maneuvers only) ---
  const motionAmt = playingLike ? Math.min(0.35, Math.max(0, omega - 2.2) * 0.09) : 0;
  const motionDir = [
    Math.max(-1, Math.min(1, player.body.omega.y * 0.6)),
    Math.max(-1, Math.min(1, -player.body.omega.x * 0.6)),
  ];

  // --- sun screen position + visibility (god rays + HUD flare share it) ---
  _pv.copy(camera.position).addScaledVector(sky.sunDir, 30000);
  _pv.project(camera);
  const sunUV = [(_pv.x * 0.5 + 0.5), (-_pv.y * 0.5 + 0.5)];
  camera.getWorldDirection(_pv2);
  const sunVis = _pv2.dot(sky.sunDir) > 0.25 && sky.sunDir.y > -0.05 && weather.cur.gray < 0.55
    ? Math.min(1, (_pv2.dot(sky.sunDir) - 0.25) * 2.4) * (1 - weather.cur.gray)
    : 0;

  // --- heat shimmer: player afterburner + freshest own missile exhaust ---
  const heat = [];
  if (playingLike && player.boosting && player.alive) {
    player.model.anchors.tail.getWorldPosition(_pv);
    _pv.project(camera);
    if (_pv.z < 1) heat.push([_pv.x * 0.5 + 0.5, -_pv.y * 0.5 + 0.5, 0.06, 0.6]);
  }
  for (let i = weapons.missiles.length - 1; i >= 0 && heat.length < 2; i--) {
    const c = weapons.missiles[i];
    if (!c.fromPlayer || c.life > 2.2) continue;
    _pv.copy(c.pos).project(camera);
    if (_pv.z < 1) heat.push([_pv.x * 0.5 + 0.5, -_pv.y * 0.5 + 0.5, 0.035, 0.45]);
  }

  // --- cinematic DOF: only during kill-cam slow-mo / intro / ace cut ---
  let dofAmt = 0, dofFocus = 900;
  if (G.timeScale < 0.95 || G.state === 'intro' || G.aceCut > 0) {
    dofAmt = 0.34;
    let best = 1e9;
    for (const e of enemies.enemies) {
      const d = e.position.distanceTo(camera.position);
      if (d < best) best = d;
    }
    dofFocus = best < 1e8 ? best : 900;
  }

  // volumetric cloud uniforms: camera, sun, weather coverage
  _pm.copy(camera.projectionMatrix).multiply(camera.matrixWorldInverse).invert();
  postfx.setState({
    cloudState: playingLike ? {
      camPos: camera.position,
      invVP: _pm,
      sunDir: sky.sunDir,
      coverage: clamp(0.52 + weather.cur.gray * 0.85 + (weather.cur.alpha - 0.82) * 0.6, 0.2, 1),
      dark: weather.cur.gray,
      night: G.night01 ?? 0,
    } : null,
    exposure: G.exposure,
    bloom: 0.6 + (G.night01 ?? 0) * 0.35 + weather.cur.gray * 0.1,
    radial, radialC: [0.5, 0.52],
    sunUV, sunVis, godray: 0.85,
    motionDir, motionAmt,
    dofAmt, dofFocus,
    warm, sat,
    vignette: 0.4 + (player.gGrey ?? 0) * 0.35,
    flash: (weather.flash ?? 0) * 0.5,
    heat,
    cloud: G.cloud ?? 0,
    rain: weather.cur.rain,
  });

  postfx.beginScene();
  renderer.render(scene, camera);
  postfx.setPipSource(pipSrc);
  // PIP box: 24% of screen width, TRUE 16:9 by pixels (not screen
  // fractions) so the seeker image is never stretched; ultra-thin frame +
  // hard viewport-safety: the box ALWAYS lands fully inside the browser
  // window at any aspect ratio.
  // LEFT side, high: rides the gap under the screen top, clear of the
  // speed tape's fixed-px furniture (SPD label sits at h/2-176). It used
  // to sit right at 0.30h and covered the altitude tape's upper third;
  // the second clamp keeps the box's bottom edge above the tape on short
  // windows, the floor keeps it on-screen at all
  const PIP_W = Math.min(0.155, (innerWidth - 40) / innerWidth);
  const PIP_H = Math.min((PIP_W * innerWidth * 9 / 16) / innerHeight, 0.2);
  const PIP_CX = PIP_W / 2 + 0.025;
  const PIP_CY = Math.max(PIP_H / 2 + 0.02,
    Math.min(PIP_H / 2 + 0.115, 0.5 - 188 / innerHeight - PIP_H / 2));
  if (pipSrc) {
    postfx.setPip(G.pipOpen, G.pipZoom, G.pipGlitch ?? 0);
    postfx.setPipRect(PIP_CX * 2 - 1, 1 - PIP_CY * 2, PIP_W * 2, PIP_H * 2);
  }
  postfx.composite(scene, camera);

  // PIP border rect for the HUD canvas (pixels), same fractions
  const rect = pipSrc ? {
    x: (PIP_CX - PIP_W / 2) * innerWidth,
    y: (PIP_CY - PIP_H / 2) * innerHeight,
    w: PIP_W * innerWidth,
    h: PIP_H * innerHeight,
  } : null;
  window.__pipRect = rect;
  return rect;
}

function renderHUD(pipRect) {
  const mins = Math.floor(((G.day01 ?? 0.46) * 24 + 6) % 24 * 60);
  const clock = `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
  hud.draw(G.paused ? 0 : 1 / 60, {
    state: G.state === 'intro' ? 'playing' : G.state,
    paused: G.paused,
    training: G.training,
    player, camera,
    enemies: enemies.enemies,
    weapons,
    kills: G.kills, score: G.score, wave: enemies.wave,
    time: G.time,
    clock, weatherName: weather.name,
    radarRange: G.radarRange,
    rain: weather.cur.rain,
    inCloud: weather.cur.gray > 0.28 && Math.abs(player.position.y - 2750) < 380,
    pipRect, pipOn: !!pipRect,
    sunUV: (() => { _pv.copy(camera.position).addScaledVector(sky.sunDir, 30000).project(camera); return [_pv.x * 0.5 + 0.5, -_pv.y * 0.5 + 0.5]; })(),
    sunVis: (() => { camera.getWorldDirection(_pv2); return _pv2.dot(sky.sunDir) > 0.3 && sky.sunDir.y > 0 ? Math.min(1, _pv2.dot(sky.sunDir)) : 0; })(),
    killGhosts: effects.killFlares.map(f => {
      _v2.copy(f.pos).project(camera);
      return [Math.round((_v2.x * 0.5 + 0.5) * 1000) / 1000, Math.round((-_v2.y * 0.5 + 0.5) * 1000) / 1000,
        _v2.z < 1, Math.round(f.t * 1000) / 1000, f.k];
    }),
    blastGhosts: settings.blastGhosts,
    blastFlare: settings.blastFlare,
    aceCut: G.aceCut > 0,
    cineBars: G.cineBars ?? 0,
    enemyLock: enemies.enemies.reduce((m, e) => Math.max(m, e.lockT || 0), 0),
    enemyWarm: enemies.enemies.reduce((m, e) => Math.max(m, e.warmT || 0), 0),
  });
}

// ---------- freeze harness: deterministic still at ?t=N ----------
function freezeFrame() {
  titleEl.classList.add('hidden');
  goEl.classList.add('hidden');
  G.state = 'playing';
  resetAll();
  const replayShot = q.has('replay');   // ?t=N&replay — freeze INTO the debrief page
  const dt = 1 / 60;
  const steps = Math.max(90, Math.round(FREEZE_T / dt));   // >=1.5 s so the camera settles
  let missileShots = 0;
  const shotTimes = [4.2, 9.0, 13.5];
  if (replayShot) recorder.start();
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
  if (replayShot) {
    recorder.stop();
    recorder.setResult({
      outcome: 'ended', kills: G.kills, score: G.score, wave: enemies.wave,
      time: recorder.time, crashed: false, ...recorder.stats,
    });
    G.state = 'debrief';
    debrief.show(recorder.toRecord(), { onRestart: startGame, onTitle: backToTitle });
    debrief.frame(1 / 60, renderer);   // settle one frame so stills show the page
  }
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

  try {
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
    effects.update(dt, camera);
    camera.updateMatrixWorld();
    _pm.copy(camera.projectionMatrix).multiply(camera.matrixWorldInverse).invert();
    postfx.setState({
      cloudState: {
        camPos: camera.position, invVP: _pm, sunDir: sky.sunDir,
        coverage: clamp(0.52 + weather.cur.gray * 0.85 + (weather.cur.alpha - 0.82) * 0.6, 0.2, 1),
        dark: weather.cur.gray, night: G.night01 ?? 0,
      },
      exposure: 1.05, bloom: 0.55, radial: 0, godray: 0, motionAmt: 0, dofAmt: 0, sunVis: 0, flash: 0, heat: [], vignette: 0.35,
    });
    postfx.beginScene();
    renderer.render(scene, camera);
    postfx.setPipSource(null);
    postfx.composite(scene, camera);
    hud.draw(dt, { state: 'title' });
  } else if (G.state === 'debrief') {
    // replay page owns the frame: its own scene/camera render straight
    // through the renderer; the HUD pass just clears the combat canvas
    debrief.frame(dt, renderer);
    hud.draw(dt, { state: 'debrief' });
  } else {
    if (G.state === 'gameover' && input.pressedRaw('Enter')) { startGame(); }
    else if (G.state === 'playing' && input.pressed('pause')) setPaused(!G.paused);
    if (G.state === 'intro') {
      introStep(dt);
    } else {
      const sdt = dt * G.timeScale;
      G.timeScale = Math.min(1, G.timeScale + dt * 1.6);   // slow-mo recovers
      update(sdt);
    }
    if (!player.alive) player.updateDeathCam(dt);           // falling-jet orbit
    camera.zoom = 1 + (1 - G.timeScale) * 0.09;            // slow-mo punch-in
    camera.updateProjectionMatrix();
    G.aceCut = Math.max(0, G.aceCut - dt);
    const pipRect = renderFrame(dt);
    renderHUD(pipRect);
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
  } catch (err) {
    // never let one bad frame kill the rAF loop: log it, surface it, move on.
    // The HUD announce is throttled hard — if the thrower is inside the
    // message-stack drawing itself, announcing every frame would grow the
    // queue unboundedly (the freeze-with-sound signature).
    console.error('frame error:', err);
    G.lastFrameErrAt = G.lastFrameErrAt ?? -999;
    if (G.time - G.lastFrameErrAt > 2) {
      G.lastFrameErrAt = G.time;
      try { hud.announce('SYSTEM ERROR', String(err.message).slice(0, 44), 1.6, 'crit'); } catch (_) {}
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

// ---------- gameplay options (settings section of the same panel) ----------
// toggle: { key, label, on, off }  |  slider: { key, label, kind: 'slider', min, max, step, fmt }
const OPTIONS = [
  { key: 'nearMissWhip', label: '近失弹甩镜 — 导弹掠过时镜头甩动+黑边', on: '开启', off: '关闭' },
  { key: 'blastFlare', label: '变形光条 — 爆炸与己方导弹的横向光晕', on: '开启', off: '关闭' },
  { key: 'blastGhosts', label: '爆炸鬼像链 — 大爆炸的镜头彩圈反射', on: '开启', off: '关闭' },
  { key: 'volMaster', label: '总音量', kind: 'slider', min: 0, max: 1, step: 0.05, fmt: v => Math.round(v * 100) + '%' },
  { key: 'volSfx', label: '音效 — 武器/爆炸/警报', kind: 'slider', min: 0, max: 1, step: 0.05, fmt: v => Math.round(v * 100) + '%' },
  { key: 'volEngine', label: '引擎与风声', kind: 'slider', min: 0, max: 1, step: 0.05, fmt: v => Math.round(v * 100) + '%' },
];
const settings = { nearMissWhip: true, blastFlare: true, blastGhosts: true, volMaster: 1, volSfx: 1, volEngine: 1 };      // defaults
try { Object.assign(settings, JSON.parse(localStorage.getItem('sb_opts') || '{}')); } catch { /* fresh start */ }
const saveSettings = () => { try { localStorage.setItem('sb_opts', JSON.stringify(settings)); } catch { /* private mode */ } };
window.__settings = settings;                 // debug hook

// settings -> live systems (audio inits on first gesture; applyVolumes is
// safe to call before and after)
const applyAudioSettings = () => {
  try { audio.applyVolumes({ master: settings.volMaster, sfx: settings.volSfx, engine: settings.volEngine }); }
  catch { /* audio not ready yet */ }
};
const applyBlastSettings = () => {
  effects.blastGhosts = settings.blastGhosts;   // streak half is gated HUD-side
};

const optRows = document.getElementById('opt-rows');
function renderOptions() {
  optRows.innerHTML = '';
  for (const o of OPTIONS) {
    const row = document.createElement('div');
    row.className = 'opt-row' + (o.kind === 'slider' ? ' slider' : '');
    const name = document.createElement('span');
    name.textContent = o.label;
    row.appendChild(name);
    if (o.kind === 'slider') {
      const val = document.createElement('span');
      val.className = 'val';
      val.textContent = o.fmt(settings[o.key]);
      const sld = document.createElement('input');
      sld.type = 'range';
      sld.min = o.min; sld.max = o.max; sld.step = o.step;
      sld.value = settings[o.key];
      sld.oninput = () => {
        settings[o.key] = parseFloat(sld.value);
        val.textContent = o.fmt(settings[o.key]);
        saveSettings();
        applyAudioSettings();
      };
      row.appendChild(sld);
      row.appendChild(val);
    } else {
      const tog = document.createElement('span');
      tog.className = 'tog' + (settings[o.key] ? '' : ' off');
      tog.textContent = settings[o.key] ? o.on : o.off;
      tog.onclick = () => { settings[o.key] = !settings[o.key]; saveSettings(); applyBlastSettings(); renderOptions(); };
      row.appendChild(tog);
    }
    optRows.appendChild(row);
  }
}
applyAudioSettings();   // restore persisted volumes (safe pre-gesture: init() reads them)
applyBlastSettings();   // + persisted blast-kit toggles

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
  // manual mission end only makes sense mid-mission
  document.getElementById('end-mission').style.display = G.state === 'playing' ? 'block' : 'none';
  bindEl.classList.remove('hidden');
  renderBindings();
  renderOptions();
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
// manual mission end (settings panel): seal the tape and open the debrief
document.getElementById('end-mission').addEventListener('click', () => {
  if (G.state !== 'playing') return;
  closeMenu();
  setPaused(false);
  enterDebrief('ended');
});

// title-page replay import: parse a downloaded record file into the debrief
const replayFile = document.getElementById('replay-file');
const replayEntry = document.getElementById('replay-entry');
// the title screen starts a mission on ANY click (window-level mousedown),
// so the button must swallow both phases before that listener sees them
for (const type of ['mousedown', 'mouseup', 'click']) {
  replayEntry.addEventListener(type, e => e.stopPropagation());
}
replayEntry.addEventListener('click', () => replayFile.click());
// training range entry: same swallow-the-click dance as the replay button —
// the title screen starts a mission on ANY mousedown
const trainingEntry = document.getElementById('training-entry');
const trainMenu = document.getElementById('train-menu');
for (const type of ['mousedown', 'mouseup', 'click']) {
  trainingEntry.addEventListener(type, e => e.stopPropagation());
}
trainingEntry.addEventListener('click', () => trainMenu.classList.toggle('hidden'));
for (const opt of trainMenu.querySelectorAll('.train-opt')) {
  for (const type of ['mousedown', 'mouseup', 'click']) {
    opt.addEventListener(type, e => e.stopPropagation());
  }
  opt.addEventListener('click', () => startTraining(opt.dataset.mode));
}
replayFile.addEventListener('change', () => {
  const f = replayFile.files && replayFile.files[0];
  replayFile.value = '';
  if (!f) return;
  f.text().then(txt => {
    const rec = parseRecord(txt);
    if (!rec) { console.warn('invalid record file'); return; }
    showImportedRecord(rec);
  });
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
  postfx.setSize(innerWidth, innerHeight);
  debrief.resize(innerWidth, innerHeight);
});

if (FREEZE_T !== null) {
  f14Ready.then(() => freezeFrame());   // model swap resolved first, stills show the F-14
} else {
  player.reset();           // park the jet for the title backdrop
  frame();
}
