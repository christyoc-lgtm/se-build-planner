// Flight analysis: speed & stopping, endurance & reaching space, jump range,
// gyroscope turning, landing stability and parachutes.
// Pure functions; all inputs in SI units (kg, N, m, s) unless noted.
import { G0, PLANETS, THRUSTER_TYPES, thrusterEffectiveness } from './data.js?v=20261107-1';
import { getDef, thrustDirOf, dirIdOf } from './calc.js?v=20261107-1';
import { rotatedSize } from './rotations.js?v=20261107-1';

const OPP = { up: 'down', down: 'up', forward: 'back', back: 'forward', left: 'right', right: 'left' };

export function planetOf(env) {
  const p = PLANETS.find(x => x.id === env.planetId);
  if (p && p.R) return p;
  // custom: scale EarthLike's well by gravity, keep the atmosphere if density > 0
  return { id: 'custom', name: 'Custom', g: env.g, density: env.density, R: 60, gravAlt: env.g > 0 ? 42.86 : 0, atmoAlt: env.density > 0 ? 14.4 : 0 };
}

/** Gravity (in g) at altitude h (m) for a planet with surface gravity g0. */
export function gravityAt(pl, g0, h) {
  if (g0 <= 0 || !pl.gravAlt) return 0;
  const R = pl.R * 1000, edge = R + pl.gravAlt * 1000;
  const r0 = edge / Math.pow(g0 / 0.05, 1 / 7);   // radius where the falloff starts
  const r = R + h;
  if (r >= edge) return 0;
  return r <= r0 ? g0 : g0 * Math.pow(r0 / r, 7);
}
/** Air density at altitude h (m): linear from the surface value to 0 at the top of the atmosphere. */
export function densityAt(pl, d0, h) {
  if (!pl.atmoAlt || d0 <= 0) return 0;
  return Math.max(0, d0 * (1 - h / (pl.atmoAlt * 1000)));
}

/** Gather per-block data the flight maths needs. */
function inventory(design) {
  const thrusters = [];           // {dir, type, f, p, h2}
  let batteryOut = 0, batteryMWh = 0, genOut = 0, solarOut = 0, h2Cap = 0;
  const gyros = [], jumps = [], gear = [], chutes = [];
  const masses = [];              // {m, c:[x,y,z] cells, s:[x,y,z] cells, cargoL}
  for (const b of design.blocks) {
    const def = getDef(design, b.id); if (!def) continue;
    const ws = rotatedSize(b.r, def.size);
    const c = [b.p[0] + ws[0] / 2, b.p[1] + ws[1] / 2, b.p[2] + ws[2] / 2];
    masses.push({ m: def.mass, c, s: ws, cap: (def.inv && !def.minorInv) ? def.inv : 0, b, def });
    if (def.thrust) thrusters.push({ dir: dirIdOf(thrustDirOf(b.r)), type: def.thrust.type, f: def.thrust.f, p: def.thrust.p || 0, h2: def.thrust.h2 || 0 });
    if (def.store) { batteryOut += def.pOut; batteryMWh += def.store; }
    else if (def.solar) solarOut += def.pOut;
    else if (def.pOut) genOut += def.pOut;          // reactors, hydrogen engines (need fuel)
    h2Cap += def.h2 || 0;
    if (def.gyro) gyros.push(def.gyro);
    if (def.jump) jumps.push(def.jump);
    if (def.gear) gear.push({ b, ws });
    if (def.chute) chutes.push(def.chute);
  }
  return { thrusters, batteryOut, batteryMWh, genOut, solarOut, h2Cap, gyros, jumps, gear, chutes, masses };
}

function dirThrust(inv, dir, density) {
  let F = 0, P = 0, H2 = 0;
  const byType = {};
  for (const t of inv.thrusters) {
    if (t.dir !== dir) continue;
    const e = thrusterEffectiveness(t.type, density);
    F += t.f * e; P += t.p; H2 += t.h2;
    const bt = byType[t.type] || (byType[t.type] = { raw: 0, p: 0, h2: 0 });
    bt.raw += t.f; bt.p += t.p; bt.h2 += t.h2;
  }
  return { F, P, H2, byType };
}

