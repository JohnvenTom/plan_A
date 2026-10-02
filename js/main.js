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
import { AASites } from './aasites.js';
import { Effects } from './effects.js';
import { HUD } from './hud.js';
import { PostFX } from './postfx.js';
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
window.__hud = hud;   // debug hook
window.__weapons = weapons;   // debug hook
window.__player = player;     // debug hook
window.__enemies = enemies;   // debug hook
window.__aaSites = aaSites;   // debug hook
window.__weather = weather;   // debug hook
window.__scene = scene;       // debug hook (screenshot harness: __renderer.render(__scene, __player.camera))
window.__renderer = renderer; // debug hook
const audio = new GameAudio();
// post-processing stack + missile-cam picture-in-picture rig
const postfx = new PostFX(renderer);
const mslCam = new THREE.PerspectiveCamera(58, 16 / 9, 2, 72000);
const mslRT = new THREE.WebGLRenderTarget(480, 270, { type: THREE.HalfFloatType });
mslRT.depthTexture = new THREE.DepthTexture(480, 270);
mslRT.depthTexture.type = THREE.UnsignedIntType;
const mslRT2 = new THREE.WebGLRenderTarget(480, 270, { type: THREE.HalfFloatType, depthBuffer: false });
window.__postfx = postfx;   // debug hook
weather.onChange = (name) => hud.announce('天气变化', name, 1.6, 'info');
const input = new Input();
weapons.playerRef = player;
weapons.audio = audio;
weapons.hud = hud;

const flashEl = document.getElementById('flash');
const titleEl = document.getElementById('title');
const goEl = document.getElementById('gameover');

// ---------- game state ----------
const G = {
  state: 'title',           // title | intro | playing | gameover
  kills: 0, score: 0,
  time: 0, deathTimer: 0, paused: false, menuOpen: false,
  contrailT: 0, smokeT: 0,
  timeScale: 1,             // kill-cam micro slow-motion
  fxPunch: 0,               // radial-blur punch on our missile launch
  aceCut: 0,                // ace-intro letterbox timer
  pipOpen: 0,               // missile-cam CRT open progress
  pipGlitch: 0,             // missile-cam signal-fault burst
  pipZoom: 1,               // missile-cam impact zoom
  pipMsl: null,             // missile the PIP rides
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
    hud.announce('摧毁目标', `TARGET DESTROYED  +${(250 + enemies.wave * 25) * (enemy.ace ? 2 : 1)}${enemy.ace ? ' · ACE x2' : ''}`, 2.2, 'kill');
    hud.destroyed();
    audio.kill();
    effects.ring?.(enemy.position, 1.3);
    G.timeScale = 0.25;   // kill-cam micro slow-motion
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
  aaSites.reset();
  hud.msgQueue.length = 0;
  hud.announce('任务开始', 'OPERATION GOLDEN HOUR', 3.0, 'info');
}

function startGame() {
  audio.init(); audio.resume(); audio.setRunning(true);
  resetAll();
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
  document.getElementById('go-stats').innerHTML = [
    ['击坠', G.kills], ['波次', enemies.wave], ['得分', G.score], ['存活', Math.round(G.time) + ' s'],
  ].map(([k, v], i) => `<div class="row" style="animation-delay:${0.15 * i}s"><span>${k}</span><b>${v}</b></div>`).join('');
  const win = false;
  document.getElementById('go-title').textContent = 'MISSION FAILED';
  document.getElementById('go-sub').textContent = player.crashed ? '机体触地坠毁' : '机体损毁';
  goEl.classList.remove('hidden');
}


