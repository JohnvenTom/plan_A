// audio.js — procedural WebAudio sound (no assets). Initialized on first gesture.
export class GameAudio {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this._lockBeepT = 0;
    this._alertT = 0;
  }

  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC();
    this.master = ctx.createGain();
    this.master.gain.value = 0.5;
    // final gate: continuous engine/wind layers must fall silent on pause and
    // death even though their gains are only refreshed while playing
    this.duck = ctx.createGain();
    this.duck.gain.value = 1;
    const comp = ctx.createDynamicsCompressor();
    this.master.connect(this.duck);
    this.duck.connect(comp).connect(ctx.destination);

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
    g.gain.setValueAtTime(gain, ctx.currentTime);
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
    g.gain.setValueAtTime(gain, ctx.currentTime);
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
  radarAlert() { this._tone('sawtooth', 620, 480, 0.22, 0.09); }
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
  missileAlert() { this._tone('square', 950, 690, 0.16, 0.10); }
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

  update(dt, player, weapons) {
    if (!this.ctx || !this.enabled) return;
    // engine follows speed & throttle
    const s = Math.min(player.speed / 600, 1);
    const boosting = player.throttle > 0.82;
    const rpm = 46 + s * 70 + player.throttle * 26;
    this.oscA.frequency.value = rpm;
    this.oscB.frequency.value = rpm * 1.007 + 1.3;
    this.engFilter.frequency.value = 260 + s * 900 + (boosting ? 500 : 0);
    this.engGain.gain.value = 0.05 + player.throttle * 0.075 + (boosting ? 0.05 : 0);
    this.windFilter.frequency.value = 500 + s * 1400;
    this.windGain.gain.value = 0.02 + s * s * 0.14;

    // inbound alert tones (locks are instant now — no acquisition beeping)
    if (weapons) {
      if (weapons.inboundWarning || weapons.radarInbound) {
        this._alertT -= dt;
        if (this._alertT <= 0) {
          if (weapons.radarInbound && !weapons.inboundWarning) this.radarAlert();
          else this.missileAlert();
          this._alertT = weapons.radarInbound && !weapons.inboundWarning ? 0.5 : 0.42;
        }
      }
    }
  }
}
