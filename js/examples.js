// Example ship generator.
// Builds single-propulsion ships (atmospheric, hydrogen or ion) around a conveyor
// "spine", then adds thrusters on the outer surfaces in every direction until each
// direction meets its target, adds batteries to power them, and checks that the
// hydrogen thrusters are plumbed to the tank and the tank to the connector.
import { BLOCKS, faceCentreCell } from './data.js?v=20261107-3';
import { ROTS, applyRot, rotatedSize } from './rotations.js?v=20261107-3';
import { analyse } from './calc.js?v=20261107-3';
import { analyseConveyors, worldPorts } from './conveyor.js?v=20261107-3';

const ck = c => c.join(',');
const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const neg = a => [-a[0], -a[1], -a[2]];
const eq = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
const AX = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
const faceName = n => (n[0] ? (n[0] > 0 ? '+x' : '-x') : n[1] ? (n[1] > 0 ? '+y' : '-y') : (n[2] > 0 ? '+z' : '-z'));
const DIRV = { up: [0, 1, 0], down: [0, -1, 0], forward: [0, 0, -1], back: [0, 0, 1], left: [-1, 0, 0], right: [1, 0, 0] };

class NoRoom extends Error {}
class Builder {
  constructor(grid) { this.grid = grid; this.blocks = []; this.occ = new Map(); this.uid = 1; }
  def(key) { const d = BLOCKS[`${this.grid}_${key}`]; if (!d) throw new Error('no block ' + key + ' on ' + this.grid); return d; }
  cells(b, def) {
    const ws = rotatedSize(b.r, def.size), out = [];
    for (let x = 0; x < ws[0]; x++) for (let y = 0; y < ws[1]; y++) for (let z = 0; z < ws[2]; z++) out.push([b.p[0] + x, b.p[1] + y, b.p[2] + z]);
    return out;
  }
  tryAdd(key, p, r) {
    const def = this.def(key), b = { id: def.id, p, r, uid: this.uid++ };
    const cells = this.cells(b, def);
    if (cells.some(c => this.occ.has(ck(c)))) return null;
    cells.forEach(c => this.occ.set(ck(c), b.uid));
    this.blocks.push(b); b.def = def;
    return b;
  }
  remove(b) { this.blocks = this.blocks.filter(x => x !== b); for (const c of this.cells(b, b.def)) this.occ.delete(ck(c)); }
  /** world cell (with p = 0) of block-local cell lc under rotation r */
  l2w(def, r, lc) {
    const ws = rotatedSize(r, def.size);
    const l = [lc[0] + 0.5 - def.size[0] / 2, lc[1] + 0.5 - def.size[1] / 2, lc[2] + 0.5 - def.size[2] / 2];
    const w = applyRot(r, l);
    return [Math.round(ws[0] / 2 + w[0] - 0.5), Math.round(ws[1] / 2 + w[1] - 0.5), Math.round(ws[2] / 2 + w[2] - 0.5)];
  }
  /**
   * Attach block `key` against `anchor` (an occupied cell) on side F: the block's face that points back
   * toward the anchor (-F) is centred on anchor+F.
   * opts.thrust: required thrust direction; opts.port: 'L'|'S'|true → that face must carry a port (of that size).
   */
  attach(key, anchor, F, opts = {}) {
    const def = this.def(key);
    let rots = ROTS.map((_, i) => i);
    if (opts.thrust) rots = rots.filter(r => eq(applyRot(r, [0, 0, -1]), opts.thrust));
    if (opts.rot != null) rots = [opts.rot];
    const scored = [];
    for (const r of rots) {
      // local normal that maps to -F
      const ln = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]].find(n => eq(applyRot(r, n), neg(F)));
      const lc = faceCentreCell(faceName(ln), def.size);
      const port = (def.ports || []).find(pt => eq(pt.n, ln) && eq(pt.c, lc));
      if (opts.port && (!port || (opts.port !== true && port.s !== opts.port))) continue;
      scored.push({ r, lc, score: (port ? 0 : 10) + (r === 0 ? 0 : 1) });
    }
    scored.sort((a, b) => a.score - b.score);
    for (const s of scored) {
      const target = add3(anchor, F);
      const off = this.l2w(def, s.r, s.lc);
      const b = this.tryAdd(key, [target[0] - off[0], target[1] - off[1], target[2] - off[2]], s.r);
      if (b) return b;
    }
    return null;
  }
  /** cell of b's port whose world normal is F */
  portCell(b, F) {
    const p = worldPorts(b, b.def).find(q => eq(q.n, F));
    return p ? p.cell : null;
  }
  design(meta) {
    return { ...meta, grid: this.grid, blocks: this.blocks.map(b => ({ id: b.id, p: b.p, r: b.r })), customBlocks: {}, overrides: {} };
  }
}