// ---------- environment: 8-minute day/night cycle + dynamic weather ----------
const DAY_LEN = 1200;                      // seconds for a full day (20 min)
function introStep(dt) {
  G.introT -= dt;
  player.update(dt, INTRO_INPUT);
  enemies.update(dt, player, { effects });
  effects.update(dt);
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
    hud.announce('MISSION START', '任务开始 — 拦截入侵机群', 2.2, 'wave');
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
        weapons.mslKind === 'radar' ? 'RADAR — 20km 即时锁定 · 预热后发射 · 39/箔条可避' : 'IR — 热源导引 · 预热后发射 · 热诱弹可避', 1.2, 'info');
    }
    if (input.pressed('cycleTarget')) weapons.headLockAttempt(player, enemies.enemies);
    if (input.pressed('debugWeather')) {
      G._wxIdx = ((G._wxIdx ?? -1) + 1) % ['晴', '多云', '阴', '毛毛雨', '雨', '雷暴', '浓雾', '狂风'].length;
      const names = ['晴', '多云', '阴', '毛毛雨', '雨', '雷暴', '浓雾', '狂风'];
      const keys = ['clear', 'cloudy', 'overcast', 'drizzle', 'rain', 'storm', 'fog', 'gale'];
      weather.force(keys[G._wxIdx]);
      hud.announce('天气切换', names[G._wxIdx] + '（调试）', 1.2, 'info');
    }
    weapons.updateFireControl(dt, player, enemies.enemies);

    // world
    enemies.update(dt, player, player.alive ? killCtx : { effects });
    aaSites.update(dt, player, weapons, effects);
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
      else if (ev.type === 'ace') { hud.announce('⚠ 王牌机参战', 'ACE — 高机动 · 击坠双倍分', 3.2, 'wave'); G.aceCut = 1.6; }
    }
    enemies.events.length = 0;

    for (const ev of weapons.events) {
      if (ev.type === 'nearMiss') {
        player.applyWhip(ev.dir);
        player.camShake = Math.min(1, player.camShake + 0.22);
        audio.nearMiss();
        G.cineT = 1.15;            // letterbox rises for the whip moment
      } else if (ev.type === 'hitTing') {
        audio.hitTing();
      }
    }
    // supersonic boom: one-shot ring + thunder when crossing the sound barrier
    if (player.alive) {
      if (!G._mach && player.speed > 340) { G._mach = true; effects.ring(player.position, 1.6); audio.sonicBoom(); }
      else if (G._mach && player.speed < 320) G._mach = false;
    }

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
    // facing the sun the eye STOPS DOWN (whole frame dims, sun itself
    // blooms) — the old positive boost blew the sky out
    exT = 1.0 - Math.max(0, sunDot - 0.3) * 0.34 + immerse * 0.35 + (G.night01 ?? 0) * 0.18;
  }
  G.exposure += (exT - G.exposure) * 0.045;

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
  // fractions) so the seeker image is never stretched; top-right corner
  // ultra-thin frame + hard viewport-safety: the box ALWAYS lands fully
  // inside the browser window at any aspect ratio
  const PIP_W = Math.min(0.155, (innerWidth - 40) / innerWidth);
  const PIP_H = Math.min((PIP_W * innerWidth * 9 / 16) / innerHeight, 0.2);
  const PIP_CX = 1 - PIP_W / 2 - 0.025;
  const PIP_CY = Math.min(PIP_H / 2 + 0.30, 1 - PIP_H / 2 - 0.05);
  if (pipSrc) {
    postfx.setPip(G.pipOpen, G.pipZoom, G.pipGlitch ?? 0);
    postfx.setPipRect(PIP_CX * 2 - 1, 1 - PIP_CY * 2, PIP_W * 2, PIP_H * 2);
  }
  postfx.composite();

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
    player, camera,
    enemies: enemies.enemies,
    weapons,
    kills: G.kills, score: G.score, wave: enemies.wave,
    time: G.time,
    clock, weatherName: weather.name,
    rain: weather.cur.rain,
    inCloud: weather.cur.gray > 0.28 && Math.abs(player.position.y - 2750) < 380,
    pipRect, pipOn: !!pipRect,
    sunUV: (() => { _pv.copy(camera.position).addScaledVector(sky.sunDir, 30000).project(camera); return [_pv.x * 0.5 + 0.5, -_pv.y * 0.5 + 0.5]; })(),
    sunVis: (() => { camera.getWorldDirection(_pv2); return _pv2.dot(sky.sunDir) > 0.3 && sky.sunDir.y > 0 ? Math.min(1, _pv2.dot(sky.sunDir)) : 0; })(),
    aceCut: G.aceCut > 0,
    cineBars: G.cineBars ?? 0,
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
    effects.update(dt);
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
    postfx.composite();
    hud.draw(dt, { state: 'title' });
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
      try { hud.announce('⚠ 系统异常', String(err.message).slice(0, 44), 1.6, 'crit'); } catch (_) {}
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
  postfx.setSize(innerWidth, innerHeight);
});

if (FREEZE_T !== null) {
  f14Ready.then(() => freezeFrame());   // model swap resolved first, stills show the F-14
} else {
  player.reset();           // park the jet for the title backdrop
  frame();
}
