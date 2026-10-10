// debrief.js — post-mission flight-record replay: a dark analysis scene (sea
// grid + dim terrain wireframe) where every recorded body flies again as a
// color-coded triangular cone, trails brighten up to the playhead, combat
// events sit on the map as clickable markers, and an Ace-Combat-style results
// panel (rank / stats / kill list) is fused into the same page. Own THREE
// scene + camera, rendered straight through the renderer (no weather / post).
//
// DOM note: the 3D build (buildRecord) is pure three.js and runs headless;
// show()/frame() additionally bind the #debrief DOM overlay.
import * as THREE from 'three';
import { terrainSurfaceAt, SEA_LEVEL } from '../world/terrain.js';
import { activeMap } from '../world/maps.js';
import { PLAYER_COLOR, ACE_COLOR, MSL_COLOR_P, MSL_COLOR_E, ENEMY_PALETTE } from './recorder.js';

const COMBAT_R = 14000;
const GRID_EXT = 16000;
const GRID_STEP = 1000;

// ---- event visual language (glyph + size + tint; drawn white, tinted per
// instance) ----
const EV_GLYPHS = {
  launch:    { draw: tri,     size: 190, label: '导弹发射' },
  hit:       { draw: xmark,   size: 130, label: '命中' },
  kill:      { draw: circX,   size: 250, label: '击坠' },
  flare:     { draw: star4,   size: 150, label: '干扰弹' },
  nearMiss:  { draw: chevron, size: 190, label: '近失弹' },
  intercept: { draw: diamond, size: 200, label: '拦截成功' },
  damage:    { draw: triDown, size: 210, label: '受击' },
  crash:     { draw: circX,   size: 330, label: '坠机' },
  gunFire:   { draw: burst3,  size: 120, label: '机炮射击' },
};
const EV_COLOR = {
  flare: 0xffe9a0, nearMiss: 0xffb347, intercept: 0x53e3ff,
  damage: 0xff5252, hit: 0xf0f6ff,
};
const RANK_COLOR = { S: '#ffd24d', A: '#53e3ff', B: '#8dffb0', C: '#c9d6e8', D: '#8fa5bd' };

// playback speed tape: 0.5x detents across 0.5–16x; labeled ticks sit on the
// powers of two so the readout carries the exact half-step value
const SPD_MIN = 0.5, SPD_MAX = 16, SPD_STEP = 0.5;
const spdSnap = v => Math.round(Math.max(SPD_MIN, Math.min(SPD_MAX, v)) / SPD_STEP) * SPD_STEP;

// ---------- tiny canvas glyphs (cached per type) ----------
const _texCache = new Map();
function glyphTexture(type) {
  if (_texCache.has(type)) return _texCache.get(type);
  const c = document.createElement('canvas');
  c.width = c.height = 96;
  const g = c.getContext('2d');
  g.strokeStyle = g.fillStyle = '#fff';
  g.lineWidth = 7; g.lineCap = 'round'; g.lineJoin = 'round';
  EV_GLYPHS[type].draw(g);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  _texCache.set(type, tex);
  return tex;
}
function tri(g) { g.beginPath(); g.moveTo(48, 14); g.lineTo(82, 74); g.lineTo(14, 74); g.closePath(); g.stroke(); }
function burst3(g) {
  // tracer burst: muzzle streak + three shells flying line-astern
  g.beginPath(); g.moveTo(8, 48); g.lineTo(26, 48); g.stroke();
  g.lineWidth = 4;
  for (const x of [44, 64, 84]) { g.beginPath(); g.arc(x, 48, 5, 0, Math.PI * 2); g.fill(); }
}
function triDown(g) { g.beginPath(); g.moveTo(48, 82); g.lineTo(82, 22); g.lineTo(14, 22); g.closePath(); g.fill(); }
function xmark(g) { g.beginPath(); g.moveTo(26, 26); g.lineTo(70, 70); g.moveTo(70, 26); g.lineTo(26, 70); g.stroke(); }
function circX(g) {
  g.beginPath(); g.arc(48, 48, 34, 0, Math.PI * 2); g.stroke();
  g.lineWidth = 6; xmark(g);
}
function star4(g) {
  g.beginPath();
  for (let i = 0; i < 8; i++) {
    const r = i % 2 ? 14 : 40, a = i * Math.PI / 4 - Math.PI / 2;
    g[i ? 'lineTo' : 'moveTo'](48 + Math.cos(a) * r, 48 + Math.sin(a) * r);
  }
  g.closePath(); g.fill();
}
function chevron(g) {
  g.beginPath();
  g.moveTo(16, 34); g.lineTo(48, 58); g.lineTo(80, 34);
  g.moveTo(16, 58); g.lineTo(48, 82); g.lineTo(80, 58);
  g.stroke();
}
function diamond(g) {
  g.beginPath(); g.moveTo(48, 10); g.lineTo(86, 48); g.lineTo(48, 86); g.lineTo(10, 48);
  g.closePath(); g.stroke();
  g.beginPath(); g.arc(48, 48, 7, 0, Math.PI * 2); g.fill();
}

