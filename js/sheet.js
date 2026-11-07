// Printable build sheet: summary, snapshots, parts list and floor-by-floor plans.
import { GRID, DIRS, THRUSTER_TYPES, CATEGORIES } from './data.js?v=20261107-3';
import { getDef, thrustDirOf, fmt } from './calc.js?v=20261107-3';
import { rotatedSize } from './rotations.js?v=20261107-3';
import { blockColor } from './geometry.js?v=20261107-3';

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hex = n => '#' + n.toString(16).padStart(6, '0');

export function buildSheetHtml({ design, a, f, cv, env, planetName, snapshots }) {
  const cell = GRID[design.grid].cell;
  const items = design.blocks.map(b => {
    const def = getDef(design, b.id);
    return def ? { b, def, ws: rotatedSize(b.r, def.size) } : null;
  }).filter(Boolean);
  if (!items.length) return '<p>Nothing to print yet: place some blocks first.</p>';

  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const it of items) for (let i = 0; i < 3; i++) { mn[i] = Math.min(mn[i], it.b.p[i]); mx[i] = Math.max(mx[i], it.b.p[i] + it.ws[i]); }

  // numbering for the legend: by BOM order
  const num = new Map();
  a.bom.forEach((e, i) => num.set(e.id, i + 1));

  const W = mx[0] - mn[0], D = mx[2] - mn[2];
  const px = Math.max(6, Math.min(26, Math.floor(330 / Math.max(W, D))));
  const floors = [];
  for (let y = mn[1]; y < mx[1]; y++) {
    const here = items.filter(it => it.b.p[1] <= y && y < it.b.p[1] + it.ws[1]);
    if (!here.length) continue;
    let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W * px + 2}" height="${D * px + 2}" viewBox="-1 -1 ${W * px + 2} ${D * px + 2}">`;
    // grid
    svg += `<g stroke="#d0d7de" stroke-width="0.5">`;
    for (let x = 0; x <= W; x++) svg += `<line x1="${x * px}" y1="0" x2="${x * px}" y2="${D * px}"/>`;
    for (let z = 0; z <= D; z++) svg += `<line x1="0" y1="${z * px}" x2="${W * px}" y2="${z * px}"/>`;
    svg += `</g>`;
    let newCount = 0;
    for (const it of here) {
      const { b, def, ws } = it;
      const x = (b.p[0] - mn[0]) * px, z = (b.p[2] - mn[2]) * px, w = ws[0] * px, d = ws[2] * px;
      const first = b.p[1] === y;
      if (first) newCount++;
      const col = hex(blockColor(def, b));
      svg += `<rect x="${x + 0.5}" y="${z + 0.5}" width="${w - 1}" height="${d - 1}" fill="${col}" fill-opacity="${first ? 0.9 : 0.3}" stroke="#24292f" stroke-width="${first ? 1 : 0.6}" ${first ? '' : 'stroke-dasharray="3 2"'}/>`;
      const cx = x + w / 2, cz = z + d / 2;
      if (def.thrust) {
        const v = thrustDirOf(b.r);
        const L = Math.min(w, d) * 0.38;
        if (v[1] !== 0) svg += `<text x="${cx}" y="${cz + px * 0.3}" font-size="${Math.max(7, px * 0.8)}" text-anchor="middle" fill="#000">${v[1] > 0 ? '▲' : '▼'}</text>`;
        else svg += `<line x1="${cx - v[0] * L}" y1="${cz - v[2] * L}" x2="${cx + v[0] * L}" y2="${cz + v[2] * L}" stroke="#000" stroke-width="1.6" marker-end="url(#ah)"/>`;
      } else if (first && px >= 9) {
        svg += `<text x="${cx}" y="${cz + Math.min(w, d) * 0.18}" font-size="${Math.max(7, Math.min(px * 0.6, Math.min(w, d) * 0.5))}" text-anchor="middle" fill="#000" font-family="sans-serif">${num.get(b.id)}</text>`;
      }
    }
    svg += `<defs><marker id="ah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#000"/></marker></defs></svg>`;
    floors.push(`<div class="floor"><div class="fh"><b>Floor ${y - mn[1] + 1}</b> <span>(Y = ${y}) · ${newCount} new block${newCount === 1 ? '' : 's'} · faded = continues from below</span></div>
      <div class="fwd">▲ Forward</div>${svg}</div>`);
  }

  const dirs = a.dirs.map(r => `<tr><td>${r.name}</td><td>${r.count}</td><td>${fmt.N(r.eff)}</td><td>${isFinite(r.twrLoaded) ? r.twrLoaded.toFixed(2) : '—'}</td><td>${fmt.num(r.accLoaded, 1)} m/s²</td></tr>`).join('');
  const bom = a.bom.map((e, i) => `<tr><td class="n">${i + 1}</td><td><span class="sw" style="background:${hex(blockColor(getDef(design, e.id), null))}"></span>${esc(e.name)}</td><td>${e.count}</td><td>${fmt.kg(e.mass)}</td><td class="tick"></td></tr>`).join('');
  const shots = snapshots.map(s => `<figure><img src="${s.url}" alt="${esc(s.label)}"><figcaption>${esc(s.label)}</figcaption></figure>`).join('');
  const asc = f.ascentFull;
  const conv = cv ? (cv.issues.length ? `${cv.issues.length} conveyor issue(s): ${cv.issues.map(i => esc(i.title)).join('; ')}` : 'All conveyor checks pass') : '';

  return `
  <div class="sheet-page">
    <header class="sh"><div><h1>${esc(design.name)}</h1>
      <div>${GRID[design.grid].name} ${design.type === 'station' ? 'station' : 'ship'} · ${a.blockCount} blocks · ${a.bounds.meters.map(v => v.toFixed(1)).join(' × ')} m (W × H × L) · printed ${new Date().toLocaleDateString()}</div></div>
      <div class="brand">SE Build Planner</div></header>
    <div class="shots">${shots}</div>
    <div class="cols">
      <section><h2>Mass</h2><table>
        <tr><td>Empty</td><td>${fmt.kg(a.emptyMass)}</td></tr>
        <tr><td>Cargo (${Math.round(a.fill * 100)}% ${esc(a.item.name.toLowerCase())}, ×${a.mult})</td><td>${fmt.kg(a.cargoMassShown)}</td></tr>
        <tr><td>Full (physics)</td><td>${fmt.kg(a.loadedMass)}</td></tr>
        <tr><td>Environment</td><td>${esc(planetName)} · ${env.g} g · air ${(+env.density).toFixed(2)}</td></tr>
        <tr><td>Power out / battery</td><td>${fmt.num(a.pOut)} MW / ${fmt.num(a.store)} MWh</td></tr>
        <tr><td>Hydrogen</td><td>${fmt.L(a.h2Cap)}</td></tr>
        ${f.jump ? `<tr><td>Jump range (full)</td><td>${fmt.num(f.jump.full, 0)} km</td></tr>` : ''}
        ${asc.applicable ? `<tr><td>Reach space (full)</td><td>${asc.reached ? 'Yes, ' + fmt.time(asc.time) : 'No: stalls at ' + fmt.num((asc.stallAt ?? asc.altitude) / 1000, 1) + ' km'}</td></tr>` : ''}
      </table><p class="small">${conv}</p></section>
      <section><h2>Thrust (full cargo)</h2><table><tr><th>Toward</th><th>#</th><th>Thrust</th><th>TWR</th><th>Accel</th></tr>${dirs}</table></section>
    </div>
    <section><h2>Parts list</h2><table class="bom"><tr><th>#</th><th>Block</th><th>Qty</th><th>Mass</th><th>✓</th></tr>${bom}</table></section>
  </div>
  <div class="sheet-page floors-page"><h2>Floor plans (top view, forward at the top, bottom floor first)</h2>
    <p class="small">Numbers refer to the parts list. ▲/▼ = thruster pushing up/down; arrows = thruster push direction. Dashed, faded blocks continue from the floor below. Each square = ${cell} m.</p>
    <div class="floors">${floors.join('')}</div></div>`;
}

