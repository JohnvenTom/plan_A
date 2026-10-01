// hud.js — Ace-Combat-7-style HUD drawn on a 2D canvas overlay: cyan-white
// thin lines, vertical speed/altitude tapes with drum-digit readout boxes,
// bracket target frames, a nose-anchored 80° missile envelope ring, dual
// missile loadout cards with the seeker warmup state, and center warnings
// with a red edge glow while missiles are inbound.
import * as THREE from 'three';
import { clamp, pad } from './utils.js';
import { cornerSpeedKMH } from './flightmodel.js';

const CYAN = '#9fe8ff';
const CYAN_DIM = 'rgba(159,232,255,0.5)';
const RED = '#ff5a4a';
const AMBER = '#ffc866';
const _hv = new THREE.Vector3();
const _hv2 = new THREE.Vector3();
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
  }

  resize() {
    this.dpr = Math.min(devicePixelRatio || 1, 2);
    this.w = innerWidth; this.h = innerHeight;
    this.canvas.width = this.w * this.dpr;
    this.canvas.height = this.h * this.dpr;
    this.canvas.style.width = this.w + 'px';
    this.canvas.style.height = this.h + 'px';
  }

  announce(text, sub = '', dur = 3.2, style = 'info', sticky = false) {
    this.msgQueue.push({ text, sub, t: 0, dur, style, sticky, y: null, dead: false, fade: 0 });
    // hard cap: force the oldest non-sticky message out
    const live = this.msgQueue.filter(m => !m.dead);
    if (live.length > 4) live[0].t = Math.max(live[0].t, live[0].dur);
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

  // ---- RWR: radar threat bearing ring, bottom-center ----
  drawRWR(S) {
    const threats = S.radarThreats || [];
    if (!threats.length) return;
    const cx = this.w / 2, cy = this.h - 96, R = 64;
    const c = this.ctx;
    this.circle(cx, cy, R, 'rgba(255,90,74,0.55)', 1.5);
    this.circle(cx, cy, R * 0.5, 'rgba(255,90,74,0.2)', 1);
    // own marker
    c.fillStyle = CYAN; c.shadowColor = CYAN; c.shadowBlur = 6;
    c.beginPath(); c.moveTo(cx, cy - 6); c.lineTo(cx - 4, cy + 4); c.lineTo(cx + 4, cy + 4); c.closePath(); c.fill();
    c.shadowBlur = 0;
    // threats plotted by bearing-from-heading, radius by distance (12 km = edge)
    const hdg = S.player.headingDeg * Math.PI / 180;
    for (const t of threats) {
      let rel = (t.brg - hdg) % (Math.PI * 2);
      const rr = R * clamp(t.dist / 12000, 0.2, 1);
      const px = cx - Math.sin(rel) * rr;   // screen-x: bearing right of nose plots right
      const py = cy - Math.cos(rel) * rr * 0.9;
      c.fillStyle = RED; c.shadowColor = RED; c.shadowBlur = 8;
      c.beginPath(); c.arc(px, py, 4, 0, Math.PI * 2); c.fill();
      c.shadowBlur = 0;
      this.line(px, py, px + Math.sin(rel) * 8, py - Math.cos(rel) * 0 + Math.cos(rel) * 8, RED, 1);
    }
    this.text('RWR', cx, cy + R + 14, 11, RED, 'center', 4);
  }

  draw(dt, S) {
    const c = this.ctx;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, this.w, this.h);
    if (S.state !== 'playing') return;

    this.drawSpeedAlt(dt, S);
    this.drawHeading(S);
    this.drawEnvelope(S);
    this.drawReticle(S);
    this.drawTargets(S);
    this.drawMissileMarkers(S);
    this.drawRadar(S);
    this.drawRWR(S);
    this.drawStatus(S);
    this.drawAlerts(dt, S);
    this.drawHint(dt);
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
    this.text(`α ${(p.alpha * 57.3).toFixed(1)}°`, xL - 34, cy + H / 2 + 72, 12,
      Math.abs(p.alpha) > 0.24 ? AMBER : CYAN_DIM);
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
        this.arcProgress(ap.x, ap.y, 52, w.warm.t / 1.0, AMBER);
      }
    }
    if (w.warm.state === 'hot') {
      this.text(`HOT ${Math.max(0, w.warm.t).toFixed(1)}`, ap.x, ap.y + 62, 12, RED, 'center', 5);
    }
  }

  // ---- target frames: AC7 brackets + RNG, off-screen arrows ----
  // The guidance target's frame is the 120° cone edge display: normal red
  // inside the cone, amber past 50° off the nose, flashing red past 56°
  // (lock breaks / launch gate closes at 60°) + a CONE tag.
  drawTargets(S) {
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
        const size = clamp(4200 / dist, 18, 66);
        this._brackets(s.x, s.y, size, col, isLock ? 2 : 1.25);
        if (isLock) {
          this._diamond(s.x, s.y, 5, col, true);
          this.text('LOCK', s.x + size / 2 + 8, s.y - size / 2 - 9, 12, col, 'left', 4);
          if (isGuide) this.text(atEdge ? 'CONE — 即将断锁' : 'CONE', s.x + size / 2 + 8, s.y - size / 2 + 22, 11, edgeCol, 'left', 4);
        }
        this.text(`RNG ${(dist / 1000).toFixed(1)}`, s.x + size / 2 + 8, s.y - size / 2 + 7, 11, col, 'left', 3);
        if (e.hp < 42) this.text('DMG', s.x + size / 2 + 8, s.y + size / 2 - 5, 11, AMBER, 'left', 3);
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
    // radar seeker warmup arc around the locked target:
    // amber while warming (progress), thin solid red ring when hot
    if (w.mslKind === 'radar' && ls.target && w.warm.state !== 'cold') {
      const tp = this.proj(ls.target.position, S.camera);
      if (!tp.behind) {
        const size = clamp(4200 / ls.target.position.distanceTo(S.player.position), 18, 66);
        const r = size * 0.78 + 10;
        if (w.warm.state === 'warming') {
          this.arcProgress(tp.x, tp.y, r, w.warm.t / 1.0, AMBER);
        } else {
          this.circle(tp.x, tp.y, r, RED, 1.25);
        }
      }
    }
  }

  // ---- hostile missiles: an unmistakable SPINNING diamond marker ----
  // rides the missile on-screen; clamps to a screen-edge ellipse when the
  // threat leaves the frame so it never becomes unreadable
  drawMissileMarkers(S) {
    for (const ms of S.weapons.missiles) {
      if (ms.fromPlayer) continue;
      const dist = ms.pos.distanceTo(S.player.position);
      const s = this.proj(ms.pos, S.camera);
      const r = clamp(3000 / Math.max(dist, 1), 7, 18);
      const spin = S.time * 3.2;
      if (!s.behind && s.x > 24 && s.x < this.w - 24 && s.y > 24 && s.y < this.h - 24) {
        this._diamond(s.x, s.y, r, RED, false, spin);
      } else {
        const dx = s.behind ? this.w / 2 - s.x : s.x - this.w / 2;
        const dy = s.behind ? this.h / 2 - s.y : s.y - this.h / 2;
        const ang = Math.atan2(dy, dx);
        const rx = this.w / 2 - 56, ry = this.h / 2 - 56;
        const t = 1 / Math.max(Math.abs(Math.cos(ang)) / rx, Math.abs(Math.sin(ang)) / ry);
        this._diamond(this.w / 2 + Math.cos(ang) * t, this.h / 2 + Math.sin(ang) * t, r * 0.8, RED, false, spin);
      }
    }
  }

  drawRadar(S) {
    const cx = this.w - 130, cy = this.h - 130, R = 88, range = 5200;
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
    const blip = (wx, wz, color, r) => {
      let dx = wx - S.player.position.x, dz = wz - S.player.position.z;
      const rx = dx * cosH - dz * sinH, rz = dx * sinH + dz * cosH;
      const px = cx + (rx / range) * R, py = cy + (rz / range) * R;
      if (Math.hypot(px - cx, py - cy) > R - 4) return;
      c.fillStyle = color; c.shadowColor = color; c.shadowBlur = 6;
      c.beginPath(); c.arc(px, py, r, 0, Math.PI * 2); c.fill();
      c.shadowBlur = 0;
    };
    for (const e of S.enemies) if (!e.dying) blip(e.position.x, e.position.z, RED, 3.2);
    for (const ms of S.weapons.missiles) {
      if (!ms.fromPlayer) blip(ms.pos.x, ms.pos.z, AMBER, 2);
    }
    // own marker (points up)
    c.fillStyle = CYAN; c.shadowColor = CYAN; c.shadowBlur = 8;
    c.beginPath(); c.moveTo(cx, cy - 7); c.lineTo(cx - 5, cy + 5); c.lineTo(cx + 5, cy + 5); c.closePath(); c.fill();
    c.shadowBlur = 0;
    this.text('RNG 5km', cx, cy + R + 16, 11, CYAN_DIM, 'center', 4);
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
    // missile loadout cards: one row per pool, the selected kind framed
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
    // enemy fire-control phases (only when nothing of ours is inbound):
    // amber while the enemy builds the 1.15 s lock, red-ish while warming
    if (!S.weapons.inboundWarning && !S.weapons.radarInbound) {
      if (S.enemyWarm > 0.1 && blink) {
        this.text('⚠ 敌方预热中 ⚠', cx, this.h / 2 - 150, 20, RED, 'center', 10);
      } else if (S.enemyLock > 0.25) {
        this.text('⚠ 敌方锁定中 ⚠', cx, this.h / 2 - 150, 20, AMBER, 'center', 10);
      }
    }
    // stall / departure: flashing red + recovery hint (push to unload)
    if (S.player.stalling && blink) {
      this.text('⚠ 失速 STALL ⚠', cx, this.h / 2 - 118, 24, RED, 'center', 14);
      this.text('推杆俯冲加速改出', cx, this.h / 2 - 96, 14, AMBER, 'center', 8);
    }
    // low hp
    if (S.player.hp <= 30 && blink) {
      this.text('DAMAGE CRITICAL', cx, this.h / 2 + 180, 18, RED, 'center');
    }
    // out of area
    if (S.player.outOfArea) {
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
      m.dying = !m.sticky && m.t > m.dur;
      if (m.dying) {
        m.fade += dt / 0.24;
        if (m.fade >= 1) { m.dead = true; continue; }
      } else {
        m.fade = Math.min(1, m.fade + dt / 0.06);
      }
      m.slot = slot++;
      live.push(m);
    }
    this.msgQueue = this.msgQueue.filter(m => !m.dead);
    const c = this.ctx;
    for (const m of live) {
      const targetY = baseY + m.slot * slotH;
      if (m.y === null) m.y = targetY - 46;      // slide up into place
      m.y += (targetY - m.y) * Math.min(1, dt * 14);
      // entry: easeOutBack overshoot on scale
      const k = Math.min(1, m.t / 0.3);
      const c1 = 1.70158, c3 = c1 + 1;
      const eob = 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2);
      const scale = 0.55 + 0.45 * (k < 1 ? eob : 1);
      const alpha = Math.min(1, m.t / 0.12) * (m.dying ? 1 - m.fade : 1);
      const drift = m.dying ? -m.fade * 34 : 0;
      const style = {
        info: { col: CYAN, size: 26, sub: CYAN },
        wave: { col: AMBER, size: 30, sub: CYAN },
        kill: { col: AMBER, size: 30, sub: CYAN },
        crit: { col: RED, size: 34, sub: RED },
      }[m.style] || { col: CYAN, size: 26, sub: CYAN };
      c.save();
      c.translate(cx, m.y + drift);
      c.scale(scale, scale);
      c.globalAlpha = alpha;
      this.text(m.text, 0, 0, style.size, style.col, 'center', m.style === 'crit' ? 18 : 14);
      if (m.sub) this.text(m.sub, 0, 30, 14, style.sub, 'center', 8);
      c.restore();
      c.globalAlpha = 1;
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

  vignette(S) {
    const p = S.player;
    const c = this.ctx;
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
