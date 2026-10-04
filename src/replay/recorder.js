// recorder.js — flight-data recorder for the post-mission debrief. Pure data,
// no THREE import: positions/quaternions are read off whatever objects the sim
// hands in (duck-typed .x/.y/.z/.w), which keeps this module headless-testable
// and serialization trivial.
//
// Sampling: fixed 20 Hz (pos + quat) of the player, every live enemy (dying
// spirals included — the falling wreck is part of the story) and every live
// missile. Events (launch / hit / kill / flare / near-miss / intercept /
// damage / crash / wave ticks) are logged as they happen with timestamps.
// Missiles and enemies are keyed by object identity; when an object leaves its
// manager's array its track is sealed (sampling stops, the trail stays).
export const PLAYER_COLOR = 0x53e3ff;
export const ACE_COLOR = 0xffd24d;
export const MSL_COLOR_P = 0x9adfff;
export const MSL_COLOR_E = 0xff9a8a;
// enemy trail palette: warm hostiles, cycled per enemy so arrow / trail / kill
// chip all share one readable color
export const ENEMY_PALETTE = [
  0xff4d4d, 0xff7a3d, 0xffb347, 0xff5f9e, 0xff6b6b, 0xe8873a,
  0xffa07a, 0xf0564c, 0xffc266, 0xd95f8a,
];

const STEP = 1 / 20;   // seconds between samples

function newTrack(id, kind, extra = {}) {
  return {
    id, kind,              // 'player' | 'enemy' | 'missile'
    side: 'p',             // 'p' | 'e'
    k: null,               // missile kind: 'ir' | 'radar' | 'aa'
    ace: false, ci: 0,     // palette index (enemies)
    t0: 0, end: 0, n: 0,   // first/last sample time, sample count
    samples: [],           // flat [t,x,y,z,qx,qy,qz,qw]*
    sealed: false,
    ...extra,
  };
}

export class Recorder {
  constructor() { this.reset(); }

  reset() {
    this.active = false;
    this.time = 0;               // mission clock this recorder owns
    this._acc = 0;
    this._tick = 0;
    this._entityMap = new Map(); // sim object -> track (identity keyed)
    this._roundSeen = new Set(); // player tracer objects seen last tick
    this._enemyCi = 0;
    this._mslCi = 0;
    this.tracks = [];
    this.events = [];
    this.result = null;          // set via setResult() at mission end
    this.date = new Date().toISOString();
    this.stats = { gunFired: 0, mslFired: 0, hits: 0 };
    this.player = null;          // player track, created on first sample()
  }

  start() { this.reset(); this.active = true; }

  stop() { this.active = false; }

  // ---- mission summary: grade is derived here so live + imported records
  // score identically ----
  setResult(o) {
    const r = { ...o };
    const shots = (r.gunFired || 0) + (r.mslFired || 0);
    r.accuracy = shots > 0 ? Math.min(1, (r.hits || 0) / shots) : 0;
    r.grade = gradeOf(r);
    this.result = r;
    return r;
  }

  // ---- per-frame sim observation; call from the playing update with the
  // scaled dt so slow-motion kill-cams record in mission time ----
  sample(dt, { player, enemies, weapons }) {
    if (!this.active) return;
    this.time += dt;
    this._acc += dt;
    if (this._acc < STEP) return;
    this._acc -= STEP;
    this._tick++;
    const t = this.time;

    if (player.alive) {
      if (!this.player) {
        this.player = newTrack('player', 'player', { side: 'p' });
        this.tracks.push(this.player);
        this._entityMap.set(player, this.player);
      }
      pushSample(this.player, t, player.position, player.quaternion);
    }

    // enemies: first-seen creates the track (palette color assigned here),
    // removal seals it — sealed tracks keep their trail for the replay
    for (const e of enemies) {
      let tr = this._entityMap.get(e);
      if (!tr) {
        tr = newTrack('e' + (++this._enemyCi), 'enemy', {
          side: 'e', ace: !!e.ace,
          ci: e.ace ? -1 : ((this._enemyCi - 1) % ENEMY_PALETTE.length),
        });
        this.tracks.push(tr);
        this._entityMap.set(e, tr);
      }
      tr._seen = this._tick;
      pushSample(tr, t, e.position, e.quaternion);
    }

    // missiles: identity per launch; a new object in the pool array IS a
    // launch event (position read within one sample step of the rail)
    for (const ms of weapons.missiles) {
      let tr = this._entityMap.get(ms);
      if (!tr) {
        tr = newTrack('m' + (this._mslCi = (this._mslCi || 0) + 1), 'missile', {
          side: ms.fromPlayer ? 'p' : 'e', k: ms.kind,
        });
        this.tracks.push(tr);
        this._entityMap.set(ms, tr);
        if (ms.fromPlayer) this.stats.mslFired++;
        this.ev('launch', { side: tr.side, k: ms.kind, m: tr.id }, ms.pos);
      }
      tr._seen = this._tick;
      pushSample(tr, t, ms.pos, ms.quat);
    }

    // seal everything that vanished between ticks
    for (const tr of this.tracks) {
      if (tr.kind === 'player' || tr.sealed || tr._seen === this._tick) continue;
      tr.sealed = true;
    }

    // gun-round diff: new player tracers since last tick = rounds fired
    const seen = this._roundSeen;
    const cur = new Set();
    for (const r of weapons.rounds) if (r.fromPlayer) cur.add(r);
    for (const r of cur) if (!seen.has(r)) this.stats.gunFired++;
    this._roundSeen = cur;
  }

