// hud.js — Ace-Combat-7-style HUD drawn on a 2D canvas overlay: cyan-white
// thin lines, vertical speed/altitude tapes with drum-digit readout boxes,
// bracket target frames, a nose-anchored 80° missile envelope ring, dual
// missile loadout cards with the seeker warmup state, and center warnings
// with a red edge glow while missiles are inbound.
import * as THREE from 'three';
import { clamp, pad, machOf } from '../core/utils.js';
import { cornerSpeedKMH } from '../units/flightmodel.js';
import { MSL_WARM_TIME } from '../units/weapons.js';

const CYAN = '#9fe8ff';
const CYAN_DIM = 'rgba(159,232,255,0.5)';
const RED = '#ff5a4a';
const COMBAT_RADIUS_M = 14000;    // keep in sync with player.js
const AMBER = '#ffc866';
const _hv = new THREE.Vector3();
const _hv2 = new THREE.Vector3();
const _hv3 = new THREE.Vector3();
const _hv4 = new THREE.Vector3();
// 120° front cone edge warning: amber past 50° off the nose, flashing
// red past 56° (lock breaks / launch gate closes at 60°)
const CONE_WARN = Math.cos(50 * Math.PI / 180);
const CONE_CRIT = Math.cos(56 * Math.PI / 180);

