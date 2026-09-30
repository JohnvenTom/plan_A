// jet.js — procedural fighter built from primitives (no external assets)
// Scale: ~18 m long, ~13 m wingspan. Anchors exposed for contrails/smoke/muzzle.
// Convention: nose points toward -Z (three.js "forward"), consistent with the
// quaternion flight model in player.js.
import * as THREE from 'three';
import { clamp } from './utils.js';

// Planform polygon in (x = spanwise, y = longitudinal(world z)), extruded flat.
function extrudedPart(points, thickness, mat) {
  const s = new THREE.Shape();
  s.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) s.lineTo(points[i][0], points[i][1]);
  s.closePath();
  const geo = new THREE.ExtrudeGeometry(s, {
    depth: thickness, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.08, bevelSegments: 1,
  });
  geo.rotateX(Math.PI / 2); // shape XY -> world XZ (thickness hangs below)
  return new THREE.Mesh(geo, mat);
}

export function buildJet(opts = {}) {
  const paint = new THREE.Color(opts.paint ?? 0x9aa7b6);
  const accent = new THREE.Color(opts.accent ?? 0x3a5f8f);

  // DoubleSide: mirrored halves use negative scale.x, which flips winding
  const DS = THREE.DoubleSide;
  const bodyMat = new THREE.MeshStandardMaterial({ color: paint, roughness: 0.55, metalness: 0.35, flatShading: true, side: DS });
  const accentMat = new THREE.MeshStandardMaterial({ color: accent, roughness: 0.5, metalness: 0.4, flatShading: true, side: DS });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x232830, roughness: 0.7, metalness: 0.3, flatShading: true, side: DS });
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x0c1622, roughness: 0.12, metalness: 0.85, flatShading: true, side: DS,
    emissive: 0x1a2c40, emissiveIntensity: 0.6,
  });

  const g = new THREE.Group();

  // --- fuselage: tapered, slightly flattened cylinder ---
  const fus = new THREE.Mesh(new THREE.CylinderGeometry(0.88, 0.66, 12.5, 10, 1), bodyMat);
  fus.rotation.x = Math.PI / 2;
  fus.scale.set(1, 1, 0.74);
  fus.position.z = 0.4;
  g.add(fus);

  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.86, 4.6, 10), bodyMat);
  nose.rotation.x = -Math.PI / 2;   // tip toward -Z
  nose.scale.set(1, 1, 0.74);
  nose.position.z = -8.4;
  g.add(nose);

  // dorsal spine
  const spine = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.5, 8.2), accentMat);
  spine.position.set(0, 0.58, 2.6);
  g.add(spine);

  // --- canopy ---
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.78, 12, 8), glassMat);
  canopy.scale.set(0.9, 0.72, 2.3);
  canopy.position.set(0, 0.68, -4.1);
  g.add(canopy);

  // --- main delta wings (both halves via mirror) ---
  const wingPts = [[1.0, 3.1], [6.4, -1.8], [6.8, -3.0], [1.0, -2.6]];
  const stripePts = [[1.2, 3.0], [6.2, -1.7], [6.2, -2.0], [1.2, 2.7]];
  for (const side of [1, -1]) {
    const w = extrudedPart(wingPts, 0.34, bodyMat);
    w.scale.x = side;
    w.position.set(0, -0.1, 0.2);
    w.rotation.z = side * 0.04;
    g.add(w);
    const stripe = extrudedPart(stripePts, 0.37, accentMat);
    stripe.scale.x = side;
    stripe.position.set(0, -0.1, 0.2);
    stripe.rotation.z = side * 0.04;
    g.add(stripe);
  }

  // --- canards ---
  for (const side of [1, -1]) {
    const c = extrudedPart([[0.9, 0.1], [2.9, -1.3], [2.9, -1.7], [0.9, -1.1]], 0.22, bodyMat);
    c.scale.x = side;
    c.position.set(0, 0.1, -4.8);
    g.add(c);
  }

  // --- articulated control surfaces (sculptor Action branch: hinge pivots) ---
  // Each surface: an Object3D pivot at the hinge line, mesh child offset aft,
  // yaw-aligned to the local trailing edge. setControlSurfaces() drives them.
  const surfaces = {};
  const hinge = (name, x, y, z, yaw, len, chord, mat) => {
    const pivot = new THREE.Object3D();
    pivot.name = 'surf_' + name;
    pivot.position.set(x, y, z);
    pivot.rotation.y = yaw;
    const m = new THREE.Mesh(new THREE.BoxGeometry(len, 0.085, chord), mat);
    m.position.set(0, 0, chord / 2 + 0.03);
    pivot.add(m);
    g.add(pivot);
    surfaces[name] = { pivot, angle: 0 };
  };
  for (const side of [1, -1]) {
    const S = side > 0 ? 'R' : 'L';   // +X is the right wing (nose = -Z)
    // ailerons on the outer wing trailing edge (swept ~42 deg)
    hinge('ail' + S, side * 4.9, -0.1, -0.37, side > 0 ? 0.74 : Math.PI - 0.74, 2.0, 0.62, darkMat);
    // all-moving stabilator trailing edge
    hinge('elev' + S, side * 1.7, 0.06, 4.05, side > 0 ? 0.04 : Math.PI - 0.04, 1.9, 0.5, bodyMat);
    // canard flaps
    hinge('can' + S, side * 1.9, 0.1, -6.25, side > 0 ? 0.29 : Math.PI - 0.29, 1.8, 0.42, bodyMat);
  }

  // hydraulic-feel deflection toward commanded angles (called by player each frame)
  let surfState = { roll: 0, pitch: 0, yaw: 0 };
  const setControlSurfaces = (ctl) => {
    surfState.roll += (clamp(ctl.roll, -1, 1) - surfState.roll) * 0.28;
    surfState.pitch += (clamp(ctl.pitch, -1, 1) - surfState.pitch) * 0.28;
    surfState.yaw += (clamp(ctl.yaw, -1, 1) - surfState.yaw) * 0.28;
    const r = surfState.roll, p = surfState.pitch, y = surfState.yaw;
    const set = (name, target) => {
      const s = surfaces[name];
      s.angle += (target - s.angle) * 0.35;
      s.pivot.rotation.x = s.angle;
    };
    set('ailL', -0.5 * r);   // roll left: left aileron up, right down
    set('ailR', 0.5 * r);
    set('elevL', -0.38 * p); // pitch up: elevators TE up
    set('elevR', -0.38 * p);
    set('canL', 0.45 * p);   // canards deflect opposite
    set('canR', 0.45 * p);
    for (const rp of rudPivots) rp.rotation.x = -0.5 * y;   // yaw input: rudders swing
  };

  // --- horizontal stabilizers ---
  for (const side of [1, -1]) {
    const st = extrudedPart([[0.6, 0.5], [3.1, -1.2], [3.1, -1.8], [0.6, -1.6]], 0.24, bodyMat);
    st.scale.x = side;
    st.position.set(0, 0.06, 5.7);
    g.add(st);
  }

  // --- twin canted vertical tails: fin built standing in (height=x, chord=z),
  //     stood up by rotZ, mirrored half inside a flipped group ---
  const finPts = [[0.3, 5.6], [2.8, 2.9], [3.05, 2.3], [0.3, 2.2]];
  const rudPivots = [];
  for (const side of [1, -1]) {
    const fin = extrudedPart(finPts, 0.18, accentMat);
    fin.rotation.z = Math.PI / 2 - 0.30;   // stand up, cant outward
    // rudder: hinged panel on the fin's trailing edge (child of the fin so it
    // inherits the cant), rotating about the fin's height axis
    const rud = new THREE.Object3D();
    rud.name = 'surf_rud';
    rud.position.set(1.9, 0, 4.35);
    const rudPanel = new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.09, 0.42), darkMat);
    rudPanel.position.set(0, 0, 0.23);
    rud.add(rudPanel);
    fin.add(rud);
    rudPivots.push(rud);
    const holder = new THREE.Group();
    holder.add(fin);
    holder.scale.x = side;
    holder.position.set(side * 1.3, 0.45, 0);
    g.add(holder);
  }

  // --- engines + afterburner cones ---
  const afterburners = [];
  for (const side of [1, -1]) {
    const nz = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.42, 1.6, 8), darkMat);
    nz.rotation.x = Math.PI / 2;
    nz.position.set(side * 0.62, 0.0, 6.7);
    g.add(nz);

    const abMat = new THREE.MeshBasicMaterial({
      color: 0xffa04c, transparent: true, opacity: 0.85,
      blending: THREE.AdditiveBlending, depthWrite: false, side: DS,
    });
    const ab = new THREE.Mesh(new THREE.ConeGeometry(0.36, 3.4, 8), abMat);
    ab.rotation.x = Math.PI / 2;    // tip toward +Z (exhaust behind)
    ab.position.set(side * 0.62, 0.0, 9.2);
    ab.visible = false;
    g.add(ab);
    afterburners.push(ab);
  }

  // --- side intakes ---
  for (const side of [1, -1]) {
    const intake = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.8, 4.2), darkMat);
    intake.position.set(side * 1.3, -0.3, -1.2);
    g.add(intake);
  }

  // --- anchors for effects ---
  const mk = (x, y, z) => {
    const o = new THREE.Object3D();
    o.position.set(x, y, z);
    g.add(o);
    return o;
  };
  const anchors = {
    nose: mk(0, 0, -9.5),
    wingL: mk(6.6, -0.1, -1.6),
    wingR: mk(-6.6, -0.1, -1.6),
    tail: mk(0, 0, 7.8),
  };

  g.traverse(o => { o.frustumCulled = false; });
  return { group: g, anchors, afterburners, setControlSurfaces };
}