// ---------- shared trail shader: whole path dim, played portion bright ----------
const TRAIL_VERT = `
attribute float aT;
varying float vT;
void main() { vT = aT; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const TRAIL_FRAG = `
uniform vec3 uColor;
uniform float uHead;    // playhead mission time
uniform float uMul;     // alpha multiplier (missile trails are quieter)
uniform float uDash;    // 1 = dotted missile trail
varying float vT;
void main() {
  float b = 1.0 - smoothstep(uHead - 1.2, uHead, vT);   // 1 behind the head
  float a = mix(0.16, 0.9, b) * uMul;
  if (uDash > 0.5 && fract(vT * 2.0) < 0.45) discard;
  gl_FragColor = vec4(uColor * mix(0.6, 1.25, b), a);
}`;

// ---------- the marker cone: 3-sided spike, nose = -Z, vertex-color gradient
// bright tip -> dark base so heading reads at a glance ----------
function buildConeGeometry(color) {
  const h = 1, r = 0.5;
  const apex = [0, 0, -h / 2];
  const base = [];
  for (let i = 0; i < 3; i++) {
    const a = Math.PI / 2 + i * (Math.PI * 2 / 3);
    base.push([Math.cos(a) * r, Math.sin(a) * r, h / 2]);
  }
  const tip = new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.75);
  const dark = new THREE.Color(color).multiplyScalar(0.35);
  const pos = [], col = [];
  const vert = (p, c) => { pos.push(...p); col.push(c.r, c.g, c.b); };
  for (let i = 0; i < 3; i++) {
    const b0 = base[i], b1 = base[(i + 1) % 3];
    vert(apex, tip); vert(b0, dark); vert(b1, dark);       // side
  }
  vert(base[0], dark); vert(base[2], dark); vert(base[1], dark);  // base cap
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return geo;
}

function fmtT(t) {
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export class Debrief {
  constructor() {
    this.active = false;
    this.record = null;
    this.hooks = {};
    this.play = { t: 0, playing: false, speed: 1, intro: false, introSpeed: 8 };
    this.cam = { mode: 'orbit', yaw: 0.8, pitch: 0.42, dist: 5600, followId: null };
    this._tmp = new THREE.Vector3();
    this._camPos = new THREE.Vector3();
    this._camLook = new THREE.Vector3();
    this._scoreShown = 0;

    // ---- persistent scene shell (terrain wireframe never changes) ----
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x05070f);
    this.scene.fog = new THREE.FogExp2(0x05070f, 0.000012);
    this.camera = new THREE.PerspectiveCamera(55, 16 / 9, 20, 120000);
    this.uHead = { value: 0 };   // shared by every trail material
    this._buildShell();
    this.recGroup = null;
    this.tracks = [];            // prepared per-record view models
    this.markers = [];           // {ev, sprite, colorHex, label}
    this._dom = null;            // bound overlay (show())

    // ---- replayed gun bursts actually FIRE: pooled tracer streaks spawned
    // from the shooter's interpolated pose while the playhead is inside the
    // burst's [t, t+dur] window (both sides, colors matching live tracers).
    // Camera-facing additive QUADS, not lines: WebGL line width is stuck at
    // 1 px, which made the old LineSegments invisible at replay zoom. ----
    this._tracers = [];
    this._tracerAcc = new Map(); // gunFire event -> spawn accumulator
    this._gunEv = [];
    this._tracerCap = 420;
    this._tracerMesh = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        transparent: true, blending: THREE.AdditiveBlending,
        depthWrite: false, side: THREE.DoubleSide,
      }),
      this._tracerCap);
    this._tracerMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._tracerMesh.frustumCulled = false;
    this._tracerMesh.count = 0;
    this.scene.add(this._tracerMesh);
    this._lsn = [];              // [target, type, fn] added while active
  }

  _buildShell() {
    // terrain wireframe over the combat area; sea clamps to the y=0 grid so
    // the floor reads as one continuous reference plane
    const pts = [];
    const hy = (x, z) => Math.max(terrainSurfaceAt(x, z), SEA_LEVEL);
    for (let x = -GRID_EXT; x <= GRID_EXT; x += GRID_STEP) {
      for (let z = -GRID_EXT; z < GRID_EXT; z += GRID_STEP) {
        pts.push(x, hy(x, z), z, x, hy(x, z + GRID_STEP), z + GRID_STEP);
      }
    }
    for (let z = -GRID_EXT; z <= GRID_EXT; z += GRID_STEP) {
      for (let x = -GRID_EXT; x < GRID_EXT; x += GRID_STEP) {
        pts.push(x, hy(x, z), z, x + GRID_STEP, hy(x + GRID_STEP, z), z);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const lines = new THREE.LineSegments(geo,
      new THREE.LineBasicMaterial({ color: 0x233655, transparent: true, opacity: 0.5 }));
    lines.frustumCulled = false;
    this.scene.add(lines);
    // combat-area boundary ring
    const ring = [];
    for (let i = 0; i < 128; i++) {
      const a0 = i / 128 * Math.PI * 2, a1 = (i + 1) / 128 * Math.PI * 2;
      ring.push(Math.cos(a0) * COMBAT_R, 0, Math.sin(a0) * COMBAT_R,
        Math.cos(a1) * COMBAT_R, 0, Math.sin(a1) * COMBAT_R);
    }
    const rgeo = new THREE.BufferGeometry();
    rgeo.setAttribute('position', new THREE.Float32BufferAttribute(ring, 3));
    const ringMesh = new THREE.LineSegments(rgeo,
      new THREE.LineBasicMaterial({ color: 0x8a6a3a, transparent: true, opacity: 0.4 }));
    ringMesh.frustumCulled = false;
    this.scene.add(ringMesh);
    this._coneMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95 });
    this._raycaster = new THREE.Raycaster();
  }

  // ---------- per-record 3D build (headless-safe: no DOM) ----------
  buildRecord(rec) {
    if (this.recGroup) {
      this.recGroup.traverse(o => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
      this.scene.remove(this.recGroup);
    }
    this.record = rec;
    this.tracks = [];
    this.markers = [];
    this._tracers.length = 0;
    this._tracerAcc.clear();
    this._gunEv = rec.events.filter(e => e.type === 'gunFire');
    const g = new THREE.Group();
    this.recGroup = g;
    this.scene.add(g);

    const trackById = new Map();
    for (const tr of rec.tracks) {
      if (tr.s.length < 8) continue;
      const n = tr.s.length / 8;
      const color = trackColor(tr);
      const vm = {
        meta: tr, n, samples: tr.s, cursor: 0, color,
        label: trackLabel(tr),
        r: tr.kind === 'missile' ? 26 : 55,
        h: tr.kind === 'missile' ? 90 : (tr.ace ? 200 : 150),
        t0: tr.s[0], tEnd: tr.s[(n - 1) * 8],
        pos: new THREE.Vector3(), quat: new THREE.Quaternion(), visibleAtT: false,
      };
      trackById.set(tr.id, vm);
      // trail line
      if (n >= 2) {
        const pos = new Float32Array(n * 3), ts = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          pos[i * 3] = tr.s[i * 8 + 1]; pos[i * 3 + 1] = tr.s[i * 8 + 2]; pos[i * 3 + 2] = tr.s[i * 8 + 3];
          ts[i] = tr.s[i * 8];
        }
        const lg = new THREE.BufferGeometry();
        lg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        lg.setAttribute('aT', new THREE.Float32BufferAttribute(ts, 1));
        const mat = new THREE.ShaderMaterial({
          vertexShader: TRAIL_VERT, fragmentShader: TRAIL_FRAG,
          uniforms: {
            uColor: { value: new THREE.Color(color) },
            uHead: this.uHead,
            uMul: { value: tr.kind === 'missile' ? 0.55 : 1 },
            uDash: { value: tr.kind === 'missile' ? 1 : 0 },
          },
          transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        });
        const line = new THREE.Line(lg, mat);
        line.frustumCulled = false;
        vm.trail = line;
        g.add(line);
      }
      // marker cone
      const cone = new THREE.Mesh(buildConeGeometry(color), this._coneMat);
      cone.scale.set(vm.r, vm.r, vm.h);
      cone.visible = false;
      cone.userData.trackId = tr.id;
      vm.cone = cone;
      g.add(cone);
      this.tracks.push(vm);
    }

    // event markers (positionless timeline-only ticks excluded). Glyph
    // textures need a canvas — under a headless build skip the sprites; the
    // trails/cones still build and the events stay on the timeline.
    const canDraw = typeof document !== 'undefined';
    for (const ev of rec.events) {
      if (ev.x === undefined || !canDraw) continue;
      const def = EV_GLYPHS[ev.type];
      if (!def) continue;
      let color = EV_COLOR[ev.type];
      if (ev.type === 'kill' && trackById.has(ev.victim)) color = trackById.get(ev.victim).color;
      else if (ev.type === 'crash') color = PLAYER_COLOR;
      else if (ev.type === 'launch' || ev.type === 'gunFire') color = ev.side === 'p' ? MSL_COLOR_P : MSL_COLOR_E;
      else if (ev.type === 'flare' && ev.side === 'e' && trackById.has(ev.m)) color = trackById.get(ev.m).color;
      const mat = new THREE.SpriteMaterial({
        map: glyphTexture(ev.type), color, transparent: true,
        depthTest: false, depthWrite: false,
      });
      const sp = new THREE.Sprite(mat);
      sp.position.set(ev.x, ev.y, ev.z);
      sp.renderOrder = 10;
      sp.visible = false;
      sp.userData.ev = ev;
      g.add(sp);
      let label = def.label + (ev.type === 'kill' && ev.w ? ` · ${ev.w === 'gun' ? '机炮' : '导弹'}` : '');
      // enemy flare bursts are throttled aggregates: smaller glyph + owner tag
      const eFlare = ev.type === 'flare' && ev.side === 'e';
      if (eFlare) label += '（敌）';
      this.markers.push({ ev, sprite: sp, color, label, size: def.size * (eFlare ? 0.7 : 1) });
    }
  }

  // ---------- lifecycle ----------
  show(rec, hooks = {}) {
    this.hooks = hooks;
    this.buildRecord(rec);
    this._bindDOM();
    const d = this._dom;
    d.root.classList.remove('hidden');
    d.root.classList.remove('panel-hidden');
    this.active = true;
    this._attachListeners();

    // results panel
    const res = rec.result || deriveResult(rec);
    this._result = res;
    d.panel.classList.toggle('done', res.outcome !== 'failed');
    d.title.textContent = res.outcome === 'failed' ? 'MISSION FAILED' : 'FLIGHT RECORD';
    d.sub.textContent = res.outcome === 'failed'
      ? (res.crashed ? '机体触地坠毁' : '机体损毁')
      : '任务记录 · 手动结束';
    // replay terrain comes from the ACTIVE war zone; a foreign-map record
    // still plays, but the ground under it won't match what was flown
    if (rec.map && rec.map !== activeMap.id)
      d.sub.textContent += ` — ⚠ ${rec.map === 'large' ? '超大 80km' : '经典 24km'} 图记录，请先在标题屏切换战区`;
    d.rank.textContent = res.grade || '—';
    d.rank.style.color = RANK_COLOR[res.grade] || '#c9d6e8';
    d.rank.style.textShadow = `0 0 26px ${(RANK_COLOR[res.grade] || '#c9d6e8') + '66'}`;
    const acc = res.accuracy != null ? Math.round(res.accuracy * 100) + '%' : '—';
    d.stats.innerHTML = [
      ['击坠 KILLS', res.kills ?? 0],
      ['最高波次 WAVE', res.wave ?? 0],
      ['总得分 SCORE', res.score ?? 0],
      ['存活 TIME', fmtT(res.time ?? rec.duration)],
      ['命中率 ACC', acc],
      ['我方机炮 GUNS', `${res.pBursts ?? 0}段 · ${res.gunFired ?? 0}发`],
      ['敌方机炮 HOSTILE', `${res.eBursts ?? 0}段 · ${res.egunFired ?? 0}发`],
    ].map(([k, v], i) =>
      `<div class="row" style="animation-delay:${0.12 * i + 0.3}s"><span>${k}</span><b>${v}</b></div>`).join('');
    this._scoreShown = 0;
    d.bigScore.textContent = '0';
    this._scoreAnimT = 0;

    // kill list (click a row -> the replay jumps to that kill)
    const kills = rec.events.filter(e => e.type === 'kill');
    d.kills.innerHTML = kills.map((e, i) => {
      const c = trackByIdColor(this.tracks, e.victim);
      const who = e.victim
        ? (e.ace ? `王牌机 ${e.victim.toUpperCase()}` : `敌机 ${e.victim.toUpperCase()}`)
        : '未知目标';
      return `<div class="kill-row" data-t="${e.t}" style="animation-delay:${0.55 + i * 0.14}s">
        <span class="kt">T+${fmtT(e.t)}</span>
        <span class="chip" style="background:#${c.toString(16).padStart(6, '0')}"></span>
        <span class="kw">${who}${e.ace ? ' <i class="ace-tag">ACE</i>' : ''}</span>
        <span class="km">${e.w === 'gun' ? '机炮' : e.w === 'msl' ? '导弹' : '—'}</span>
      </div>`;
    }).join('') || '<div class="kill-row none">本次任务无击坠记录</div>';
    for (const row of d.kills.querySelectorAll('.kill-row[data-t]')) {
      row.addEventListener('click', () => {
        this.seek(parseFloat(row.dataset.t));
        this._cancelIntro();
      });
    }

    // timeline ticks + event dots
    const dur = Math.max(0.001, rec.duration);
    let ticks = '', dots = '';
    for (const ev of rec.events) {
      const p = (ev.t / dur * 100).toFixed(2);
      if (ev.type === 'wave') ticks += `<i class="tk wave" style="left:${p}%"></i>`;
      else if (ev.type === 'ace') ticks += `<i class="tk ace" style="left:${p}%"></i>`;
      else if (ev.type === 'waveClear') ticks += `<i class="tk clear" style="left:${p}%"></i>`;
      // gun bursts are frequent: thin side-colored ticks, not fat event dots
      else if (ev.type === 'gunFire') ticks += `<i class="tk gun ${ev.side}" style="left:${p}%" title="机炮射击 T+${fmtT(ev.t)}"></i>`;
      else if (EV_GLYPHS[ev.type]) {
        const c = markerHex(this.tracks, ev);
        const big = ev.type === 'kill' || ev.type === 'crash' ? ' big' : '';
        dots += `<i class="dot${big}" data-t="${ev.t}" title="${EV_GLYPHS[ev.type].label} T+${fmtT(ev.t)}" style="left:${p}%;border-color:#${c}"></i>`;
      }
    }
    d.ticks.innerHTML = ticks;
    d.dots.innerHTML = dots;
    for (const dot of d.dots.querySelectorAll('.dot')) {
      dot.addEventListener('click', ev => {
        ev.stopPropagation();
        this.seek(parseFloat(dot.dataset.t));
        this._cancelIntro();
      });
    }
    d.total.textContent = fmtT(rec.duration);
    this.setSpeed(1);
    this.setPlaying(true);
    // entry sweep: fast draw-in of the whole mission, then rest at the end
    this.play.intro = true;
    this.play.t = 0;
    this.play.introSpeed = Math.min(24, Math.max(2, rec.duration / 8));

    // camera fly-in start pose
    this._followId = null;
    this.cam.mode = 'orbit';
    this._camPos.copy(this._orbitTargetAt(0)).add(new THREE.Vector3(
      Math.cos(this.cam.yaw + 2.4) * this.cam.dist * 2.6, this.cam.dist * 1.9,
      Math.sin(this.cam.yaw + 2.4) * this.cam.dist * 2.6));
    this._camLook.copy(this._orbitTargetAt(0));
  }

  hide() {
    this.active = false;
    this._detachListeners();
    if (this._dom) {
      this._dom.root.classList.add('hidden');
      this._dom.tip.style.display = 'none';
    }
  }

  // ---------- per-frame ----------
  frame(dt, renderer) {
    // `active` is the DOM/listener lifecycle; the playback math only needs a
    // record (headless probes drive frame() without ever calling show())
    if (!this.record) return;
    const p = this.play, rec = this.record;
    if (p.playing) {
      p.t += dt * (p.intro ? p.introSpeed : p.speed);
      if (p.t >= rec.duration) {
        p.t = rec.duration;
        p.playing = false;
        p.intro = false;
        this._syncPlayBtn();
      }
    }
    this.uHead.value = p.t;

    // tracks: interpolate cone pose at the playhead
    for (const vm of this.tracks) this._updateTrack(vm, p.t);

    // replayed gun fire flies in mission time (frozen when paused)
    const sdt = p.playing ? dt * (p.intro ? p.introSpeed : p.speed) : 0;
    this._updateTracers(sdt, p.t);

    // markers: past events visible, fade-in over 0.3 s, distance-compensated
    const camDist = this.camera.position.distanceTo(this._camLook);
    for (const mk of this.markers) {
      const age = p.t - mk.ev.t;
      const vis = age >= 0;
      mk.sprite.visible = vis;
      if (!vis) continue;
      mk.sprite.material.opacity = Math.min(1, age / 0.3) * 0.95;
      const s = mk.size * Math.min(4.5, Math.max(1, camDist / 6000));
      mk.sprite.scale.set(s, s, 1);
    }

    this._updateCamera(dt);
    this._updateUI(dt);

    if (renderer) {
      // flat colors read truer without the battlefield's filmic curve
      const tm = renderer.toneMapping;
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.render(this.scene, this.camera);
      renderer.toneMapping = tm;
    }
  }

  // spawn + advance replayed tracers: while the playhead sits inside a
  // gunFire burst, streaks pour from the shooter's pose at ~28 rps (mission
  // time), fly ~1100 m/s along the nose with a touch of spread, fade out
  _updateTracers(sdt, t) {
    const tr = this._tracers;
    for (const ev of this._gunEv) {
      const dur = ev.dur || 0.25;
      if (t < ev.t || t > ev.t + dur) { this._tracerAcc.delete(ev); continue; }
      if (sdt <= 0) continue;
      const vm = this._trackById(ev.m)
        || (ev.side === 'p' ? this.tracks.find(v => v.meta.kind === 'player') : null);
      if (!vm || !vm.visibleAtT) continue;
      _v1.set(0, 0, -1).applyQuaternion(vm.quat);   // nose direction
      let acc = Math.min(30, (this._tracerAcc.get(ev) || 0) + sdt * 28);
      while (acc >= 1 && tr.length < this._tracerCap) {
        acc -= 1;
        const s = 0.006;
        tr.push({
          x: vm.pos.x + _v1.x * 12, y: vm.pos.y + _v1.y * 12, z: vm.pos.z + _v1.z * 12,
          vx: (_v1.x + (Math.random() - .5) * s) * 1100,
          vy: (_v1.y + (Math.random() - .5) * s) * 1100,
          vz: (_v1.z + (Math.random() - .5) * s) * 1100,
          life: 0.7, side: ev.side,
        });
      }
      this._tracerAcc.set(ev, acc);
    }
    // integrate, then lay each tracer out as a camera-facing quad whose
    // length/width scale with view distance — readable from follow-cam to
    // full-battlefield overview
    for (let i = tr.length - 1; i >= 0; i--) {
      const b = tr[i];
      b.life -= sdt;
      if (b.life <= 0) { tr.splice(i, 1); continue; }
      if (sdt > 0) { b.x += b.vx * sdt; b.y += b.vy * sdt; b.z += b.vz * sdt; }
    }
    const mesh = this._tracerMesh, camPos = this.camera.position;
    let n = 0;
    for (const b of tr) {
      if (n >= this._tracerCap) break;
      const inv = 1 / Math.hypot(b.vx, b.vy, b.vz);
      _v1.set(b.vx * inv, b.vy * inv, b.vz * inv);          // streak axis
      const camDist = camPos.distanceTo(_v2.set(b.x, b.y, b.z));
      const L = Math.max(80, camDist * 0.045);              // ~4.5% of view distance
      const W = Math.max(2.4, camDist * 0.0024);
      // billboard: plane X along the streak, Y perpendicular to the view ray
      _v2.copy(camPos).sub(_v3.set(b.x, b.y, b.z)).normalize();   // view dir
      _v3.crossVectors(_v1, _v2);
      if (_v3.lengthSq() < 1e-6) _v3.set(0, 1, 0).cross(_v1);    // dead-on view fallback
      _v3.normalize();
      _v2.crossVectors(_v3, _v1).normalize();               // right-handed basis
      _m4.makeBasis(_v1, _v3, _v2);
      _m4.scale(_vs.set(L, W, 1));
      _m4.setPosition(_v1.x * -L / 2 + b.x, _v1.y * -L / 2 + b.y, _v1.z * -L / 2 + b.z);
      mesh.setMatrixAt(n, _m4);
      const fade = Math.min(1, b.life / 0.25);
      mesh.setColorAt(n, b.side === 'p'
        ? _col.setRGB(0.4 * fade, 0.9 * fade, 1 * fade)
        : _col.setRGB(1 * fade, 0.5 * fade, 0.35 * fade));
      n++;
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  _updateTrack(vm, t) {    const s = vm.samples, n = vm.n;
    // 0.3 s bracket pad: the playhead resting exactly on `duration` sits one
    // sample-step past the last pose — without the pad every cone would
    // blink out on the final frame of the entry sweep
    vm.visibleAtT = t >= vm.t0 - 0.3 && t <= vm.tEnd + 0.3;
    if (!vm.visibleAtT) {
      vm.cone.visible = false;
      // clamp pose to the nearest end sample so orbit targets and follow cams
      // freeze at the track's end instead of snapping to the origin
      const a = t < vm.t0 ? 0 : (n - 1) * 8;
      vm.pos.set(s[a + 1], s[a + 2], s[a + 3]);
      vm.quat.set(s[a + 4], s[a + 5], s[a + 6], s[a + 7]);
      return;
    }
    // cursor walk (binary search on backward jumps / seeks)
    let i = Math.min(vm.cursor, n - 2);
    if (s[i * 8] > t) {
      let lo = 0, hi = n - 2;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (s[mid * 8] <= t) lo = mid; else hi = mid - 1;
      }
      i = lo;
    } else {
      while (i < n - 2 && s[(i + 1) * 8] <= t) i++;
    }
    vm.cursor = i;
    const a = i * 8, b = a + 8;
    const k = Math.max(0, Math.min(1, (t - s[a]) / Math.max(1e-6, s[b] - s[a])));
    vm.pos.set(
      s[a + 1] + (s[b + 1] - s[a + 1]) * k,
      s[a + 2] + (s[b + 2] - s[a + 2]) * k,
      s[a + 3] + (s[b + 3] - s[a + 3]) * k);
    vm.quat.set(s[a + 4], s[a + 5], s[a + 6], s[a + 7])
      .slerp(_q2.set(s[b + 4], s[b + 5], s[b + 6], s[b + 7]), k);
    vm.cone.visible = true;
    vm.cone.position.copy(vm.pos);
    vm.cone.quaternion.copy(vm.quat);
    // keep markers legible at overview zoom (mild, capped)
    const d = this.camera.position.distanceTo(vm.pos);
    const sc = Math.min(3, Math.max(1, d / 5200));
    vm.cone.scale.set(vm.r * sc, vm.r * sc, vm.h * sc);
  }

  // ---------- camera ----------
  _trackById(id) { return this.tracks.find(vm => vm.meta.id === id) || null; }

  _followedTrack() {
    if (this._followId) {
      const vm = this._trackById(this._followId);
      if (vm) return vm;
    }
    return this.tracks.find(vm => vm.meta.kind === 'player') || this.tracks[0] || null;
  }

  _orbitTargetAt(t) {
    const vm = this._followedTrack();
    if (vm && this.record) this._updateTrack(vm, t);
    return vm ? this._tmp.copy(vm.pos) : this._tmp.set(0, 1500, 0);
  }

  _updateCamera(dt) {
    const c = this.cam;
    const vm = this._followedTrack();
    const tgt = vm ? vm.pos : this._tmp.set(0, 1500, 0);
    if (c.mode === 'follow' && vm) {
      // chase rig behind the cone's own axes
      const back = _v1.set(0, 0, 1).applyQuaternion(vm.quat);
      const up = _v2.set(0, 1, 0).applyQuaternion(vm.quat);
      const want = _v3.copy(vm.pos).addScaledVector(back, 420).addScaledVector(up, 130);
      this._camPos.lerp(want, 1 - Math.exp(-5 * dt));
      this._camLook.lerp(_v1.copy(vm.pos).addScaledVector(
        _v2.set(0, 0, -1).applyQuaternion(vm.quat), 260), 1 - Math.exp(-7 * dt));
    } else {
      const cp = Math.cos(c.pitch), sp = Math.sin(c.pitch);
      const want = _v3.set(
        tgt.x + Math.cos(c.yaw) * cp * c.dist,
        tgt.y + sp * c.dist,
        tgt.z + Math.sin(c.yaw) * cp * c.dist);
      this._camPos.lerp(want, 1 - Math.exp(-4.5 * dt));
      this._camLook.lerp(tgt, 1 - Math.exp(-8 * dt));
    }
    this.camera.position.copy(this._camPos);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this._camLook);
  }

  // ---------- playback control ----------
  seek(t) {
    this.play.t = Math.max(0, Math.min(this.record.duration, t));
    // tracers belong to the timeline: a jump invalidates every streak in flight
    this._tracers.length = 0;
    this._tracerAcc.clear();
  }
  setPlaying(v) {
    this.play.playing = v;
    if (v && this.play.t >= this.record.duration) this.play.t = 0;
    this._syncPlayBtn();
  }
  setSpeed(v) {
    this.play.speed = spdSnap(v);
    this._cancelIntro();
    if (this._dom) this._syncSpeedTape();
  }

  _syncSpeedTape() {
    const d = this._dom;
    const f = (this.play.speed - SPD_MIN) / (SPD_MAX - SPD_MIN);
    d.spNeedle.style.left = (f * 100) + '%';
    d.spFill.style.width = (f * 100) + '%';
    d.spVal.textContent = this.play.speed.toFixed(1) + '×';
  }

  _buildSpeedTape() {
    const d = this._dom;
    // one tick per integer multiplier, tall + labeled on powers of two
    let html = '';
    for (let s = 1; s <= SPD_MAX; s++) {
      const maj = (s & (s - 1)) === 0;   // 1,2,4,8,16
      const label = maj ? `<span>${s}</span>` : '';
      html += `<i class="${maj ? 'maj' : ''}" style="left:${(s - SPD_MIN) / (SPD_MAX - SPD_MIN) * 100}%">${label}</i>`;
    }
    // the 0.5x floor gets its own labeled tick
    html += `<i class="maj" style="left:0%"><span>½</span></i>`;
    d.spTicks.innerHTML = html;

    const pick = ev => {
      const r = d.spTape.getBoundingClientRect();
      const f = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
      this.setSpeed(SPD_MIN + f * (SPD_MAX - SPD_MIN));
    };
    d.spTape.addEventListener('pointerdown', ev => {
      pick(ev);   // pick first: setPointerCapture can throw on synthetic events
      try { d.spTape.setPointerCapture(ev.pointerId); } catch (_) { /* synthetic probe */ }
      const mv = e => pick(e);
      const up = () => {
        d.spTape.removeEventListener('pointermove', mv);
        d.spTape.removeEventListener('pointerup', up);
      };
      d.spTape.addEventListener('pointermove', mv);
      d.spTape.addEventListener('pointerup', up);
    });
    d.spTape.addEventListener('wheel', ev => {
      ev.preventDefault();
      ev.stopPropagation();   // keep the game's global wheel (throttle) out of it
      this.setSpeed(this.play.speed - Math.sign(ev.deltaY) * SPD_STEP);
    }, { passive: false });
    d.spBox.addEventListener('dblclick', () => this.setSpeed(1));
  }
  toggleFollow() {
    this.cam.mode = this.cam.mode === 'follow' ? 'orbit' : 'follow';
  }
  _cancelIntro() { if (this.play.intro) { this.play.intro = false; } }
  _syncPlayBtn() {
    if (this._dom) this._dom.play.textContent = this.play.playing ? '⏸' : '▶';
  }

  // ---------- DOM overlay ----------
  _bindDOM() {
    if (this._dom) return;
    const $ = id => document.getElementById(id);
    const d = {
      root: $('debrief'),
      title: $('db-title'), sub: $('db-sub'),
      rank: $('db-rank'), bigScore: $('db-score'),
      stats: $('db-stats'), kills: $('db-kills'),
      play: $('db-play'),
      spBox: $('db-speed'),
      spTape: $('db-speed-tape'), spTicks: $('db-speed-ticks'),
      spFill: $('db-speed-fill'), spNeedle: $('db-speed-needle'), spVal: $('db-speed-val'),
      cur: $('db-cur'), total: $('db-total'),
      track: $('db-track'), ticks: $('db-ticks'), dots: $('db-dots'), head: $('db-head'),
      tip: $('db-tip'), panel: $('db-left'), bottom: $('db-bottom'),
    };
    if (!d.root) throw new Error('debrief DOM missing (index.html)');
    this._dom = d;
    d.play.addEventListener('click', () => { this._cancelIntro(); this.setPlaying(!this.play.playing); });
    this._buildSpeedTape();
    // timeline scrub: press anywhere on the bar, drag through the mission
    const scrubFrom = ev => {
      const r = d.track.getBoundingClientRect();
      const f = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
      this._cancelIntro();
      this.seek(f * this.record.duration);
    };
    d.track.addEventListener('pointerdown', ev => {
      d.track.setPointerCapture(ev.pointerId);
      scrubFrom(ev);
      const mv = e => scrubFrom(e);
      const up = () => {
        d.track.removeEventListener('pointermove', mv);
        d.track.removeEventListener('pointerup', up);
      };
      d.track.addEventListener('pointermove', mv);
      d.track.addEventListener('pointerup', up);
    });
    document.getElementById('db-restart').addEventListener('click', () => this.hooks.onRestart?.());
    document.getElementById('db-download').addEventListener('click', () => this._download());
    document.getElementById('db-totitle').addEventListener('click', () => this.hooks.onTitle?.());
  }

  _download() {
    const blob = new Blob([JSON.stringify(this.record)], { type: 'application/json' });
    const a = document.createElement('a');
    const ts = (this.record.date || new Date().toISOString()).replace(/[-:]/g, '').slice(0, 15);
    a.href = URL.createObjectURL(blob);
    a.download = `sky-baroness-${ts}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  _attachListeners() {
    const canvas = document.getElementById('gl');
    const add = (t, type, fn, opt) => { t.addEventListener(type, fn, opt); this._lsn.push([t, type, fn]); };
    // orbit drag on the 3D view (overlay panels sit above and swallow their own)
    let dragging = false, px = 0, py = 0, moved = 0;
    add(canvas, 'pointerdown', ev => {
      dragging = true; moved = 0; px = ev.clientX; py = ev.clientY;
    });
    add(window, 'pointermove', ev => {
      if (dragging) {
        const dx = ev.clientX - px, dy = ev.clientY - py;
        px = ev.clientX; py = ev.clientY;
        moved += Math.abs(dx) + Math.abs(dy);
        this.cam.yaw += dx * 0.005;
        this.cam.pitch = Math.max(0.04, Math.min(1.45, this.cam.pitch + dy * 0.004));
        this.cam.mode = 'orbit';
      } else {
        this._hover(ev);
      }
    });
    add(window, 'pointerup', ev => {
      if (dragging && moved < 5) this._click(ev);
      dragging = false;
    });
    add(canvas, 'wheel', ev => {
      ev.preventDefault();
      this.cam.dist = Math.max(500, Math.min(60000, this.cam.dist * Math.exp(ev.deltaY * 0.0012)));
    }, { passive: false });
    add(window, 'keydown', ev => {
      if (ev.repeat) return;
      switch (ev.code) {
        case 'Space': ev.preventDefault(); this._cancelIntro(); this.setPlaying(!this.play.playing); break;
        case 'KeyF': this.toggleFollow(); break;
        case 'Tab': ev.preventDefault(); this._dom.root.classList.toggle('panel-hidden'); break;
        case 'KeyR': this.hooks.onRestart?.(); break;
        case 'Escape': this.hooks.onTitle?.(); break;
        case 'ArrowLeft': this._cancelIntro(); this.seek(this.play.t - 5); break;
        case 'ArrowRight': this._cancelIntro(); this.seek(this.play.t + 5); break;
      }
    });
  }

  _detachListeners() {
    for (const [t, type, fn] of this._lsn) t.removeEventListener(type, fn);
    this._lsn.length = 0;
  }

  _pick(ev) {
    if (!this._dom) return null;
    const r = this._dom.root.getBoundingClientRect();
    _mouse.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    this._raycaster.setFromCamera(_mouse, this.camera);
    const sprites = this.markers.filter(m => m.sprite.visible).map(m => m.sprite);
    const hitS = this._raycaster.intersectObjects(sprites, false)[0];
    if (hitS) return { marker: hitS.object.userData.ev };
    const cones = this.tracks.filter(t => t.cone.visible).map(t => t.cone);
    const hitC = this._raycaster.intersectObjects(cones, false)[0];
    if (hitC) return { trackId: hitC.object.userData.trackId };
    return null;
  }

  _click(ev) {
    // overlay panels own their clicks; only react to hits on the bare canvas
    if (ev.target && ev.target.id !== 'gl') return;
    const hit = this._pick(ev);
    if (!hit) return;
    if (hit.marker) {
      this._cancelIntro();
      this.seek(hit.marker.t);
    } else if (hit.trackId) {
      this._followId = hit.trackId;
      this.cam.mode = 'follow';
    }
  }

  _hover(ev) {
    if (!this._dom || (ev.target && ev.target.id !== 'gl')) { if (this._dom) this._dom.tip.style.display = 'none'; return; }
    const hit = this._pick(ev);
    const tip = this._dom.tip;
    if (!hit) { tip.style.display = 'none'; return; }
    if (hit.marker) {
      const mk = this.markers.find(m => m.ev === hit.marker);
      tip.textContent = `${mk.label} · T+${fmtT(hit.marker.t)}`;
    } else {
      const vm = this._trackById(hit.trackId);
      tip.textContent = vm ? `${vm.label} · 点击跟随` : '';
    }
    tip.style.display = 'block';
    tip.style.left = (ev.clientX + 16) + 'px';
    tip.style.top = (ev.clientY + 12) + 'px';
  }

  _updateUI(dt) {
    if (!this._dom) return;
    const d = this._dom, rec = this.record, p = this.play;
    const f = Math.max(0, Math.min(1, p.t / Math.max(0.001, rec.duration)));
    d.head.style.left = (f * 100) + '%';
    d.cur.textContent = fmtT(p.t);
    // score count-up (ease-out, ~2.2 s)
    this._scoreAnimT += dt;
    const k = 1 - Math.pow(1 - Math.min(1, this._scoreAnimT / 2.2), 3);
    const shown = Math.round((this._result?.score ?? 0) * k);
    if (shown !== this._scoreShown) {
      this._scoreShown = shown;
      d.bigScore.textContent = String(shown);
    }
    // highlight the freshest kill the playhead has passed
    let curRow = null;
    for (const row of d.kills.querySelectorAll('.kill-row[data-t]')) {
      const isPast = parseFloat(row.dataset.t) <= p.t + 0.001;
      row.classList.toggle('past', isPast);
      if (isPast) curRow = row;
    }
    if (curRow) {
      d.kills.querySelector('.kill-row.cur')?.classList.remove('cur');
      if (p.t - parseFloat(curRow.dataset.t) < 4) curRow.classList.add('cur');
    }
  }

  resize(w, h) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}

