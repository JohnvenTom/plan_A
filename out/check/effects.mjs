// effects.js — pooled particle system: explosions, smoke, contrails, sparks
// Two Points layers: additive (fire/spark/flash) + alpha smoke. Seeded RNG keeps
// the ?t=N freeze harness reproducible.
import * as THREE from 'three';
import { mulberry32, lerp, clamp } from './utils.js';

const MAX_ADD = 1400, MAX_SMOKE = 1600;

const PT_VERT = /* glsl */`
attribute float size;
attribute vec4 pcolor;
varying vec4 vColor;
void main() {
  vColor = pcolor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = clamp(size * (620.0 / -mv.z), 1.0, 260.0);
  gl_Position = projectionMatrix * mv;
}`;

const PT_FRAG = /* glsl */`
precision highp float;
varying vec4 vColor;
uniform float uSoft;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, uSoft, d) * vColor.a;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor.rgb, a);
}`;

class ParticleLayer {
  constructor(scene, max, blending, soft) {
    this.max = max;
    this.list = [];
    this.geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 4);
    this.size = new Float32Array(max);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('pcolor', new THREE.BufferAttribute(this.col, 4));
    this.geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1));
    this.mat = new THREE.ShaderMaterial({
      vertexShader: PT_VERT, fragmentShader: PT_FRAG,
      transparent: true, depthWrite: false,
      blending, uniforms: { uSoft: { value: soft } },
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  push(p) {
    if (this.list.length >= this.max) this.list.shift();
    this.list.push(p);
  }

  update(dt) {
    const L = this.list;
    for (let i = L.length - 1; i >= 0; i--) {
      const p = L[i];
      p.age += dt;
      if (p.age >= p.life) { L.splice(i, 1); continue; }
      p.vel.multiplyScalar(Math.pow(p.drag, dt * 60));
      p.vel.y -= p.gravity * dt;
      p.pos.addScaledVector(p.vel, dt);
      if (p.turb) {
        p.pos.x += Math.sin(p.age * p.turb + p.seed * 37) * dt * p.turb * 2;
        p.pos.y += Math.cos(p.age * p.turb * 0.8 + p.seed * 91) * dt * p.turb;
      }
    }
    const n = L.length;
    for (let i = 0; i < n; i++) {
      const p = L[i];
      const t = p.age / p.life;
      this.pos[i * 3] = p.pos.x; this.pos[i * 3 + 1] = p.pos.y; this.pos[i * 3 + 2] = p.pos.z;
      this.col[i * 4] = lerp(p.c0[0], p.c1[0], t);
      this.col[i * 4 + 1] = lerp(p.c0[1], p.c1[1], t);
      this.col[i * 4 + 2] = lerp(p.c0[2], p.c1[2], t);
      this.col[i * 4 + 3] = lerp(p.a0, p.a1, t);
      this.size[i] = lerp(p.s0, p.s1, t);
    }
    for (let i = n; i < this.max; i++) { this.size[i] = 0; }
    this.geo.setDrawRange(0, n);
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.pcolor.needsUpdate = true;
    this.geo.attributes.size.needsUpdate = true;
  }
}

export class Effects {
  constructor(scene) {
    this.rng = mulberry32(0xC0FFEE);
    const V = () => new THREE.Vector3();
    this.add = new ParticleLayer(scene, MAX_ADD, THREE.AdditiveBlending, 0.02);
    this.smoke = new ParticleLayer(scene, MAX_SMOKE, THREE.NormalBlending, 0.12);
    this._v = V();
  }

  spawn(layer, o) {
    layer.push({
      pos: o.pos.clone(), vel: o.vel || new THREE.Vector3(),
      age: 0, life: o.life,
      c0: o.c0, c1: o.c1, a0: o.a0 ?? 1, a1: o.a1 ?? 0,
      s0: o.s0, s1: o.s1 ?? o.s0,
      drag: o.drag ?? 1, gravity: o.gravity ?? 0,
      turb: o.turb ?? 0, seed: this.rng(),
    });
  }

  explosion(pos, scale = 1) {
    const r = this.rng;
    // core flash
    this.spawn(this.add, {
      pos, life: 0.28, c0: [3.2, 2.6, 1.9], c1: [1.4, 0.5, 0.15],
      s0: 26 * scale, s1: 60 * scale,
    });
    // fireball
    for (let i = 0; i < 34; i++) {
      const v = new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize()
        .multiplyScalar((14 + r() * 42) * scale);
      this.spawn(this.add, {
        pos, vel: v, life: 0.5 + r() * 0.55, drag: 0.90, gravity: -4,
        c0: [2.6, 1.2, 0.35], c1: [0.55, 0.12, 0.03],
        s0: (7 + r() * 9) * scale, s1: (2 + r() * 3) * scale,
      });
    }
    // smoke
    for (let i = 0; i < 26; i++) {
      const v = new THREE.Vector3(r() - 0.5, r() * 0.55, r() - 0.5).normalize()
        .multiplyScalar((8 + r() * 26) * scale);
      this.spawn(this.smoke, {
        pos, vel: v, life: 1.6 + r() * 1.8, drag: 0.94, gravity: -2.2, turb: 2.4,
        c0: [0.16, 0.15, 0.15], c1: [0.28, 0.27, 0.27], a0: 0.62, a1: 0,
        s0: (8 + r() * 10) * scale, s1: (34 + r() * 26) * scale,
      });
    }
    // sparks
    for (let i = 0; i < 16; i++) {
      const v = new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize()
        .multiplyScalar((60 + r() * 150) * scale);
      this.spawn(this.add, {
        pos, vel: v, life: 0.4 + r() * 0.5, drag: 0.965, gravity: 60,
        c0: [3.0, 2.2, 0.9], c1: [1.2, 0.3, 0.05],
        s0: 2.4 * scale, s1: 0.4,
      });
    }
  }

  missileTrail(pos, vel) {
    this.spawn(this.smoke, {
      pos, vel, life: 1.9 + this.rng() * 0.5, drag: 0.92, gravity: -1.2, turb: 1.2,
      c0: [0.88, 0.86, 0.84], c1: [0.55, 0.54, 0.53], a0: 0.62, a1: 0,
      s0: 3.2, s1: 26,
    });
    this.spawn(this.add, {
      pos, life: 0.07, c0: [3.2, 1.9, 0.7], c1: [1.2, 0.5, 0.1], s0: 8, s1: 3,
    });
  }

  contrail(pos) {
    this.spawn(this.smoke, {
      pos, life: 1.9 + this.rng() * 0.5, drag: 1, turb: 0.5,
      c0: [0.95, 0.96, 1.0], c1: [0.8, 0.82, 0.86], a0: 0.34, a1: 0,
      s0: 1.6, s1: 7,
    });
  }

  damageSmoke(pos, vel, dark) {
    this.spawn(this.smoke, {
      pos, vel, life: 1.3 + this.rng() * 0.6, drag: 0.95, gravity: -3, turb: 2,
      c0: dark ? [0.08, 0.08, 0.08] : [0.2, 0.19, 0.18], c1: [0.3, 0.3, 0.3], a0: 0.55, a1: 0,
      s0: 2.5, s1: 16,
    });
  }

  hitSpark(pos) {
    for (let i = 0; i < 7; i++) {
      const v = new THREE.Vector3(this.rng() - 0.5, this.rng() - 0.5, this.rng() - 0.5)
        .normalize().multiplyScalar(35 + this.rng() * 90);
      this.spawn(this.add, {
        pos, vel: v, life: 0.18 + this.rng() * 0.22, drag: 0.95, gravity: 40,
        c0: [3.0, 2.3, 1.0], c1: [1.3, 0.4, 0.1], s0: 2.2, s1: 0.4,
      });
    }
  }

  gunTrailAir(pos) {   // airburst puff for missed gun rounds
    this.spawn(this.smoke, {
      pos, life: 0.5, c0: [0.6, 0.6, 0.62], c1: [0.5, 0.5, 0.52], a0: 0.25, a1: 0,
      s0: 1.5, s1: 5,
    });
  }

  flare(pos, vel) {
    // bright burning countermeasure: hot white-orange core that fades
    this.spawn(this.add, {
      pos, vel, life: 2.3, drag: 0.995, gravity: 22, turb: 1.2,
      c0: [4.0, 3.0, 1.8], c1: [1.6, 0.5, 0.15],
      s0: 4.2, s1: 1.4,
    });
    this.spawn(this.smoke, {
      pos, vel, life: 1.8, drag: 0.99, gravity: 14, turb: 1.5,
      c0: [0.55, 0.52, 0.48], c1: [0.4, 0.4, 0.4], a0: 0.3, a1: 0,
      s0: 1.8, s1: 9,
    });
  }

  update(dt) {
    this.add.update(dt);
    this.smoke.update(dt);
  }
}