// Thruster families per propulsion type ---------------------------------------
const FAMILY = {
  atmo: { large: 'AtmoL', small: 'AtmoS', name: 'Atmospheric' },
  hydrogen: { large: 'HydroL', small: 'HydroS', name: 'Hydrogen' },
  ion: { large: 'IonL', small: 'IonS', name: 'Ion' },
};

// Target acceleration per direction, in g (Up is on top of cancelling gravity → TWR).
function targets(g) {
  const space = Math.max(g, 0.5);
  return { up: Math.max(1.6 * g, 0.5), forward: 0.8 * space, back: 0.6 * space, down: 0.3 * space, left: 0.3 * space, right: 0.3 * space };
}

function envFor(spec) {
  const base = { planetId: spec.planet, g: spec.g, density: spec.density, invMult: 1, itemId: 'ore', customLPerKg: 0.37,
    fillPct: 100, fillMinor: false, extraMass: 0, targetTwr: 1.5, suggestDir: 'up' };
  return base;
}

function snapshot(B, meta) { return B.design(meta); }

/** Candidate thruster mounts for direction D (thrust toward D → thruster sits on the -D side). */
function mountCandidates(B, D, needPortSize, preferLow = false) {
  const F = neg(D);
  const cand = [];
  const ports = new Map();
  if (needPortSize) for (const b of B.blocks) for (const p of worldPorts(b, b.def)) ports.set(ck(p.cell) + '|' + p.n.join(), p);
  let cx = 0, cy = 0, cz = 0, n = 0;
  for (const k of B.occ.keys()) { const c = k.split(',').map(Number); cx += c[0]; cy += c[1]; cz += c[2]; n++; }
  const cen = [cx / n, cy / n, cz / n];
  const thrustCells = new Set();
  for (const b of B.blocks) if (b.def.thrust) for (const c of B.cells(b, b.def)) thrustCells.add(ck(c));
  for (const k of B.occ.keys()) {
    const s = k.split(',').map(Number);
    if (thrustCells.has(k)) continue;               // never mount on another thruster
    if (B.occ.has(ck(add3(s, F)))) continue;
    if (needPortSize) {
      const p = ports.get(ck(s) + '|' + F.join());
      if (!p || p.size !== needPortSize) continue;
    }
    const along = s[0] * F[0] + s[1] * F[1] + s[2] * F[2];
    const lat = Math.hypot(...[0, 1, 2].map(i => F[i] ? 0 : s[i] - cen[i]));
    cand.push({ s, along, lat });
  }
  cand.sort((a, b) => (preferLow ? a.along - b.along : b.along - a.along) || (a.lat - b.lat) || (a.s[0] - b.s[0]));
  return cand;
}

