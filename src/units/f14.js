// f14.js — optional external F-14 player model (assets/F14Tomcat.glb, exported
// from Blender with hinge pivots `surf_*` and effect anchors baked into the node
// tree). Mirrors the buildJet() interface: { group, anchors, afterburners,
// setControlSurfaces }. Returns null when the asset is missing/corrupt so the
// caller keeps the procedural jet as fallback.
import * as THREE from 'three';
import { GLTFLoader } from '../../vendor/GLTFLoader.js';

let pending = null;   // cached promise → model | null

export function loadF14() {
  if (!pending) {
    pending = new Promise((resolve) => {
      new GLTFLoader().load(
        'assets/F14Tomcat.glb',
        (gltf) => { try { resolve(build(gltf)); } catch (_) { resolve(null); } },
        undefined,
        () => resolve(null),
      );
    });
  }
  return pending;
}

function build(gltf) {
  // glTF export maps Blender -Y forward to +Z; the game flies nose -Z. The 180°
  // fixup lives on the INNER node: the outer wrapper is quaternion-driven by the
  // flight body every frame, so anything baked on it would be overwritten.
  const root = gltf.scene;
  root.rotation.y = Math.PI;
  const group = new THREE.Group();
  group.add(root);
  const byName = {};
  root.traverse(o => { byName[o.name] = o; o.frustumCulled = false; });

  const anchors = {
    nose: byName['anchor_nose'], wingL: byName['anchor_wingL'],
    wingR: byName['anchor_wingR'], tail: byName['anchor_tail'],
  };
  for (const k in anchors) if (!anchors[k]) throw new Error('f14: missing ' + k);

  // afterburner cones on the twin nozzles (same recipe as the procedural jet)
  const afterburners = [];
  for (const n of ['anchor_abL', 'anchor_abR']) {
    const a = byName[n];
    if (!a) continue;
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffa04c, transparent: true, opacity: 0.85,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    const ab = new THREE.Mesh(new THREE.ConeGeometry(0.45, 3.0, 8), mat);
    // cones live inside the flipped inner node: -Z_inner is "aft" in game space
    ab.rotation.x = -Math.PI / 2;                   // tip toward -Z_inner (aft)
    ab.position.set(a.position.x, a.position.y, a.position.z - 0.9);
    ab.visible = false;
    root.add(ab);
    afterburners.push(ab);
  }

  // Strip the baked `surf_*` hinge pivots and their panel meshes entirely —
  // the user wants the plain airframe, no separate control-surface pieces.
  // Interface symmetry: player.js calls setControlSurfaces only when present.
  for (const n of ['ailL', 'ailR', 'elevL', 'elevR', 'rudL', 'rudR']) {
    const pivot = byName['surf_' + n];
    if (pivot && pivot.parent) pivot.parent.remove(pivot);
  }

  return { group, anchors, afterburners };
}
