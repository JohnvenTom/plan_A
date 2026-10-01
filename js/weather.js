// weather.js — eight-state weather machine with smooth transitions, camera-
// wrapped rain streaks, and storm lightning. Applies itself to the sky
// (cloud coverage/alpha, fog multiplier, light dimming) every frame.
import * as THREE from 'three';
import { clamp, smoothstep } from './utils.js';

const STATES = {
  clear:    { name: '晴',   thresh: 0.55, alpha: 0.85, fogMul: 1.0, dim: 1.00, gray: 0.00, rain: 0.0, wind: 1.0, w: 35 },
  cloudy:   { name: '多云', thresh: 0.47, alpha: 0.95, fogMul: 1.3, dim: 0.90, gray: 0.25, rain: 0.0, wind: 1.5, w: 25 },
  overcast: { name: '阴',   thresh: 0.40, alpha: 1.00, fogMul: 1.8, dim: 0.78, gray: 0.50, rain: 0.3, wind: 1.9, w: 18 },
  rain:     { name: '雨',   thresh: 0.34, alpha: 1.00, fogMul: 2.4, dim: 0.66, gray: 0.70, rain: 1.0, wind: 2.5, w: 14 },
  storm:    { name: '雷暴', thresh: 0.30, alpha: 1.00, fogMul: 3.0, dim: 0.52, gray: 0.85, rain: 1.0, wind: 3.4, w: 8 },
  drizzle:  { name: '毛毛雨', thresh: 0.50, alpha: 0.92, fogMul: 2.0, dim: 0.85, gray: 0.40, rain: 0.45, wind: 1.6, w: 12 },
  fog:      { name: '浓雾', thresh: 0.62, alpha: 0.75, fogMul: 5.5, dim: 0.62, gray: 0.55, rain: 0.0, wind: 0.7, w: 10 },
  gale:     { name: '狂风', thresh: 0.42, alpha: 0.90, fogMul: 1.5, dim: 0.80, gray: 0.35, rain: 0.35, wind: 6.5, w: 9 },
};
const RAIN_COUNT = 700;
const BOX = { x: 260, y: 150, z: 260 };

export class Weather {
  constructor(scene, sky, renderer) {
    this.scene = scene;
    this.sky = sky;
    this.renderer = renderer;
    this.keys = Object.keys(STATES);
    this.onChange = null;   // main wires this to the HUD announcer
    this.state = 'clear';
    this.target = { ...STATES.clear };
    this.cur = { ...STATES.clear };
    this.timer = 40 + Math.random() * 40;
    this.flash = 0;
    this.nextBolt = 4 + Math.random() * 6;
    this.baseExposure = renderer.toneMappingExposure;

    // rain streaks: LineSegments wrapped around the camera
    const pos = new Float32Array(RAIN_COUNT * 6);
    this.dropVel = [];
    for (let i = 0; i < RAIN_COUNT; i++) this.dropVel.push(new THREE.Vector3());
    this.rainGeo = new THREE.BufferGeometry();
    this.rainGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.rainMat = new THREE.LineBasicMaterial({
      color: 0xa8c0d8, transparent: true, opacity: 0, depthWrite: false,
    });
    this.rain = new THREE.LineSegments(this.rainGeo, this.rainMat);
    this.rain.frustumCulled = false;
    this.rain.visible = false;
    scene.add(this.rain);
    this.rainPos = new Float32Array(RAIN_COUNT * 3);
    for (let i = 0; i < RAIN_COUNT; i++) this.respawnDrop(i, null);
  }

  respawnDrop(i, camera) {
    const c = camera ? camera.position : { x: 0, y: 2000, z: 0 };
    this.rainPos[i * 3] = c.x + (Math.random() - 0.5) * 2 * BOX.x;
    this.rainPos[i * 3 + 1] = c.y + Math.random() * BOX.y - BOX.y * 0.2;
    this.rainPos[i * 3 + 2] = c.z + (Math.random() - 0.5) * 2 * BOX.z;
  }