export const SHEET_CSS = `
#sheet { position: fixed; inset: 0; z-index: 80; background: #fff; color: #111; overflow: auto; font-family: "Segoe UI", system-ui, sans-serif; }
#sheet .sbar { position: sticky; top: 0; display: flex; gap: 8px; padding: 8px 14px; background: #f6f8fa; border-bottom: 1px solid #d0d7de; z-index: 2; }
#sheet .sbar button { background: #fff; color: #111; border: 1px solid #d0d7de; }
#sheet .sbar button.primary { background: #9a4f14; color: #fff; border-color: #9a4f14; }
#sheet .sheet-page { max-width: 1050px; margin: 0 auto; padding: 18px 24px; }
#sheet h1 { margin: 0; font-size: 22px; } #sheet h2 { font-size: 15px; margin: 14px 0 6px; border-bottom: 2px solid #f0883e; padding-bottom: 2px; }
#sheet .sh { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 3px solid #111; padding-bottom: 6px; }
#sheet .brand { font-weight: 700; color: #9a4f14; }
#sheet .shots { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-top: 10px; }
#sheet figure { margin: 0; border: 1px solid #d0d7de; } #sheet figure img { width: 100%; display: block; background: #0b0f16; }
#sheet figcaption { font-size: 11px; text-align: center; padding: 2px; }
#sheet .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
#sheet table { border-collapse: collapse; width: 100%; font-size: 12px; }
#sheet td, #sheet th { border-bottom: 1px solid #e1e4e8; padding: 3px 5px; text-align: left; }
#sheet .bom td.n { width: 28px; font-weight: 700; } #sheet .bom td.tick { width: 30px; border: 1px solid #999; }
#sheet .sw { display: inline-block; width: 10px; height: 10px; margin-right: 5px; border: 1px solid #555; vertical-align: -1px; }
#sheet .small { font-size: 11px; color: #555; }
#sheet .floors { display: flex; flex-wrap: wrap; gap: 14px; }
#sheet .floor { border: 1px solid #d0d7de; padding: 6px; break-inside: avoid; page-break-inside: avoid; }
#sheet .fh { font-size: 12px; } #sheet .fh span { color: #666; } #sheet .fwd { font-size: 10px; color: #9a4f14; text-align: center; }
@media print {
  body.printing > *:not(#sheet) { display: none !important; }
  body.printing { overflow: visible !important; background: #fff; }
  body.printing #sheet { position: static; overflow: visible; }
  #sheet .sbar { display: none; }
  #sheet .floors-page { page-break-before: always; }
  @page { size: A4; margin: 10mm; }
}`;
