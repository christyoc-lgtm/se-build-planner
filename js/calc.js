// Pure calculation engine: mass, cargo, gravity, thrust per direction.
import { G0, BLOCKS, DIRS, ITEMS, THRUSTER_TYPES, thrusterEffectiveness } from './data.js?v=20261107-1';
import { applyRot, rotatedSize } from './rotations.js?v=20261107-1';

/** Resolve a block definition, applying custom blocks and per-design overrides. */
export function getDef(design, id) {
  const base = BLOCKS[id] || (design.customBlocks && design.customBlocks[id]);
  if (!base) return null;
  const ov = design.overrides && design.overrides[id];
  return ov ? { ...base, ...ov, thrust: base.thrust ? { ...base.thrust, ...(ov.thrust || {}) } : null } : base;
}

export function thrustDirOf(rot) {
  // Thrust pushes the ship toward block-local -Z.
  return applyRot(rot, [0, 0, -1]);
}

export function dirIdOf(v) {
  for (const d of DIRS) if (d.v[0] === v[0] && d.v[1] === v[1] && d.v[2] === v[2]) return d.id;
  return null;
}

/**
 * env: { g (in g units), density (0..1+), invMult, itemId, customLPerKg, fillPct,
 *        fillMinor (bool), extraMass, targetTwr, station (bool) }
 */
export function analyse(design, env) {
  const gAcc = env.g * G0;
  const item = ITEMS.find(i => i.id === env.itemId) || ITEMS[0];
  const lPerKg = item.id === 'custom' ? Math.max(0.001, env.customLPerKg || 0.37) : item.lPerKg;
  const kgPerL = 1 / lPerKg;
  const isOre = item.id === 'ore' || item.id === 'gravel';
  const fill = Math.max(0, Math.min(100, env.fillPct)) / 100;
  const mult = env.invMult || 1;

  let dryMass = 0, capL = 0, capOreL = 0, capMinorL = 0;
  let pOut = 0, store = 0, h2Cap = 0, o2Cap = 0;
  const com = [0, 0, 0];
  const bom = new Map();
  const perDir = Object.fromEntries(DIRS.map(d => [d.id, {
    raw: 0, eff: 0, count: 0, powerMW: 0, h2Ls: 0, byType: {},
  }]));
  let thrusterPowerAll = 0;
  const missing = [];

  const blockCargoCap = []; // [centre, litres] for COM of cargo

  for (const b of design.blocks) {
    const def = getDef(design, b.id);
    if (!def) { missing.push(b.id); continue; }
    const size = rotatedSize(b.r, def.size);
    const c = [b.p[0] + size[0] / 2, b.p[1] + size[1] / 2, b.p[2] + size[2] / 2];
    dryMass += def.mass;
    com[0] += def.mass * c[0]; com[1] += def.mass * c[1]; com[2] += def.mass * c[2];

    const e = bom.get(b.id) || { id: b.id, name: def.name, count: 0, mass: 0 };
    e.count++; e.mass += def.mass; bom.set(b.id, e);

    let cap = 0;
    if (def.inv) {
      if (def.minorInv) { capMinorL += def.inv; if (env.fillMinor) cap += def.inv; }
      else { capL += def.inv; cap += def.inv; }
    }
    if (def.invOre) { capOreL += def.invOre; if (env.fillMinor && isOre) cap += def.invOre; }
    if (cap) blockCargoCap.push([c, cap]);

    pOut += def.pOut || 0; store += def.store || 0; h2Cap += def.h2 || 0; o2Cap += def.o2 || 0;

    if (def.thrust) {
      const v = thrustDirOf(b.r);
      const did = dirIdOf(v);
      const t = def.thrust;
      const eff = thrusterEffectiveness(t.type, env.density);
      const pd = perDir[did];
      pd.raw += t.f; pd.eff += t.f * eff; pd.count++;
      pd.powerMW += t.p || 0; pd.h2Ls += t.h2 || 0;
      const bt = pd.byType[t.type] || (pd.byType[t.type] = { count: 0, raw: 0, eff: 0, effPct: eff });
      bt.count++; bt.raw += t.f; bt.eff += t.f * eff;
      thrusterPowerAll += t.p || 0;
    }
  }

  // Cargo ---------------------------------------------------------------
  const fillableBaseL = capL + (env.fillMinor ? capMinorL + (isOre ? capOreL : 0) : 0);
  const cargoVolL = fillableBaseL * mult * fill;          // litres in game (with multiplier)
  const cargoMassShown = cargoVolL * kgPerL;               // what the game HUD shows
  const cargoMassPhys = cargoMassShown / mult;              // what physics/thrusters feel
  const extra = Math.max(0, env.extraMass || 0);

  const emptyMass = dryMass + extra;
  const loadedMass = emptyMass + cargoMassPhys;
  const loadedMassShown = emptyMass + cargoMassShown;

  // Centre of mass (cell units), loaded
  let comLoaded = null, comEmpty = null;
  if (dryMass > 0) {
    comEmpty = com.map(x => x / dryMass);
    const cl = [...com];
    const totCap = blockCargoCap.reduce((s, x) => s + x[1], 0);
    if (totCap > 0 && cargoMassPhys > 0) {
      for (const [c, cap] of blockCargoCap) {
        const m = cargoMassPhys * cap / totCap;
        cl[0] += m * c[0]; cl[1] += m * c[1]; cl[2] += m * c[2];
      }
    }
    const tm = dryMass + (totCap > 0 ? cargoMassPhys : 0);
    comLoaded = cl.map(x => x / tm);
  }

  // Per-direction performance ---------------------------------------------
  const target = env.targetTwr || 1.5;
  const dirs = DIRS.map(d => {
    const pd = perDir[d.id];
    const F = pd.eff;
    const r = {
      ...d, ...pd,
      accEmpty: emptyMass > 0 ? F / emptyMass : 0,
      accLoaded: loadedMass > 0 ? F / loadedMass : 0,
      twrEmpty: gAcc > 0 && emptyMass > 0 ? F / (emptyMass * gAcc) : Infinity,
      twrLoaded: gAcc > 0 && loadedMass > 0 ? F / (loadedMass * gAcc) : Infinity,
      liftKg: gAcc > 0 ? F / gAcc : Infinity,
      netUpLoaded: loadedMass > 0 ? F / loadedMass - gAcc : 0,
      requiredN: loadedMass * gAcc * target,
    };
    r.deficitN = Math.max(0, r.requiredN - F);
    r.maxCargoPhysKg = gAcc > 0 ? Math.max(0, F / (gAcc * target) - emptyMass) : Infinity;
    r.maxCargoShownKg = r.maxCargoPhysKg * mult;
    r.status = gAcc === 0 ? (F > 0 ? 'ok' : 'none')
      : r.twrLoaded >= target ? 'ok' : r.twrLoaded >= 1 ? 'marginal' : F > 0 ? 'fail' : 'none';
    // Hover / burn on hydrogen
    r.h2BurnFullS = pd.h2Ls > 0 && h2Cap > 0 ? h2Cap / pd.h2Ls : null;
    const throttle = F > 0 ? Math.min(1, (loadedMass * gAcc) / F) : 1;
    r.hoverThrottle = gAcc > 0 && F > 0 ? throttle : null;
    r.h2HoverS = pd.h2Ls > 0 && h2Cap > 0 && gAcc > 0 && F >= loadedMass * gAcc ? h2Cap / (pd.h2Ls * throttle) : null;
    return r;
  });

  const cellM = design.grid === 'L' ? 2.5 : 0.5;
  let bounds = null;
  if (design.blocks.length) {
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (const b of design.blocks) {
      const def = getDef(design, b.id); if (!def) continue;
      const s = rotatedSize(b.r, def.size);
      for (let i = 0; i < 3; i++) { mn[i] = Math.min(mn[i], b.p[i]); mx[i] = Math.max(mx[i], b.p[i] + s[i]); }
    }
    bounds = { cells: mx.map((v, i) => v - mn[i]), meters: mx.map((v, i) => (v - mn[i]) * cellM) };
  }

  return {
    gAcc, kgPerL, mult, fill, item, isOre,
    dryMass, extra, emptyMass, loadedMass, loadedMassShown,
    capL, capMinorL, capOreL, fillableBaseL, cargoVolL, cargoMassShown, cargoMassPhys,
    weightEmptyN: emptyMass * gAcc, weightLoadedN: loadedMass * gAcc,
    pOut, store, h2Cap, o2Cap, thrusterPowerAll,
    dirs, comEmpty, comLoaded, bom: [...bom.values()].sort((a, b) => b.mass - a.mass),
    bounds, missing, blockCount: design.blocks.length,
  };
}