// ---------- helpers ----------
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q2 = new THREE.Quaternion();
const _m4 = new THREE.Matrix4();
const _vs = new THREE.Vector3();
const _col = new THREE.Color();
const _mouse = new THREE.Vector2();

function trackColor(tr) {
  if (tr.kind === 'player') return PLAYER_COLOR;
  if (tr.kind === 'missile') return tr.side === 'p' ? MSL_COLOR_P : MSL_COLOR_E;
  return tr.ace ? ACE_COLOR : ENEMY_PALETTE[((tr.ci ?? 0) + ENEMY_PALETTE.length) % ENEMY_PALETTE.length];
}
function trackLabel(tr) {
  if (tr.kind === 'player') return '座机 PLAYER';
  if (tr.kind === 'missile') return (tr.side === 'p' ? '我方导弹 ' : '敌方导弹 ') + tr.id.toUpperCase() + (tr.k ? ` (${tr.k.toUpperCase()})` : '');
  return (tr.ace ? '王牌机 ' : '敌机 ') + tr.id.toUpperCase();
}
function trackByIdColor(tracks, id) {
  const vm = tracks.find(t => t.meta.id === id);
  return vm ? vm.color : ACE_COLOR;
}
function markerHex(tracks, ev) {
  let c = EV_COLOR[ev.type];
  if (ev.type === 'kill') c = trackByIdColor(tracks, ev.victim);
  else if (ev.type === 'crash') c = PLAYER_COLOR;
  else if (ev.type === 'launch' || ev.type === 'gunFire') c = ev.side === 'p' ? MSL_COLOR_P : MSL_COLOR_E;
  else if (ev.type === 'flare' && ev.side === 'e') c = trackByIdColor(tracks, ev.m);
  return c.toString(16).padStart(6, '0');
}
// imported files may lack a result block — derive the basics from the events
function deriveResult(rec) {
  const kills = rec.events.filter(e => e.type === 'kill');
  return {
    outcome: rec.events.some(e => e.type === 'crash') ? 'failed' : 'ended',
    kills: kills.length, wave: 0, score: 0,
    time: rec.duration, crashed: rec.events.some(e => e.type === 'crash' && e.crashed),
    accuracy: null, grade: null,
  };
}
