// Conveyor network analysis.
//  - Ports connect when two blocks have ports on touching faces, facing each other.
//  - Large ↔ large and small ↔ small connect. Large ↔ small does NOT connect: a Conveyor Converter is needed.
//  - Gas (hydrogen/oxygen), ore and ingots travel through any connection.
//    Components and large items only travel through LARGE connections.
import { getDef } from './calc.js?v=20261107-5';
import { applyRot, rotatedSize } from './rotations.js?v=20261107-5';

const ck = (c) => c[0] + ',' + c[1] + ',' + c[2];

class UF {
  constructor() { this.p = new Map(); }
  find(a) { if (!this.p.has(a)) this.p.set(a, a); let r = a; while (this.p.get(r) !== r) r = this.p.get(r);
    while (this.p.get(a) !== r) { const n = this.p.get(a); this.p.set(a, r); a = n; } return r; }
  union(a, b) { const x = this.find(a), y = this.find(b); if (x !== y) this.p.set(x, y); }
}

/** World-space upgrade-module attachment points of a placed block. */
export function worldUpgradePoints(b, def) {
  if (!def.upgrade || !def.upgrade.length) return [];
  return worldPorts(b, { ...def, ports: def.upgrade.map(p => ({ ...p, s: 'U' })) });
}

/** World-space ports of a placed block. */
export function worldPorts(b, def) {
  if (!def.ports || !def.ports.length) return [];
  const ws = rotatedSize(b.r, def.size);
  const cen = [b.p[0] + ws[0] / 2, b.p[1] + ws[1] / 2, b.p[2] + ws[2] / 2];
  return def.ports.map(pt => {
    const lc = [pt.c[0] + 0.5 - def.size[0] / 2, pt.c[1] + 0.5 - def.size[1] / 2, pt.c[2] + 0.5 - def.size[2] / 2];
    const w = applyRot(b.r, lc);
    return {
      cell: [Math.round(cen[0] + w[0] - 0.5), Math.round(cen[1] + w[1] - 0.5), Math.round(cen[2] + w[2] - 0.5)],
      n: applyRot(b.r, pt.n), size: pt.s,
    };
  });
}

const ROLE_NAMES = {
  cargo: 'Cargo container', connector: 'Connector', h2tank: 'Hydrogen tank', o2tank: 'Oxygen tank', gasgen: 'O2/H2 generator',
  h2user: 'Hydrogen engine', h2thrust: 'Hydrogen thruster', reactor: 'Reactor', cockpit: 'Cockpit', drill: 'Drill',
  welder: 'Welder', grinder: 'Grinder', collector: 'Collector', refinery: 'Refinery', assembler: 'Assembler', weapon: 'Weapon', chute: 'Parachute',
};
const INVENTORY_ROLES = new Set(['cargo', 'connector', 'reactor', 'cockpit', 'drill', 'welder', 'grinder', 'collector', 'refinery', 'assembler', 'gasgen', 'weapon', 'chute']);
// Blocks that move components or large items and so need a LARGE route to the cargo
const NEEDS_LARGE = new Set(['assembler', 'welder', 'grinder', 'connector', 'collector']);

