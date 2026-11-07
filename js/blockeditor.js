// Custom block editor: conveyor ports and upgrade-module slots painted cell by cell on each face.
import { parsePorts, BLOCKS, CATEGORIES, THRUSTER_TYPES } from './data.js?v=20261107-5';

const $ = s => document.querySelector(s);

// Each face as seen from OUTSIDE the block, looking at it.
//  r = the block direction that runs left→right on screen, u = bottom→top.
//  Top / Bottom are drawn with the block's front at the top of the grid.
export const FACE_DEFS = [
  { f: '-z', name: 'Front',  n: [0, 0, -1], r: [-1, 0, 0], u: [0, 1, 0] },
  { f: '+z', name: 'Back',   n: [0, 0, 1],  r: [1, 0, 0],  u: [0, 1, 0] },
  { f: '-x', name: 'Left',   n: [-1, 0, 0], r: [0, 0, 1],  u: [0, 1, 0] },
  { f: '+x', name: 'Right',  n: [1, 0, 0],  r: [0, 0, -1], u: [0, 1, 0] },
  { f: '+y', name: 'Top',    n: [0, 1, 0],  r: [1, 0, 0],  u: [0, 0, -1] },
  { f: '-y', name: 'Bottom', n: [0, -1, 0], r: [-1, 0, 0], u: [0, 0, -1] },
];
const EDGE_NAME = { '0,0,-1': 'Front', '0,0,1': 'Back', '-1,0,0': 'Left side', '1,0,0': 'Right side', '0,1,0': 'Top', '0,-1,0': 'Bottom' };
const TYPE_NAME = { L: 'Large port', S: 'Small port', U: 'Module slot' };
const neg = v => v.map(x => -x);
const axisOf = v => v.findIndex(x => x !== 0);
const faceById = f => FACE_DEFS.find(d => d.f === f);
const faceByNormal = n => FACE_DEFS.find(d => d.n.join() === n.join());

/** Face cell (1-based column from the left, row from the bottom, as seen from outside) → block-local cell. */
export function cellOf(fd, size, col, row) {
  const c = [0, 0, 0];
  for (let i = 0; i < 3; i++) if (fd.n[i]) c[i] = fd.n[i] > 0 ? size[i] - 1 : 0;
  const ri = axisOf(fd.r), ui = axisOf(fd.u);
  c[ri] = fd.r[ri] > 0 ? col - 1 : size[ri] - col;
  c[ui] = fd.u[ui] > 0 ? row - 1 : size[ui] - row;
  return c;
}
export function colRowOf(fd, size, c) {
  const ri = axisOf(fd.r), ui = axisOf(fd.u);
  return [fd.r[ri] > 0 ? c[ri] + 1 : size[ri] - c[ri], fd.u[ui] > 0 ? c[ui] + 1 : size[ui] - c[ui]];
}
const dims = (fd, size) => [size[axisOf(fd.r)], size[axisOf(fd.u)]];
const onFace = (fd, size, c) => c.every((v, i) => v >= 0 && v < size[i]) &&
  [0, 1, 2].every(i => !fd.n[i] || c[i] === (fd.n[i] > 0 ? size[i] - 1 : 0));

/** Parse "Left 1x2 L" (row × column, as the grid labels show). */
export function parsePortText(text, size) {
  const out = [], bad = [];
  for (const part of text.split(/[;\n]+/).map(s => s.trim()).filter(Boolean)) {
    const m = /^(front|back|left|right|top|bottom)\s*(\d+)\s*[x×*,]\s*(\d+)\s*(large|small|module|slot|l|s|m|u)?$/i.exec(part);
    if (!m) { bad.push(part); continue; }
    const fd = FACE_DEFS.find(d => d.name.toLowerCase() === m[1].toLowerCase());
    const row = +m[2], col = +m[3], [cols, rows] = dims(fd, size);
    if (row < 1 || col < 1 || row > rows || col > cols) { bad.push(part); continue; }
    const t = (m[4] || 'L')[0].toUpperCase();
    out.push({ f: fd.f, c: cellOf(fd, size, col, row), t: t === 'M' || t === 'U' ? 'U' : t });
  }
  return { out, bad };
}