function buildShip(spec, margin) {
  const B = new Builder(spec.grid);
  const L = spec.grid === 'L';
  const u = L ? 1 : 3;
  const N = spec.spine;
  const elems = [];
  for (let i = 0; i < N; i++) elems.push(L ? B.tryAdd('ConvJunc', [0, 0, i], 0) : B.tryAdd('ConvHubSG', [-1, -1, 3 * i], 0));
  const centre = i => [0, 0, u * i + (u - 1) / 2];
  const face = (i, F) => add3(centre(i), F.map(v => v * (u - 1) / 2));
  const X = AX.x, Y = AX.y, Z = AX.z;

  // Cockpit at the front
  if (L) B.attach('CockpitLG', face(0, neg(Z)), neg(Z), { port: 'L' });
  else {
    const conv = B.attach('ConvConverter', face(0, neg(Z)), neg(Z), { port: 'L' });
    const sp = conv && B.portCell(conv, neg(Z));
    if (sp) B.attach('CockpitSG', sp, neg(Z), { port: 'S' });
  }
  // Cargo on the sides
  for (const [key, i, side] of spec.cargo) B.attach(key, face(i, side === '+' ? X : neg(X)), side === '+' ? X : neg(X), { port: 'L' });
  // Hydrogen tank on top, connector on the tank (or on the spine)
  let top = null;
  if (spec.type === 'hydrogen') top = B.attach(spec.tank, face(spec.tankAt, Y), Y, { port: 'L' });
  const conAnchor = top ? B.portCell(top, Y) : face(spec.connectorAt ?? 0, Y);
  const connector = conAnchor && B.attach('Connector', conAnchor, Y, { port: 'L' });
  if (!connector) B.attach('Connector', face(N - 1, Y), Y, { port: 'L' });

  // Mounting deck under the hull: conveyor junctions on hydrogen ships (so thrusters are plumbed), armour otherwise
  {
    let mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
    for (const k of B.occ.keys()) { const c = k.split(',').map(Number); for (let i = 0; i < 3; i++) { mn[i] = Math.min(mn[i], c[i]); mx[i] = Math.max(mx[i], c[i]); } }
    const deck = [];
    if (spec.type === 'hydrogen' && !L) {
      // small grid: tile large conveyor junctions (3x3x3) on the spine's 3-cell lattice, right under the spine
      const ax0 = Math.floor((mn[0] - margin) / 3), ax1 = Math.ceil((mx[0] + margin) / 3);
      for (let a = ax0; a <= ax1; a++) for (let z = Math.floor((mn[2] - margin) / 3); z <= Math.ceil((mx[2] + margin - 2) / 3); z++)
        { const b = B.tryAdd('ConvHubSG', [3 * a - 1, -4, 3 * z], 0); if (b) deck.push(b); }
    } else {
      const key = spec.type === 'hydrogen' ? 'ConvJunc' : 'LightArmor';
      for (let x = mn[0] - margin; x <= mx[0] + margin; x++) for (let z = mn[2] - margin; z <= mx[2] + margin; z++)
        { const b = B.tryAdd(key, [x, mn[1] - 1, z], 0); if (b) deck.push(b); }
    }
    if (spec.type === 'hydrogen') {
      // drop deck conveyors that ended up cut off from the ship's system
      const d = B.design({}); d.blocks.forEach((b, i) => b.uid = B.blocks[i].uid);
      let cv = analyseConveyors(d);
      // remove deck pieces whose large ports butt against small ports (would need converters)
      const bad = new Set(cv.ports.filter(p => p.status === 'mismatch').map(p => p.uid));
      for (const b of deck) if (bad.has(b.uid)) B.remove(b);
      const d2 = B.design({}); d2.blocks.forEach((b, i) => b.uid = B.blocks[i].uid);
      cv = analyseConveyors(d2);
      const main = cv.netOf.get(elems[0].uid);
      for (const b of deck) if (B.blocks.includes(b) && cv.netOf.get(b.uid) !== main) B.remove(b);
      B.deck = deck;
    }
  }

  const meta = { format: 'se-build-planner', version: 1, name: spec.name, type: 'ship', settings: envFor(spec), description: spec.description };
  const env = meta.settings;

  // Gyros and a starter battery on top surfaces (no ports needed)
  const addOnTop = key => {
    for (const c of mountCandidates(B, neg(Y), null, true)) { // free +Y faces, lowest first
      if (B.attach(key, c.s, Y)) return true;
    }
    return false;
  };
  const nGyro = spec.gyros;
  for (let i = 0; i < nGyro; i++) addOnTop('Gyro');
  addOnTop('Battery');

  const fam = FAMILY[spec.type];
  const isH2 = spec.type === 'hydrogen';
  const tgt = targets(env.g);
  for (let iter = 0; iter < 12; iter++) {
    let changed = false;
    for (const dir of ['up', 'forward', 'back', 'down', 'left', 'right']) {
      const D = DIRV[dir];
      for (let guard = 0; guard < 80; guard++) {
        const a = analyse(snapshot(B, meta), env);
        const r = a.dirs.find(x => x.id === dir);
        const need = tgt[dir] * 9.81 * a.loadedMass + (dir === 'up' ? 0 : 0);
        const have = dir === 'up' ? r.eff : r.eff;
        const req = dir === 'up' ? tgt.up * 9.81 * a.loadedMass : need;
        if (have >= req) break;
        const big = B.def(fam.large), small = B.def(fam.small);
        const deficit = req - have;
        const order = deficit > big.thrust.f * 0.45 && !spec.smallOnly ? [fam.large, fam.small] : [fam.small, fam.large];
        let placed = null;
        for (const key of order) {
          const d = B.def(key);
          const ps = isH2 ? d.ports[0].s : null;
          for (const c of mountCandidates(B, D, ps)) {
            placed = B.attach(key, c.s, neg(D), { thrust: D, port: ps || undefined });
            if (placed) break;
          }
          if (placed) break;
        }
        if (!placed) throw new NoRoom(dir);
        changed = true;
      }
    }
    // Power for electric thrusters: cover the hungriest direction + 20%
    for (let guard = 0; guard < 40; guard++) {
      const a = analyse(snapshot(B, meta), env);
      const needMW = Math.max(...a.dirs.map(r => r.powerMW)) * 1.2;
      if (a.pOut >= needMW) break;
      if (!addOnTop('Battery')) break;
      changed = true;
    }
    if (!changed) break;
  }
  // Prune dead-end deck conveyors that feed nothing
  if (B.deck) {
    const deckSet = new Set(B.deck.map(b => b.uid));
    for (let pass = 0; pass < 40; pass++) {
      const d = B.design({}); d.blocks.forEach((b, i) => b.uid = B.blocks[i].uid);
      const cv = analyseConveyors(d);
      const peers = new Map();
      for (const p of cv.ports) if (p.status === 'connected') { if (!peers.has(p.uid)) peers.set(p.uid, new Set()); peers.get(p.uid).add(p.peer); }
      let removed = 0;
      for (const b of [...B.blocks]) {
        if (!deckSet.has(b.uid)) continue;
        const pr = [...(peers.get(b.uid) || [])];
        const attachedToShip = pr.some(u => !deckSet.has(u));
        if (!attachedToShip && pr.length <= 1) { B.remove(b); deckSet.delete(b.uid); removed++; }
      }
      if (!removed) break;
    }
  }
  const d = B.design(meta);
  return d;
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------
const EARTH = { planet: 'earth', g: 1, density: 1 };
const MOON = { planet: 'moon', g: 0.25, density: 0 };

export const EXAMPLES = [
  // Large grid ---------------------------------------------------------------
  { id: 'lg-atmo-light', grid: 'L', type: 'atmo', ...EARTH, name: 'LG Atmo — planetary shuttle', spine: 3, gyros: 1,
    cargo: [['CargoS', 1, '+'], ['CargoS', 1, '-']], description: 'Atmospheric thrusters only, for EarthLike. Two small cargo containers.' },
  { id: 'lg-atmo-heavy', grid: 'L', type: 'atmo', ...EARTH, name: 'LG Atmo — heavy ore lifter', spine: 5, gyros: 2,
    cargo: [['CargoL', 2, '+'], ['CargoL', 2, '-']], description: 'Large atmospheric thrusters lifting two full large cargo containers of ore on EarthLike.' },
  { id: 'lg-h2-light', grid: 'L', type: 'hydrogen', ...EARTH, name: 'LG Hydrogen — utility hopper', spine: 3, gyros: 1,
    cargo: [['CargoS', 1, '+'], ['CargoS', 1, '-']], tank: 'H2TankS', tankAt: 1, description: 'Hydrogen only. Every thruster plumbed to the tank; the connector sits on the tank for refuelling.' },
  { id: 'lg-h2-heavy', grid: 'L', type: 'hydrogen', ...EARTH, name: 'LG Hydrogen — heavy hauler', gyros: 2,
    spine: 7, cargo: [['CargoL', 2, '+'], ['CargoL', 2, '-']], tank: 'H2Tank', tankAt: 5, description: 'Large hydrogen thrusters and a large tank; works on any planet or in space.' },
  { id: 'lg-ion-light', grid: 'L', type: 'ion', ...MOON, name: 'LG Ion — space courier', spine: 3, gyros: 1,
    cargo: [['CargoS', 1, '+'], ['CargoS', 1, '-']], description: 'Ion thrusters, battery powered. Sized for space and the Moon (no atmosphere).' },
  { id: 'lg-ion-heavy', grid: 'L', type: 'ion', ...MOON, name: 'LG Ion — space freighter', spine: 5, gyros: 2,
    cargo: [['CargoL', 2, '+'], ['CargoL', 2, '-']], description: 'Large ion thrusters; can land on the Moon fully loaded.' },
  // Small grid -------------------------------------------------------------------
  { id: 'sg-atmo-light', grid: 'S', type: 'atmo', ...EARTH, name: 'SG Atmo — scout', spine: 2, gyros: 2, smallOnly: true,
    cargo: [['CargoM', 1, '+']], description: 'Small-grid atmospheric flyer with one medium cargo container.' },
  { id: 'sg-atmo-heavy', grid: 'S', type: 'atmo', ...EARTH, name: 'SG Atmo — cargo hauler', spine: 3, gyros: 3,
    cargo: [['CargoL', 1, '+'], ['CargoL', 1, '-']], description: 'Two small-grid large cargo containers lifted by large atmospheric thrusters.' },
  { id: 'sg-h2-light', grid: 'S', type: 'hydrogen', ...EARTH, name: 'SG Hydrogen — hopper', spine: 2, gyros: 2,
    cargo: [['CargoM', 1, '+'], ['CargoM', 1, '-']], tank: 'H2Tank', tankAt: 1, description: 'Small-grid hydrogen ship; small thrusters use the cargo containers\' small ports, large ones the large conveyors.' },
  { id: 'sg-h2-heavy', grid: 'S', type: 'hydrogen', ...EARTH, name: 'SG Hydrogen — hauler', spine: 4, gyros: 3,
    cargo: [['CargoL', 1, '+'], ['CargoL', 1, '-']], tank: 'H2Tank', tankAt: 3, description: 'Small-grid large hydrogen thrusters fed through large conveyor junctions.' },
  { id: 'sg-ion-light', grid: 'S', type: 'ion', ...MOON, name: 'SG Ion — space fighter frame', spine: 2, gyros: 2, smallOnly: true,
    cargo: [['CargoM', 1, '+']], description: 'Small ion thrusters on every side for agile space flight.' },
  { id: 'sg-ion-heavy', grid: 'S', type: 'ion', ...MOON, name: 'SG Ion — space miner hauler', spine: 3, gyros: 3,
    cargo: [['CargoL', 1, '+'], ['CargoL', 1, '-']], description: 'Large small-grid ion thrusters moving two full cargo containers in space.' },
];

const cache = new Map();
export function buildExampleShip(id) {
  if (!cache.has(id)) {
    const spec = EXAMPLES.find(e => e.id === id);
    let d = null;
    for (let m = 1; m <= 8 && !d; m++) {
      try { d = buildShip(spec, m * (spec.grid === 'S' ? 2 : 1)); } catch (e) { if (!(e instanceof NoRoom)) throw e; }
    }
    cache.set(id, JSON.stringify(d));
  }
  return JSON.parse(cache.get(id));
}

export { analyseConveyors };