/**
 * How many of a given thruster are needed to give `dirResult` the target TWR,
 * accounting for the extra mass the new thrusters add (iterative, like 343N's calc).
 */
export function thrustersNeeded(def, env, loadedMass, currentEffN) {
  const gAcc = env.g * G0;
  if (!def || !def.thrust || gAcc <= 0) return null;
  const target = env.targetTwr || 1.5;
  const per = def.thrust.f * thrusterEffectiveness(def.thrust.type, env.density);
  const netPer = per - def.mass * gAcc * target;
  if (netPer <= 0) return { possible: false, per };
  const need = loadedMass * gAcc * target - currentEffN;
  if (need <= 0) return { possible: true, count: 0, per };
  return { possible: true, count: Math.ceil(need / netPer), per };
}

export const fmt = {
  kg(v) {
    if (!isFinite(v)) return '∞';
    if (Math.abs(v) >= 1e6) return (v / 1000).toLocaleString(undefined, { maximumFractionDigits: 0 }) + ' t';
    if (Math.abs(v) >= 1e4) return (v / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' t';
    return v.toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' kg';
  },
  N(v) {
    if (!isFinite(v)) return '∞';
    if (Math.abs(v) >= 1e6) return (v / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 }) + ' MN';
    if (Math.abs(v) >= 1e3) return (v / 1e3).toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' kN';
    return v.toLocaleString(undefined, { maximumFractionDigits: 0 }) + ' N';
  },
  L(v) {
    if (Math.abs(v) >= 1e6) return (v / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 }) + ' ML';
    if (Math.abs(v) >= 1e4) return (v / 1e3).toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' kL';
    return v.toLocaleString(undefined, { maximumFractionDigits: 0 }) + ' L';
  },
  num(v, d = 2) { return isFinite(v) ? v.toLocaleString(undefined, { maximumFractionDigits: d }) : '∞'; },
  time(s) {
    if (s == null || !isFinite(s)) return '—';
    if (s < 120) return s.toFixed(0) + ' s';
    if (s < 7200) return (s / 60).toFixed(1) + ' min';
    return (s / 3600).toFixed(1) + ' h';
  },
};

export { THRUSTER_TYPES };