export function initBlockEditor(ctx) {
  // ctx: { getDesign, onSave(def, isUpdate), onDelete(id), toast, ask }
  let items = new Map();          // `${face}|x,y,z` → { f, c, t }
  let face = '-x', brush = 'L', editingId = null;
  const size = () => [+$('#cbX').value || 1, +$('#cbY').value || 1, +$('#cbZ').value || 1].map(v => Math.max(1, Math.min(30, Math.round(v))));
  const key = (f, c) => `${f}|${c.join(',')}`;

  $('#cbCat').innerHTML = CATEGORIES.map(c => `<option value="${c.id}" ${c.id === 'custom' ? 'selected' : ''}>${c.name}</option>`).join('');
  $('#cbThrType').innerHTML = '<option value="">— not a thruster —</option>' +
    Object.entries(THRUSTER_TYPES).map(([k, v]) => `<option value="${k}">${v.name}</option>`).join('');
  $('#cbFaceSeg').innerHTML = FACE_DEFS.map(d => `<button data-face="${d.f}">${d.name}</button>`).join('');
  $('#cbBrush').innerHTML = Object.entries({ ...TYPE_NAME, X: 'Clear' })
    .map(([k, v]) => `<button data-brush="${k}"><i class="sw ${k}"></i>${v}</button>`).join('');

  function setFace(f) { face = f; render(); }
  function setBrush(b) { brush = b; $$('#cbBrush button').forEach(x => x.classList.toggle('on', x.dataset.brush === b)); }
  function $$(s) { return [...document.querySelectorAll(s)]; }

  function prune() {
    const sz = size();
    for (const [k, it] of items) if (!onFace(faceById(it.f), sz, it.c)) items.delete(k);
  }

  function render() {
    prune();
    const sz = size(), fd = faceById(face), [cols, rows] = dims(fd, sz);
    $$('#cbFaceSeg button').forEach(b => {
      b.classList.toggle('on', b.dataset.face === face);
      const n = [...items.values()].filter(i => i.f === b.dataset.face).length;
      b.innerHTML = faceById(b.dataset.face).name + (n ? ` <span class="cnt">${n}</span>` : '');
    });
    const cell = Math.max(22, Math.min(40, Math.floor(260 / Math.max(cols, rows))));
    let h = `<div class="fe-edge top">${EDGE_NAME[fd.u.join()]}</div>
      <div class="fe-edge left"><span>${EDGE_NAME[neg(fd.r).join()]}</span></div>
      <div class="fe-cells" style="grid-template-columns:repeat(${cols},${cell}px);grid-auto-rows:${cell}px">`;
    for (let row = rows; row >= 1; row--) for (let col = 1; col <= cols; col++) {
      const c = cellOf(fd, sz, col, row), it = items.get(key(face, c));
      h += `<button class="fe-cell ${it ? it.t : ''}" data-col="${col}" data-row="${row}" title="${fd.name} ${row}×${col}${it ? ' — ' + TYPE_NAME[it.t] : ''}">${row}×${col}</button>`;
    }
    h += `</div><div class="fe-edge right"><span>${EDGE_NAME[fd.r.join()]}</span></div>
      <div class="fe-edge bottom">${EDGE_NAME[neg(fd.u).join()]}</div>`;
    $('#cbFaceGrid').innerHTML = h;
    $('#cbFaceHint').textContent = `${fd.name} face seen from outside · ${rows} row${rows > 1 ? 's' : ''} (1 = ${EDGE_NAME[neg(fd.u).join()].toLowerCase()}) × ${cols} column${cols > 1 ? 's' : ''} (1 = ${EDGE_NAME[neg(fd.r).join()].toLowerCase()})`;
    renderList();
  }

  function renderList() {
    const sz = size();
    const list = [...items.values()].sort((a, b) => FACE_DEFS.indexOf(faceById(a.f)) - FACE_DEFS.indexOf(faceById(b.f)));
    $('#cbPortList').innerHTML = list.length ? list.map(it => {
      const fd = faceById(it.f), [col, row] = colRowOf(fd, sz, it.c);
      return `<span class="chip ${it.t}" data-k="${key(it.f, it.c)}" title="Show this face">${fd.name} ${row}×${col} · ${TYPE_NAME[it.t]} <b data-del="${key(it.f, it.c)}" title="Remove">✕</b></span>`;
    }).join('') : '<span class="muted">No ports or module slots yet.</span>';
    const slots = list.filter(i => i.t === 'U').length, prod = $('#cbProd').value;
    let warn = '';
    if (slots && !prod) warn = 'Module slots only count if this block is a production block or a module: choose one under “Modules”.';
    else if (prod && ['speed', 'yield', 'power'].includes(prod) && !slots) warn = 'A module needs at least one module slot to attach to a refinery or assembler.';
    else if ((prod === 'refinery' || prod === 'assembler') && !slots) warn = 'No module slots: this block will not accept upgrade modules.';
    $('#cbModWarn').textContent = warn;
  }

  function apply(col, row, toggle) {
    const sz = size(), c = cellOf(faceById(face), sz, col, row), k = key(face, c), cur = items.get(k);
    if (brush === 'X' || (toggle && cur && cur.t === brush)) items.delete(k);
    else items.set(k, { f: face, c, t: brush });
  }

  // Paint by tap or drag (mouse and touch)
  let painting = false, lastCell = null;
  const grid = $('#cbFaceGrid');
  const cellAt = e => { const el = document.elementFromPoint(e.clientX, e.clientY); return el && el.closest && el.closest('.fe-cell'); };
  grid.addEventListener('pointerdown', e => {
    const el = e.target.closest('.fe-cell'); if (!el) return;
    e.preventDefault(); painting = true; lastCell = el.dataset.col + ',' + el.dataset.row;
    apply(+el.dataset.col, +el.dataset.row, true); render();
  });
  grid.addEventListener('pointermove', e => {
    if (!painting) return;
    const el = cellAt(e); if (!el) return;
    const id = el.dataset.col + ',' + el.dataset.row; if (id === lastCell) return;
    lastCell = id; apply(+el.dataset.col, +el.dataset.row, false); render();
  });
  window.addEventListener('pointerup', () => { painting = false; lastCell = null; });

  $('#cbFaceSeg').onclick = e => { const b = e.target.closest('[data-face]'); if (b) setFace(b.dataset.face); };
  $('#cbBrush').onclick = e => { const b = e.target.closest('[data-brush]'); if (b) setBrush(b.dataset.brush); };
  $('#cbPortList').onclick = e => {
    const d = e.target.dataset.del; if (d) { items.delete(d); render(); return; }
    const ch = e.target.closest('.chip'); if (ch) setFace(ch.dataset.k.split('|')[0]);
  };
  ['#cbX', '#cbY', '#cbZ'].forEach(s => $(s).addEventListener('input', render));
  $('#cbProd').addEventListener('change', () => { updateProdFields(); renderList(); });
  $('#cbThrType').addEventListener('change', updateThrFields);

  $('#cbPorts').onchange = e => {
    const v = e.target.value; e.target.value = '';
    if (v === '') return;
    for (const [k, it] of items) if (it.t !== 'U') items.delete(k);
    if (v !== 'none') for (const p of parsePorts(v.split(' '), size())) {
      const fd = faceByNormal(p.n); items.set(key(fd.f, p.c), { f: fd.f, c: p.c, t: p.s });
    }
    render();
  };
  $('#cbSlotsFace').onchange = e => {
    const f = e.target.value; e.target.value = '';
    if (!f) return;
    const fd = faceById(f), sz = size(), [cols, rows] = dims(fd, sz);
    for (let col = 1; col <= cols; col++) for (let row = 1; row <= rows; row++) {
      const c = cellOf(fd, sz, col, row); items.set(key(f, c), { f, c, t: 'U' });
    }
    setFace(f);
  };
  $('#cbPortAdd').onclick = () => {
    const { out, bad } = parsePortText($('#cbPortText').value, size());
    for (const it of out) items.set(key(it.f, it.c), it);
    if (out.length) { face = out[out.length - 1].f; $('#cbPortText').value = bad.join('; '); }
    render();
    if (bad.length) ctx.toast(`Couldn't read: ${bad.join('; ')} — use e.g. “Left 1x2 L” (row × column, L/S/M)`);
  };
  $('#cbPortText').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#cbPortAdd').click(); } });

  function updateThrFields() { $$('.cbThr').forEach(el => el.style.display = $('#cbThrType').value ? '' : 'none'); }
  function updateProdFields() {
    const v = $('#cbProd').value;
    $$('.cbProdKw').forEach(el => el.style.display = v === 'refinery' || v === 'assembler' ? '' : 'none');
  }

  // ---- load / new ----
  function fillFrom() {
    const d = ctx.getDesign(), g = d.grid;
    const customs = Object.values(d.customBlocks || {}).filter(b => b.grid === g).sort((a, b) => a.name.localeCompare(b.name));
    const games = Object.values(BLOCKS).filter(b => b.grid === g).sort((a, b) => a.name.localeCompare(b.name));
    $('#cbFrom').innerHTML = '<option value="">— new blank block —</option>' +
      (customs.length ? `<optgroup label="Edit one of your custom blocks">${customs.map(b => `<option value="c:${b.id}">${b.name}</option>`).join('')}</optgroup>` : '') +
      `<optgroup label="Start from a copy of a game block">${games.map(b => `<option value="g:${b.id}">${b.name}</option>`).join('')}</optgroup>`;
  }
  function load(def, isEdit) {
    editingId = isEdit ? def.id : null;
    $('#cbName').value = isEdit ? def.name : def ? def.name + ' (modded)' : 'My block';
    $('#cbCat').value = def ? (isEdit ? def.cat : def.cat) : 'custom';
    const s = def ? def.size : [1, 1, 1];
    $('#cbX').value = s[0]; $('#cbY').value = s[1]; $('#cbZ').value = s[2];
    $('#cbMass').value = def ? def.mass : 500;
    $('#cbInv').value = def ? (def.inv || def.invOre || 0) : 0;
    $('#cbThrType').value = def && def.thrust ? def.thrust.type : '';
    $('#cbForce').value = def && def.thrust ? def.thrust.f : 0;
    $('#cbPower').value = def && def.thrust ? def.thrust.p || 0 : 0;
    $('#cbH2').value = def && def.thrust ? def.thrust.h2 || 0 : 0;
    $('#cbPOut').value = def ? def.pOut || 0 : 0;
    $('#cbH2Cap').value = def ? def.h2 || 0 : 0;
    $('#cbRole').value = def && isEdit && def.roleSet ? def.role || '' : '';
    $('#cbProd').value = def ? (def.module || (def.prod && def.prod.modules ? def.prod.kind : '') || '') : '';
    if (!['', 'refinery', 'assembler', 'speed', 'yield', 'power'].includes($('#cbProd').value)) $('#cbProd').value = '';
    $('#cbProdKw').value = def && def.prod ? def.prod.kw : 560;
    items = new Map();
    for (const p of (def && def.ports) || []) { const fd = faceByNormal(p.n); if (fd) items.set(key(fd.f, p.c), { f: fd.f, c: [...p.c], t: p.s }); }
    for (const p of (def && def.upgrade) || []) { const fd = faceByNormal(p.n); if (fd) items.set(key(fd.f, p.c), { f: fd.f, c: [...p.c], t: 'U' }); }
    const first = [...items.values()][0]; face = first ? first.f : '-x';
    $('#cbSave').textContent = isEdit ? 'Save changes' : 'Add block';
    $('#cbDelete').hidden = !isEdit;
    updateThrFields(); updateProdFields(); render();
  }
  $('#cbFrom').onchange = e => {
    const v = e.target.value, d = ctx.getDesign();
    if (!v) load(null, false);
    else if (v.startsWith('c:')) load(d.customBlocks[v.slice(2)], true);
    else load(BLOCKS[v.slice(2)], false);
  };

  function open(editId) {
    fillFrom();
    const d = ctx.getDesign();
    if (editId && d.customBlocks[editId]) { $('#cbFrom').value = 'c:' + editId; load(d.customBlocks[editId], true); }
    else { $('#cbFrom').value = ''; load(null, false); }
    setBrush(brush);
    $('#customModal').hidden = false;
  }

  function buildDef() {
    const d = ctx.getDesign(), grid = d.grid;
    const name = $('#cbName').value.trim() || 'Custom block';
    const id = editingId || `${grid}_custom_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
    const tt = $('#cbThrType').value, prod = $('#cbProd').value, sz = size();
    prune();
    const list = [...items.values()];
    const def = {
      id, key: id, grid, name, cat: $('#cbCat').value, shape: tt ? 'thruster' : 'box', custom: true,
      size: sz, mass: +$('#cbMass').value || 0,
      inv: +$('#cbInv').value || 0, invOre: 0, invIce: 0, fuelInv: 0, minorInv: false,
      thrust: tt ? { type: tt, f: +$('#cbForce').value || 0, p: +$('#cbPower').value || 0, h2: +$('#cbH2').value || 0 } : null,
      pOut: +$('#cbPOut').value || 0, store: 0, h2: +$('#cbH2Cap').value || 0, o2: 0,
      ports: list.filter(i => i.t !== 'U').map(i => ({ c: [...i.c], n: faceById(i.f).n, s: i.t })),
      upgrade: list.filter(i => i.t === 'U').map(i => ({ c: [...i.c], n: faceById(i.f).n })),
      prod: prod === 'refinery' || prod === 'assembler' ? { kind: prod, kw: +$('#cbProdKw').value || 0, base: 1, modules: true } : null,
      module: ['speed', 'yield', 'power'].includes(prod) ? prod : null,
    };
    const role = $('#cbRole').value;
    def.roleSet = !!role;
    def.role = role || (tt === 'hydrogen' ? 'h2thrust' : def.prod ? def.prod.kind : def.h2 ? 'h2tank' : def.inv ? 'cargo' : null);
    return def;
  }

  $('#cbSave').onclick = () => {
    const def = buildDef(), d = ctx.getDesign();
    const isUpdate = !!d.customBlocks[def.id];
    ctx.onSave(def, isUpdate);
    editingId = null;
    $('#customModal').hidden = true;
  };
  $('#cbDelete').onclick = async () => {
    if (!editingId) return;
    const ok = await ctx.onDelete(editingId);
    if (ok) { editingId = null; $('#customModal').hidden = true; }
  };

  setBrush('L');
  return { open, edit: id => open(id) };
}