// ---------------------------------------------------------------------------
// 1. Speed & stopping
// ---------------------------------------------------------------------------
function speedStop(inv, env, m, cap) {
  const g = env.g * G0;
  const rows = [];
  for (const dir of ['forward', 'back', 'left', 'right']) {
    const a = dirThrust(inv, dir, env.density).F / m;
    const ab = dirThrust(inv, OPP[dir], env.density).F / m;   // braking uses the opposite thrusters
    rows.push({ id: dir, label: dir === 'back' ? 'Backward' : dir[0].toUpperCase() + dir.slice(1), a,
      tCap: a > 0 ? cap / a : null, dCap: a > 0 ? cap * cap / (2 * a) : null,
      tBrake: ab > 0 ? cap / ab : null, dBrake: ab > 0 ? cap * cap / (2 * ab) : null });
  }
  // Vertical
  const up = dirThrust(inv, 'up', env.density).F / m, down = dirThrust(inv, 'down', env.density).F / m;
  const climb = up - g;          // net climbing acceleration
  const fall = down + g;         // diving acceleration
  rows.push({ id: 'climb', label: 'Climb (Up − gravity)', a: climb,
    tCap: climb > 0 ? cap / climb : null, dCap: climb > 0 ? cap * cap / (2 * climb) : null,
    tBrake: fall > 0 ? cap / fall : null, dBrake: fall > 0 ? cap * cap / (2 * fall) : null });
  rows.push({ id: 'descend', label: 'Descent (Down + gravity)', a: fall,
    tCap: fall > 0 ? cap / fall : null, dCap: fall > 0 ? cap * cap / (2 * fall) : null,
    tBrake: climb > 0 ? cap / climb : null, dBrake: climb > 0 ? cap * cap / (2 * climb) : null });
  // Landing: fastest descent you can still stop within a given height
  const landing = climb > 0
    ? [50, 100, 250, 500, 1000].map(h => ({ h, v: Math.min(cap, Math.sqrt(2 * climb * h)) }))
    : null;
  return { rows, landing, cap, brakeDecel: climb };
}

// ---------------------------------------------------------------------------
// 2. Endurance & reaching space
// ---------------------------------------------------------------------------
function endurance(inv, env, m) {
  const g = env.g * G0;
  const up = dirThrust(inv, 'up', env.density);
  const fwd = dirThrust(inv, 'forward', env.density);
  const out = { batteryMWh: inv.batteryMWh, genOut: inv.genOut, solarOut: inv.solarOut, h2Cap: inv.h2Cap };
  // Hover: every Up thruster at the same throttle
  if (g > 0 && up.F >= m * g) {
    const thr = m * g / up.F;
    out.hoverThrottle = thr;
    out.hoverMW = up.P * thr;
    out.hoverH2 = up.H2 * thr;
  }
  const hours = mw => {
    const net = mw - inv.genOut;           // generators (reactors/engines) cover part of the draw while they have fuel
    if (mw <= 0) return null;
    if (net <= 0) return Infinity;
    return inv.batteryMWh > 0 ? inv.batteryMWh / net : 0;
  };
  out.hoverBatteryH = out.hoverMW != null ? hours(out.hoverMW) : null;
  out.cruiseMW = fwd.P;
  out.cruiseBatteryH = hours(fwd.P);
  out.hoverH2S = out.hoverH2 > 0 ? (inv.h2Cap > 0 ? inv.h2Cap / out.hoverH2 : 0) : null;
  out.cruiseH2S = fwd.H2 > 0 ? (inv.h2Cap > 0 ? inv.h2Cap / fwd.H2 : 0) : null;
  return out;
}

/**
 * Simulate a vertical climb from the surface to the edge of the gravity well.
 * Full throttle until the speed cap, then just enough thrust to hold the cap.
 */