export function analyseConveyors(design) {
  const blocks = [], occ = new Map(), portMap = new Map();
  for (const b of design.blocks) {
    const def = getDef(design, b.id); if (!def) continue;
    const ws = rotatedSize(b.r, def.size);
    for (let x = 0; x < ws[0]; x++) for (let y = 0; y < ws[1]; y++) for (let z = 0; z < ws[2]; z++)
      occ.set(ck([b.p[0] + x, b.p[1] + y, b.p[2] + z]), b.uid);
    const ports = worldPorts(b, def);
    blocks.push({ b, def, ports });
    for (const p of ports) { p.uid = b.uid; portMap.set(ck(p.cell) + '|' + p.n.join(','), p); }
  }

  const all = new UF(), large = new UF();
  const portBlocks = blocks.filter(x => x.ports.length);
  for (const x of portBlocks) { all.find(x.b.uid); large.find(x.b.uid); }
  const mismatches = [];
  for (const x of portBlocks) {
    for (const p of x.ports) {
      const nb = [p.cell[0] + p.n[0], p.cell[1] + p.n[1], p.cell[2] + p.n[2]];
      const q = portMap.get(ck(nb) + '|' + p.n.map(v => -v).join(','));
      if (q && q.uid !== p.uid) {
        p.peer = q.uid;
        if (q.size === p.size) {
          p.status = 'connected';
          all.union(p.uid, q.uid);
          if (p.size === 'L') large.union(p.uid, q.uid);
        } else {
          p.status = 'mismatch';
          if (p.size === 'L') mismatches.push([p.uid, q.uid]);
        }
      } else if (occ.has(ck(nb)) && occ.get(ck(nb)) !== p.uid) p.status = 'blocked';
      else p.status = 'open';
    }
  }

  // Networks (components of the "all" graph)
  const netIdx = new Map(); const networks = [];
  for (const x of portBlocks) {
    const r = all.find(x.b.uid);
    if (!netIdx.has(r)) { netIdx.set(r, networks.length); networks.push({ id: networks.length, uids: [], roles: {} }); }
    const n = networks[netIdx.get(r)];
    n.uids.push(x.b.uid);
    if (x.def.role) n.roles[x.def.role] = (n.roles[x.def.role] || 0) + 1;
  }
  // Order networks by size so #1 is the main one
  networks.sort((a, b) => b.uids.length - a.uids.length).forEach((n, i) => n.id = i);
  const netOf = new Map();
  for (const n of networks) for (const u of n.uids) netOf.set(u, n.id);

  const byUid = new Map(blocks.map(x => [x.b.uid, x]));
  const issues = [];
  const status = new Map(); // uid -> 'error' | 'warn' | 'isolated'
  const rank = { error: 3, warn: 2, isolated: 1 };
  const flag = (uid, lvl) => { if ((rank[status.get(uid)] || 0) < rank[lvl]) status.set(uid, lvl); };
  const issue = (level, title, detail, uids) => { issues.push({ level, title, detail, uids }); uids.forEach(u => flag(u, level)); };

  const withRole = r => blocks.filter(x => x.def.role === r);
  const tanks = withRole('h2tank'), connectors = withRole('connector');
  const h2Users = blocks.filter(x => x.def.role === 'h2thrust' || x.def.role === 'h2user');
  const netHas = (uid, role) => { const n = networks[netOf.get(uid)]; return !!(n && n.roles[role]); };

  // Hydrogen ------------------------------------------------------------------
  const h2 = { users: h2Users.length, tanks: tanks.length, usersOk: 0, tanksRefuel: 0 };
  if (h2Users.length) {
    if (!tanks.length) {
      issue('error', 'No hydrogen tank', `${h2Users.length} hydrogen thruster/engine block(s) but no hydrogen tank on the grid. They will have no fuel.`, h2Users.map(x => x.b.uid));
    } else {
      const noPorts = h2Users.filter(x => !x.ports.length);
      const bad = h2Users.filter(x => x.ports.length && !netHas(x.b.uid, 'h2tank'));
      h2.usersOk = h2Users.length - bad.length - noPorts.length;
      if (bad.length) issue('error', `${bad.length} hydrogen block(s) not connected to a tank`,
        'These hydrogen thrusters/engines have no conveyor path to any hydrogen tank, so they won\'t fire. Run conveyors (small is fine for hydrogen) from their port to a tank.', bad.map(x => x.b.uid));
    }
  }
  if (tanks.length) {
    if (!connectors.length) {
      issue('warn', 'No connector to refuel hydrogen', 'Add a Connector linked to the hydrogen tank(s) so the ship can be refuelled when docked.', tanks.map(x => x.b.uid));
    } else {
      const bad = tanks.filter(x => !netHas(x.b.uid, 'connector'));
      h2.tanksRefuel = tanks.length - bad.length;
      if (bad.length) issue('warn', `${bad.length} hydrogen tank(s) can't be refuelled`,
        'No conveyor path from these tanks to a Connector, so they can\'t be filled when docked.', bad.map(x => x.b.uid));
    }
  }

  // Inventories -----------------------------------------------------------------
  const invBlocks = blocks.filter(x => INVENTORY_ROLES.has(x.def.role) && x.ports.length);
  let mainNet = null;
  if (invBlocks.length) {
    const score = new Map();
    for (const x of invBlocks) { const n = netOf.get(x.b.uid); score.set(n, (score.get(n) || 0) + (x.def.role === 'cargo' ? 10 : 1) + (x.def.inv || 0) / 1e6); }
    mainNet = [...score.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const off = invBlocks.filter(x => netOf.get(x.b.uid) !== mainNet);
    if (off.length && invBlocks.length > 1) {
      const names = [...new Set(off.map(x => x.def.name))].join(', ');
      issue('warn', `${off.length} inventory block(s) not on the main conveyor system`,
        `${names}: items can't reach the main cargo from these.`, off.map(x => x.b.uid));
    }
    // Large-route check for component movers
    const mainCargo = invBlocks.filter(x => netOf.get(x.b.uid) === mainNet && x.def.role === 'cargo')
      .sort((a, b) => (b.def.inv || 0) - (a.def.inv || 0))[0];
    if (mainCargo) {
      const lr = large.find(mainCargo.b.uid);
      const smallOnly = invBlocks.filter(x => netOf.get(x.b.uid) === mainNet && x !== mainCargo &&
        (NEEDS_LARGE.has(x.def.role) || x.def.role === 'cargo') && large.find(x.b.uid) !== lr);
      if (smallOnly.length) issue('warn', `${smallOnly.length} block(s) linked only through small conveyors`,
        'Small conveyors move ore, ingots and gas but not components or large items. Use large conveyors (or a Conveyor Converter only where small is enough).', smallOnly.map(x => x.b.uid));
    }
  }

  // Size mismatches ---------------------------------------------------------------
  if (mismatches.length) {
    const uids = [...new Set(mismatches.flat())];
    issue('error', `${mismatches.length} large ↔ small port mismatch(es)`,
      'A large port is touching a small port, so they do not connect. Put a Conveyor Converter (small grid) between them, or use matching conveyor sizes.', uids);
  }

  // Isolated blocks ---------------------------------------------------------------
  if (portBlocks.length > 1) {
    const iso = portBlocks.filter(x => !x.ports.some(p => p.status === 'connected'));
    for (const x of iso) flag(x.b.uid, 'isolated');
    const isoConv = iso.filter(x => x.def.cat === 'conveyor');
    if (isoConv.length) issue('warn', `${isoConv.length} conveyor block(s) connected to nothing`, 'Check their orientation: the ports must face the neighbouring block\'s ports.', isoConv.map(x => x.b.uid));
  }

  return {
    networks, netOf, mainNet, issues, status, byUid, h2,
    portBlocks: portBlocks.length,
    ports: portBlocks.flatMap(x => x.ports),
    roleName: r => ROLE_NAMES[r] || r,
  };
}
