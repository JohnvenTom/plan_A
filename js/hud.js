// hud.js — Ace-Combat-style HUD drawn on a 2D canvas overlay
import * as THREE from 'three';
import { clamp, pad } from './utils.js';

const CYAN = '#8fe0ff';
const CYAN_DIM = 'rgba(143,224,255,0.55)';
const RED = '#ff5a4a';
const AMBER = '#ffc866';

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
  }

  resize() {
    this.dpr = Math.min(devicePixelRatio || 1, 2);
    this.w = innerWidth; this.h = innerHeight;
    this.canvas.width = this.w * this.dpr;
    this.canvas.height = this.h * this.dpr;
    this.canvas.style.width = this.w + 'px';
    this.canvas.style.height = this.h + 'px';
  }

  announce(text, sub = '', dur = 3.2) { this.msgQueue.push({ text, sub, t: 0, dur }); }

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

  draw(dt, S) {
    const c = this.ctx;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, this.w, this.h);
    if (S.state !== 'playing') return;

    this.drawSpeedAlt(S);
    this.drawHeading(S);
    this.drawReticle(S);
    this.drawTargets(S);
    this.drawRadar(S);
    this.drawStatus(S);
    this.drawAlerts(dt, S);
    this.vignette(S);
  }

  // ---- speed / altitude / throttle ----
  drawSpeedAlt(S) {
    const p = S.player;
    const cx = this.w / 2, cy = this.h / 2;
    const boxW = 118, boxH = 34;
    // speed (left)
    const sx = cx - 250 - boxW / 2;
    this.strokeRect(sx, cy - boxH / 2, boxW, boxH, CYAN);
    this.text(`${Math.round(p.speed * 3.6)}`, sx + 10, cy, 20, CYAN);
    this.text('km/h', sx + boxW + 8, cy - 10, 11, CYAN_DIM);
    this.text('SPD', sx + 2, cy - boxH / 2 - 12, 11, CYAN_DIM);
    // throttle bar
    const tbx = sx - 16;
    this.line(tbx, cy + boxH / 2, tbx, cy - boxH / 2, CYAN_DIM, 1);
    const ty = cy + boxH / 2 - p.throttle * boxH;
    this.line(tbx - 4, ty, tbx + 4, ty, p.boosting ? AMBER : CYAN, 3);
    // G readout (warmed by the energy model: hard pulls bleed speed)
    this.text(`G ${p.gLoad.toFixed(1)}`, sx + 2, cy + boxH / 2 + 16, 13,
      p.gLoad > 12 ? RED : p.gLoad > 7 ? AMBER : CYAN_DIM);
    // altitude (right)
    const ax = cx + 250 - boxW / 2;
    this.strokeRect(ax, cy - boxH / 2, boxW, boxH, CYAN);
    this.text(`${Math.round(p.position.y)}`, ax + 10, cy, 20, CYAN);
    this.text('ALT m', ax + boxW + 8, cy - 10, 11, CYAN_DIM);
    this.text('ALT', ax + 2, cy - boxH / 2 - 12, 11, CYAN_DIM);
    // G / heading readout small
    this.text(`HDG ${pad(Math.round(p.headingDeg) % 360, 3)}`, ax + 2, cy + boxH / 2 + 14, 12, CYAN_DIM);
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

  // ---- War Thunder style: aim director circle at the mouse + flight path marker ----
  drawReticle(S) {
    const c = this.ctx;
    // flight path marker: where the nose actually points (chases the circle)
    const fp = S.player.position.clone().addScaledVector(S.player.forward(this._v), 2600);
    const s = this.proj(fp, S.camera);
    const fpOn = !s.behind && s.x > 20 && s.x < this.w - 20 && s.y > 20 && s.y < this.h - 20;
    if (fpOn) {
      this.circle(s.x, s.y, 9, CYAN, 2);
      this.line(s.x - 17, s.y, s.x - 9, s.y, CYAN, 2);
      this.line(s.x + 9, s.y, s.x + 17, s.y, CYAN, 2);
      this.line(s.x, s.y - 17, s.x, s.y - 9, CYAN, 2);
      this.line(s.x, s.y + 9, s.x, s.y + 17, CYAN, 2);
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

    // lock-on ring rides the flight path marker (the nose chases the circle)
    const ls = S.weapons.lockState;
    if (ls.target && fpOn) {
      const r = 46 - ls.progress * 30;
      this.circle(s.x, s.y, Math.max(10, r), ls.locked ? RED : AMBER, ls.locked ? 2.5 : 2);
      this.text(ls.locked ? 'LOCK' : '...', s.x, s.y + 62, 14, ls.locked ? RED : AMBER, 'center');
    }
  }

  // filled by edit: drawTargets, drawRadar, drawStatus, drawAlerts, vignette
  drawTargets(S) {
    const ls = S.weapons.lockState;
    for (const e of S.enemies) {
      if (e.dying) continue;
      const s = this.proj(e.position, S.camera);
      const dist = e.position.distanceTo(S.player.position);
      const onScreen = !s.behind && s.x > 30 && s.x < this.w - 30 && s.y > 30 && s.y < this.h - 30;
      const isLock = ls.target === e;
      if (onScreen) {
        const size = clamp(3600 / dist, 16, 64);
        const col = isLock ? (ls.locked ? RED : AMBER) : CYAN;
        this.strokeRect(s.x - size / 2, s.y - size / 2, size, size, col, isLock ? 2.5 : 1.5);
        // corner ticks for the locked target
        if (isLock && ls.locked) {
          this.strokeRect(s.x - size / 2 - 6, s.y - size / 2 - 6, size + 12, size + 12, RED, 1.5);
        }
        this.text(`${(dist / 1000).toFixed(1)}`, s.x + size / 2 + 8, s.y - size / 2 + 4, 12, col, 'left', 4);
        if (e.hp < 42) this.text('DMG', s.x + size / 2 + 8, s.y + size / 2 - 4, 11, AMBER, 'left', 4);
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
        c.fillStyle = isLock ? RED : CYAN_DIM;
        c.shadowColor = c.fillStyle; c.shadowBlur = 6;
        c.beginPath(); c.moveTo(12, 0); c.lineTo(-6, -7); c.lineTo(-6, 7); c.closePath(); c.fill();
        c.restore();
        c.shadowBlur = 0;
      }
    }
  }

  drawRadar(S) {
    const cx = this.w - 130, cy = this.h - 130, R = 88, range = 5200;
    const c = this.ctx;
    c.save();
    // dial
    this.circle(cx, cy, R, CYAN_DIM, 1.5);
    this.circle(cx, cy, R * 0.55, 'rgba(143,224,255,0.22)', 1);
    this.line(cx - R, cy, cx + R, cy, 'rgba(143,224,255,0.18)', 1);
    this.line(cx, cy - R, cx, cy + R, 'rgba(143,224,255,0.18)', 1);
    // sweep
    const sw = (S.time * 1.5) % (Math.PI * 2);
    const grad = c.createLinearGradient(cx, cy, cx + Math.cos(sw - Math.PI / 2) * R, cy + Math.sin(sw - Math.PI / 2) * R);
    c.strokeStyle = 'rgba(143,224,255,0.5)'; c.lineWidth = 2;
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
    // left column: HP + ammo
    const x = 46, y = this.h - 150;
    this.text('AIRFRAME', x, y, 12, CYAN_DIM);
    const hpw = 190;
    this.strokeRect(x, y + 10, hpw, 12, CYAN_DIM, 1);
    const hpcol = p.hp > 55 ? CYAN : p.hp > 25 ? AMBER : RED;
    const c = this.ctx;
    c.fillStyle = hpcol; c.shadowColor = hpcol; c.shadowBlur = 8;
    c.fillRect(x + 2, y + 12, Math.max(0, (hpw - 4) * p.hp / 100), 8);
    c.shadowBlur = 0;
    this.text(`${Math.round(p.hp)}`, x + hpw + 10, y + 16, 13, hpcol);
    // missiles
    this.text('MISSILE', x, y + 46, 12, CYAN_DIM);
    for (let i = 0; i < w.ammoMax; i++) {
      const mx = x + 2 + i * 16;
      if (i < w.ammo) {
        c.fillStyle = AMBER; c.shadowColor = AMBER; c.shadowBlur = 6;
        c.beginPath(); c.moveTo(mx, y + 68); c.lineTo(mx + 5, y + 54); c.lineTo(mx + 10, y + 68); c.closePath(); c.fill();
        c.shadowBlur = 0;
      } else {
        this.strokeRect(mx, y + 55, 10, 13, 'rgba(255,200,102,0.25)', 1);
      }
    }
    this.text(`${w.ammo}/${w.ammoMax}`, x + w.ammoMax * 16 + 12, y + 61, 13, AMBER);
    // gun heat
    this.text('GUN', x, y + 88, 12, CYAN_DIM);
    this.strokeRect(x + 36, y + 82, 120, 10, CYAN_DIM, 1);
    if (w.gunHeat > 0.02) {
      c.fillStyle = w.gunHeat > 0.8 ? RED : CYAN;
      c.fillRect(x + 38, y + 84, 116 * Math.min(1, w.gunHeat), 6);
    }
    // kills top-right
    this.text(`KILLS ${S.kills}`, this.w - 46, 40, 16, CYAN, 'right');
    this.text(`WAVE ${S.wave}`, this.w - 46, 64, 13, CYAN_DIM, 'right');
    this.text(`SCORE ${S.score}`, this.w - 46, 88, 13, CYAN_DIM, 'right');
  }

  drawAlerts(dt, S) {
    const cx = this.w / 2;
    const blink = Math.floor(S.time * 4) % 2 === 0;
    // inbound missile
    if (S.weapons.inboundWarning && blink) {
      this.text('⚠ MISSILE ⚠', cx, this.h / 2 - 150, 26, RED, 'center', 14);
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
    // announcements (wave / kill)
    for (let i = this.msgQueue.length - 1; i >= 0; i--) {
      const m = this.msgQueue[i];
      m.t += dt;
      if (m.t > m.dur) { this.msgQueue.splice(i, 1); continue; }
      const a = Math.min(1, m.t * 4) * Math.min(1, (m.dur - m.t) * 2);
      const c = this.ctx;
      c.globalAlpha = a;
      this.text(m.text, cx, this.h * 0.30, 30, AMBER, 'center', 14);
      if (m.sub) this.text(m.sub, cx, this.h * 0.30 + 34, 15, CYAN, 'center', 8);
      c.globalAlpha = 1;
    }
  }

  vignette(S) {
    const p = S.player;
    const c = this.ctx;
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