  force(name) {
    if (!STATES[name]) return;
    this.state = name;
    this.target = { ...STATES[name] };
    this.timer = 120;   // hold for tests
  }

  get name() { return STATES[this.state].name; }

  pickNext() {
    let total = 0;
    for (const k of this.keys) total += STATES[k].w;
    let r = Math.random() * total;
    for (const k of this.keys) {
      r -= STATES[k].w;
      if (r <= 0) return k;
    }
    return 'clear';
  }

  update(dt, camera) {
    // state machine
    this.timer -= dt;
    if (this.timer <= 0) {
      this.state = this.pickNext();
      this.target = { ...STATES[this.state] };
      this.timer = 90 + Math.random() * 120;
      if (this.onChange) this.onChange(STATES[this.state].name);
    }
    // smooth transition toward the target parameters
    const k = 1 - Math.exp(-dt / 9);
    for (const p of ['thresh', 'alpha', 'fogMul', 'dim', 'gray', 'rain', 'wind']) {
      this.cur[p] += (this.target[p] - this.cur[p]) * k;
    }

    // apply to the sky
    const sm = this.sky;
    if (sm.cloudMats) {
      for (const m of sm.cloudMats) {
        m.uniforms.uThreshold.value = m.uniforms.uScale.value > 5
          ? this.cur.thresh : this.cur.thresh + 0.06;
        m.uniforms.uAlpha.value = this.cur.alpha * (m.uniforms.uScale.value > 5 ? 1 : 0.7);
        m.uniforms.uDrift.value = 0.0035 * this.cur.wind;
      }
    }
    // sky.setCycle reads this object as "weather"
    sm.weatherParams = this.cur;

    // lightning during storms
    if (this.state === 'storm' && this.cur.rain > 0.8) {
      this.nextBolt -= dt;
      if (this.nextBolt <= 0) {
        this.nextBolt = 3 + Math.random() * 7;
        this.flash = 1;
      }
    }
    if (this.flash > 0) {
      this.flash = Math.max(0, this.flash - dt / 0.16);
      this.renderer.toneMappingExposure = this.baseExposure + this.flash * this.flash * 1.5;
    } else {
      this.renderer.toneMappingExposure = this.baseExposure;
    }

    // rain streaks
    const raining = this.cur.rain > 0.05;
    this.rain.visible = raining;
    this.rainMat.opacity = 0.32 * this.cur.rain;
    if (raining) {
      const c = camera.position;
      const wy = -95, wx = 16 * this.cur.wind, wz = 7;
      const posAttr = this.rainGeo.attributes.position;
      const arr = posAttr.array;
      for (let i = 0; i < RAIN_COUNT; i++) {
        const v = this.dropVel[i];
        let x = this.rainPos[i * 3] + wx * dt;
        let y = this.rainPos[i * 3 + 1] + wy * dt;
        let z = this.rainPos[i * 3 + 2] + wz * dt;
        if (y < c.y - BOX.y * 0.6 || Math.abs(x - c.x) > BOX.x || Math.abs(z - c.z) > BOX.z) {
          this.respawnDrop(i, camera);
          x = this.rainPos[i * 3]; y = this.rainPos[i * 3 + 1]; z = this.rainPos[i * 3 + 2];
        } else {
          this.rainPos[i * 3] = x; this.rainPos[i * 3 + 1] = y; this.rainPos[i * 3 + 2] = z;
        }
        // streak segment: current point + short line along the fall velocity
        arr[i * 6] = x; arr[i * 6 + 1] = y; arr[i * 6 + 2] = z;
        arr[i * 6 + 3] = x - wx * 0.14; arr[i * 6 + 4] = y - wy * 0.14; arr[i * 6 + 5] = z - wz * 0.14;
      }
      posAttr.needsUpdate = true;
    }
  }
}