  // ---- event log; pos optional (some events are timeline-only ticks) ----
  ev(type, f = {}, pos = null) {
    if (!this.active) return;
    const e = { t: Math.round(this.time * 100) / 100, type, ...f };
    if (pos) { e.x = pos.x; e.y = pos.y; e.z = pos.z; }
    if (type === 'kill' && !e.w) {
      // infer the killing weapon: the freshest hit on anyone inside 0.3 s
      for (let i = this.events.length - 1; i >= 0; i--) {
        const h = this.events[i];
        if (e.t - h.t > 0.3) break;
        if (h.type === 'hit') { e.w = h.w; break; }
      }
    }
    this.events.push(e);
    return e;
  }

  trackIdOf(obj) { const tr = this._entityMap.get(obj); return tr ? tr.id : null; }

  // ---- export: in-memory record (full precision) for the live debrief ----
  toRecord() {
    return {
      v: 1, app: 'sky-baroness',
      date: this.date,
      duration: Math.round(this.time * 100) / 100,
      result: this.result,
      tracks: this.tracks.map(tr => ({
        id: tr.id, kind: tr.kind, side: tr.side, k: tr.k, ace: tr.ace, ci: tr.ci,
        s: tr.samples.slice(),
      })),
      events: this.events.map(e => ({ ...e })),
    };
  }

  // ---- export: quantized JSON for download (pos 0.1 m, quat 1e-3, t 10 ms) ----
  serialize() {
    const rec = this.toRecord();
    for (const tr of rec.tracks) {
      const s = tr.s;
      for (let i = 0; i < s.length; i += 8) {
        s[i] = Math.round(s[i] * 100) / 100;
        s[i + 1] = Math.round(s[i + 1] * 10) / 10;
        s[i + 2] = Math.round(s[i + 2] * 10) / 10;
        s[i + 3] = Math.round(s[i + 3] * 10) / 10;
        s[i + 4] = Math.round(s[i + 4] * 1000) / 1000;
        s[i + 5] = Math.round(s[i + 5] * 1000) / 1000;
        s[i + 6] = Math.round(s[i + 6] * 1000) / 1000;
        s[i + 7] = Math.round(s[i + 7] * 1000) / 1000;
      }
    }
    for (const e of rec.events) {
      if (e.x !== undefined) {
        e.x = Math.round(e.x * 10) / 10;
        e.y = Math.round(e.y * 10) / 10;
        e.z = Math.round(e.z * 10) / 10;
      }
    }
    return JSON.stringify(rec);
  }
}

function pushSample(tr, t, p, q) {
  tr.samples.push(t, p.x, p.y, p.z, q.x, q.y, q.z, q.w);
  tr.end = t;
  if (tr.n === 0) tr.t0 = t;
  tr.n++;
}

// S~D evaluation: combat score + survival + accuracy, failed missions cap at A
export function gradeOf(r) {
  const total = (r.score || 0)
    + Math.floor(Math.min(r.time || 0, 600) * 5)
    + Math.floor((r.accuracy || 0) * 1500);
  let g = total >= 9000 ? 'S' : total >= 6000 ? 'A' : total >= 3500 ? 'B' : total >= 1500 ? 'C' : 'D';
  if (r.outcome === 'failed' && g === 'S') g = 'A';
  return g;
}

// ---- import: accept a JSON string or an already-parsed object; returns a
// normalized record or null when the shape is not one of ours ----
export function parseRecord(input) {
  let rec = input;
  if (typeof input === 'string') {
    try { rec = JSON.parse(input); } catch { return null; }
  }
  if (!rec || rec.v !== 1 || !Array.isArray(rec.tracks) || !Array.isArray(rec.events)) return null;
  for (const tr of rec.tracks) {
    if (!tr || !Array.isArray(tr.s) || tr.s.length % 8 !== 0) return null;
  }
  return rec;
}