export function ascent(inv, env, m, cap) {
  const pl = planetOf(env);
  const g0 = env.g;
  if (g0 <= 0) return { applicable: false };
  const edge = pl.gravAlt * 1000;
  const types = {};
  for (const t of inv.thrusters) if (t.dir === 'up') {
    const x = types[t.type] || (types[t.type] = { raw: 0, p: 0, h2: 0 }); x.raw += t.f; x.p += t.p; x.h2 += t.h2;
  }
  let h = 0, v = 0, t = 0, h2 = 0, mwh = 0, minNet = Infinity, stallAt = null, h2Out = null, batOut = null;
  const dt = 0.25;
  let atmoLossAt = null;
  while (h < edge && t < 4 * 3600) {
    const g = gravityAt(pl, g0, h) * G0;
    const d = densityAt(pl, env.density, h);
    let F = 0;
    for (const [ty, x] of Object.entries(types)) F += x.raw * thrusterEffectiveness(ty, d);
    if (h2Out != null || batOut != null) {
      // ran out of a fuel: recompute without that propulsion
      F = 0;
      for (const [ty, x] of Object.entries(types)) {
        if (ty === 'hydrogen' && h2Out != null) continue;
        if (ty !== 'hydrogen' && batOut != null) continue;
        F += x.raw * thrusterEffectiveness(ty, d);
      }
    }
    const W = m * g;
    const throttle = v < cap ? 1 : Math.min(1, W / Math.max(F, 1e-9));
    const a = (F * throttle - W) / m;
    minNet = Math.min(minNet, F / m - g);
    if (a <= 0 && v <= 0.01) { stallAt = h; break; }
    // consumption
    for (const [ty, x] of Object.entries(types)) {
      if (ty === 'hydrogen') h2 += x.h2 * throttle * dt;
      else mwh += Math.max(0, x.p * throttle - inv.genOut) * dt / 3600;
    }
    if (h2Out == null && types.hydrogen && h2 > inv.h2Cap) h2Out = h;
    if (batOut == null && mwh > inv.batteryMWh && Object.keys(types).some(k => k !== 'hydrogen')) batOut = h;
    if (atmoLossAt == null && types.atmo && d < 0.3 && env.density >= 0.3) atmoLossAt = h;
    v = Math.min(cap, Math.max(0, v + a * dt));
    h += v * dt; t += dt;
  }
  return {
    applicable: true, reached: h >= edge, edge, altitude: Math.min(h, edge), time: t, stallAt,
    h2Used: h2, h2Cap: inv.h2Cap, mwhUsed: mwh, mwhCap: inv.batteryMWh, h2Out, batOut, atmoLossAt, planet: pl,
  };
}

// ---------------------------------------------------------------------------
// 3. Jump drive
// ---------------------------------------------------------------------------
function jumpRange(inv, mEmpty, mFull) {
  if (!inv.jumps.length) return null;
  const range = m => inv.jumps.reduce((s, j) => s + j.km * Math.min(1, j.massKg / m), 0);
  const maxKm = inv.jumps.reduce((s, j) => s + j.km, 0);
  const threshold = Math.min(...inv.jumps.map(j => j.massKg));
  return { count: inv.jumps.length, empty: range(mEmpty), full: range(mFull), maxKm, threshold,
    chargeMWh: inv.jumps.reduce((s, j) => s + j.MWh, 0) };
}

// ---------------------------------------------------------------------------
// 4. Gyroscopes & landing
// ---------------------------------------------------------------------------
function inertia(inv, cell, cargoPhysKg) {
  // centre of mass and moment of inertia (kg·m²) about the CoM, per ship axis
  const totCap = inv.masses.reduce((s, x) => s + x.cap, 0);
  let M = 0; const c = [0, 0, 0];
  const pts = inv.masses.map(x => {
    const m = x.m + (totCap > 0 ? cargoPhysKg * x.cap / totCap : 0);
    M += m; for (let i = 0; i < 3; i++) c[i] += m * x.c[i] * cell;
    return { m, c: x.c.map(v => v * cell), s: x.s.map(v => v * cell) };
  });
  if (!M) return null;
  for (let i = 0; i < 3; i++) c[i] /= M;
  const I = [0, 0, 0];
  for (const p of pts) {
    const d = p.c.map((v, i) => v - c[i]);
    const self = [p.s[1] ** 2 + p.s[2] ** 2, p.s[0] ** 2 + p.s[2] ** 2, p.s[0] ** 2 + p.s[1] ** 2].map(v => p.m * v / 12);
    I[0] += p.m * (d[1] ** 2 + d[2] ** 2) + self[0];   // pitch (about X)
    I[1] += p.m * (d[0] ** 2 + d[2] ** 2) + self[1];   // yaw (about Y)
    I[2] += p.m * (d[0] ** 2 + d[1] ** 2) + self[2];   // roll (about Z)
  }
  return { M, com: c, I };
}

function rating(degS2) {
  if (degS2 >= 30) return 'ok';
  if (degS2 >= 8) return 'ok';
  if (degS2 >= 2) return 'marginal';
  return 'fail';
}

