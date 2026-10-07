// audio.js — procedural WebAudio sound (no assets). Initialized on first gesture.
export class GameAudio {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this._lockBeepT = 0;
    this._stallT = 0;
    this.samples = null;      // decoded RWR one-shots (assets/sfx/rwr/*)
    this._sfxT = {};          // per-voice cooldown clock (audio time)
    this._rwrVoice = null;    // RWR loop: voice currently ruling the receiver
    this._rwrLoopT = 0;       // RWR loop: re-arm countdown for that voice
    this._rwrSrc = null;      // RWR loop: sounding clip, cut on voice switch
    // volume factors from the settings panel (0..1); applied at every node
    // that can carry sound so master/sfx/engine scale independently. RWR is
    // its own category (like engine): scaled by volRwr, NOT by volSfx
    this.volMaster = 1;
    this.volSfx = 1;
    this.volEngine = 1;
    this.volRwr = 0.7;
  }

  // settings panel hookup: { master?, sfx?, engine?, rwr? } in 0..1
  applyVolumes(o = {}) {
    if (o.master !== undefined) this.volMaster = Math.min(1, Math.max(0, o.master));
    if (o.sfx !== undefined) this.volSfx = Math.min(1, Math.max(0, o.sfx));
    if (o.engine !== undefined) this.volEngine = Math.min(1, Math.max(0, o.engine));
    if (o.rwr !== undefined) this.volRwr = Math.min(1, Math.max(0, o.rwr));
    if (this.master) this.master.gain.value = 0.5 * this.volMaster;
  }

  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC();
    this.master = ctx.createGain();
    this.master.gain.value = 0.5 * this.volMaster;
    // final gate: continuous engine/wind layers must fall silent on pause and
    // death even though their gains are only refreshed while playing
    this.duck = ctx.createGain();
    this.duck.gain.value = 1;
    const comp = ctx.createDynamicsCompressor();
    // muffle: lowpass between duck and comp — cloud pass / G-LOC pushes the
    // whole world behind a wool filter, AC7 style
    this.muffle = ctx.createBiquadFilter();
    this.muffle.type = 'lowpass';
    this.muffle.frequency.value = 20000;
    this.master.connect(this.duck);
    this.duck.connect(this.muffle).connect(comp).connect(ctx.destination);

    // engine: two detuned saws through a lowpass
    this.engGain = ctx.createGain(); this.engGain.gain.value = 0;
    this.engFilter = ctx.createBiquadFilter();
    this.engFilter.type = 'lowpass'; this.engFilter.frequency.value = 500; this.engFilter.Q.value = 2;
    this.engFilter.connect(this.engGain).connect(this.master);
    this.oscA = ctx.createOscillator(); this.oscA.type = 'sawtooth'; this.oscA.frequency.value = 55;
    this.oscB = ctx.createOscillator(); this.oscB.type = 'sawtooth'; this.oscB.frequency.value = 55.8;
    this.oscA.connect(this.engFilter); this.oscB.connect(this.engFilter);
    this.oscA.start(); this.oscB.start();

    // wind noise layer
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;
    this.windSrc = ctx.createBufferSource();
    this.windSrc.buffer = buf; this.windSrc.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass'; this.windFilter.frequency.value = 900; this.windFilter.Q.value = 0.6;
    this.windGain = ctx.createGain(); this.windGain.gain.value = 0;
    this.windSrc.connect(this.windFilter).connect(this.windGain).connect(this.master);
    this.windSrc.start();

    // stall buffet rumble: same noise through a deep lowpass — the
    // airframe shudder you feel in the seat before the horn goes off
    this.bufSrc = ctx.createBufferSource();
    this.bufSrc.buffer = buf; this.bufSrc.loop = true;
    this.bufFilter = ctx.createBiquadFilter();
    this.bufFilter.type = 'lowpass'; this.bufFilter.frequency.value = 130; this.bufFilter.Q.value = 0.8;
    this.bufGain = ctx.createGain(); this.bufGain.gain.value = 0;
    this.bufSrc.connect(this.bufFilter).connect(this.bufGain).connect(this.master);
    this.bufSrc.start();

    this.loadSamples();
  }

  // ---- RWR voice: sampled cockpit warnings (assets/sfx/rwr/*) ----
  // fetched + decoded once after init; a missing or undecodable file is not
  // an error — the procedural fallbacks in the rwr* methods keep every
  // warning audible, so the samples are an upgrade, never a dependency
  loadSamples() {
    const files = {
      newContact: 'assets/sfx/rwr/new_contact.aac',
      radarLock: 'assets/sfx/rwr/radar_lock.aac',
      mslLaunch: 'assets/sfx/rwr/missile_launch.aac',
      special: 'assets/sfx/rwr/special_contact.aac',
    };
    for (const [key, url] of Object.entries(files)) {
      fetch(url)
        .then(r => { if (!r.ok) throw new Error(url); return r.arrayBuffer(); })
        .then(b => this.ctx.decodeAudioData(b))
        .then(buf => { (this.samples ?? (this.samples = {}))[key] = buf; })
        .catch(() => { });   // stay silent here; fallback tones cover it
    }
  }

  // raw one-shot playback of a decoded RWR sample; returns {src, gain} so
  // the loop can cut it with a matching fade on voice switches. The source
  // clips end at FULL amplitude (hard-cut exports) — a 20 ms tail ramp
  // before the buffer's own end kills the pop without eating the warning
  _playBuf(key, gain = 0.9) {
    const buf = this.samples && this.samples[key];
    if (!buf || !this.ctx || !this.enabled) return null;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const g = this.ctx.createGain();
    const t0 = this.ctx.currentTime;
    const v = gain * this.volRwr;
    const fade = Math.min(0.02, buf.duration * 0.25);
    g.gain.setValueAtTime(v, t0);
    g.gain.setValueAtTime(v, t0 + Math.max(0, buf.duration - fade));
    g.gain.linearRampToValueAtTime(0.0001, t0 + buf.duration);
    src.connect(g).connect(this.master);
    src.start();
    return { src, gain: g };
  }

  // stop a sounding RWR clip the same way clips end on their own: a 20 ms
  // gain ramp, then stop — a bare .stop() is an audible click
  _cutRwr() {
    const c = this._rwrSrc;
    if (!c) return;
    this._rwrSrc = null;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    try {
      c.gain.gain.cancelScheduledValues(t);
      c.gain.gain.setValueAtTime(Math.max(c.gain.gain.value, 0.0001), t);
      c.gain.gain.linearRampToValueAtTime(0.0001, t + 0.02);
      c.src.stop(t + 0.03);
    } catch (e) { /* already ended */ }
  }

  // RWR procedural fallback tone: scaled by the RWR fader only (master chain
  // still applies) — deliberately NOT by volSfx, the RWR slider owns these
  _rwrTone(type, f0, f1, dur, gain) {
    const ctx = this.ctx;
    if (!ctx || !this.enabled) return;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, ctx.currentTime);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), ctx.currentTime + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain * this.volRwr, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0008, ctx.currentTime + dur);
    o.connect(g).connect(this.master);
    o.start();
    o.stop(ctx.currentTime + dur + 0.05);
  }

  // one-shot sample with per-voice debounce. Returns false only when the
  // sample is missing and the caller should use its procedural fallback;
  // cooldown hits and a disabled ctx count as handled (stay silent)
  _sample(key, gain = 0.9, cool = 0.5) {
    if (!this.ctx || !this.enabled) return true;
    const t = this.ctx.currentTime;
    if (t - (this._sfxT[key] ?? -1e9) < cool) return true;
    this._sfxT[key] = t;
    return !!this._playBuf(key, gain);
  }

  // RWR edge events: sampled aircraft voice when the aac decoded, else the
  // procedural tone — never silent. New contact fires once per contact
  // (picket crossing / battery ring); the SAM salvo commit is the one
  // special-contact edge — sweep, lock and launch live in the loop below
  rwrNewContact() {
    if (!this._sample('newContact', 0.8, 0.6)) this._rwrTone('square', 950, 950, 0.07, 0.08);
  }
  rwrSpecial() {
    if (!this._sample('special', 0.9, 3.0)) this._rwrTone('sine', 620, 620, 0.10, 0.09);
  }

  // --- RWR loop: while a threat PERSISTS, its voice keeps ringing. One
  // voice at a time, highest severity wins (launch > hard lock > radar
  // sweep) and a voice switch CUTS the sounding clip — a receiver changes
  // its tune, it doesn't stack them. Samples re-arm as each clip ends plus
  // a severity gap; without samples the procedural fallbacks take the same
  // slot at beep cadence (this loop REPLACES the old standalone inbound
  // beeper, so with samples loaded the beeps fall silent) ---
  rwrUpdate(dt, weapons, enemies) {
    const riding = weapons && (weapons.inboundWarning || weapons.radarInbound);
    const locked = enemies && enemies.rwrLocked;
    const swept = enemies && enemies.rwrSwept && !locked;
    const voice = riding ? 'mslLaunch' : locked ? 'radarLock' : swept ? 'special' : null;
    if (voice !== this._rwrVoice) {
      this._cutRwr();
      this._rwrVoice = voice;
      this._rwrLoopT = 0;   // a new threat speaks immediately
    }
    if (!voice) return;
    this._rwrLoopT -= dt;
    if (this._rwrLoopT > 0) return;
    const buf = this.samples && this.samples[voice];
    if (buf) {
      const gain = voice === 'mslLaunch' ? 1.0 : voice === 'radarLock' ? 0.9 : 0.8;
      const gap = voice === 'mslLaunch' ? 0.12 : voice === 'radarLock' ? 0.3 : 0.55;
      this._rwrSrc = this._playBuf(voice, gain);
      this._rwrLoopT = buf.duration + gap;
    } else if (voice === 'mslLaunch') {
      // launch fallback keeps the classic distinct radar/IR inbound beeps
      if (weapons.radarInbound && !weapons.inboundWarning) { this._rwrTone('sawtooth', 620, 480, 0.22, 0.09); this._rwrLoopT = 0.5; }
      else { this._rwrTone('square', 950, 690, 0.16, 0.10); this._rwrLoopT = 0.42; }
    } else if (voice === 'radarLock') {
      this._rwrTone('square', 1250, 980, 0.18, 0.10);
      this._rwrLoopT = 0.55;
    } else {
      this._rwrTone('sawtooth', 620, 480, 0.22, 0.09);
      this._rwrLoopT = 0.7;
    }
  }

  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }

  // master gate for pause / death / restart; fade lets one-shots (e.g. the
  // death explosion) ring out when a slower fade is requested
  setRunning(on, fade = 0.15) {
    if (!this.ctx || !this.duck) return;
    const t = this.ctx.currentTime;
    const g = this.duck.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(Math.max(g.value, 0.0001), t);
    g.exponentialRampToValueAtTime(on ? 1 : 0.0001, t + fade);
  }

  _noise(dur, filterType, freq0, freq1, gain, Q = 1) {
    const ctx = this.ctx;
    if (!ctx || !this.enabled) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = filterType; f.Q.value = Q;
    f.frequency.setValueAtTime(freq0, ctx.currentTime);
    f.frequency.exponentialRampToValueAtTime(Math.max(30, freq1), ctx.currentTime + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain * this.volSfx, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start();
    src.stop(ctx.currentTime + dur + 0.05);
  }

  _tone(type, f0, f1, dur, gain) {
    const ctx = this.ctx;
    if (!ctx || !this.enabled) return;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, ctx.currentTime);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), ctx.currentTime + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain * this.volSfx, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0008, ctx.currentTime + dur);
    o.connect(g).connect(this.master);
    o.start();
    o.stop(ctx.currentTime + dur + 0.05);
  }

  gun(fromPlayer) {
    if (fromPlayer) this._noise(0.07, 'bandpass', 1800, 700, 0.24, 1.2);
    else this._noise(0.06, 'bandpass', 1200, 500, 0.05, 1.5);
  }
  missileLaunch() {
    this._noise(0.9, 'lowpass', 3000, 300, 0.5);
    this._tone('square', 180, 60, 0.5, 0.06);
  }
  radarLaunch() {
    // bigger boost, deeper roar for the semi-active shooter
    this._noise(1.3, 'lowpass', 2200, 180, 0.55);
    this._tone('square', 130, 45, 0.8, 0.07);
  }
  explosion(far = 1) {
    this._noise(1.4, 'lowpass', 900, 60, 0.65 * far, 0.8);
    this._tone('sine', 110, 28, 1.1, 0.5 * far);
  }
  lock() { this._tone('square', 1250, 1250, 0.09, 0.12); }
  lockTick() { this._tone('square', 780, 780, 0.05, 0.08); }
  // seeker warmup: soft rising hum on start, two-tone confirm when hot,
  // damped click on cancel, double ping when the IR seeker bites a heat source
  warmStart() { this._tone('sine', 150, 340, 0.9, 0.07); }
  warmReady() {
    this._tone('square', 880, 880, 0.06, 0.1);
    setTimeout(() => this._tone('square', 1320, 1320, 0.09, 0.12), 85);
  }
  warmCancel() { this._tone('sine', 300, 120, 0.14, 0.07); }
  seekBite() {
    this._tone('square', 1600, 1600, 0.05, 0.09);
    setTimeout(() => this._tone('square', 1600, 1600, 0.05, 0.09), 70);
  }
  crit() {
    this._tone('square', 1500, 1500, 0.07, 0.16);
    setTimeout(() => this._tone('square', 1150, 1150, 0.09, 0.14), 85);
  }
  flare() {
    this._noise(0.12, 'bandpass', 2400, 500, 0.18, 1.8);
    setTimeout(() => this._noise(0.1, 'bandpass', 1800, 400, 0.14, 1.8), 70);
  }
  hitTaken() { this._noise(0.25, 'lowpass', 500, 100, 0.4); }
  sonicBoom() {
    this._tone('sine', 90, 32, 0.8, 0.5);
    this._noise(0.5, 'lowpass', 600, 70, 0.45);
  }
  nearMiss() { this._noise(0.3, 'bandpass', 1500, 320, 0.34, 1.2); }
  // AC7 hit-confirm: bright metallic ting layered over the impact noise
  hitTing() {
    this._tone('triangle', 2093, 2093, 0.09, 0.10);
    this._tone('sine', 3136, 3136, 0.05, 0.035);
  }
  kill() { this._tone('triangle', 520, 780, 0.28, 0.2); }

  update(dt, player, weapons, cloud = 0, enemies = null) {
    if (!this.ctx || !this.enabled) return;
    // RWR loop first: the persistent-threat voices (launch > lock > sweep)
    this.rwrUpdate(dt, weapons, enemies);
    // engine follows speed & throttle
    const s = Math.min(player.speed / 600, 1);
    const boosting = player.throttle > 0.82;
    const rpm = 46 + s * 70 + player.throttle * 26;
    this.oscA.frequency.value = rpm;
    this.oscB.frequency.value = rpm * 1.007 + 1.3;
    this.engFilter.frequency.value = 260 + s * 900 + (boosting ? 500 : 0);
    this.engGain.gain.value = (0.05 + player.throttle * 0.075 + (boosting ? 0.05 : 0)) * this.volEngine;
    this.windFilter.frequency.value = 500 + s * 1400;
    this.windGain.gain.value = (0.02 + s * s * 0.14 + cloud * cloud * 0.5) * this.volEngine;   // cloud-pass roar
    // stall buffet rumble: depth-scaled seat shudder, brighter as it deepens
    const bdy = player.body;
    if (bdy && this.bufGain) {
      this.bufGain.gain.value = bdy.buffet * 0.38 * this.volEngine;
      this.bufFilter.frequency.value = 90 + bdy.buffet * 120;
    }
    // stall horn / spin wail: plain stall gets the repeating horn; a spin
    // gets an urgent two-tone; the flat spin a long descending wail
    if (player.stalling && bdy) {
      this._stallT -= dt;
      if (this._stallT <= 0) {
        if (bdy.spin === 2) this._tone('sawtooth', 880, 220, 0.5, 0.11);
        else if (bdy.spin === 1) {
          this._tone('square', 620, 620, 0.09, 0.10);
          setTimeout(() => this._tone('square', 470, 470, 0.09, 0.10), 115);
        }
        else this._tone('square', 760, 700, 0.12, 0.07);
        this._stallT = bdy.spin ? 0.55 : 0.45;
      }
    } else this._stallT = 0;
    // world muffled while inside a deck
    const mufT = cloud > 0.05 ? 20000 - Math.pow(cloud, 1.2) * 15000 : 20000;
    this.muffle.frequency.value += (mufT - this.muffle.frequency.value) * Math.min(1, dt * 5);
  }
}
