// radar.js — realistic-mode SEARCH radar (War Thunder style).
// In realistic mode the HUD is fully radar-gated: an aircraft the antenna has
// not painted has no scope blip, no target frame and no X-lock — the eyes
// still have the 3D model, the fire control does not. The antenna ping-pongs
// across a selectable azimuth sector (wide ±60° / narrow ±20°, N toggles);
// a contact is (re) painted only when the sweep CROSSES its bearing, then
// rides at its last-paint position and fades. An STT lock stops the antenna
// dead on the locked target — everything else goes stale, exactly like a
// fighter radar that has left search to single-target-track.
export const RADAR_SCAN_RANGE = 100000;   // instrumented detection: 100 km, whole battlefield
export const RADAR_FADE = 4;              // s a paint survives without a re-sweep

const ANT_SPEED = 60 * Math.PI / 180;     // antenna rate: 60°/s (wide pass = 2 s, narrow = 0.67 s)
const PATTERNS = {
  wide:   { half: 60 * Math.PI / 180 },
  narrow: { half: 20 * Math.PI / 180 },
};
const RIM_SLOP = 0.035;                   // ~2° bearing slack at the sector rim

// same live-body convention as weapons.js (enemies flag dying/dead)
function live(t) { return !!t && !t.dying && !t.dead && t.alive !== false; }

export class RadarSensor {
  constructor() { this.reset(); }

  reset() {
    this.pattern = 'wide';                // 'wide' | 'narrow' (N toggles)
    this.t = 0;                           // sensor clock (contact staleness)
    this.ant = -PATTERNS.wide.half;       // antenna bearing: 0 = nose, + = starboard
    this.dir = 1;                         // ping-pong direction
    this.contacts = new Map();            // enemy -> { t, x, z } last-paint snapshot
    this.stt = null;                      // single-target-track aircraft (antenna frozen)
  }

  get half() { return PATTERNS[this.pattern].half; }

  togglePattern() {
    this.pattern = this.pattern === 'wide' ? 'narrow' : 'wide';
    const h = this.half;
    if (this.ant > h) this.ant = h;
    else if (this.ant < -h) this.ant = -h;
    return this.pattern;
  }

  // a body is "detected" while its paint is still fresh
  detected(e) {
    const c = this.contacts.get(e);
    return !!c && this.t - c.t <= RADAR_FADE;
  }

  // signed bearing of a world point in the scope frame: 0 = nose azimuth,
  // + = starboard. Uses the SAME heading rotation the HUD scope uses, so
  // sensor and display can never disagree about where a blip sits.
  bearing(player, pos) {
    const hdg = player.headingDeg * Math.PI / 180;
    const cosH = Math.cos(-hdg), sinH = Math.sin(-hdg);
    const dx = pos.x - player.position.x, dz = pos.z - player.position.z;
    const rx = dx * cosH - dz * sinH, rz = dx * sinH + dz * cosH;
    return Math.atan2(rx, -rz);
  }

  update(dt, player, enemies, lockTarget) {
    this.t += dt;
    // missiles stay lockable for intercepts but are not radar paints: only an
    // aircraft lock freezes the antenna into STT
    const stt = live(lockTarget) && !lockTarget.kind ? lockTarget : null;
    this.stt = stt;
    if (stt) {
      const p = stt.position;
      const c = this.contacts.get(stt);
      if (c) { c.t = this.t; c.x = p.x; c.z = p.z; }
      else this.contacts.set(stt, { t: this.t, x: p.x, z: p.z });
    } else {
      const prev = this.ant;
      const h = this.half;
      this.ant += this.dir * ANT_SPEED * dt;
      if (this.ant >= h) { this.ant = h; this.dir = -1; }
      else if (this.ant <= -h) { this.ant = -h; this.dir = 1; }
      const lo = Math.min(prev, this.ant), hi = Math.max(prev, this.ant);
      const pp = player.position;
      for (const e of enemies) {
        if (!live(e)) continue;
        if (e.position.distanceTo(pp) > RADAR_SCAN_RANGE) continue;
        const b = this.bearing(player, e.position);
        if (Math.abs(b) > h + RIM_SLOP) continue;
        if (b >= lo && b <= hi) this.contacts.set(e, { t: this.t, x: e.position.x, z: e.position.z });
      }
    }
    // prune: dead hosts and paints long gone stale
    for (const [e, c] of this.contacts) {
      if (!live(e) || this.t - c.t > RADAR_FADE + 0.5) this.contacts.delete(e);
    }
  }
}