function gyroCheck(inv, cell, cargoPhysKg) {
  const ine = inertia(inv, cell, cargoPhysKg);
  if (!ine) return null;
  const torque = inv.gyros.reduce((s, x) => s + x, 0);
  const axes = ['Pitch', 'Yaw', 'Roll'].map((name, i) => {
    const alpha = torque / ine.I[i] * 180 / Math.PI;     // deg/s²
    return { name, alpha, status: torque ? rating(alpha) : 'fail', t90: alpha > 0 ? 2 * Math.sqrt(90 / alpha) : null };
  });
  return { count: inv.gyros.length, torque, axes, mass: ine.M, com: ine.com };
}

function hull2d(pts) {
  pts = [...new Map(pts.map(p => [p.join(), p])).values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const p of pts) { while (lo.length >= 2 && cross(lo.at(-2), lo.at(-1), p) <= 0) lo.pop(); lo.push(p); }
  for (const p of [...pts].reverse()) { while (up.length >= 2 && cross(up.at(-2), up.at(-1), p) <= 0) up.pop(); up.push(p); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
function insideMargin(poly, q) {
  // signed distance from q to polygon edge (positive inside) for a CCW convex polygon
  if (poly.length < 3) return -Infinity;
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const ex = b[0] - a[0], ey = b[1] - a[1], len = Math.hypot(ex, ey) || 1;
    const d = ((q[0] - a[0]) * ey - (q[1] - a[1]) * ex) / len;   // >0 to the right
    best = Math.min(best, -d);
  }
  return best;
}

function landingCheck(inv, cell, cargoPhysKg, mFull) {
  const ine = inertia(inv, cell, cargoPhysKg);
  if (!ine) return null;
  let support = [], source;
  if (inv.gear.length) {
    source = 'landing gear / wheels';
    for (const { b, ws } of inv.gear) {
      support.push([b.p[0], b.p[2]], [b.p[0] + ws[0], b.p[2]], [b.p[0], b.p[2] + ws[2]], [b.p[0] + ws[0], b.p[2] + ws[2]]);
    }
  } else {
    source = 'lowest blocks';
    let minY = Infinity;
    for (const x of inv.masses) minY = Math.min(minY, x.b.p[1]);
    for (const x of inv.masses) if (x.b.p[1] === minY)
      support.push([x.b.p[0], x.b.p[2]], [x.b.p[0] + x.s[0], x.b.p[2]], [x.b.p[0], x.b.p[2] + x.s[2]], [x.b.p[0] + x.s[0], x.b.p[2] + x.s[2]]);
  }
  const poly = hull2d(support.map(p => [p[0] * cell, p[1] * cell]));
  const margin = insideMargin(poly, [ine.com[0], ine.com[2]]);
  let minY = Infinity;
  for (const x of inv.masses) minY = Math.min(minY, x.b.p[1]);
  const height = ine.com[1] - minY * cell;
  const tipDeg = margin > 0 ? Math.atan2(margin, Math.max(height, 0.01)) * 180 / Math.PI : 0;
  const chuteKg = inv.chutes.reduce((s, x) => s + x, 0);
  // offset of CoM from the middle of the support area
  const cx = poly.reduce((s, p) => s + p[0], 0) / (poly.length || 1), cz = poly.reduce((s, p) => s + p[1], 0) / (poly.length || 1);
  return { source, margin, height, tipDeg, stable: margin > 0, offset: [ine.com[0] - cx, ine.com[2] - cz],
    chutes: inv.chutes.length, chuteKg, chuteOk: chuteKg >= mFull };
}

// ---------------------------------------------------------------------------
export function flightAnalysis(design, env, a) {
  const inv = inventory(design);
  const cell = design.grid === 'L' ? 2.5 : 0.5;
  const cap = env.speedCap || 100;
  return {
    speedFull: speedStop(inv, env, a.loadedMass || 1, cap),
    speedEmpty: speedStop(inv, env, a.emptyMass || 1, cap),
    enduranceFull: endurance(inv, env, a.loadedMass || 1),
    enduranceEmpty: endurance(inv, env, a.emptyMass || 1),
    ascentFull: ascent(inv, env, a.loadedMass || 1, cap),
    ascentEmpty: ascent(inv, env, a.emptyMass || 1, cap),
    jump: jumpRange(inv, a.emptyMass || 1, a.loadedMass || 1),
    gyroEmpty: gyroCheck(inv, cell, 0),
    gyroFull: gyroCheck(inv, cell, a.cargoMassPhys),
    landing: landingCheck(inv, cell, a.cargoMassPhys, a.loadedMass),
    inv,
  };
}