export class HUD {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.w = 0; this.h = 0; this.dpr = 1;
    this.resize();
    addEventListener('resize', () => this.resize());
    this._v = new THREE.Vector3();
    this.msgQueue = [];   // {text, sub, t, dur}
    this.killFeed = [];   // {text, t}
    this._hintMsg = null; // transient gate hint (预热中…/未锁定/…)
    this._collapse = new Map(); // dying target frames: enemy -> 0..1
    this._lockPrev = null;      // lock-fly: previous locked target
    this._lockScreen = null;    // last frame's lock bracket screen pos
    this._lockFly = null;       // {from:{x,y}, t}
    this._mslKindSeen = null;   // weapon-switch slide animation
    this._mslSlide = 0;
    this._rainSeeds = Array.from({ length: 90 }, () => [Math.random(), Math.random(), Math.random()]);
    // preload the knockout bar font so the first message doesn't fall back
    // (headless test env has no document — the guard keeps it importable)
    if (typeof document !== 'undefined' && document.fonts?.load) document.fonts.load('800 26px "Saira ExtraCondensed"');
  }

  resize() {
    this.dpr = Math.min(devicePixelRatio || 1, 2);
    this.w = innerWidth; this.h = innerHeight;
    this.canvas.width = this.w * this.dpr;
    this.canvas.height = this.h * this.dpr;
    this.canvas.style.width = this.w + 'px';
    this.canvas.style.height = this.h + 'px';
  }

  announce(text, sub = '', dur = 3.2, style = 'info', sticky = false, reward = null) {
    const live = this.msgQueue.filter(m => !m.dead);
    if (!sticky && live.length >= 6) return;   // saturated: drop, never grow
    // reward messages (kill/intercept) hold 6s so the drum roll plays out;
    // everything else: 1.6x the requested duration, floor 3.2s
    const d = sticky ? dur : (reward ? 6 : Math.max(dur * 1.6, 3.2));
    this.msgQueue.push({ text, sub, t: 0, dur: d, style, sticky, y: null, dead: false, reward });
    // hard cap: force the oldest non-sticky message out
    const now = this.msgQueue.filter(m => !m.dead);
    if (now.length > 4) now[0].t = Math.max(now[0].t, now[0].dur);
  }

  clearSticky() {
    this.msgQueue = this.msgQueue.filter(m => !m.sticky);
  }

  // small transient line under the reticle: rejected SPACE presses explain
  // themselves here instead of a full center announcement
  hint(text) { this._hintMsg = { text, t: 0 }; }

  // world position -> screen px; returns {x, y, behind}
  proj(pos, camera) {
    this._v.copy(pos).project(camera);
    const behind = this._v.z > 1;
    return {
      x: (this._v.x * 0.5 + 0.5) * this.w,
      y: (-this._v.y * 0.5 + 0.5) * this.h,
      behind,
    };
  }

  text(str, x, y, size = 15, color = CYAN, align = 'left', glow = 8) {
    const c = this.ctx;
    c.font = `bold ${size}px Consolas, "Courier New", monospace`;
    c.textAlign = align;
    c.textBaseline = 'middle';
    c.shadowColor = color; c.shadowBlur = glow;
    c.fillStyle = color;
    c.fillText(str, x, y);
    c.shadowBlur = 0;
  }

  strokeRect(x, y, w, h, color, lw = 1.5) {
    const c = this.ctx;
    c.strokeStyle = color; c.lineWidth = lw;
    c.shadowColor = color; c.shadowBlur = 6;
    c.strokeRect(x, y, w, h);
    c.shadowBlur = 0;
  }

  // rolling-digit drum gauge: each position keeps its shown digit; on change
  // the old digit slides out of the cell and the new one slides in — UP when
  // the value grew, DOWN when it shrank (old-fighter mechanical instrument).
  // key: which gauge this is — speed/alt/corner each keep their own drum state.
  drawDrum(key, num, x, y, size, color, dt) {
    this._drums = this._drums || {};
    let st = this._drums[key];
    if (!st || st.chars.length !== num.length) {
      st = this._drums[key] = { chars: num.split(''), anims: num.split('').map(() => null) };
    }
    const c = this.ctx;
    c.font = `bold ${size}px Consolas, "Courier New", monospace`;
    const cw = c.measureText('0').width;
    const cellH = size * 1.35, DUR = 0.28;
    for (let i = 0; i < num.length; i++) {
      const ch = num[i];
      if (st.chars[i] !== ch) {
        const from = st.chars[i];
        const up = ch > from;                 // bigger digit pushes up, smaller drops
        st.anims[i] = { from, to: ch, t: 0, up };
        st.chars[i] = ch;
      }
      const cx = x + i * cw + cw / 2;
      const a = st.anims[i];
      c.save();
      c.beginPath();
      c.rect(cx - cw / 2 - 0.5, y - cellH / 2, cw + 1, cellH);
      c.clip();
      if (a && a.t < 1) {
        a.t = Math.min(1, a.t + (dt || 1 / 60) / DUR);
        const e = a.t * a.t * (3 - 2 * a.t);  // smoothstep, like a drum's snap
        const dir = a.up ? -1 : 1;            // outgoing travel direction
        this.text(a.from, cx, y + dir * e * cellH, size, color, 'center');
        this.text(a.to, cx, y - dir * (1 - e) * cellH, size, color, 'center');
        if (a.t >= 1) st.anims[i] = null;
      } else {
        this.text(ch, cx, y, size, color, 'center');
      }
      c.restore();
    }
  }

  line(x0, y0, x1, y1, color, lw = 1.5) {
    const c = this.ctx;
    c.strokeStyle = color; c.lineWidth = lw;
    c.shadowColor = color; c.shadowBlur = 6;
    c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();
    c.shadowBlur = 0;
  }

  circle(x, y, r, color, lw = 1.5) {
    const c = this.ctx;
    c.strokeStyle = color; c.lineWidth = lw;
    c.shadowColor = color; c.shadowBlur = 6;
    c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.stroke();
    c.shadowBlur = 0;
  }

  // arc from -90° clockwise spanning `frac` of a full turn
  arcProgress(x, y, r, frac, color, lw = 2.5) {
    const c = this.ctx;
    c.strokeStyle = color; c.lineWidth = lw;
    c.shadowColor = color; c.shadowBlur = 8;
    c.beginPath();
    c.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + clamp(frac, 0, 1) * Math.PI * 2);
    c.stroke();
    c.shadowBlur = 0;
  }

  _diamond(x, y, r, col, fill, rot = 0) {
    const c = this.ctx;
    c.save();
    c.translate(x, y);
    c.rotate(rot || 0);
    c.fillStyle = col; c.strokeStyle = col; c.lineWidth = 1.5;
    c.shadowColor = col; c.shadowBlur = 6;
    c.beginPath();
    c.moveTo(0, -r); c.lineTo(r, 0); c.lineTo(0, r); c.lineTo(-r, 0);
    c.closePath();
    if (fill) c.fill(); else c.stroke();
    c.restore();
    c.shadowBlur = 0;
  }

  // AC7-style target frame: four corner brackets around (x, y)
  _brackets(x, y, s, col, lw) {
    const h = s / 2, k = Math.max(5, s * 0.28);
    this.line(x - h, y - h + k, x - h, y - h, col, lw);
    this.line(x - h, y - h, x - h + k, y - h, col, lw);
    this.line(x + h - k, y - h, x + h, y - h, col, lw);
    this.line(x + h, y - h, x + h, y - h + k, col, lw);
    this.line(x + h, y + h - k, x + h, y + h, col, lw);
    this.line(x + h, y + h, x + h - k, y + h, col, lw);
    this.line(x - h + k, y + h, x - h, y + h, col, lw);
    this.line(x - h, y + h, x - h, y + h - k, col, lw);
  }

  // ---- AC-style threat flashes around the VIEW AXIS ----
  // Centered on the camera axis (screen center — where the view points),
  // NOT on the aim director circle: the circle floats as the camera chases
  // it, the disc must not. The ring reads as a plan COMPASS around the view
  // direction: top = dead ahead, bottom = directly behind, sides = abeam —
  // elevation is ignored on purpose. Ace Combat language: nothing
  // persistent — a hit detonates a thick red ARC SEGMENT on the bearing it
  // came from (two hard blinks, fast fade), and every hostile missile
  // riding the player gets a big double chevron pointing straight at it,
  // tracking its bearing until it dies or drops. The bottom-right radar
  // paints the same missiles as red blinking dots (range + heading
  // picture); this ring is the instant, peripheral half of the pair.
  drawHitDisc(dt, S) {
    const w = S.weapons;
    const hits = w.hitLog || [];
    let live = 0;
    for (const ms of w.missiles) {
      if (!ms.fromPlayer && !ms._dead && ms.target === S.player) live++;
    }
    if (!hits.length && !live) return;
    const cx = this.w / 2, cy = this.h / 2, R = 150;
    const c = this.ctx;
    // camera basis; bearing is AZIMUTH ONLY around the view axis: 0 = dead
    // ahead of the view direction, +/-PI = directly behind, elevation is
    // deliberately ignored — a high stern attack must read BEHIND (bottom),
    // not "above" (top)
    _hv.setFromMatrixColumn(S.camera.matrixWorld, 0);            // right
    _hv2.setFromMatrixColumn(S.camera.matrixWorld, 2).negate();  // forward
    const bearing = dir => Math.atan2(dir.dot(_hv), dir.dot(_hv2));
    // hit arcs — one heavy flash per impact, not an instrument readout
    for (const h of hits) {
      h.t += dt;
      const fade = h.kind === 'msl' ? 1.4 : h.kind === 'near' ? 0.9 : 1.1;
      const k = 1 - h.t / fade;
      if (k <= 0) continue;
      const a = bearing(h.dir);
      const span = h.kind === 'msl' ? 1.5 : h.kind === 'near' ? 0.7 : 0.95;
      const col = h.kind === 'near' ? AMBER : RED;
      // impact flash: two hard blinks in the first 0.3 s, then steady decay
      const flash = h.t < 0.3 ? (Math.floor(h.t / 0.1) % 2 === 0 ? 1 : 0.25) : 1;
      c.globalAlpha = k * flash;
      c.strokeStyle = col;
      c.lineWidth = h.kind === 'msl' ? 8 : 5;
      c.shadowColor = col; c.shadowBlur = h.kind === 'msl' ? 16 : 10;
      c.beginPath();
      c.arc(cx, cy, R, a - Math.PI / 2 - span / 2, a - Math.PI / 2 + span / 2);
      c.stroke();
      c.shadowBlur = 0;
    }
    c.globalAlpha = 1;
    // inbound missiles: double chevron pointing AT the missile, riding its
    // bearing — the AC "it's over there" cue
    const blink = 0.65 + 0.35 * Math.sin(S.time * 10);
    for (const ms of w.missiles) {
      if (ms.fromPlayer || ms._dead || ms.target !== S.player) continue;
      _hv3.copy(ms.pos).sub(S.player.position).normalize();
      const a = bearing(_hv3);
      c.save();
      c.translate(cx + Math.sin(a) * R, cy - Math.cos(a) * R);
      c.rotate(a);
      // local -Y = outward, toward the missile
      c.globalAlpha = blink;
      c.strokeStyle = RED; c.shadowColor = RED; c.shadowBlur = 12;
      c.lineJoin = 'miter';
      for (let i = 0; i < 2; i++) {
        const o = i * 14;   // second chevron one step further inward
        c.lineWidth = 5 - i;
        c.beginPath();
        c.moveTo(-14, o + 4);
        c.lineTo(0, o - 10);
        c.lineTo(14, o + 4);
        c.stroke();
      }
      c.shadowBlur = 0;
      c.restore();
    }
    c.globalAlpha = 1;
  }

  draw(dt, S) {
    const c = this.ctx;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, this.w, this.h);
    if (S.state !== 'playing') return;

    // missile-launch punch: the 3D world kicks with a radial speed-blur
    // (weapons.fxPunch) — the HUD breathes with it: a quick scale-up that
    // settles plus a decaying pixel jitter, so the whole screen reads as
    // one shove instead of the overlay sitting frozen on top of it
    const punch = Math.min(1, S.weapons?.fxPunch ?? 0);
    if (punch > 0.003) {
      const s = 1 + punch * 0.035;
      const jx = (Math.random() - 0.5) * punch * 6;
      const jy = (Math.random() - 0.5) * punch * 5;
      c.translate(this.w / 2 + jx, this.h / 2 + jy);
      c.scale(s, s);
      c.translate(-this.w / 2, -this.h / 2);
    }

    // weapon-switch slide: cards dart in from the side on kind change
    const kindNow = S.weapons.mslKind;
    if (kindNow !== this._mslKindSeen) {
      if (this._mslKindSeen !== null) this._mslSlide = 1;
      this._mslKindSeen = kindNow;
    }
    this._mslSlide = Math.max(0, this._mslSlide - dt * 3.4);
    S.mslSlide = this._mslSlide;

    this.drawSpeedAlt(dt, S);
    this.drawHeading(S);
    this.drawEnvelope(S);
    this.drawReticle(S);
    this.drawHitDisc(dt, S);
    this.drawTargets(dt, S);
    this.drawMissileMarkers(S);
    this.drawRadar(S);
    this.drawStatus(S);
    this.drawAlerts(dt, S);
    this.drawHint(dt);
    this.drawRain(dt, S);
    this.drawFlare(S);
    this.drawBlastFlare(S);
    this.drawMissileGlint(S);
    this.drawPipFrame(S);
    this.drawLetterbox(S);
    this.vignette(S);
  }

  // ---- vertical tick tape (AC7 style) ----
  // side 1: ticks point right (left tape); side -1: ticks point left
  _tape(x, cy, H, value, minor, major, side) {
    const pxPerUnit = H / (minor * 28);
    const half = H / 2;
    this.line(x, cy - half, x, cy + half, CYAN_DIM, 1.5);
    const vLo = value - half / pxPerUnit, vHi = value + half / pxPerUnit;
    const i0 = Math.max(0, Math.ceil(vLo / minor));
    const i1 = Math.floor(vHi / minor);
    for (let i = i0; i <= i1; i++) {
      const v = i * minor;
      const y = cy - (v - value) * pxPerUnit;
      const isMajor = i % (major / minor) === 0;
      const len = isMajor ? 12 : 6;
      this.line(x, y, x + side * len, y, isMajor ? CYAN : CYAN_DIM, 1);
      if (isMajor && v > 0) {
        this.text(String(Math.round(v)), x + side * (len + 4), y, 11, CYAN_DIM,
          side > 0 ? 'left' : 'right', 3);
      }
    }
  }

  // drum-digit readout box sitting on the tape
  _drumBox(key, x, cy, num, unit, dt) {
    const c = this.ctx;
    const w = 104, h = 44;
    c.fillStyle = 'rgba(4,14,24,0.72)';
    c.fillRect(x - w / 2, cy - h / 2, w, h);
    this.strokeRect(x - w / 2, cy - h / 2, w, h, CYAN, 1.5);
    this.drawDrum(key, num, x - 24, cy, 19, CYAN, dt);
    this.text(unit, x + w / 2 - 8, cy + h / 2 - 9, 9, CYAN_DIM, 'right', 2);
  }

  // ---- speed / altitude vertical tapes + throttle + G/AOA ----
  drawSpeedAlt(dt, S) {
    const p = S.player;
    const cy = this.h / 2;
    const H = 320;
    const xL = 118, xR = this.w - 118;
    // speed (left)
    this._tape(xL, cy, H, p.speed * 3.6, 20, 100, 1);
    this._drumBox('spd', xL, cy, String(Math.round(p.speed * 3.6)), 'km/h', dt);
    this.text('SPD', xL - 16, cy - H / 2 - 16, 11, CYAN_DIM, 'right', 4);
    // mach readout: the speed of sound DROPS with altitude (standard
    // atmosphere), so this — not the km/h tape — is the honest transonic
    // gauge: M 1.00 is the vapor-cone line at any altitude
    {
      const M = machOf(p.speed, p.position.y);
      const col = M >= 1 ? AMBER : M >= 0.95 ? CYAN : CYAN_DIM;
      this.text(`M ${M.toFixed(2)}`, xL, cy + 40, 13, col, 'center', 4);
    }
    // corner-speed (max-G) reference, altitude-compensated (density thins ->
    // crossing rises with alt): lights up inside the ±40 km/h window
    {
      const kmh = p.speed * 3.6;
      const corner = cornerSpeedKMH(p.position.y);
      const inBand = Math.abs(kmh - corner) <= 40;
      const label = inBand ? '▶ 机动速度 ' : '机动 ';
      const color = inBand ? AMBER : CYAN_DIM;
      const size = inBand ? 17 : 14;
      const c = this.ctx;
      c.font = `bold ${size}px Consolas, "Courier New", monospace`;
      const num = String(corner);
      const lx = xL - 34, ly = cy + H / 2 + 26;
      this.text(label, lx, ly, size, color);
      this.drawDrum('corner', num, lx + c.measureText(label).width, ly, size, color, dt);
    }
    // throttle bar outboard of the tape
    const tbx = xL - 32;
    this.line(tbx, cy + 60, tbx, cy - 60, CYAN_DIM, 1);
    const ty = cy + 60 - p.throttle * 120;
    this.line(tbx - 4, ty, tbx + 4, ty, p.boosting ? AMBER : CYAN, 3);
    // G + AOA readouts below the tape
    this.text(`G ${p.gLoad.toFixed(1)}`, xL - 34, cy + H / 2 + 52, 13,
      p.gLoad > 12 ? RED : p.gLoad > 7 ? AMBER : CYAN_DIM);
    const b = p.body;
    this.text(`α ${(p.alpha * 57.3).toFixed(1)}°`, xL - 34, cy + H / 2 + 72, 12,
      b.buffet > 0.5 ? RED : b.buffet > 0.1 || Math.abs(p.alpha) > 0.24 ? AMBER : CYAN_DIM);
    // FBW AoA-limiter status: amber (and blinking in the stall) when OFF —
    // departure physics are live, F restores it
    const fbwOff = !b.fbwOn && (b.buffet < 0.3 || Math.floor(S.time * 4) % 2 === 0);
    this.text(fbwOff ? 'FBW OFF · F' : 'FBW ON', xL - 34, cy + H / 2 + 92, 11,
      b.fbwOn ? CYAN_DIM : AMBER);
    // altitude (right)
    this._tape(xR, cy, H, p.position.y, 20, 100, -1);
    this._drumBox('alt', xR, cy, String(Math.round(p.position.y)), 'm', dt);
    this.text('ALT', xR + 16, cy - H / 2 - 16, 11, CYAN_DIM, 'left', 4);
    this.text(`HDG ${pad(Math.round(p.headingDeg) % 360, 3)}`, xR + 16, cy + H / 2 + 26, 12, CYAN_DIM, 'left');
  }

  // ---- heading tape ----
  drawHeading(S) {
    const hdg = S.player.headingDeg;
    const cx = this.w / 2, y = 46, span = 90; // degrees visible
    const pxPerDeg = this.w * 0.7 / span;
    this.line(cx - (span / 2) * pxPerDeg, y + 14, cx + (span / 2) * pxPerDeg, y + 14, CYAN_DIM, 1);
    for (let d = Math.floor((hdg - span / 2) / 10) * 10; d <= hdg + span / 2; d += 10) {
      const x = cx + (d - hdg) * pxPerDeg;
      const dd = ((d % 360) + 360) % 360;
      const major = dd % 30 === 0;
      this.line(x, y + 14, x, y + (major ? 4 : 9), CYAN_DIM, 1);
      if (major) this.text(dd === 0 ? 'N' : dd === 90 ? 'E' : dd === 180 ? 'S' : dd === 270 ? 'W' : String(dd / 10), x, y - 6, 11, CYAN_DIM, 'center', 4);
    }
    // caret
    this.line(cx, y + 22, cx - 6, y + 30, CYAN, 2);
    this.line(cx, y + 22, cx + 6, y + 30, CYAN, 2);
  }

  // ---- 120° front cone envelope ring (TRUE projection) ----
  // The circle of directions 60° off the nose, sampled in 3D and drawn run
  // by run — only what the camera can actually see, strictly true projection
  // (off-screen parts are simply not drawn).
  //   cold & unlocked: ONLY the arc segment nearest the sight direction — the
  //     boundary the player is approaching; shows itself when the aim pulls
  //     far enough off the nose in a fight.
  //   warming/hot or locked: the full visible ring.
  // Takes the cone-edge warning colors near the boundary.
  drawEnvelope(S) {
    const p = S.player, w = S.weapons;
    const active = w.warm.state !== 'cold' || w.lockState.locked;
    const N = 72, STEP = Math.PI * 2 / N;
    if (!this._envDirs) {
      this._envDirs = [];
      this._envPts = [];
      for (let i = 0; i <= N; i++) {
        this._envDirs.push(new THREE.Vector3());
        this._envPts.push({ x: 0, y: 0, ok: false });
      }
    }
    const nose = new THREE.Vector3();
    p.forward(nose);
    const ref = Math.abs(nose.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(ref, nose).normalize();
    const upv = new THREE.Vector3().crossVectors(nose, right).normalize();
    const R = 2600, cosT = Math.cos(60 * Math.PI / 180), sinT = Math.sin(60 * Math.PI / 180);
    for (let i = 0; i <= N; i++) {
      const a = i * STEP;
      this._envDirs[i].copy(nose).multiplyScalar(cosT)
        .addScaledVector(right, Math.cos(a) * sinT)
        .addScaledVector(upv, Math.sin(a) * sinT);
      const s = this.proj(_hv.copy(this._envDirs[i]).multiplyScalar(R).add(p.position), S.camera);
      this._envPts[i].ok = !s.behind;
      this._envPts[i].x = s.x;
      this._envPts[i].y = s.y;
    }
    const cd = w.guideConeDot;
    const hasCd = cd !== null && cd !== undefined;
    let col = 'rgba(159,232,255,0.32)';
    let lw = 1.25;
    if (hasCd && cd < CONE_CRIT) col = Math.floor(S.time * 6) % 2 === 0 ? RED : 'rgba(255,90,74,0.3)';
    else if (hasCd && cd < CONE_WARN) col = AMBER;
    if (col !== 'rgba(159,232,255,0.32)') lw = 2;
    const c = this.ctx;
    c.strokeStyle = col; c.lineWidth = lw;
    c.shadowColor = col; c.shadowBlur = 6;
    let labelPt = null;
    if (active) {
      // full visible ring; the longest run carries the label
      let bestLen = 0, bestMid = -1, runLen = 0, runStart = 0;
      c.beginPath();
      for (let i = 0; i <= N; i++) {
        const q = this._envPts[i];
        if (!q.ok) {
          if (runLen > bestLen) { bestLen = runLen; bestMid = runStart + (runLen >> 1); }
          runLen = 0;
          continue;
        }
        if (!runLen) { runStart = i; c.moveTo(q.x, q.y); } else c.lineTo(q.x, q.y);
        runLen++;
      }
      if (runLen > bestLen) { bestLen = runLen; bestMid = runStart + (runLen >> 1); }
      c.stroke();
      if (bestMid >= 0) labelPt = this._envPts[bestMid];
    } else {
      // cold: only the arc segment nearest the sight direction
      const aim = p.aimDir;
      let best = 0, bestDot = -Infinity;
      for (let i = 0; i < N; i++) {
        const d = aim.dot(this._envDirs[i]);
        if (d > bestDot) { bestDot = d; best = i; }
      }
      const W = 8;   // ±40° of ring parameter around the nearest point
      c.beginPath();
      let started = false;
      for (let k = -W; k <= W; k++) {
        const q = this._envPts[((best + k) % N + N) % N];
        if (!q.ok) { started = false; continue; }
        if (!started) { c.moveTo(q.x, q.y); started = true; }
        else c.lineTo(q.x, q.y);
      }
      c.stroke();
      if (this._envPts[best].ok) labelPt = this._envPts[best];
    }
    c.shadowBlur = 0;
    if (labelPt) this.text('LIM 120°', labelPt.x + 12, labelPt.y - 12, 10, CYAN_DIM, 'left', 3);
  }

  // ---- War Thunder style: aim director circle at the mouse + flight path marker ----
  drawReticle(S) {
    const c = this.ctx;
    // flight path marker: the TRUE velocity vector — with real aerodynamics the
    // nose and the flight path separate; this marker lags the boresight by AOA
    const fp = S.player.position.clone()
      .addScaledVector(_hv.copy(S.player.vel).normalize(), 2600);
    const s = this.proj(fp, S.camera);
    const fpOn = !s.behind && s.x > 20 && s.x < this.w - 20 && s.y > 20 && s.y < this.h - 20;
    if (fpOn) {
      this.circle(s.x, s.y, 9, CYAN, 2);
      this.line(s.x - 17, s.y, s.x - 9, s.y, CYAN, 2);
      this.line(s.x + 9, s.y, s.x + 17, s.y, CYAN, 2);
      this.line(s.x, s.y - 17, s.x, s.y - 9, CYAN, 2);
      this.line(s.x, s.y + 9, s.x, s.y + 17, CYAN, 2);
    }

    // nose boresight cross: where the fuselage actually points — it chases
    // the aim circle and leads the flight path marker by the AOA, so all
    // three converge only when the jet has settled on the aim direction
    const np = S.player.position.clone()
      .addScaledVector(S.player.forward(_hv), 2600);
    const ns = this.proj(np, S.camera);
    if (!ns.behind) {
      this.line(ns.x - 9, ns.y, ns.x - 3, ns.y, CYAN_DIM, 1.5);
      this.line(ns.x + 3, ns.y, ns.x + 9, ns.y, CYAN_DIM, 1.5);
      this.line(ns.x, ns.y - 9, ns.x, ns.y - 3, CYAN_DIM, 1.5);
      this.line(ns.x, ns.y + 3, ns.x, ns.y + 9, CYAN_DIM, 1.5);
    }

    // aim director circle at the WORLD-ANCHORED aim direction: it stays pinned
    // to the world spot while the nose chases it (WT behavior — the circle and
    // the flight path marker converge as the plane aligns)
    const ap = this.proj(S.player.aimPoint, S.camera);
    if (!ap.behind) {
      const ax = ap.x, ay = ap.y;
      const R = 26;
      this.circle(ax, ay, R, CYAN, 2);
      c.fillStyle = CYAN; c.shadowColor = CYAN; c.shadowBlur = 8;
      c.beginPath(); c.arc(ax, ay, 2.4, 0, Math.PI * 2); c.fill();
      c.shadowBlur = 0;
      for (let i = 0; i < 4; i++) {
        const a = i * Math.PI / 2;
        const x0 = ax + Math.cos(a) * (R + 3), y0 = ay + Math.sin(a) * (R + 3);
        const x1 = ax + Math.cos(a) * (R + 11), y1 = ay + Math.sin(a) * (R + 11);
        this.line(x0, y0, x1, y1, CYAN, 2);
      }
    }

    this.drawIRReticle(S, ap);
  }

  // ---- IR seeker reticle (rides the sight circle) ----
  // Flashing red frame from the moment the warmup starts; goes SOLID when the
  // seeker has bitten a heat source — a diamond marks WHAT it bit (aircraft
  // or decoy: the seeker is fully physical and never explains itself).
  drawIRReticle(S, ap) {
    const w = S.weapons;
    if (w.mslKind !== 'ir' || w.warm.state === 'cold' || ap.behind) return;
    const blink = Math.floor(S.time * 5) % 2 === 0;
    const solid = w.warm.state === 'hot' && w.irSeek;
    if (solid) {
      this.circle(ap.x, ap.y, 44, RED, 2.5);
      // marker on the bitten heat source + thin tie line from the reticle;
        // the diamond doubles as the 120° cone-edge display for the bite
      const src = w.irSeek;
      const bp = this.proj(src.position ?? src.pos, S.camera);
      if (!bp.behind) {
        this.line(ap.x, ap.y, bp.x, bp.y, 'rgba(255,90,74,0.4)', 1);
        const cd = w.guideConeDot;
        const hasCd = cd !== null && cd !== undefined;
        const blink = Math.floor(S.time * 6) % 2 === 0;
        const dcol = hasCd && cd < CONE_CRIT ? (blink ? RED : 'rgba(255,90,74,0.3)')
          : hasCd && cd < CONE_WARN ? AMBER : RED;
        this._diamond(bp.x, bp.y, 9, dcol, false);
        if (dcol !== RED) this.text('CONE', bp.x, bp.y + 22, 11, dcol, 'center', 4);
      }
    } else {
      if (blink) this.circle(ap.x, ap.y, 44, RED, 2);
      if (w.warm.state === 'warming') {
        this.arcProgress(ap.x, ap.y, 52, w.warm.t / MSL_WARM_TIME, AMBER);
      }
    }
    if (w.warm.state === 'hot') {
      this.text(`HOT ${Math.max(0, w.warm.t).toFixed(1)}`, ap.x, ap.y + 62, 12, RED, 'center', 5);
    }
  }

  // ---- closure + nose-relative heading tag (X-locked targets) ----
  // To the LEFT of the lock frame: signed radial closure in m/s (+ = eating
  // in, - = being opened on), and beneath it a small solid arrow rotating
  // continuously to the target's heading in the NOSE frame — up = flying
  // our heading, down = inbound toward us, sideways = crossing.
  _closureTag(S, t, rightX, cy, col) {
    const p = S.player;
    const tp = t.position ?? t.pos;
    const los = _hv.copy(tp).sub(p.position);
    const d = los.length() || 1;
    los.divideScalar(d);
    const rel = _hv2.copy(t.vel).sub(p.vel);
    const closure = -rel.dot(los);
    const vFwd = rel.dot(p.forward(_hv3));
    const vRight = rel.dot(p.body.rightVec(_hv4));
    this.text(`${closure >= 0 ? '+' : ''}${Math.round(closure)} m/s`, rightX, cy + 4, 11, col, 'right', 3);
    this._dirArrow(rightX - 14, cy + 18, Math.atan2(vRight, vFwd), col);
  }

  // small filled arrow, ang 0 = straight up, clockwise positive
  _dirArrow(x, y, ang, col) {
    const c = this.ctx;
    c.save();
    c.translate(x, y);
    c.rotate(ang);
    c.fillStyle = col; c.shadowColor = col; c.shadowBlur = 4;
    c.beginPath();
    c.moveTo(0, -5);
    c.lineTo(3.6, 3);
    c.lineTo(0, 1.4);
    c.lineTo(-3.6, 3);
    c.closePath();
    c.fill();
    c.restore();
  }

  // ---- target frames: AC7 brackets + RNG, off-screen arrows ----
  // The guidance target's frame is the 120° cone edge display: normal red
  // inside the cone, amber past 50° off the nose, flashing red past 56°
  // (lock breaks / launch gate closes at 60°) + a CONE tag.
  drawTargets(dt, S) {
    const w = S.weapons;
    const ls = w.lockState;
    const cd = w.guideConeDot;
    const hasCd = cd !== null && cd !== undefined;
    const nearEdge = hasCd && cd < CONE_WARN;
    const atEdge = hasCd && cd < CONE_CRIT;
    const blink = Math.floor(S.time * 6) % 2 === 0;
    const edgeCol = atEdge ? (blink ? RED : 'rgba(255,90,74,0.3)') : AMBER;
    for (const e of S.enemies) {
      if (e.dying) continue;
      const s = this.proj(e.position, S.camera);
      const dist = e.position.distanceTo(S.player.position);
      const onScreen = !s.behind && s.x > 30 && s.x < this.w - 30 && s.y > 30 && s.y < this.h - 30;
      const isLock = ls.target === e;
      const isGuide = isLock && nearEdge;   // this frame shows the edge state
      const col = isGuide ? edgeCol : (isLock ? RED : CYAN_DIM);
      if (onScreen) {
        let size = clamp(4200 / dist, 18, 66);
        let px = s.x, py = s.y, alpha = 1;
        // dying: the frame collapses into the wreck and fades out
        if (e.dying) {
          if (!this._collapse.has(e)) this._collapse.set(e, 0);
          const k = Math.min(1, this._collapse.get(e) + dt * 1.6);
          this._collapse.set(e, k);
          size *= (1 - k * 0.85);
          alpha = 1 - k;
          if (alpha <= 0.02) { size = 0; }
        }
        // lock switch: the brackets fly from the old target to the new one
        if (isLock) {
          if (this._lockPrev !== e) {
            if (this._lockPrev && this._lockScreen) this._lockFly = { x: this._lockScreen.x, y: this._lockScreen.y, t: 0 };
            this._lockPrev = e;
          }
          if (this._lockFly) {
            this._lockFly.t += dt / 0.25;
            if (this._lockFly.t >= 1) this._lockFly = null;
            else {
              const k = this._lockFly.t, e2 = 1 - Math.pow(1 - k, 3);
              px = this._lockFly.x + (px - this._lockFly.x) * e2;
              py = this._lockFly.y + (py - this._lockFly.y) * e2;
            }
          }
          this._lockScreen = { x: s.x, y: s.y };
        }
        if (size > 1) {
          const c = this.ctx;
          c.globalAlpha = alpha;
          this._brackets(px, py, size, col, isLock ? 2 : 1.25);
          if (isLock) {
            this._diamond(px, py, 5, col, true);
            this.text('LOCK', px + size / 2 + 8, py - size / 2 - 9, 12, col, 'left', 4);
            if (isGuide) this.text(atEdge ? 'CONE — 即将断锁' : 'CONE', px + size / 2 + 8, py - size / 2 + 22, 11, edgeCol, 'left', 4);
            // distance readout rolls drum-style like the cockpit gauges
            this.drawDrum('lockRng', (dist / 1000).toFixed(1), px + size / 2 + 12, py - size / 2 + 7, 11, col, dt);
            // closure + nose-relative heading tag on the LEFT of the frame
            this._closureTag(S, e, px - size / 2 - 8, py, col);
          } else {
            this.text(`RNG ${(dist / 1000).toFixed(1)}`, px + size / 2 + 8, py - size / 2 + 7, 11, col, 'left', 3);
          }
          if (e.hp < 42 && !e.dying) this.text('DMG', px + size / 2 + 8, py + size / 2 - 5, 11, AMBER, 'left', 3);
          c.globalAlpha = 1;
        }
      } else {
        // off-screen: arrow clamped to a centered ellipse pointing outward
        const dx = s.x - this.w / 2, dy = s.y - this.h / 2;
        const ang = Math.atan2(dy, dx);
        const rx = this.w / 2 - 70, ry = this.h / 2 - 90;
        const t = 1 / Math.max(Math.abs(Math.cos(ang)) / rx, Math.abs(Math.sin(ang)) / ry);
        const ax = this.w / 2 + Math.cos(ang) * t, ay = this.h / 2 + Math.sin(ang) * t;
        const c = this.ctx;
        c.save();
        c.translate(ax, ay);
        c.rotate(ang);
        c.fillStyle = col;
        c.shadowColor = c.fillStyle; c.shadowBlur = 6;
        c.beginPath(); c.moveTo(12, 0); c.lineTo(-6, -7); c.lineTo(-6, 7); c.closePath(); c.fill();
        c.restore();
        c.shadowBlur = 0;
        if (isGuide) this.text('CONE', ax - Math.cos(ang) * 26, ay - Math.sin(ang) * 26, 11, edgeCol, 'center', 4);
      }
    }
    if (this._collapse.size > 12) {
      for (const k of this._collapse.keys()) if (!S.enemies.includes(k)) this._collapse.delete(k);
    }
    // anti-missile intercept lock: red brackets + MSL tag ride the locked
    // hostile round (aircraft brackets above never see missile targets)
    {
      const lt = ls.target;
      if (lt && lt.kind && !lt.fromPlayer) {
        const s = this.proj(lt.pos, S.camera);
        if (!s.behind && s.x > 30 && s.x < this.w - 30 && s.y > 30 && s.y < this.h - 30) {
          const dist = lt.pos.distanceTo(S.player.position);
          const size = clamp(4200 / dist, 14, 40);
          this._brackets(s.x, s.y, size, RED, 2);
          this._diamond(s.x, s.y, 5, RED, true);
          this.text('MSL LOCK', s.x + size / 2 + 8, s.y - size / 2 - 9, 12, RED, 'left', 4);
          this.text(`RNG ${(dist / 1000).toFixed(1)}`, s.x + size / 2 + 8, s.y - size / 2 + 7, 11, RED, 'left', 3);
        }
      }
    }
    // radar seeker warmup arc around the locked target:
    // amber while warming (progress), thin solid red ring when hot
    if (w.mslKind === 'radar' && ls.target && w.warm.state !== 'cold') {
      const ltp = ls.target.position ?? ls.target.pos;
      const tp = this.proj(ltp, S.camera);
      if (!tp.behind) {
        const size = clamp(4200 / ltp.distanceTo(S.player.position), 18, 66);
        const r = size * 0.78 + 10;
        if (w.warm.state === 'warming') {
          this.arcProgress(tp.x, tp.y, r, w.warm.t / MSL_WARM_TIME, AMBER);
        } else {
          this.circle(tp.x, tp.y, r, RED, 1.25);
        }
      }
    }
  }

  // ---- hit direction: superseded by drawHitDisc + radar red dots ----

  // ---- sweep bar (message queue): theme-blue strip expanding from the
  // center, edges fading to nothing, letters knocked out so the scene shows
  // through; text glides in from the right, whole bar fades near the end ----
  _sweepBar(text, cx, cy, t, dur) {
    const barW = this.w * 0.42, barH = 40;
    const slide = Math.min(1, t / 0.22);
    const out = Math.max(0, (t - (dur - 0.4)) / 0.4);
    if (out >= 1) return 1;
    if (slide <= 0) return 0;   // first frame: nothing drawn yet, alpha 0
    const x0 = cx - barW / 2 * slide, x1 = cx + barW / 2 * slide;
    const c = this.ctx;
    // compose on an offscreen canvas so the knockout only erases the bar,
    // not other HUD elements already drawn on the main canvas
    if (!this._barCv) this._barCv = document.createElement('canvas');
    const bc = this._barCv.getContext('2d');
    this._barCv.width = Math.ceil((x1 - x0) * this.dpr);
    this._barCv.height = Math.ceil(barH * this.dpr);
    bc.scale(this.dpr, this.dpr);
    // flat blue plateau across the middle 60%, fading to nothing at both ends
    const bw = x1 - x0;
    const g = bc.createLinearGradient(0, 0, bw, 0);
    g.addColorStop(0, 'rgba(70,130,255,0)');
    g.addColorStop(0.2, 'rgba(70,130,255,0.55)');
    g.addColorStop(0.8, 'rgba(70,130,255,0.55)');
    g.addColorStop(1, 'rgba(70,130,255,0)');
    bc.fillStyle = g;
    bc.fillRect(0, 0, bw, barH);
    // knock the letters out so the scene shows through
    bc.globalCompositeOperation = 'destination-out';
    bc.font = '800 26px "Saira ExtraCondensed", Consolas, monospace';
    bc.textAlign = 'center';
    bc.textBaseline = 'middle';
    bc.fillStyle = '#000';
    bc.fillText(text, cx + (1 - slide) * 90 - out * 60 - x0, barH / 2);
    c.save();
    c.globalAlpha = Math.min(1, slide) * (1 - out);
    c.drawImage(this._barCv, x0, cy - barH / 2, x1 - x0, barH);
    c.restore();
    return out;
  }

  // ---- hostile missiles: an unmistakable SPINNING diamond marker ----
  // rides the missile on-screen; clamps to a screen-edge ellipse when the
  // threat leaves the frame so it never becomes unreadable
  drawMissileMarkers(S) {
    const ls = S.weapons.lockState;
    for (const ms of S.weapons.missiles) {
      if (ms.fromPlayer) continue;
      const dist = ms.pos.distanceTo(S.player.position);
      const s = this.proj(ms.pos, S.camera);
      const r = clamp(3000 / Math.max(dist, 1), 7, 18);
      const spin = S.time * 3.2;
      if (!s.behind && s.x > 24 && s.x < this.w - 24 && s.y > 24 && s.y < this.h - 24) {
        this._diamond(s.x, s.y, r, RED, false, spin);
        this.text(`${(dist / 1000).toFixed(1)}km`, s.x, s.y + r + 13, 11, RED, 'center', 4);
        // X-locked inbound (gun intercept): closure + heading tag — the
        // closure number IS the gunnery lead cue for the intercept
        if (ls.target === ms) this._closureTag(S, ms, s.x - r - 10, s.y, RED);
      } else {
        const dx = s.behind ? this.w / 2 - s.x : s.x - this.w / 2;
        const dy = s.behind ? this.h / 2 - s.y : s.y - this.h / 2;
        const ang = Math.atan2(dy, dx);
        const rx = this.w / 2 - 56, ry = this.h / 2 - 56;
        const t = 1 / Math.max(Math.abs(Math.cos(ang)) / rx, Math.abs(Math.sin(ang)) / ry);
        const ex = this.w / 2 + Math.cos(ang) * t, ey = this.h / 2 + Math.sin(ang) * t;
        this._diamond(ex, ey, r * 0.8, RED, false, spin);
        this.text(`${(dist / 1000).toFixed(1)}km`, ex, ey + r * 0.8 + 12, 11, RED, 'center', 4);
      }
    }
  }

  drawRadar(S) {
    // range is switchable 5/10/20 km (M cycles, default 10) — everything
    // below scales with it, and riding-you missiles pin to the rim beyond it
    const range = S.radarRange || 10000;
    const cx = this.w - 130, cy = this.h - 130, R = 88;
    const c = this.ctx;
    c.save();
    // dial
    this.circle(cx, cy, R, CYAN_DIM, 1.5);
    this.circle(cx, cy, R * 0.55, 'rgba(159,232,255,0.22)', 1);
    this.line(cx - R, cy, cx + R, cy, 'rgba(159,232,255,0.18)', 1);
    this.line(cx, cy - R, cx, cy + R, 'rgba(159,232,255,0.18)', 1);
    // sweep
    const sw = (S.time * 1.5) % (Math.PI * 2);
    c.strokeStyle = 'rgba(159,232,255,0.5)'; c.lineWidth = 2;
    c.beginPath(); c.moveTo(cx, cy);
    c.lineTo(cx + Math.cos(sw - Math.PI / 2) * R, cy + Math.sin(sw - Math.PI / 2) * R); c.stroke();
    // player heading-up rotation
    const hdg = S.player.headingDeg * Math.PI / 180;
    const cosH = Math.cos(-hdg), sinH = Math.sin(-hdg);
    const blip = (wx, wz, color, r, clampRim = false) => {
      let dx = wx - S.player.position.x, dz = wz - S.player.position.z;
      const rx = dx * cosH - dz * sinH, rz = dx * sinH + dz * cosH;
      let px = cx + (rx / range) * R, py = cy + (rz / range) * R;
      const d = Math.hypot(px - cx, py - cy);
      if (d > R - 4) {
        if (!clampRim) return null;
        const k = (R - 4) / d;   // beyond range: pin to the rim, keep the bearing
        px = cx + (px - cx) * k; py = cy + (py - cy) * k;
      }
      c.fillStyle = color; c.shadowColor = color; c.shadowBlur = 6;
      c.beginPath(); c.arc(px, py, r, 0, Math.PI * 2); c.fill();
      c.shadowBlur = 0;
      return [px, py];
    };
    for (const e of S.enemies) if (!e.dying) blip(e.position.x, e.position.z, RED, 3.2);
    const blinkOn = Math.floor(S.time * 5) % 2 === 0;
    for (const ms of S.weapons.missiles) {
      if (ms.fromPlayer) continue;
      // riding the player: bigger RED blinking dot, pinned to the rim when
      // beyond range — the amber dots are someone else's problem
      const riding = !ms._dead && ms.target === S.player;
      // a radar shot still HARD ON US (seeker track intact — not notched,
      // chaffed or terrain-masked) draws a flashing thin yellow spoke to
      // the center, in sync with the dot's blink
      const locked = riding && ms.kind === 'radar' && !(ms.blind > 0);
      let pos = null;
      if (riding) {
        if (blinkOn) pos = blip(ms.pos.x, ms.pos.z, RED, 2.8, true);
      } else {
        pos = blip(ms.pos.x, ms.pos.z, AMBER, 2);
      }
      if (locked && blinkOn && pos) this.line(cx, cy, pos[0], pos[1], AMBER, 1);
    }
    // own marker (points up)
    c.fillStyle = CYAN; c.shadowColor = CYAN; c.shadowBlur = 8;
    c.beginPath(); c.moveTo(cx, cy - 7); c.lineTo(cx - 5, cy + 5); c.lineTo(cx + 5, cy + 5); c.closePath(); c.fill();
    c.shadowBlur = 0;
    this.text(`RNG ${range / 1000}km`, cx, cy + R + 16, 11, CYAN_DIM, 'center', 4);
    c.restore();
  }

  drawStatus(S) {
    const p = S.player, w = S.weapons;
    const c = this.ctx;
    // left column: HP + dual missile pools
    const x = 46, y = this.h - 232;
    this.text('AIRFRAME', x, y, 12, CYAN_DIM);
    const hpw = 190;
    this.strokeRect(x, y + 10, hpw, 12, CYAN_DIM, 1);
    const hpcol = p.hp > 55 ? CYAN : p.hp > 25 ? AMBER : RED;
    c.fillStyle = hpcol; c.shadowColor = hpcol; c.shadowBlur = 8;
    c.fillRect(x + 2, y + 12, Math.max(0, (hpw - 4) * p.hp / 100), 8);
    c.shadowBlur = 0;
    this.text(`${Math.round(p.hp)}`, x + hpw + 10, y + 16, 13, hpcol);
    // missile loadout cards: one row per pool, the selected kind framed.
    // R-switch slides the whole block in from the left with a soft fade.
    const slide = S.mslSlide ?? 0;
    c.save();
    if (slide > 0) {
      const e = 1 - Math.pow(1 - (1 - slide), 3);   // ease-out
      c.globalAlpha = 1 - slide * 0.65;
      c.translate(-(1 - e) * 46, 0);
    }
    this.text('MSL', x, y + 42, 12, CYAN_DIM);
    const rows = [['ir', 'IR', AMBER], ['radar', 'RDR', RED]];
    let yy = y + 66;
    for (const [k, label, col] of rows) {
      const active = w.mslKind === k;
      if (active) this.strokeRect(x - 5, yy - 13, 240, 25, CYAN, 1);
      this.text(label, x, yy, 12, active ? col : CYAN_DIM);
      for (let i = 0; i < w.ammoMax[k]; i++) {
        const mx = x + 40 + i * 15;
        if (i < w.ammo[k]) {
          c.fillStyle = col; c.shadowColor = col; c.shadowBlur = active ? 6 : 2;
          c.beginPath(); c.moveTo(mx, yy + 7); c.lineTo(mx + 4.5, yy - 6); c.lineTo(mx + 9, yy + 7); c.closePath(); c.fill();
          c.shadowBlur = 0;
        } else {
          c.strokeStyle = 'rgba(255,200,102,0.22)'; c.lineWidth = 1;
          c.strokeRect(mx, yy - 6, 9, 13);
        }
      }
      this.text(`${w.ammo[k]}`, x + 40 + w.ammoMax[k] * 15 + 10, yy, 12, active ? col : CYAN_DIM);
      yy += 30;
    }
    // seeker warmup status of the selected kind
    const ws = w.warm;
    if (ws.state === 'warming') {
      this.text('WARMING', x, yy + 2, 12, AMBER);
      c.fillStyle = AMBER; c.shadowColor = AMBER; c.shadowBlur = 6;
      c.fillRect(x + 76, yy - 3, Math.max(2, 60 * clamp(ws.t / 1.0, 0, 1)), 6);
      c.shadowBlur = 0;
    } else if (ws.state === 'hot') {
      const blink = ws.t < 2 && Math.floor(S.time * 4) % 2 === 0;
      this.text(`HOT ${Math.max(0, ws.t).toFixed(1)}`, x, yy + 2, 12, blink ? 'rgba(255,90,74,0.5)' : RED);
    } else {
      this.text('COLD', x, yy + 2, 12, CYAN_DIM);
    }
    if (w.mslKind === 'ir' && w.irSeek) this.text('SEEK LOCK', x + 130, yy + 2, 12, RED, 'left', 5);
    c.restore();
    // countermeasure stock + gun heat
    this.text(`CM ${Math.floor(w.flares)}`, x, yy + 28, 12, w.flares >= 10 ? CYAN_DIM : AMBER);
    this.text('GUN', x, yy + 52, 12, CYAN_DIM);
    this.strokeRect(x + 36, yy + 46, 120, 10, CYAN_DIM, 1);
    if (w.gunHeat > 0.02) {
      c.fillStyle = w.gunHeat > 0.8 ? RED : CYAN;
      c.fillRect(x + 38, yy + 48, 116 * Math.min(1, w.gunHeat), 6);
    }
    // kills top-right
    this.text(`KILLS ${S.kills}`, this.w - 46, 40, 16, CYAN, 'right');
    this.text(`WAVE ${S.wave}`, this.w - 46, 64, 13, CYAN_DIM, 'right');
    this.text(`SCORE ${S.score}`, this.w - 46, 88, 13, CYAN_DIM, 'right');
    // mission clock + weather
    if (S.clock) this.text(`${S.clock} · ${S.weatherName || ''}`, this.w - 46, 112, 13, CYAN_DIM, 'right');
  }

  // spin-recovery progress bar: fills as anti-rudder + unloaded stick arrest
  // the rotation; the tick marks the point where the spin breaks
  _spinBar(cx, y, rec) {
    const w = 150;
    this.line(cx - w / 2, y, cx + w / 2, y, 'rgba(159,232,255,0.35)', 3);
    this.line(cx - w / 2, y, cx - w / 2 + w * clamp(rec, 0, 1), y, AMBER, 3);
    this.text('RECOVERY', cx + w / 2 + 10, y, 10, AMBER, 'left', 4);
  }

  drawAlerts(dt, S) {
    const cx = this.w / 2;
    const blink = Math.floor(S.time * 4) % 2 === 0;
    // inbound missile
    if (S.weapons.inboundWarning && blink) {
      this.text('⚠ MISSILE ⚠', cx, this.h / 2 - 150, 26, RED, 'center', 14);
    }
    // radar missile inbound: RWR ring + distinct alert
    if (S.weapons.radarInbound && blink) {
      this.text('⚠ RADAR ⚠ 39机动/箔条!', cx, this.h / 2 - 150, 22, RED, 'center', 12);
    }
    // realistic-mode training readout: the nearest inbound's energy state —
    // speed, motor phase, range. The energy game is invisible without a
    // number, so the range gets one (real-mode training courses only)
    if (S.training && S.mslReal && (S.weapons.inboundWarning || S.weapons.radarInbound)) {
      let m0 = null, d0 = Infinity;
      for (const ms of S.weapons.missiles) {
        if (ms.fromPlayer) continue;
        const d = ms.pos.distanceTo(S.player.position);
        if (d < d0) { d0 = d; m0 = ms; }
      }
      if (m0 && m0.real) {
        const burn = m0.life <= m0.motorEnd;
        this.text(`${Math.round(m0.speed)} m/s · ${burn ? '燃烧' : '燃尽'} · ${(d0 / 1000).toFixed(1)} km`,
          cx, this.h / 2 - 124, 14, AMBER, 'center', 8);
      }
    }
    // enemy fire-control phases (only when nothing of ours is inbound):
    // amber while the enemy builds the 1.15 s lock, red-ish while warming
    if (!S.weapons.inboundWarning && !S.weapons.radarInbound) {
      if (S.enemyWarm > 0.1 && blink) {
        this.text('⚠ 敌方预热中 ⚠', cx, this.h / 2 - 150, 20, RED, 'center', 10);
      } else if (S.enemyLock > 0.25) {
        this.text('⚠ 敌方锁定中 ⚠', cx, this.h / 2 - 150, 20, AMBER, 'center', 10);
      }
    }
    // stall / departure ladder, worst first:
    //   flat spin (near-unrecoverable easter egg) -> steep spin (anti-rudder
    //   directive + recovery progress bar) -> stall (push hint) -> AOA
    //   advisory (buffet onset before the horn)
    const b = S.player.body;
    if (b.spin === 2) {
      this.text('⚠ 平尾旋 FLAT SPIN ⚠', cx, this.h / 2 - 118, 24, RED, 'center', 14);
      if (blink) this.text('蹬满反舵 + 顶杆 — 改出希望渺茫', cx, this.h / 2 - 96, 14, AMBER, 'center', 8);
      this._spinBar(cx, this.h / 2 - 78, b.spinRec);
    } else if (b.spin === 1) {
      this.text('⚠ 尾旋 SPIN ⚠', cx, this.h / 2 - 118, 24, RED, 'center', 14);
      if (blink) this.text(b.spinDir > 0 ? '按 E 右舵改出 + 顶杆' : '按 Q 左舵改出 + 顶杆',
        cx, this.h / 2 - 96, 14, AMBER, 'center', 8);
      this._spinBar(cx, this.h / 2 - 78, b.spinRec);
    } else if (S.player.stalling && blink) {
      this.text('⚠ 失速 STALL ⚠', cx, this.h / 2 - 118, 24, RED, 'center', 14);
      this.text(b.fbwOn ? '推杆俯冲加速改出' : '推杆俯冲加速改出 · F 恢复限器',
        cx, this.h / 2 - 96, 14, AMBER, 'center', 8);
    } else if (b.buffet > 0.15 && Math.abs(b.alpha) > 0.19) {
      this.text(`AOA ${(b.alpha * 57.3).toFixed(0)}°`, cx, this.h / 2 - 118, 15, AMBER, 'center', 6);
    }
    // low hp
    if (S.player.hp <= 30 && blink) {
      this.text('DAMAGE CRITICAL', cx, this.h / 2 + 180, 18, RED, 'center');
    }
    // approaching the map rim: amber heads-up BEFORE the batteries open up
    // (the training range is free flight — no rim, no batteries)
    if (!S.training && !S.player.outOfArea && S.player.edgeDist < COMBAT_RADIUS_M * 0.15) {
      const d = Math.max(0, S.player.edgeDist);
      if (blink) this.text('接近战区边界 — 建议转向', cx, 120, 17, AMBER, 'center', 8);
      this.text(`EDGE ${Math.round(d / 100) * 100}m`, cx, 146, 13, AMBER, 'center', 6);
    }
    // out of area
    if (!S.training && S.player.outOfArea) {
      const left = Math.max(0, 15 - S.player.outOfAreaTime);
      if (blink) this.text('脱离战区 — 返回作战空域', cx, 120, 20, AMBER, 'center', 10);
      this.text(`WARNING ${left.toFixed(0)}`, cx, 148, 16, RED, 'center', 8);
    }
    // animated message stack: spring-in, sequential slots, fade-out — never overlaps
    const baseY = this.h * 0.24, slotH = 66;
    let slot = 0;
    const live = [];
    for (const m of this.msgQueue) {
      if (m.dead) continue;
      if (!m.sticky) m.t += dt;
      // the sweep bar itself fades over the last 0.4s; stay alive until done
      if (!m.sticky && m.t > m.dur + 0.42) { m.dead = true; continue; }
      m.slot = slot++;
      live.push(m);
    }
    this.msgQueue = this.msgQueue.filter(m => !m.dead);
    const c = this.ctx;
    for (const m of live) {
      const targetY = baseY + m.slot * slotH;
      if (m.y === null) m.y = targetY - 46;      // slide up into place
      m.y += (targetY - m.y) * Math.min(1, dt * 14);
      const out = this._sweepBar(m.text, cx, m.y, m.t, m.dur);
      const alpha = Math.min(1, m.t / 0.12) * (1 - out);
      // small caption under the bar
      if (m.sub) {
        c.save();
        c.globalAlpha = alpha;
        this.text(m.sub, cx, m.y + 20 + 15, 13, CYAN, 'center', 8);
        c.restore();
      }
      // reward rail: amber line expanding right of the bar, then x-mult and
      // +score roll in digit-by-digit like the speedometer drums
      if (m.reward) {
        const t = m.t;
        const railX = cx + this.w * 0.42 / 2 + 14;
        const railW = 175 * Math.min(1, Math.max(0, (t - 0.25) / 0.3));
        const lineY = m.y - 22;
        if (railW > 0) {
          c.save();
          c.globalAlpha = alpha;
          this.line(railX, lineY, railX + railW, lineY, AMBER, 2);
          c.restore();
        }
        const mult = `x${m.reward.mult}`;
        const score = `+${m.reward.score * m.reward.mult}`;
        const rowY = lineY + 14;
        const drum = (str, x0, start) => {
          c.font = `800 17px "Saira ExtraCondensed", Consolas, monospace`;
          c.textAlign = 'center';
          c.textBaseline = 'middle';
          const cw = c.measureText('0').width * 1.05;
          let x = x0;
          for (let i = 0; i < str.length; i++) {
            const kk = Math.min(1, Math.max(0, (t - start - i * 0.055) / 0.3));
            if (kk <= 0) { x += cw; continue; }
            const e = 1 - Math.pow(1 - kk, 3);   // easeOutCubic rise
            c.save();
            c.beginPath();
            c.rect(x - 1, rowY - 12, cw + 2, 24);
            c.clip();
            c.globalAlpha = alpha * Math.min(1, kk * 1.5);
            c.shadowColor = AMBER; c.shadowBlur = 8;
            c.fillStyle = AMBER;
            c.fillText(str[i], x + cw / 2, rowY + (1 - e) * 24);
            c.restore();
            x += cw;
          }
          return x - x0;
        };
        const wMult = drum(mult, railX, 0.6);
        drum(score, railX + wMult + 12, 0.72);
      }
    }
  }

  drawHint(dt) {
    const m = this._hintMsg;
    if (!m) return;
    m.t += dt;
    if (m.t > 0.9) { this._hintMsg = null; return; }
    const a = m.t < 0.7 ? 1 : 1 - (m.t - 0.7) / 0.2;
    const c = this.ctx;
    c.globalAlpha = a;
    this.text(m.text, this.w / 2, this.h / 2 + 120, 15, AMBER, 'center', 6);
    c.globalAlpha = 1;
  }

  // ---- rain on the glass: streaking sheets + droplets that hit the LENS,
  // quiver, then get blown up-screen by the airstream ----
  drawRain(dt, S) {
    const rain = S.rain ?? 0;
    if (rain < 0.25) return;
    const c = this.ctx;
    const speed = S.player.speed ?? 300;
    c.save();
    c.strokeStyle = `rgba(200,220,235,${0.16 * rain})`;
    c.lineWidth = 1.4;
    for (const sd of this._rainSeeds) {
      sd[1] = (sd[1] + dt * (0.9 + sd[2] * 0.7)) % 1;
      const x = sd[0] * this.w + sd[1] * speed * 0.9;
      const y = sd[1] * this.h;
      const len = 14 + sd[2] * 26;
      c.beginPath();
      c.moveTo(x, y);
      c.lineTo(x - len * 0.55, y + len);
      c.stroke();
    }
    c.restore();
    // refracting droplets live in the postfx composite now (real light warp)
  }

  // ---- sun lens flare on the HUD glass: cinematic anamorphic kit —
  // big warm halo at the sun, chromatic ghost chain through the center,
  // wide blue horizontal streak with a secondary feather ----
  drawFlare(S) {
    const vis = S.sunVis ?? 0;
    if (vis <= 0.03) return;
    const [ux, uy] = S.sunUV;
    if (ux < -0.15 || ux > 1.15 || uy < -0.15 || uy > 1.15) return;
    const c = this.ctx;
    const cx = ux * this.w, cy = uy * this.h;
    const fx = this.w - cx, fy = this.h - cy;
    const V = Math.min(1, vis);
    c.save();
    c.globalCompositeOperation = 'lighter';
    // sun-side halo: warm core + wide amber bloom
    const halo = c.createRadialGradient(cx, cy, 0, cx, cy, 150);
    halo.addColorStop(0, `rgba(255,235,200,${0.5 * V})`);
    halo.addColorStop(0.25, `rgba(255,200,140,${0.22 * V})`);
    halo.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = halo;
    c.beginPath(); c.arc(cx, cy, 150, 0, Math.PI * 2); c.fill();
    // chromatic ghost chain mirrored through the screen center
    const ghosts = [
      [0.30, 20, 255, 170, 110, 0.30],   // warm amber
      [0.48, 34, 190, 255, 210, 0.20],   // mint
      [0.66, 52, 140, 200, 255, 0.16],   // cyan ring-ish
      [0.82, 16, 255, 240, 190, 0.26],   // pale gold
      [1.06, 40, 255, 130, 130, 0.10],   // faint red far ghost
    ];
    for (const [t, r, cr, cg, cb, a] of ghosts) {
      const gx = cx + fx * 2 * (t - 0.5) * 0.5;
      const gy = cy + fy * 2 * (t - 0.5) * 0.5;
      const g = c.createRadialGradient(gx, gy, 0, gx, gy, r);
      g.addColorStop(0, `rgba(${cr},${cg},${cb},${a * V})`);
      g.addColorStop(0.8, `rgba(${cr},${cg},${cb},${a * 0.35 * V})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g;
      c.beginPath(); c.arc(gx, gy, r, 0, Math.PI * 2); c.fill();
    }
    // primary anamorphic streak (wide, bright)
    const st = c.createLinearGradient(cx - this.w * 0.34, cy, cx + this.w * 0.34, cy);
    st.addColorStop(0, 'rgba(110,170,255,0)');
    st.addColorStop(0.42, `rgba(150,200,255,${0.20 * V})`);
    st.addColorStop(0.5, `rgba(210,235,255,${0.34 * V})`);
    st.addColorStop(0.58, `rgba(150,200,255,${0.20 * V})`);
    st.addColorStop(1, 'rgba(110,170,255,0)');
    c.fillStyle = st;
    c.fillRect(cx - this.w * 0.34, cy - 3, this.w * 0.68, 6);
    // secondary feather streak
    const st2 = c.createLinearGradient(cx - this.w * 0.2, cy, cx + this.w * 0.2, cy);
    st2.addColorStop(0, 'rgba(120,180,255,0)');
    st2.addColorStop(0.5, `rgba(160,210,255,${0.12 * V})`);
    st2.addColorStop(1, 'rgba(120,180,255,0)');
    c.fillStyle = st2;
    c.fillRect(cx - this.w * 0.2, cy - 8, this.w * 0.4, 16);
    c.restore();
  }

  // ---- blast lens kit: big explosions get the sun treatment, all in
  // screen space — a huge anamorphic horizontal streak (nearly full screen
  // width, two stacked fire-palette layers) plus the chromatic ghost train
  // mirrored through the screen center. A lens artifact keeps its size
  // whatever the range, so the streak reads full-width from anywhere. ----
  drawBlastFlare(S) {
    const list = S.killGhosts;
    if (!list || !list.length) return;
    const noStreak = S.blastFlare === false, noGhosts = S.blastGhosts === false;
    if (noStreak && noGhosts) return;      // settings toggles (absent = on)
    const c = this.ctx;
    c.save();
    c.globalCompositeOperation = 'lighter';
    for (const [ux, uy, front, t, k] of list) {
      if (!front) continue;
      if (ux < -0.35 || ux > 1.35 || uy < -0.35 || uy > 1.35) continue;
      const a = Math.min(1, t / 0.04) * Math.pow(Math.max(0, 1 - t / 0.5), 1.6);
      if (a <= 0.01) continue;
      const cx = ux * this.w, cy = uy * this.h;
      if (!noStreak) {
        // whip-out: length snaps to full width in ~70 ms, then gutters out
        const wl = 1 - Math.pow(1 - Math.min(1, t / 0.07), 2);
        const half = this.w * 0.44 * wl;
        const st = c.createLinearGradient(cx - half, cy, cx + half, cy);
        st.addColorStop(0, 'rgba(255,120,40,0)');
        st.addColorStop(0.42, `rgba(255,150,60,${0.24 * a})`);
        st.addColorStop(0.5, `rgba(255,200,120,${0.42 * a})`);
        st.addColorStop(0.58, `rgba(255,150,60,${0.24 * a})`);
        st.addColorStop(1, 'rgba(255,120,40,0)');
        c.fillStyle = st;
        c.fillRect(cx - half, cy - 4, half * 2, 8);
        // secondary feather: shorter, thicker, deeper red-orange
        const half2 = this.w * 0.26 * wl;
        const st2 = c.createLinearGradient(cx - half2, cy, cx + half2, cy);
        st2.addColorStop(0, 'rgba(255,90,30,0)');
        st2.addColorStop(0.5, `rgba(255,120,50,${0.15 * a})`);
        st2.addColorStop(1, 'rgba(255,90,30,0)');
        c.fillStyle = st2;
        c.fillRect(cx - half2, cy - 11, half2 * 2, 22);
      }
      if (!noGhosts) {
        const fx = this.w - cx, fy = this.h - cy;
        const ghosts = [
          [0.30, 40, 255, 215, 150, 0.30],   // gold      (radii 2x the sun kit:
          [0.48, 68, 255, 170, 90,  0.20],   // amber      explosions are dimmer
          [0.66, 104, 255, 130, 60, 0.16],   // orange     sources, same sizes read
          [0.82, 32, 230, 70, 40,   0.26],   // deep red   as noise)
          [1.06, 80, 180, 40, 30,   0.10],   // dark red
        ];
        for (const [gt, r, cr, cg, cb, ga] of ghosts) {
          const gx = cx + fx * 2 * (gt - 0.5) * 0.5;
          const gy = cy + fy * 2 * (gt - 0.5) * 0.5;
          const g = c.createRadialGradient(gx, gy, 0, gx, gy, r * k);
          g.addColorStop(0, `rgba(${cr},${cg},${cb},${ga * a})`);
          g.addColorStop(0.8, `rgba(${cr},${cg},${cb},${ga * 0.35 * a})`);
          g.addColorStop(1, 'rgba(0,0,0,0)');
          c.fillStyle = g;
          c.beginPath(); c.arc(gx, gy, r * k, 0, Math.PI * 2); c.fill();
        }
      }
    }
    c.restore();
  }

  // ---- own-missile glint: the anamorphic kit's little sibling — a short,
  // thin fire streak riding each of the player's outgoing missiles. Much
  // smaller than the blast bar, and it shrinks + fades with range (far
  // missiles hand readability back to their smoke trail); brightness
  // jitters frame to frame like a burning motor seen through the glass. ----
  drawMissileGlint(S) {
    if (S.blastFlare === false) return;           // shares the streak toggle
    const c = this.ctx;
    c.save();
    c.globalCompositeOperation = 'lighter';
    for (const ms of S.weapons.missiles) {
      if (!ms.fromPlayer) continue;
      // the glint IS the burning motor seen through the glass: real-mode
      // rounds go dark at burnout (their trail already thinned out — a
      // coasting brick must not wear a live plume). Arcade motors never
      // burn out, so they keep the streak for the whole flight
      if (ms.real && ms.life > ms.motorEnd) continue;
      const d = ms.pos.distanceTo(S.player.position);
      const k = clamp((2000 - d) / 1600, 0, 1);       // full <= 400 m, gone at 2 km
      if (k <= 0.02) continue;
      const s = this.proj(ms.pos, S.camera);
      if (s.behind || s.x < -30 || s.x > this.w + 30 || s.y < -30 || s.y > this.h + 30) continue;
      const fl = 0.55 + 0.45 * Math.random();        // per-frame motor sparkle
      const a = 0.55 * k * fl;
      const half = this.w * 0.07 * (0.15 + 0.85 * k);   // shortens hard toward the 2 km edge
      const st = c.createLinearGradient(s.x - half, s.y, s.x + half, s.y);
      st.addColorStop(0, 'rgba(255,140,50,0)');
      st.addColorStop(0.5, `rgba(255,225,170,${a})`);
      st.addColorStop(1, 'rgba(255,140,50,0)');
      c.fillStyle = st;
      c.fillRect(s.x - half, s.y - 1.5, half * 2, 3);
      const half2 = half * 0.55;
      const st2 = c.createLinearGradient(s.x - half2, s.y, s.x + half2, s.y);
      st2.addColorStop(0, 'rgba(255,90,30,0)');
      st2.addColorStop(0.5, `rgba(255,150,60,${a * 0.5})`);
      st2.addColorStop(1, 'rgba(255,90,30,0)');
      c.fillStyle = st2;
      c.fillRect(s.x - half2, s.y - 4, half2 * 2, 8);
    }
    c.restore();
  }

  // ---- missile-cam PIP label only: the frame itself is drawn INSIDE the
  // WebGL quad's shader, so border and picture are the same object and can
  // never disagree in size. 锁定预览 = radar-lock preview slaved to any
  // X-lock (either loadout); MSL CAM = riding a launched round ----
  drawPipFrame(S) {
    const r = S.pipRect;
    if (!r || !S.pipOn) return;
    this.text(S.pipLabel === 'PREVIEW' ? '锁定预览' : 'MSL CAM', r.x + 10, r.y + 13, 11, 'rgba(159,232,255,0.9)', 'left', 4);
  }

  // ---- cinematic letterbox: animated rise/fall (ACE cut, near-miss whip) ----
  drawLetterbox(S) {
    const k = S.cineBars ?? 0;
    if (k <= 0.01) return;
    const c = this.ctx;
    const e = 1 - Math.pow(1 - k, 3);          // ease-out as it rises
    const bh = this.h * 0.11 * e;
    c.fillStyle = 'rgba(2,4,8,0.94)';
    c.fillRect(0, 0, this.w, bh);
    c.fillRect(0, this.h - bh, this.w, bh);
    if (S.aceCut && k > 0.85) this.text('ACE APPROACHING', this.w / 2, this.h - bh / 2, 20, RED, 'center', 10);
  }

  vignette(S) {
    const p = S.player;
    const c = this.ctx;
    // sustained high G: grey-out tunnel vision from the edges (G-LOC)
    if (p.gGrey > 0.02) {
      const g = c.createRadialGradient(this.w / 2, this.h / 2, this.h * 0.22, this.w / 2, this.h / 2, this.h * 0.72);
      g.addColorStop(0, 'rgba(10,10,12,0)');
      g.addColorStop(1, `rgba(8,8,10,${0.72 * p.gGrey})`);
      c.fillStyle = g;
      c.fillRect(0, 0, this.w, this.h);
    }

    // inbound missile: red edge pulse (AC-style warning glow)
    if (S.weapons && (S.weapons.inboundWarning || S.weapons.radarInbound)) {
      const pulse = 0.22 + Math.sin(S.time * 6) * 0.1;
      const g = c.createRadialGradient(this.w / 2, this.h / 2, this.h * 0.42, this.w / 2, this.h / 2, this.h * 0.8);
      g.addColorStop(0, 'rgba(255,30,10,0)');
      g.addColorStop(1, `rgba(255,30,10,${pulse})`);
      c.fillStyle = g;
      c.fillRect(0, 0, this.w, this.h);
    }
    // damage vignette
    const dmg = Math.max(p.hitFlash, p.hp <= 30 ? 0.22 + Math.sin(S.time * 5) * 0.08 : 0);
    if (dmg > 0.01) {
      const g = c.createRadialGradient(this.w / 2, this.h / 2, this.h * 0.3, this.w / 2, this.h / 2, this.h * 0.75);
      g.addColorStop(0, 'rgba(255,30,10,0)');
      g.addColorStop(1, `rgba(255,30,10,${0.55 * Math.min(1, dmg)})`);
      c.fillStyle = g;
      c.fillRect(0, 0, this.w, this.h);
    }
    // speed vignette
    const sv = clamp((p.speed - 420) / 280, 0, 0.5);
    if (sv > 0.02) {
      const g = c.createRadialGradient(this.w / 2, this.h / 2, this.h * 0.45, this.w / 2, this.h / 2, this.h * 0.85);
      g.addColorStop(0, 'rgba(10,20,40,0)');
      g.addColorStop(1, `rgba(10,20,40,${sv * 0.7})`);
      c.fillStyle = g;
      c.fillRect(0, 0, this.w, this.h);
    }
  }
}
