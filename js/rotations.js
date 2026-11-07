// 24 axis-aligned rotation matrices (row-major 3x3 integer arrays).
// Index 0 is identity. Matrices map block-local vectors to ship/world vectors.

function mul(a, b) {
  const r = new Array(9).fill(0);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return r;
}
const RX = [1, 0, 0, 0, 0, -1, 0, 1, 0];   // +90° about X
const RY = [0, 0, 1, 0, 1, 0, -1, 0, 0];   // +90° about Y
const RZ = [0, -1, 0, 1, 0, 0, 0, 0, 1];   // +90° about Z
const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export const ROTS = [];
const key = (m) => m.join(',');
const seen = new Map();
(function build() {
  const queue = [I];
  seen.set(key(I), 0); ROTS.push(I);
  while (queue.length) {
    const m = queue.shift();
    for (const g of [RX, RY, RZ]) {
      const n = mul(g, m);
      const k = key(n);
      if (!seen.has(k)) { seen.set(k, ROTS.length); ROTS.push(n); queue.push(n); }
    }
  }
})();

export function rotIndex(m) { return seen.get(key(m)); }

/** Rotate the orientation `idx` by +/-90° about a world axis ('x'|'y'|'z'). */
export function rotateAbout(idx, axis, dir = 1) {
  let g = axis === 'x' ? RX : axis === 'y' ? RY : RZ;
  if (dir < 0) g = mul(g, mul(g, g)); // -90° = 3 × +90°
  return rotIndex(mul(g, ROTS[idx]));
}

/** Mirror an orientation across the plane normal to `axis`: R' = S R S. */
export function mirrorRot(idx, axis) {
  const s = axis === 'x' ? [-1, 0, 0, 0, 1, 0, 0, 0, 1]
          : axis === 'y' ? [1, 0, 0, 0, -1, 0, 0, 0, 1]
          : [1, 0, 0, 0, 1, 0, 0, 0, -1];
  return rotIndex(mul(s, mul(ROTS[idx], s)));
}

export function applyRot(idx, v) {
  const m = ROTS[idx];
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/** World-space dimensions (in cells) of a block of local size `s` under rotation idx. */
export function rotatedSize(idx, s) {
  const v = applyRot(idx, s);
  return v.map(Math.abs);
}
