// Three.js geometry & mesh builders for blocks.
import * as THREE from './vendor/three.module.min.js';
import { CAT_COLORS, THRUSTER_TYPES } from './data.js';
import { ROTS, rotatedSize } from './rotations.js';

const h = 0.5;
// Convex polyhedron from vertex list + faces (any winding — fixed automatically).
function convex(verts, faces) {
  const c = verts.reduce((a, v) => [a[0] + v[0], a[1] + v[1], a[2] + v[2]], [0, 0, 0]).map(x => x / verts.length);
  const pos = [];
  const A = new THREE.Vector3(), Bv = new THREE.Vector3(), C = new THREE.Vector3(), n = new THREE.Vector3(), t = new THREE.Vector3();
  for (const f of faces) {
    for (let i = 1; i < f.length - 1; i++) {
      let a = verts[f[0]], b = verts[f[i]], cc = verts[f[i + 1]];
      A.fromArray(a); Bv.fromArray(b); C.fromArray(cc);
      n.subVectors(Bv, A).cross(t.subVectors(C, A));
      const toC = new THREE.Vector3().fromArray(c).sub(A);
      if (n.dot(toC) > 0) [b, cc] = [cc, b];
      pos.push(...a, ...b, ...cc);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

const SHAPES = {
  cube: () => new THREE.BoxGeometry(1, 1, 1),
  // Full bottom & back (+Z) faces; slope rises from front-bottom to back-top.
  slope: () => convex(
    [[-h,-h,-h],[h,-h,-h],[h,-h,h],[-h,-h,h],[-h,h,h],[h,h,h]],
    [[0,1,2,3],[3,2,5,4],[0,1,5,4],[0,3,4],[1,2,5]]),
  corner: () => convex(
    [[h,-h,h],[-h,-h,h],[h,-h,-h],[h,h,h]],
    [[0,1,2],[0,1,3],[0,2,3],[1,2,3]]),
  invcorner: () => convex(
    [[-h,-h,-h],[h,-h,-h],[h,-h,h],[-h,-h,h],[h,h,-h],[h,h,h],[-h,h,h]],
    [[0,1,2,3],[1,4,5,2],[3,2,5,6],[0,1,4],[0,3,6],[4,5,6],[0,4,6]]),
};

const geoCache = new Map();
function cached(key, fn) { if (!geoCache.has(key)) geoCache.set(key, fn()); return geoCache.get(key); }
const matCache = new Map();
export function mat(color, opts = {}) {
  const k = color + JSON.stringify(opts);
  if (!matCache.has(k)) matCache.set(k, new THREE.MeshStandardMaterial({ color, roughness: 0.65, metalness: 0.25, ...opts }));
  return matCache.get(k);
}
const edgeMat = new THREE.LineBasicMaterial({ color: 0x0d1117, transparent: true, opacity: 0.55 });

export function blockColor(def, b) {
  if (b && b.color != null) return b.color;
  if (def.thrust) return THRUSTER_TYPES[def.thrust.type].color;
  if (def.cat === 'armor') return def.heavy ? 0x6e7681 : 0xb1bac4;
  return CAT_COLORS[def.cat] ?? 0x8b949e;
}

/**
 * Build a THREE.Group for a block. Group origin = block centre in world (cell units × cellSize).
 * @param def  block definition
 * @param b    placed block {p,r,color}
 * @param cell cell size in metres (we render in cell units scaled by `cell`)
 */
export function buildBlockObject(def, b, cell, { ghost = false, ghostOk = true } = {}) {
  const grp = new THREE.Group();
  const [sx, sy, sz] = def.size;
  const color = blockColor(def, b);
  const m = ghost
    ? new THREE.MeshStandardMaterial({ color: ghostOk ? color : 0xff4444, transparent: true, opacity: 0.45, depthWrite: false })
    : mat(color);
  const inner = new THREE.Group(); // local block space (cells), rotated
  const shape = def.shape || 'box';

  const addEdges = (geo, obj) => {
    if (ghost) return;
    const eg = cached('e:' + geo.uuid, () => new THREE.EdgesGeometry(geo, 20));
    const l = new THREE.LineSegments(eg, edgeMat);
    l.position.copy(obj.position); l.scale.copy(obj.scale); l.rotation.copy(obj.rotation);
    l.raycast = () => {};
    inner.add(l);
  };

  if (SHAPES[shape]) {
    const geo = cached(shape, SHAPES[shape]);
    const mesh = new THREE.Mesh(geo, m);
    mesh.scale.set(sx, sy, sz);
    inner.add(mesh); addEdges(geo, mesh);
  } else if (shape === 'thruster') {
    // Body occupies front 60% of length, nozzle bell the rear 40% (+Z side)
    const bodyLen = sz * 0.62, nozLen = sz - bodyLen;
    const box = cached('box', SHAPES.cube);
    const body = new THREE.Mesh(box, m);
    body.scale.set(sx * 0.96, sy * 0.96, bodyLen);
    body.position.z = -sz / 2 + bodyLen / 2;
    inner.add(body); addEdges(box, body);
    const r = Math.min(sx, sy) * 0.46;
    const ng = cached('noz', () => new THREE.CylinderGeometry(0.28, 0.5, 1, 20, 1, true));
    const noz = new THREE.Mesh(ng, ghost ? m : mat(0x30363d, { side: THREE.DoubleSide, metalness: 0.6 }));
    noz.rotation.x = Math.PI / 2; // cylinder axis Y → Z; wide end toward +Z
    noz.scale.set(r * 2, nozLen, r * 2);
    noz.position.z = sz / 2 - nozLen / 2;
    inner.add(noz);
    if (!ghost) {
      const glow = new THREE.Mesh(cached('disc', () => new THREE.CircleGeometry(0.5, 20)),
        mat(color, { emissive: color, emissiveIntensity: 0.8, side: THREE.DoubleSide }));
      glow.scale.set(r * 1.7, r * 1.7, 1);
      glow.position.z = sz / 2 - nozLen * 0.85;
      inner.add(glow);
    }
  } else if (shape === 'tank') {
    const box = cached('box', SHAPES.cube);
    const cg = cached('cyl', () => new THREE.CylinderGeometry(0.5, 0.5, 1, 24));
    const cyl = new THREE.Mesh(cg, m);
    cyl.scale.set(sx * 0.92, sy * 0.98, sz * 0.92);
    inner.add(cyl);
    const frame = new THREE.Mesh(box, ghost ? m : mat(0x484f58));
    frame.scale.set(sx, sy * 0.12, sz);
    frame.position.y = -sy / 2 + sy * 0.06;
    inner.add(frame); addEdges(box, frame);
    const frame2 = frame.clone(); frame2.position.y = sy / 2 - sy * 0.06; inner.add(frame2);
  } else {
    const box = cached('box', SHAPES.cube);
    const mesh = new THREE.Mesh(box, m);
    mesh.scale.set(sx * 0.98, sy * 0.98, sz * 0.98);
    inner.add(mesh); addEdges(box, mesh);
    if (!ghost) {
      // "front" marker on local -Z face
      const plate = new THREE.Mesh(cached('plane', () => new THREE.PlaneGeometry(1, 1)),
        mat(0xf0f6fc, { emissive: 0x58a6ff, emissiveIntensity: 0.25, side: THREE.DoubleSide }));
      plate.scale.set(Math.min(sx, 1) * 0.5, Math.min(sy, 1) * 0.25, 1);
      plate.position.set(0, sy * 0.2, -sz / 2 * 0.98 - 0.01);
      plate.rotation.y = Math.PI;
      plate.raycast = () => {};
      inner.add(plate);
    }
  }

  // Orientation
  const R = ROTS[b.r];
  const m4 = new THREE.Matrix4().set(R[0], R[1], R[2], 0, R[3], R[4], R[5], 0, R[6], R[7], R[8], 0, 0, 0, 0, 1);
  inner.quaternion.setFromRotationMatrix(m4);
  grp.add(inner);

  const ws = rotatedSize(b.r, def.size);
  grp.position.set((b.p[0] + ws[0] / 2) * cell, (b.p[1] + ws[1] / 2) * cell, (b.p[2] + ws[2] / 2) * cell);
  grp.scale.setScalar(cell);
  return grp;
}

export function makeArrow(from, dir, len, color) {
  return new THREE.ArrowHelper(new THREE.Vector3(...dir).normalize(), from, len, color, len * 0.3, len * 0.18);
}

export { THREE };
