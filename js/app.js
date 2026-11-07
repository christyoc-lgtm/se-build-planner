// Space Engineers Build Planner — editor & UI
import * as THREE from './vendor/three.module.min.js';
import { OrbitControls } from './vendor/OrbitControls.js';
import { parsePorts, BLOCKS, CATEGORIES, CAT_COLORS, PLANETS, ITEMS, INVENTORY_MULTIPLIERS, THRUSTER_TYPES, DIRS, GRID, G0, thrusterEffectiveness } from './data.js';
import { ROTS, rotateAbout, mirrorRot, rotatedSize, applyRot, rotIndex } from './rotations.js';
import { analyse, getDef, thrustersNeeded, thrustDirOf, fmt } from './calc.js';
import { buildBlockObject, blockColor, makeArrow } from './geometry.js';
import { analyseConveyors, worldPorts } from './conveyor.js';
import { EXAMPLES, buildExampleShip } from './examples.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const LS_DESIGNS = 'sebp.designs.v1', LS_CURRENT = 'sebp.current.v1', LS_CUSTOM = 'sebp.customlib.v1';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const defaultSettings = () => ({
  planetId: 'earth', g: 1, density: 1, invMult: 1, itemId: 'ore', customLPerKg: 0.37,
  fillPct: 100, fillMinor: false, extraMass: 0, targetTwr: 1.5, suggestDir: 'up',
});
const newDesign = (grid = 'L') => ({
  format: 'se-build-planner', version: 1, name: 'Untitled ship', grid, type: 'ship',
  blocks: [], customBlocks: {}, overrides: {}, settings: defaultSettings(),
});

let uidSeq = 1;
const state = {
  design: newDesign('L'),
  tool: 'place', selId: 'L_LightArmor', rot: 0, color: null,
  mirror: { x: false, y: false, z: false }, mirrorPos: { x: 0.5, y: 0.5, z: 0.5 },
  layerY: 0, cutOn: false, cutY: 0, showArrows: true, showCom: true,
  undo: [], redo: [], dirty: false,
  convView: false, focusUid: null,
};
const S = () => state.design.settings;
const cellSize = () => GRID[state.design.grid].cell;

function withUids(blocks) { return blocks.map(b => ({ ...b, uid: uidSeq++ })); }

// ---------------------------------------------------------------------------
// Occupancy
// ---------------------------------------------------------------------------
let occ = new Map();
const ck = (x, y, z) => x + ',' + y + ',' + z;
function blockCells(b, def) {
  const s = rotatedSize(b.r, def.size), out = [];
  for (let x = 0; x < s[0]; x++) for (let y = 0; y < s[1]; y++) for (let z = 0; z < s[2]; z++)
    out.push([b.p[0] + x, b.p[1] + y, b.p[2] + z]);
  return out;
}
function rebuildOcc() {
  occ = new Map();
  for (const b of state.design.blocks) {
    const def = getDef(state.design, b.id); if (!def) continue;
    for (const c of blockCells(b, def)) occ.set(ck(...c), b.uid);
  }
}
function fits(b, def, extraOcc) {
  for (const c of blockCells(b, def)) {
    const k = ck(...c);
    if (occ.has(k) || (extraOcc && extraOcc.has(k))) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Undo / modify
// ---------------------------------------------------------------------------
function snapshot() { return JSON.stringify(state.design.blocks.map(({ uid, ...b }) => b)); }
function commit(mutator) {
  const before = snapshot();
  mutator();
  const after = snapshot();
  if (before === after) return;
  state.undo.push(before); if (state.undo.length > 200) state.undo.shift();
  state.redo = [];
  changed();
}
function restore(snap) { state.design.blocks = withUids(JSON.parse(snap)); changed(); }
function undo() { if (!state.undo.length) return; state.redo.push(snapshot()); restore(state.undo.pop()); }
function redo() { if (!state.redo.length) return; state.undo.push(snapshot()); restore(state.redo.pop()); }

let changeQueued = false;
function changed() {
  state.dirty = true;
  rebuildOcc();
  syncScene();
  queueAnalysis();
  autosave();
}

// ---------------------------------------------------------------------------
// Three.js scene
// ---------------------------------------------------------------------------
const canvas = $('#c3d');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0f16);
const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 5000);
camera.position.set(22, 16, 20);
const controls = new OrbitControls(camera, canvas);
controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
controls.enableDamping = true; controls.dampingFactor = 0.15;
controls.screenSpacePanning = true;
canvas.addEventListener('contextmenu', e => e.preventDefault());

scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x202530, 0.9));
const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(30, 60, 20); scene.add(sun);
const fill = new THREE.DirectionalLight(0x88aaff, 0.5); fill.position.set(-30, -10, -40); scene.add(fill);

const blockRoot = new THREE.Group(); scene.add(blockRoot);
const overlayRoot = new THREE.Group(); scene.add(overlayRoot);
let gridHelper = null, pickPlane = null, axisGroup = null, ghostGroup = new THREE.Group(), mirrorGroup = new THREE.Group();
scene.add(ghostGroup); scene.add(mirrorGroup);
const objByUid = new Map();

function setupGridHelpers() {
  if (gridHelper) scene.remove(gridHelper);
  if (pickPlane) scene.remove(pickPlane);
  if (axisGroup) scene.remove(axisGroup);
  const c = cellSize(), n = 60;
  gridHelper = new THREE.GridHelper(n * c, n, 0x3a4556, 0x1f2633);
  gridHelper.position.y = state.layerY * c;
  scene.add(gridHelper);
  pickPlane = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.MeshBasicMaterial({ visible: false }));
  pickPlane.rotation.x = -Math.PI / 2; pickPlane.position.y = state.layerY * c;
  scene.add(pickPlane);
  axisGroup = new THREE.Group();
  const L = c * 4;
  axisGroup.add(makeArrow(new THREE.Vector3(0, 0, 0), [0, 0, -1], L, 0xff5555));
  axisGroup.add(makeArrow(new THREE.Vector3(0, 0, 0), [0, 1, 0], L * 0.7, 0x55dd77));
  axisGroup.add(makeArrow(new THREE.Vector3(0, 0, 0), [1, 0, 0], L * 0.7, 0x5599ff));
  axisGroup.add(textSprite('FORWARD', new THREE.Vector3(0, c * 0.3, -L - c * 0.6), c));
  axisGroup.add(textSprite('UP', new THREE.Vector3(0, L * 0.7 + c * 0.4, 0), c));
  axisGroup.add(textSprite('RIGHT', new THREE.Vector3(L * 0.7 + c * 0.8, 0, 0), c));
  axisGroup.traverse(o => { if (o.material) { o.material.depthTest = false; o.material.transparent = true; } o.renderOrder = 15; o.raycast = () => {}; });
  scene.add(axisGroup);
}
function textSprite(text, pos, scale) {
  const cv = document.createElement('canvas'); cv.width = 256; cv.height = 64;
  const g = cv.getContext('2d'); g.font = 'bold 34px Segoe UI, sans-serif'; g.fillStyle = '#c9d1d9';
  g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, 128, 32);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), depthTest: false, transparent: true }));
  sp.position.copy(pos); sp.scale.set(scale * 2.4, scale * 0.6, 1); sp.renderOrder = 10;
  return sp;
}

function syncScene() {
  const present = new Set();
  for (const b of state.design.blocks) {
    present.add(b.uid);
    if (!objByUid.has(b.uid)) {
      const def = getDef(state.design, b.id);
      if (!def) continue;
      const o = buildBlockObject(def, b, cellSize());
      o.traverse(n => { n.userData.uid = b.uid; });
      blockRoot.add(o); objByUid.set(b.uid, o);
    }
  }
  for (const [uid, o] of objByUid) if (!present.has(uid)) { blockRoot.remove(o); objByUid.delete(uid); }
  applyCut();
  if (state.convView) { lastConv = analyseConveyors(state.design); applyConveyorView(); }
  rebuildOverlays();
}
function clearScene() { for (const o of objByUid.values()) blockRoot.remove(o); objByUid.clear(); }
function applyCut() {
  for (const b of state.design.blocks) {
    const o = objByUid.get(b.uid); if (!o) continue;
    o.visible = !state.cutOn || b.p[1] <= state.cutY;
  }
}

let lastAnalysis = null;
function rebuildOverlays() {
  overlayRoot.clear();
  const c = cellSize();
  if (state.showArrows && !state.convView) {
    for (const b of state.design.blocks) {
      const def = getDef(state.design, b.id);
      if (!def || !def.thrust) continue;
      if (state.cutOn && b.p[1] > state.cutY) continue;
      const ws = rotatedSize(b.r, def.size);
      const centre = new THREE.Vector3((b.p[0] + ws[0] / 2) * c, (b.p[1] + ws[1] / 2) * c, (b.p[2] + ws[2] / 2) * c);
      const d = thrustDirOf(b.r);
      const len = Math.max(...def.size) * c * 0.9 + c * 0.6;
      const start = centre.clone().addScaledVector(new THREE.Vector3(...d), Math.max(...def.size) * c * 0.5);
      const a = makeArrow(start, d, len, THRUSTER_TYPES[def.thrust.type].color);
      a.traverse(n => { n.raycast = () => {}; });
      overlayRoot.add(a);
    }
  }
  if (state.showCom && lastAnalysis && lastAnalysis.comLoaded) {
    const p = lastAnalysis.comLoaded;
    const sph = new THREE.Mesh(new THREE.SphereGeometry(c * 0.35, 20, 14),
      new THREE.MeshBasicMaterial({ color: 0xffd33d, depthTest: false, transparent: true, opacity: 0.9 }));
    sph.position.set(p[0] * c, p[1] * c, p[2] * c); sph.renderOrder = 20; sph.raycast = () => {};
    overlayRoot.add(sph);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(c * 0.6, c * 0.05, 8, 32),
      new THREE.MeshBasicMaterial({ color: 0xffd33d, depthTest: false, transparent: true, opacity: 0.6 }));
    ring.position.copy(sph.position); ring.rotation.x = Math.PI / 2; ring.renderOrder = 20; ring.raycast = () => {};
    overlayRoot.add(ring);
  }
  rebuildConveyorOverlay();
  rebuildMirrorPlanes();
}
// ---------------------------------------------------------------------------
// Conveyor view
// ---------------------------------------------------------------------------
let lastConv = null;
const NET_COLORS = [0x3fb950, 0x58a6ff, 0xd2a8ff, 0xe3b341, 0x39c5cf, 0xff7b72, 0xf778ba, 0xa5d6ff];
const convMats = new Map();
function convMat(color, opacity = 1) {
  const k = color + ':' + opacity;
  if (!convMats.has(k)) convMats.set(k, new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.1,
    transparent: opacity < 1, opacity, depthWrite: opacity >= 1 }));
  return convMats.get(k);
}
const ghostMat = new THREE.MeshBasicMaterial({ color: 0x8b949e, transparent: true, opacity: 0.07, depthWrite: false });
function applyConveyorView() {
  const cv = lastConv;
  for (const [uid, o] of objByUid) {
    let m = null, showEdges = true;
    if (state.convView && cv) {
      const x = cv.byUid.get(uid);
      if (!x || !x.ports.length) { m = ghostMat; showEdges = false; }
      else {
        const st = cv.status.get(uid);
        const net = cv.netOf.get(uid);
        m = st === 'error' ? convMat(0xf85149) : convMat(NET_COLORS[net % NET_COLORS.length], st === 'isolated' ? 0.55 : 1);
      }
    }
    o.traverse(n => {
      if (n.isMesh) { if (!n.userData.origMat) n.userData.origMat = n.material; n.material = m || n.userData.origMat; }
      if (n.isLineSegments) n.visible = showEdges;
    });
  }
}
function rebuildConveyorOverlay() {
  if (!state.convView || !lastConv) return;
  const c = cellSize();
  const cols = { connected: 0x3fb950, open: 0x8b949e, blocked: 0xd29922, mismatch: 0xff3b30 };
  const geo = new THREE.BoxGeometry(1, 1, 1);
  for (const p of lastConv.ports) {
    const b = state.design.blocks.find(x => x.uid === p.uid);
    if (state.cutOn && b && b.p[1] > state.cutY) continue;
    const sz = p.size === 'L' ? 0.62 : 0.26;
    const on = p.status === 'connected' || p.status === 'mismatch';
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: cols[p.status] || 0xffffff, depthTest: !on, transparent: on, opacity: on ? 0.9 : 1 }));
    const pos = new THREE.Vector3((p.cell[0] + 0.5 + p.n[0] * 0.5) * c, (p.cell[1] + 0.5 + p.n[1] * 0.5) * c, (p.cell[2] + 0.5 + p.n[2] * 0.5) * c);
    m.position.copy(pos);
    m.scale.set(p.n[0] ? 0.06 * c : sz * c, p.n[1] ? 0.06 * c : sz * c, p.n[2] ? 0.06 * c : sz * c);
    m.raycast = () => {}; m.renderOrder = on ? 12 : 5;
    overlayRoot.add(m);
  }
  for (const [uid, st] of lastConv.status) {
    const o = objByUid.get(uid); if (!o || !o.visible) continue;
    if (st === 'ok') continue;
    const box = new THREE.Box3().setFromObject(o).expandByScalar(c * 0.06);
    const h = new THREE.Box3Helper(box, st === 'error' ? 0xff3b30 : st === 'warn' ? 0xd29922 : 0xf0883e);
    h.raycast = () => {};
    overlayRoot.add(h);
  }
}
function setConveyorView(on) {
  state.convView = on;
  $('#btnConv').classList.toggle('on', on);
  $('#legendNormal').style.display = on ? 'none' : '';
  $('#legendConv').style.display = on ? '' : 'none';
  applyConveyorView(); rebuildOverlays();
  const t2 = $('#convToggle2'); if (t2) { t2.textContent = (on ? 'Hide' : 'Show') + ' conveyor view'; t2.classList.toggle('on', on); }
}
function focusBlocks(uids) {
  if (!uids || !uids.length) return;
  if (!state.convView) setConveyorView(true);
  const box = new THREE.Box3();
  for (const u of uids) { const o = objByUid.get(u); if (o) box.expandByObject(o); }
  if (box.isEmpty()) return;
  const centre = box.getCenter(new THREE.Vector3());
  const off = camera.position.clone().sub(controls.target);
  controls.target.copy(centre); camera.position.copy(centre).add(off);
  // flash
  const helper = new THREE.Box3Helper(box.clone().expandByScalar(cellSize() * 0.2), 0xffffff);
  scene.add(helper); let n = 0;
  const t = setInterval(() => { helper.visible = !helper.visible; if (++n > 7) { clearInterval(t); scene.remove(helper); } }, 180);
}

function rebuildMirrorPlanes() {
  mirrorGroup.clear();
  const c = cellSize(), size = 40 * c;
  const cols = { x: 0xff5555, y: 0x55dd77, z: 0x5599ff };
  for (const ax of ['x', 'y', 'z']) {
    if (!state.mirror[ax]) continue;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size),
      new THREE.MeshBasicMaterial({ color: cols[ax], transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false }));
    const pos = state.mirrorPos[ax] * c;
    if (ax === 'x') { m.rotation.y = Math.PI / 2; m.position.x = pos; }
    if (ax === 'y') { m.rotation.x = Math.PI / 2; m.position.y = pos; }
    if (ax === 'z') { m.position.z = pos; }
    m.raycast = () => {};
    mirrorGroup.add(m);
  }
}

function resize() {
  const r = canvas.parentElement.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / Math.max(1, r.height); camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(canvas.parentElement);

function loop() { controls.update(); renderer.render(scene, camera); requestAnimationFrame(loop); }

function setView(kind) {
  const c = cellSize();
  let centre = new THREE.Vector3(0, 0, 0), radius = 8 * c;
  const bb = new THREE.Box3();
  if (state.design.blocks.length) { bb.setFromObject(blockRoot); bb.getCenter(centre); radius = Math.max(bb.getSize(new THREE.Vector3()).length() * 0.75, 3 * c); }
  const d = radius / Math.tan((camera.fov * Math.PI / 180) / 2) * 0.9;
  const dir = { iso: [1.2, 0.9, 1], top: [0, 1, 0.0001], front: [0, 0.15, -1], side: [1, 0.15, 0], fit: null }[kind];
  let v = dir ? new THREE.Vector3(...dir).normalize() : camera.position.clone().sub(controls.target);
  if (v.lengthSq() < 1e-9) v = new THREE.Vector3(1.2, 0.9, 1);
  v.normalize();
  controls.target.copy(centre);
  camera.position.copy(centre).addScaledVector(v, d);
  camera.near = Math.max(0.01, d / 500); camera.far = d * 50; camera.updateProjectionMatrix();
}

// ---------------------------------------------------------------------------
// Picking & placement
// ---------------------------------------------------------------------------
const ray = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let hover = null;          // { kind:'block'|'plane', uid, cell, normal }
let fillStart = null;      // for shift-drag box fill

function pick(ev) {
  const r = canvas.getBoundingClientRect();
  mouse.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(mouse, camera);
  const c = cellSize();
  const targets = [...objByUid.values()].filter(o => o.visible);
  const hits = ray.intersectObjects(targets, true).filter(h => h.object.isMesh && h.face);
  if (hits.length) {
    const h = hits[0];
    const n = h.face.normal.clone().transformDirection(h.object.matrixWorld);
    const ax = [Math.abs(n.x), Math.abs(n.y), Math.abs(n.z)];
    const i = ax.indexOf(Math.max(...ax));
    const nAxis = [0, 0, 0]; nAxis[i] = Math.sign([n.x, n.y, n.z][i]) || 1;
    const pc = h.point.clone().divideScalar(c).addScaledVector(n, -0.01);
    const inside = [Math.floor(pc.x), Math.floor(pc.y), Math.floor(pc.z)];
    return { kind: 'block', uid: h.object.userData.uid, inside, normal: nAxis };
  }
  const ph = ray.intersectObject(pickPlane)[0];
  if (ph) {
    const p = ph.point.clone().divideScalar(c);
    return { kind: 'plane', inside: [Math.floor(p.x), state.layerY - 1, Math.floor(p.z)], normal: [0, 1, 0] };
  }
  return null;
}

/** Target empty cell next to hovered face (walk outward if still occupied by the same block). */
function targetCell(h) {
  let c = [h.inside[0] + h.normal[0], h.inside[1] + h.normal[1], h.inside[2] + h.normal[2]];
  for (let i = 0; i < 12 && h.kind === 'block' && occ.get(ck(...c)) === h.uid; i++)
    c = [c[0] + h.normal[0], c[1] + h.normal[1], c[2] + h.normal[2]];
  return c;
}

function placementAt(h, defId = state.selId, rot = state.rot) {
  const def = getDef(state.design, defId); if (!def) return null;
  const ws = rotatedSize(rot, def.size);
  const c = targetCell(h), n = h.normal, p = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    if (n[i] > 0) p[i] = c[i];
    else if (n[i] < 0) p[i] = c[i] - ws[i] + 1;
    else p[i] = c[i] - Math.floor((ws[i] - 1) / 2);
  }
  return { id: defId, p, r: rot, def, ws };
}

function mirroredVariants(pl) {
  const out = [{ p: pl.p, r: pl.r }];
  for (const ax of ['x', 'y', 'z']) {
    if (!state.mirror[ax]) continue;
    const i = { x: 0, y: 1, z: 2 }[ax], m = state.mirrorPos[ax];
    const add = [];
    for (const v of out) {
      const p = [...v.p]; p[i] = Math.round(2 * m - v.p[i] - pl.ws[i]);
      add.push({ p, r: mirrorRot(v.r, ax) });
    }
    out.push(...add);
  }
  const seen = new Set();
  return out.filter(v => { const k = v.p.join() + '|' + v.r; if (seen.has(k)) return false; seen.add(k); return true; });
}

function placeBlocks(list) {
  commit(() => {
    const extra = new Set();
    for (const pl of list) {
      for (const v of mirroredVariants(pl)) {
        const b = { id: pl.id, p: v.p, r: v.r, uid: uidSeq++ };
        if (state.color != null) b.color = state.color;
        if (!fits(b, pl.def, extra)) continue;
        for (const c of blockCells(b, pl.def)) extra.add(ck(...c));
        state.design.blocks.push(b);
      }
    }
  });
}

function eraseAt(h) {
  const b = state.design.blocks.find(x => x.uid === h.uid); if (!b) return;
  const def = getDef(state.design, b.id);
  const ws = rotatedSize(b.r, def.size);
  const victims = new Set([b.uid]);
  for (const v of mirroredVariants({ p: b.p, r: b.r, ws })) {
    const centre = v.p.map((x, i) => x + Math.floor(ws[i] / 2));
    const u = occ.get(ck(...centre)); if (u != null) victims.add(u);
  }
  commit(() => { state.design.blocks = state.design.blocks.filter(x => !victims.has(x.uid)); });
}

function paintAt(h) {
  commit(() => {
    const b = state.design.blocks.find(x => x.uid === h.uid); if (!b) return;
    const idx = state.design.blocks.indexOf(b);
    const nb = { ...b, uid: uidSeq++ };
    if (state.color == null) delete nb.color; else nb.color = state.color;
    state.design.blocks[idx] = nb;
  });
}

function pickAt(h) {
  const b = state.design.blocks.find(x => x.uid === h.uid); if (!b) return;
  selectBlockType(b.id); state.rot = b.r; updateRotLabel();
  if (b.color != null) { state.color = b.color; $('#colorPick').value = '#' + b.color.toString(16).padStart(6, '0'); $('#useColor').checked = true; }
  showBlockInfo(b);
}

function showGhost(h) {
  ghostGroup.clear();
  if (!h) return;
  const c = cellSize();
  if (state.tool === 'place') {
    const list = fillStart ? boxFillList(fillStart, h) : [placementAt(h)].filter(Boolean);
    let n = 0;
    const extra = new Set();
    for (const pl of list) {
      for (const v of mirroredVariants(pl)) {
        if (n++ > 400) break;
        const b = { p: v.p, r: v.r, color: state.color };
        const ok = fits(b, pl.def, extra);
        if (ok) for (const cc of blockCells(b, pl.def)) extra.add(ck(...cc));
        const g = buildBlockObject(pl.def, b, c, { ghost: true, ghostOk: ok });
        g.traverse(o => { o.raycast = () => {}; });
        ghostGroup.add(g);
        if (pl.def.ports && pl.def.ports.length && list.length === 1) drawGhostPorts(pl.def, b);
      }
    }
    const pl = list[0];
    let portTxt = '';
    if (pl && pl.def.ports && pl.def.ports.length && list.length === 1) {
      const st = ghostPortStatus(pl.def, { p: pl.p, r: pl.r });
      const con = st.filter(x => x.status === 'connected').length, mm = st.filter(x => x.status === 'mismatch').length;
      portTxt = ` · ports: ${con}/${st.length} would connect` + (mm ? `, ${mm} size mismatch` : '') + (con ? '' : ' (T = auto-rotate)');
      drawNearbyPorts(pl.p);
    }
    if (pl) $('#stCell').textContent = `Cell ${pl.p.join(', ')}` + (list.length > 1 ? ` · fill ${list.length}` : '') + portTxt;
  } else if (h.kind === 'block') {
    const o = objByUid.get(h.uid);
    if (o) {
      const box = new THREE.Box3().setFromObject(o);
      const helper = new THREE.Box3Helper(box, state.tool === 'erase' ? 0xff5555 : 0xffd33d);
      ghostGroup.add(helper);
    }
  }
}

// ---------------------------------------------------------------------------
// Port preview while placing
// ---------------------------------------------------------------------------
const PORT_COLORS = { connected: 0x3fb950, open: 0xc9d1d9, blocked: 0xd29922, mismatch: 0xff3b30 };
function existingPortMap() {
  const m = new Map();
  if (lastConv) for (const p of lastConv.ports) m.set(p.cell.join() + '|' + p.n.join(), p);
  return m;
}
/** Status of each port of a not-yet-placed block. */
function ghostPortStatus(def, b) {
  const map = existingPortMap();
  return worldPorts(b, def).map(p => {
    const nb = [p.cell[0] + p.n[0], p.cell[1] + p.n[1], p.cell[2] + p.n[2]];
    const q = map.get(nb.join() + '|' + p.n.map(v => -v).join());
    const status = q ? (q.size === p.size ? 'connected' : 'mismatch') : occ.has(ck(...nb)) ? 'blocked' : 'open';
    return { ...p, status };
  });
}
function portMarker(p, color, { scale = 1, opacity = 1, onTop = true } = {}) {
  const c = cellSize();
  const sz = (p.size === 'L' ? 0.62 : 0.28) * scale;
  const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({ color, depthTest: !onTop, transparent: true, opacity }));
  m.position.set((p.cell[0] + 0.5 + p.n[0] * 0.5) * c, (p.cell[1] + 0.5 + p.n[1] * 0.5) * c, (p.cell[2] + 0.5 + p.n[2] * 0.5) * c);
  m.scale.set(p.n[0] ? 0.08 * c : sz * c, p.n[1] ? 0.08 * c : sz * c, p.n[2] ? 0.08 * c : sz * c);
  m.renderOrder = 30; m.raycast = () => {};
  return m;
}
function drawGhostPorts(def, b) {
  const c = cellSize();
  for (const p of ghostPortStatus(def, b)) {
    ghostGroup.add(portMarker(p, PORT_COLORS[p.status]));
    // small stub showing which way the port faces
    const from = new THREE.Vector3((p.cell[0] + 0.5 + p.n[0] * 0.5) * c, (p.cell[1] + 0.5 + p.n[1] * 0.5) * c, (p.cell[2] + 0.5 + p.n[2] * 0.5) * c);
    const a = makeArrow(from, p.n, c * 0.45, PORT_COLORS[p.status]);
    a.traverse(o => { if (o.material) { o.material.depthTest = false; o.material.transparent = true; } o.renderOrder = 31; o.raycast = () => {}; });
    ghostGroup.add(a);
  }
}
/** Show existing open ports near the cursor, so you can see what to connect to. */
function drawNearbyPorts(p0) {
  if (!lastConv) return;
  const R = state.design.grid === 'L' ? 6 : 14;
  for (const p of lastConv.ports) {
    if (p.status !== 'open') continue;
    if (Math.abs(p.cell[0] - p0[0]) > R || Math.abs(p.cell[1] - p0[1]) > R || Math.abs(p.cell[2] - p0[2]) > R) continue;
    ghostGroup.add(portMarker(p, p.size === 'L' ? 0x58a6ff : 0x39c5cf, { scale: 0.7, opacity: 0.45 }));
  }
}
/** Rotate the selected block so that the most ports connect at the hovered spot (thrusters keep their thrust direction). */
function autoRotate() {
  if (!hover || state.tool !== 'place') { toast('Point at where you want to place the block, then press T'); return; }
  const def = getDef(state.design, state.selId);
  if (!def || !def.ports || !def.ports.length) { toast(`${def ? def.name : 'This block'} has no conveyor ports`); return; }
  const keepDir = def.thrust ? thrustDirOf(state.rot).join() : null;
  let best = null;
  for (let k = 0; k < ROTS.length; k++) {
    const r = (state.rot + k) % ROTS.length;
    if (keepDir && thrustDirOf(r).join() !== keepDir) continue;
    const pl = placementAt(hover, state.selId, r); if (!pl) continue;
    const b = { p: pl.p, r };
    if (!fits(b, def)) continue;
    const st = ghostPortStatus(def, b);
    const score = st.filter(x => x.status === 'connected').length * 10 - st.filter(x => x.status === 'mismatch').length * 5 - st.filter(x => x.status === 'blocked').length;
    if (!best || score > best.score) best = { r, score, con: st.filter(x => x.status === 'connected').length };
  }
  if (!best || best.con === 0) { toast('No orientation connects a port here. Try another spot, or check the port sizes.'); return; }
  state.rot = best.r; updateRotLabel(); showGhost(hover);
  toast(`Rotated: ${best.con} port${best.con > 1 ? 's' : ''} will connect`);
}

function boxFillList(start, h) {
  const a = placementAt(start), b = placementAt(h);
  if (!a || !b) return [];
  const ws = a.ws, out = [];
  const lo = a.p.map((v, i) => Math.min(v, b.p[i])), hi = a.p.map((v, i) => Math.max(v, b.p[i]));
  const cnt = lo.map((v, i) => Math.floor((hi[i] - v) / ws[i]) + 1);
  if (cnt[0] * cnt[1] * cnt[2] > 4000) return [a];
  for (let x = 0; x < cnt[0]; x++) for (let y = 0; y < cnt[1]; y++) for (let z = 0; z < cnt[2]; z++) {
    const p = [a.p[0] <= b.p[0] ? a.p[0] + x * ws[0] : a.p[0] - x * ws[0],
               a.p[1] <= b.p[1] ? a.p[1] + y * ws[1] : a.p[1] - y * ws[1],
               a.p[2] <= b.p[2] ? a.p[2] + z * ws[2] : a.p[2] - z * ws[2]];
    out.push({ ...a, p });
  }
  return out;
}

let downPos = null;
canvas.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  downPos = [e.clientX, e.clientY];
  if (state.tool === 'place' && e.shiftKey) { const h = pick(e); if (h) { fillStart = h; canvas.setPointerCapture(e.pointerId); } }
});
canvas.addEventListener('pointermove', e => {
  hover = pick(e);
  showGhost(hover);
  updateHoverInfo(hover);
});
canvas.addEventListener('pointerleave', () => { ghostGroup.clear(); $('#hoverInfo').style.display = 'none'; });
canvas.addEventListener('pointerup', e => {
  if (e.button !== 0 || !downPos) return;
  const moved = Math.hypot(e.clientX - downPos[0], e.clientY - downPos[1]) > 5;
  downPos = null;
  const h = pick(e);
  if (fillStart) { const list = h ? boxFillList(fillStart, h) : []; fillStart = null; if (list.length) placeBlocks(list); showGhost(pick(e)); return; }
  if (moved || !h) return;
  if (state.tool === 'place') { const pl = placementAt(h); if (pl) placeBlocks([pl]); }
  else if (h.kind === 'block') {
    if (state.tool === 'erase') eraseAt(h);
    else if (state.tool === 'paint') paintAt(h);
    else if (state.tool === 'pick') pickAt(h);
  }
  showGhost(pick(e));
});

function updateHoverInfo(h) {
  const el = $('#hoverInfo');
  if (!h || h.kind !== 'block') { el.style.display = 'none'; return; }
  const b = state.design.blocks.find(x => x.uid === h.uid); if (!b) { el.style.display = 'none'; return; }
  const def = getDef(state.design, b.id);
  let t = `<b>${def.name}</b><br><span class="muted">${fmt.kg(def.mass)} · ${def.size.join('×')}</span>`;
  if (def.thrust) {
    const d = DIRS.find(x => x.v.join() === thrustDirOf(b.r).join());
    const eff = thrusterEffectiveness(def.thrust.type, S().density);
    t += `<br>Pushes ship <b>${d.name}</b> · ${fmt.N(def.thrust.f * eff)} (${Math.round(eff * 100)}%)`;
  }
  if (def.inv) t += `<br>Cargo ${fmt.L(def.inv * S().invMult)}`;
  if (lastConv && def.ports && def.ports.length) {
    const x = lastConv.byUid.get(b.uid);
    const net = lastConv.netOf.get(b.uid);
    const con = x ? x.ports.filter(p => p.status === 'connected').length : 0;
    const L = def.ports.filter(p => p.s === 'L').length, Sm = def.ports.length - L;
    t += `<br>Conveyor: ${L ? L + ' large' : ''}${L && Sm ? ' + ' : ''}${Sm ? Sm + ' small' : ''} port(s), ${con} connected · system #${net + 1}`;
    const st = lastConv.status.get(b.uid);
    if (st && st !== 'ok') t += `<br><span style="color:${st === 'error' ? '#f85149' : '#d29922'}">${st === 'isolated' ? 'Not connected to anything' : lastConv.issues.filter(i => i.uids.includes(b.uid)).map(i => i.title).join('; ')}</span>`;
  } else if (state.convView) t += `<br><span class="muted">No conveyor ports</span>`;
  el.innerHTML = t; el.style.display = 'block';
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------
window.addEventListener('keydown', e => {
  if (e.target.matches('select, textarea, input:not([type=checkbox]):not([type=range]):not([type=color]):not([type=radio])')) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); redo(); return; }
  if ((e.ctrlKey || e.metaKey) && k === 's') { e.preventDefault(); saveToBrowser(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const dir = e.shiftKey ? -1 : 1;
  // WASD tilts the block's front up/down/left/right, Q/E roll it left/right
  if (k === 'w') rotateSel('x', 1);
  else if (k === 's') rotateSel('x', -1);
  else if (k === 'a') rotateSel('y', 1);
  else if (k === 'd') rotateSel('y', -1);
  else if (k === 'q') rotateSel('z', 1);
  else if (k === 'e') rotateSel('z', -1);
  else if (k === 'r') rotateSel('y', dir);
  else if (k === 'f') rotateSel('x', dir);
  else if (k === 'v') rotateSel('z', dir);
  else if (k === 'c') setConveyorView(!state.convView);
  else if (k === 't') autoRotate();
  else if (k === 'x') { state.rot = 0; updateRotLabel(); showGhost(hover); }
  else if (['1', '2', '3', '4'].includes(k)) setTool(['place', 'erase', 'pick', 'paint'][+k - 1]);
  else if (k === 'pageup' || k === ']') setLayer(state.layerY + 1);
  else if (k === 'pagedown' || k === '[') setLayer(state.layerY - 1);
  else if (k === 'escape') { fillStart = null; showGhost(hover); }
});
function rotateSel(ax, dir) { state.rot = rotateAbout(state.rot, ax, dir); updateRotLabel(); showGhost(hover); }
function updateRotLabel() {
  const def = getDef(state.design, state.selId);
  let s = '';
  if (def && def.thrust) { const d = DIRS.find(x => x.v.join() === thrustDirOf(state.rot).join()); s = `→ pushes ${d.name}`; }
  else { const f = applyRot(state.rot, [0, 0, -1]); const d = DIRS.find(x => x.v.join() === f.join()); s = `front faces ${d.name}`; }
  $('#rotLabel').textContent = s;
  const pi = $('#portInfo');
  if (pi) {
    if (def && def.ports && def.ports.length) {
      const items = def.ports.map(p => {
        const w = applyRot(state.rot, p.n); const d = DIRS.find(x => x.v.join() === w.join());
        return `<span class="pt ${p.s}">${p.s === 'L' ? 'Large' : 'Small'} → ${d.name}</span>`;
      });
      pi.innerHTML = `Ports: ${items.join(' ')}`;
    } else pi.innerHTML = def ? '<span class="muted">No conveyor ports</span>' : '';
  }
}

// ---------------------------------------------------------------------------
// Left panel
// ---------------------------------------------------------------------------
function allDefsForGrid() {
  const g = state.design.grid;
  const list = Object.values(BLOCKS).filter(b => b.grid === g);
  for (const cb of Object.values(state.design.customBlocks || {})) if (cb.grid === g) list.push(cb);
  return list;
}
function renderPalette() {
  const q = $('#blockSearch').value.trim().toLowerCase();
  const pal = $('#palette'); pal.innerHTML = '';
  const defs = allDefsForGrid();
  for (const cat of CATEGORIES) {
    const items = defs.filter(d => d.cat === cat.id && (!q || d.name.toLowerCase().includes(q)));
    if (!items.length) continue;
    const div = document.createElement('div'); div.className = 'cat';
    div.innerHTML = `<div class="cathead">▾ ${cat.name} <span class="muted">(${items.length})</span></div><div class="blist"></div>`;
    div.firstChild.onclick = () => div.classList.toggle('closed');
    const bl = div.lastChild;
    for (const d of items) {
      const it = document.createElement('div');
      it.className = 'bitem' + (d.id === state.selId ? ' sel' : '');
      it.title = `${d.name}\n${d.size.join('×')} cells · ${fmt.kg(d.mass)}` + (d.thrust ? `\n${fmt.N(d.thrust.f)} ${THRUSTER_TYPES[d.thrust.type].name}` : '') + (d.approx ? '\n≈ value from older game data' : '');
      const col = '#' + blockColor(d).toString(16).padStart(6, '0');
      const meta = d.thrust ? fmt.N(d.thrust.f) : d.inv ? fmt.L(d.inv) : fmt.kg(d.mass);
      it.innerHTML = `<span class="sw" style="background:${col}"></span><span>${d.name}${d.approx ? ' <span class="muted">≈</span>' : ''}</span><span class="meta">${d.size.join('×')} · ${meta}</span>`;
      it.onclick = () => { selectBlockType(d.id); setTool('place'); };
      bl.appendChild(it);
    }
    pal.appendChild(div);
  }
}
function selectBlockType(id) {
  state.selId = id; renderPalette(); updateRotLabel();
  const def = getDef(state.design, id);
  $('#stSel').textContent = def ? `Selected: ${def.name}` : '';
}
function setTool(t) {
  state.tool = t;
  $$('#toolSeg button').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
  showGhost(hover);
}
function setLayer(y) {
  state.layerY = y; $('#layerY').value = y;
  const c = cellSize(); gridHelper.position.y = y * c; pickPlane.position.y = y * c;
  pickPlane.updateMatrixWorld();
  showGhost(hover);
}

function showBlockInfo(b) {
  const def = getDef(state.design, b.id);
  const base = BLOCKS[b.id] || state.design.customBlocks[b.id];
  const ov = state.design.overrides[b.id];
  const html = `<div class="box"><button class="close" data-close>×</button>
    <h2>${def.name}</h2>
    <div class="kv">
      <span class="k">Grid</span><span class="v">${GRID[def.grid].name}</span>
      <span class="k">Size</span><span class="v">${def.size.join(' × ')} cells (${def.size.map(s => s * GRID[def.grid].cell).join(' × ')} m)</span>
      <span class="k">Mass</span><span class="v">${fmt.kg(def.mass)} ${def.approx && !ov ? '<span class="muted">≈ older data</span>' : ''}</span>
      ${def.inv ? `<span class="k">Inventory (×1)</span><span class="v">${fmt.L(def.inv)}</span>` : ''}
      ${def.invOre ? `<span class="k">Ore inventory (×1)</span><span class="v">${fmt.L(def.invOre)}</span>` : ''}
      ${def.thrust ? `<span class="k">Thrust</span><span class="v">${fmt.N(def.thrust.f)} · ${THRUSTER_TYPES[def.thrust.type].name}</span>
        <span class="k">Power / H₂</span><span class="v">${def.thrust.p ? def.thrust.p + ' MW' : '—'} / ${def.thrust.h2 ? def.thrust.h2 + ' L/s' : '—'}</span>` : ''}
      ${def.pOut ? `<span class="k">Power output</span><span class="v">${def.pOut} MW</span>` : ''}
      ${def.store ? `<span class="k">Storage</span><span class="v">${def.store} MWh</span>` : ''}
      ${def.h2 ? `<span class="k">H₂ capacity</span><span class="v">${fmt.L(def.h2)}</span>` : ''}
      <span class="k">Placed on this design</span><span class="v">${state.design.blocks.filter(x => x.id === b.id).length}</span>
    </div>
    <h4>Override for this design</h4>
    <div class="formgrid">
      <label>Mass (kg)</label><input type="number" id="ovMass" value="${def.mass}">
      ${def.thrust ? `<label>Thrust (N)</label><input type="number" id="ovThrust" value="${def.thrust.f}">` : ''}
      ${def.inv ? `<label>Inventory (L)</label><input type="number" id="ovInv" value="${def.inv}">` : ''}
    </div>
    <div class="row right"><button id="ovReset">Reset to default</button><button class="primary" id="ovApply">Apply</button></div></div>`;
  const m = document.createElement('div'); m.className = 'modal'; m.innerHTML = html;
  document.body.appendChild(m);
  const close = () => m.remove();
  m.addEventListener('click', e => { if (e.target === m || e.target.dataset.close != null) close(); });
  $('#ovApply', m).onclick = () => {
    const o = {};
    const mass = +$('#ovMass', m).value; if (mass !== base.mass) o.mass = mass;
    if ($('#ovThrust', m)) { const f = +$('#ovThrust', m).value; if (f !== base.thrust.f) o.thrust = { f }; }
    if ($('#ovInv', m)) { const v = +$('#ovInv', m).value; if (v !== base.inv) o.inv = v; }
    if (Object.keys(o).length) { o.approx = false; state.design.overrides[b.id] = o; } else delete state.design.overrides[b.id];
    clearScene(); changed(); renderPalette(); close();
  };
  $('#ovReset', m).onclick = () => { delete state.design.overrides[b.id]; clearScene(); changed(); renderPalette(); close(); };
}

// ---------------------------------------------------------------------------
// Analysis panel
// ---------------------------------------------------------------------------
let analysisQueued = false;
function queueAnalysis() { if (analysisQueued) return; analysisQueued = true; requestAnimationFrame(() => { analysisQueued = false; renderAnalysis(); }); }

const statusText = { ok: 'OK', marginal: 'Low', fail: "Can't lift", none: 'None' };
const dirHint = {
  up: 'level flight / hover (belly to the ground)',
  down: 'flying upside-down',
  forward: 'nose pointing at the sky (rocket launch)',
  back: 'tail pointing at the sky',
  left: 'left side up (banked 90°)',
  right: 'right side up (banked 90°)',
};

function renderAnalysis() {
  const d = state.design, env = S();
  const a = analyse(d, env);
  lastAnalysis = a;
  rebuildOverlays();
  const station = d.type === 'station';
  const g = env.g;

  $('#stCount').textContent = `${a.blockCount} blocks` + (a.bounds ? ` · ${a.bounds.meters.map(v => v.toFixed(1)).join(' × ')} m` : '');

  // Mass ------------------------------------------------------------------
  const cargoLine = a.mult > 1
    ? `<span class="k">Cargo mass (game shows)</span><span class="v">${fmt.kg(a.cargoMassShown)}</span>
       <span class="k">Cargo mass (physics, ÷${a.mult})</span><span class="v">${fmt.kg(a.cargoMassPhys)}</span>`
    : `<span class="k">Cargo mass</span><span class="v">${fmt.kg(a.cargoMassPhys)}</span>`;
  $('#massSection').innerHTML = `<h3>Mass &amp; weight</h3>
    <div class="kv">
      <span class="k">Blocks (dry mass)</span><span class="v">${fmt.kg(a.dryMass)}</span>
      ${a.extra ? `<span class="k">Extra mass</span><span class="v">${fmt.kg(a.extra)}</span>` : ''}
      <span class="k">Empty ship</span><span class="v big">${fmt.kg(a.emptyMass)}</span>
      <span class="k">Cargo space (×${a.mult})</span><span class="v">${fmt.L(a.fillableBaseL * a.mult)}</span>
      <span class="k">Cargo loaded (${Math.round(a.fill * 100)}% ${a.item.name.toLowerCase()})</span><span class="v">${fmt.L(a.cargoVolL)}</span>
      ${cargoLine}
      <span class="k">Full ship${a.mult > 1 ? ' (physics)' : ''}</span><span class="v big">${fmt.kg(a.loadedMass)}</span>
      ${a.mult > 1 ? `<span class="k">Full ship (as game HUD shows)</span><span class="v">${fmt.kg(a.loadedMassShown)}</span>` : ''}
      <span class="k">Weight empty @ ${fmt.num(g)} g</span><span class="v">${fmt.N(a.weightEmptyN)}</span>
      <span class="k">Weight full @ ${fmt.num(g)} g</span><span class="v">${fmt.N(a.weightLoadedN)}</span>
    </div>
    ${a.capMinorL && !env.fillMinor ? `<div class="small muted" style="margin-top:4px">+ ${fmt.L((a.capMinorL + a.capOreL) * a.mult)} in connectors/tools not counted (tick the box above to include).</div>` : ''}`;

  // Thrust table ----------------------------------------------------------
  if (station) {
    $('#thrustSection').innerHTML = `<h3>Thrust</h3><div class="note">Station / base mode: the grid is anchored to the ground, so no thrust is needed. Mass and cargo figures still apply. Switch to <b>Ship</b> to check flight.</div>`;
    $('#suggestSection').innerHTML = ''; $('#planetSection').innerHTML = '';
  } else {
    const rows = a.dirs.map(r => {
      const twr = isFinite(r.twrLoaded) ? r.twrLoaded : null;
      const pct = twr == null ? 100 : Math.min(100, twr / Math.max(env.targetTwr, 1) * 100);
      const col = r.status === 'ok' ? 'var(--ok)' : r.status === 'marginal' ? 'var(--warn)' : 'var(--bad)';
      const types = Object.entries(r.byType).map(([t, v]) => `${v.count} ${THRUSTER_TYPES[t].name} @${Math.round(v.effPct * 100)}%`).join(', ');
      return `<tr title="Thrust toward ${r.name}: needed for ${dirHint[r.id]}.\n${types || 'No thrusters'}">
        <td><b>${r.name}</b><div class="small muted">${r.count} thr.</div></td>
        <td>${fmt.N(r.eff)}${r.eff !== r.raw ? `<div class="small muted">of ${fmt.N(r.raw)}</div>` : ''}</td>
        <td>${fmt.num(r.accEmpty, 1)}<div class="small muted">${fmt.num(r.accLoaded, 1)}</div></td>
        <td>${g > 0 ? `${twr == null ? '∞' : twr.toFixed(2)}<div class="bar"><div style="width:${pct}%;background:${col}"></div></div>` : '—'}</td>
        <td><span class="pill ${r.status}">${g > 0 ? statusText[r.status] : (r.count ? 'OK' : 'None')}</span></td></tr>`;
    }).join('');
    const up = a.dirs.find(x => x.id === 'up');
    let notes = '';
    if (g > 0 && up) {
      notes += `<div class="note ${up.status === 'ok' ? '' : 'warn'}">Level hover with full cargo needs <b>${fmt.N(a.weightLoadedN)}</b> of Up thrust (${fmt.N(up.requiredN)} for TWR ${env.targetTwr}).
        You have <b>${fmt.N(up.eff)}</b>, so the ship can carry up to <b>${fmt.kg(up.maxCargoShownKg)}</b> of cargo${a.mult > 1 ? ' (as the game shows it)' : ''} at TWR ${env.targetTwr}.
        ${up.netUpLoaded > 0 ? `It climbs at ${fmt.num(up.netUpLoaded, 1)} m/s² when full.` : up.eff > 0 ? `When full it sinks at ${fmt.num(-up.netUpLoaded, 1)} m/s² even at full thrust.` : ''}</div>`;
    }
    const dens = env.density;
    if (dens > 0 && a.dirs.some(r => r.byType.ion)) notes += `<div class="note warn">Ion thrusters are only ${Math.round(thrusterEffectiveness('ion', dens) * 100)}% effective at air density ${dens.toFixed(2)}.</div>`;
    if (dens < 0.3 && a.dirs.some(r => r.byType.atmo)) notes += `<div class="note warn">Atmospheric thrusters give ${Math.round(thrusterEffectiveness('atmo', dens) * 100)}% thrust at air density ${dens.toFixed(2)} (they need at least 0.3).</div>`;
    $('#thrustSection').innerHTML = `<h3>Thrust by direction</h3>
      <table class="t"><thead><tr><th>Toward</th><th>Eff. thrust</th><th>Accel m/s²<br><span class="small">empty/full</span></th><th>TWR full</th><th></th></tr></thead><tbody>${rows}</tbody></table>
      <div class="small muted" style="margin-top:4px">“Toward Up” = thrusters with nozzles facing down. Each row shows whether the ship can hold itself up with that side facing the sky. Hover a row for details.</div>
      ${notes}`;

    // Suggestions -------------------------------------------------------
    const sd = env.suggestDir || 'up';
    const dr = a.dirs.find(x => x.id === sd);
    const thr = allDefsForGrid().filter(x => x.thrust);
    const sug = thr.map(def => {
      const n = thrustersNeeded(def, env, a.loadedMass, dr.eff);
      const eff = thrusterEffectiveness(def.thrust.type, env.density);
      return { def, n, eff };
    }).sort((x, y) => (x.n && x.n.possible ? x.n.count * x.def.mass : 1e15) - (y.n && y.n.possible ? y.n.count * y.def.mass : 1e15));
    const sugRows = g <= 0 ? '' : sug.map(({ def, n, eff }) => `<tr>
      <td>${def.name}<div class="small muted">${THRUSTER_TYPES[def.thrust.type].name} · ${Math.round(eff * 100)}%</div></td>
      <td>${fmt.N(def.thrust.f * eff)}</td>
      <td>${!n || !n.possible ? '<span class="pill fail">no lift</span>' : n.count === 0 ? '<span class="pill ok">enough</span>' : `<b>+${n.count}</b>`}</td>
      <td>${n && n.possible && n.count ? fmt.kg(n.count * def.mass) : ''}</td></tr>`).join('');
    $('#suggestSection').innerHTML = `<h3>Thrusters to add</h3>
      <div class="dirsel">${DIRS.map(x => `<button data-sdir="${x.id}" class="${x.id === sd ? 'on' : ''}">${x.name}</button>`).join('')}</div>
      ${g <= 0 ? '<div class="small muted">No gravity: any thrust moves the ship. Set a planet to size thrusters for lift.</div>' :
      `<div class="small muted">Extra thrusters (of one type) needed toward <b>${dr.name}</b> to reach TWR ${env.targetTwr} with full cargo on this planet, counting their own mass. Sorted by the mass they add.</div>
      <table class="t"><thead><tr><th>Thruster</th><th>Each (eff.)</th><th>Add</th><th>Adds mass</th></tr></thead><tbody>${sugRows}</tbody></table>`}`;

    // Planet comparison ---------------------------------------------------
    const prow = PLANETS.filter(p => p.id !== 'custom' && p.id !== 'space').map(p => {
      const e2 = { ...env, g: p.g, density: p.density };
      const a2 = analyse(d, e2);
      const r2 = a2.dirs.find(x => x.id === sd);
      return `<tr class="${p.id === env.planetId ? 'hl' : ''}"><td>${p.name}</td><td>${p.g}</td><td>${p.density}</td>
        <td>${fmt.N(r2.eff)}</td><td>${isFinite(r2.twrEmpty) ? r2.twrEmpty.toFixed(2) : '∞'}</td><td>${isFinite(r2.twrLoaded) ? r2.twrLoaded.toFixed(2) : '∞'}</td>
        <td><span class="pill ${r2.status}">${statusText[r2.status]}</span></td></tr>`;
    }).join('');
    $('#planetSection').innerHTML = `<h3>Where can it fly? (toward ${dr.name}, surface)</h3>
      <table class="t"><thead><tr><th>Planet</th><th>g</th><th>Air</th><th>Thrust</th><th>TWR empty</th><th>TWR full</th><th></th></tr></thead><tbody>${prow}</tbody></table>`;
    $$('[data-sdir]').forEach(b => b.onclick = () => { env.suggestDir = b.dataset.sdir; autosave(); renderAnalysis(); });
  }

  // Conveyors ----------------------------------------------------------------
  lastConv = analyseConveyors(d);
  if (state.convView) { applyConveyorView(); rebuildOverlays(); }
  renderConveyorSection(lastConv);

  // Power & fuel ------------------------------------------------------------
  const worstDirPower = Math.max(0, ...a.dirs.map(r => r.powerMW));
  const upD = a.dirs.find(x => x.id === 'up');
  const pwOk = a.pOut >= worstDirPower;
  $('#powerSection').innerHTML = `<h3>Power &amp; fuel</h3>
    <div class="kv">
      <span class="k">Power output (reactors, batteries, engines)</span><span class="v">${fmt.num(a.pOut)} MW</span>
      <span class="k">Battery storage</span><span class="v">${fmt.num(a.store)} MWh</span>
      <span class="k">Electric thrusters, one direction at full</span><span class="v">${fmt.num(worstDirPower)} MW</span>
      <span class="k">All electric thrusters at full</span><span class="v">${fmt.num(a.thrusterPowerAll)} MW</span>
      <span class="k">Hydrogen capacity</span><span class="v">${fmt.L(a.h2Cap)}</span>
      ${upD && upD.h2Ls ? `<span class="k">Up H₂ thrusters at full</span><span class="v">${fmt.num(upD.h2Ls, 0)} L/s · ${fmt.time(upD.h2BurnFullS)}</span>` : ''}
      ${upD && upD.h2HoverS && !station ? `<span class="k">Hover time on H₂ (full cargo)</span><span class="v">≈ ${fmt.time(upD.h2HoverS)}</span>` : ''}
      ${a.o2Cap ? `<span class="k">Oxygen capacity</span><span class="v">${fmt.L(a.o2Cap)}</span>` : ''}
    </div>
    ${worstDirPower > 0 && !pwOk ? `<div class="note warn">Electric thrusters can draw ${fmt.num(worstDirPower)} MW in one direction but the grid only makes ${fmt.num(a.pOut)} MW, so they'll run below full thrust.</div>` : ''}
    ${upD && upD.h2Ls && !a.h2Cap ? `<div class="note warn">Hydrogen thrusters but no hydrogen tank.</div>` : ''}`;

  // Bill of blocks ------------------------------------------------------------
  const bomRows = a.bom.map(e => `<tr><td>${e.name}</td><td>${e.count}</td><td>${fmt.kg(e.mass)}</td><td>${a.dryMass ? (e.mass / a.dryMass * 100).toFixed(1) : 0}%</td></tr>`).join('');
  $('#bomSection').innerHTML = `<h3>Blocks (${a.blockCount})</h3>
    ${a.bom.length ? `<table class="t"><thead><tr><th>Block</th><th>#</th><th>Mass</th><th>Share</th></tr></thead><tbody>${bomRows}</tbody></table>` : '<div class="muted">Nothing placed yet.</div>'}
    ${a.bounds ? `<div class="small muted" style="margin-top:6px">Footprint ${a.bounds.cells.join(' × ')} cells = ${a.bounds.meters.map(v => v.toFixed(1)).join(' × ')} m (W × H × L)</div>` : ''}
    ${a.missing.length ? `<div class="note warn">${a.missing.length} blocks reference unknown definitions and were ignored.</div>` : ''}`;
}

function renderConveyorSection(cv) {
  const el = $('#conveyorSection');
  if (!cv.portBlocks) {
    el.innerHTML = `<h3>Conveyor systems</h3><div class="muted">No blocks with conveyor ports yet.</div>`; return;
  }
  const nets = cv.networks.map((n, i) => {
    const roles = Object.entries(n.roles).map(([r, c]) => `${c} ${cv.roleName(r).toLowerCase()}${c > 1 ? 's' : ''}`).join(', ');
    const col = '#' + NET_COLORS[i % NET_COLORS.length].toString(16).padStart(6, '0');
    return `<div class="netrow" data-net="${i}"><i style="background:${col}"></i><b>#${i + 1}</b> <span>${n.uids.length} block${n.uids.length > 1 ? 's' : ''}${roles ? ' · ' + roles : ''}</span></div>`;
  }).join('');
  const h = cv.h2;
  const checks = [];
  if (h.users) checks.push([h.tanks && h.usersOk === h.users ? 'ok' : 'fail', `Hydrogen thrusters/engines fed by a tank: ${h.usersOk}/${h.users}`]);
  if (h.tanks) checks.push([h.tanksRefuel === h.tanks ? 'ok' : 'marginal', `Hydrogen tanks reachable from a connector: ${h.tanksRefuel}/${h.tanks}`]);
  const errs = cv.issues.filter(i => i.level === 'error').length, warns = cv.issues.length - errs;
  checks.unshift([errs ? 'fail' : warns ? 'marginal' : 'ok', errs || warns ? `${errs} error(s), ${warns} warning(s)` : 'All conveyor checks pass']);
  const issues = cv.issues.map((it, i) => `<div class="issue ${it.level}"><div><span class="pill ${it.level === 'error' ? 'fail' : 'marginal'}">${it.level === 'error' ? 'Error' : 'Warning'}</span> <b>${escapeHtml(it.title)}</b>
     <button class="mini right" data-issue="${i}">Show</button></div><div class="small muted">${escapeHtml(it.detail)}</div></div>`).join('');
  el.innerHTML = `<h3>Conveyor systems <button class="mini right ${state.convView ? 'on' : ''}" id="convToggle2">${state.convView ? 'Hide' : 'Show'} conveyor view</button></h3>
    ${checks.map(([s, t]) => `<div class="check"><span class="pill ${s}">${s === 'ok' ? '✓' : s === 'fail' ? '✗' : '!'}</span> ${t}</div>`).join('')}
    <div class="small muted" style="margin:6px 0 2px">${cv.networks.length} separate conveyor system${cv.networks.length > 1 ? 's' : ''} (blocks joined by matching ports):</div>
    <div class="nets">${nets}</div>
    ${issues}`;
  $('#convToggle2').onclick = () => setConveyorView(!state.convView);
  $$('[data-issue]', el).forEach(b => b.onclick = () => focusBlocks(cv.issues[+b.dataset.issue].uids));
  $$('[data-net]', el).forEach(b => b.onclick = () => focusBlocks(cv.networks[+b.dataset.net].uids));
}

// ---------------------------------------------------------------------------
// Environment controls
// ---------------------------------------------------------------------------
function initEnvControls() {
  $('#planet').innerHTML = PLANETS.map(p => `<option value="${p.id}">${p.name}${p.id !== 'custom' ? ` — ${p.g} g` : ''}</option>`).join('');
  $('#invMult').innerHTML = INVENTORY_MULTIPLIERS.map(m => `<option value="${m}">${m === 1 ? 'Realistic (×1)' : '×' + m}</option>`).join('');
  $('#cargoItem').innerHTML = ITEMS.map(i => `<option value="${i.id}">${i.name}${i.id !== 'custom' ? ` (${(1 / i.lPerKg).toFixed(1)} kg/L)` : ''}</option>`).join('');
  $('#planet').onchange = e => {
    const p = PLANETS.find(x => x.id === e.target.value);
    S().planetId = p.id;
    if (p.id !== 'custom') { S().g = p.g; S().density = p.density; }
    envToUi(); envChanged();
  };
  $('#gravity').oninput = e => { S().g = Math.max(0, +e.target.value || 0); markCustomPlanet(); envChanged(); };
  $('#density').oninput = e => { S().density = +e.target.value; $('#densityVal').textContent = S().density.toFixed(2); envChanged(); };
  $('#invMult').onchange = e => { S().invMult = +e.target.value; envChanged(); };
  $('#cargoItem').onchange = e => { S().itemId = e.target.value; envToUi(); envChanged(); };
  $('#customLPerKg').oninput = e => { S().customLPerKg = +e.target.value; envChanged(); };
  $('#fillPct').oninput = e => { S().fillPct = +e.target.value; $('#fillVal').textContent = S().fillPct + '%'; envChanged(); };
  $('#extraMass').oninput = e => { S().extraMass = Math.max(0, +e.target.value || 0); envChanged(); };
  $('#targetTwr').oninput = e => { S().targetTwr = Math.max(0.1, +e.target.value || 1.5); envChanged(); };
  $('#fillMinor').onchange = e => { S().fillMinor = e.target.checked; envChanged(); };
}
function markCustomPlanet() {
  const p = PLANETS.find(x => x.id === S().planetId);
  if (p && p.id !== 'custom' && Math.abs(p.g - S().g) > 1e-9) { S().planetId = 'custom'; $('#planet').value = 'custom'; }
}
function envToUi() {
  const s = S();
  $('#planet').value = s.planetId; $('#gravity').value = s.g;
  $('#density').value = s.density; $('#densityVal').textContent = (+s.density).toFixed(2);
  $('#invMult').value = s.invMult; $('#cargoItem').value = s.itemId; $('#customLPerKg').value = s.customLPerKg;
  $$('.customDensity').forEach(e => e.style.display = s.itemId === 'custom' ? '' : 'none');
  $('#fillPct').value = s.fillPct; $('#fillVal').textContent = s.fillPct + '%';
  $('#extraMass').value = s.extraMass; $('#targetTwr').value = s.targetTwr; $('#fillMinor').checked = s.fillMinor;
  const p = PLANETS.find(x => x.id === s.planetId);
  $('#envNote').textContent = s.g > 0
    ? `Gravity ${(s.g * G0).toFixed(2)} m/s². Air density ${(+s.density).toFixed(2)}: set it lower to model higher altitude (atmosphere thins toward its edge).`
    : 'Zero gravity: weight and TWR don\'t apply; acceleration is still shown.';
}
function envChanged() { queueAnalysis(); autosave(); }

// ---------------------------------------------------------------------------
// Design management
// ---------------------------------------------------------------------------
function loadDesign(d, { keepUndo = false } = {}) {
  const base = newDesign(d.grid || 'L');
  const design = { ...base, ...d, settings: { ...base.settings, ...(d.settings || {}) }, customBlocks: d.customBlocks || {}, overrides: d.overrides || {} };
  // merge global custom library
  const lib = readJSON(LS_CUSTOM, {});
  for (const [k, v] of Object.entries(lib)) if (!design.customBlocks[k]) design.customBlocks[k] = v;
  design.blocks = withUids((d.blocks || []).map(b => ({ id: b.id, p: b.p, r: b.r || 0, ...(b.color != null ? { color: b.color } : {}) })));
  state.design = design;
  if (!keepUndo) { state.undo = []; state.redo = []; }
  clearScene();
  setupGridHelpers();
  $('#designName').value = design.name;
  $$('#gridSeg button').forEach(b => b.classList.toggle('on', b.dataset.grid === design.grid));
  $$('#typeSeg button').forEach(b => b.classList.toggle('on', b.dataset.type === design.type));
  if (!getDef(design, state.selId) || getDef(design, state.selId).grid !== design.grid) state.selId = `${design.grid}_LightArmor`;
  renderPalette(); envToUi(); updateRotLabel(); selectBlockType(state.selId);
  rebuildOcc(); syncScene(); queueAnalysis(); autosave();
  setTimeout(() => setView(design.blocks.length ? 'fit' : 'iso'), 0);
}
function serialise() {
  const d = state.design;
  return { format: 'se-build-planner', version: 1, name: d.name, grid: d.grid, type: d.type,
    blocks: d.blocks.map(b => ({ id: b.id, p: b.p, r: b.r, ...(b.color != null ? { color: b.color } : {}) })),
    customBlocks: d.customBlocks, overrides: d.overrides, settings: d.settings, savedAt: new Date().toISOString() };
}
function readJSON(k, dflt) { try { return JSON.parse(localStorage.getItem(k)) ?? dflt; } catch { return dflt; } }
function writeJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } }
let saveTimer = null;
function autosave() { clearTimeout(saveTimer); saveTimer = setTimeout(() => writeJSON(LS_CURRENT, serialise()), 400); }
function saveToBrowser() {
  const all = readJSON(LS_DESIGNS, {});
  all[state.design.name] = serialise();
  if (writeJSON(LS_DESIGNS, all)) toast(`Saved “${state.design.name}” in this browser`);
  else toast('Could not save (browser storage unavailable). Use Export instead.');
  renderDesignsMenu();
}
function renderDesignsMenu() {
  const all = readJSON(LS_DESIGNS, {});
  const names = Object.keys(all).sort();
  $('#designsMenu').innerHTML = names.length ? names.map(n => `<div class="item" data-load="${encodeURIComponent(n)}"><span>${escapeHtml(n)}</span>
     <span class="muted small">${all[n].grid === 'S' ? 'SG' : 'LG'} · ${all[n].blocks.length}</span><button class="mini" data-del="${encodeURIComponent(n)}">✕</button></div>`).join('')
    : '<div class="empty">No saved designs yet. Click Save.</div>';
}
// In-page yes/no dialog (the browser's built-in pop-ups are blocked in some hosts)
function ask(msg, okLabel = 'Continue') {
  return new Promise(res => {
    const m = document.createElement('div'); m.className = 'modal';
    m.innerHTML = `<div class="box" style="width:min(440px,92vw)"><p>${escapeHtml(msg)}</p>
      <div class="row" style="justify-content:flex-end"><button data-a="0">Cancel</button><button class="primary" data-a="1">${okLabel}</button></div></div>`;
    document.body.appendChild(m);
    m.addEventListener('click', e => { const a = e.target.dataset.a; if (e.target === m || a != null) { m.remove(); res(a === '1'); } });
  });
}
function escapeHtml(s) { return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 2200); }

function exportDesign() {
  const json = JSON.stringify(serialise(), null, 1);
  const fname = (state.design.name || 'design').replace(/[^\w\- ]+/g, '_') + '.sebp.json';
  const m = document.createElement('div'); m.className = 'modal';
  m.innerHTML = `<div class="box"><button class="close" data-close>×</button><h2>Export design</h2>
    <p class="small muted">Download the file, or copy the JSON into a text file. To load a design later use Import, or paste JSON here and click “Load pasted JSON”.</p>
    <textarea id="exJson" spellcheck="false" style="width:100%;height:260px;background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:6px;font:12px monospace"></textarea>
    <div class="row" style="justify-content:flex-end"><button id="exLoad">Load pasted JSON</button><button id="exCopy">Copy</button><button class="primary" id="exDl">Download file</button></div></div>`;
  document.body.appendChild(m);
  $('#exJson', m).value = json;
  m.addEventListener('click', e => { if (e.target === m || e.target.dataset.close != null) m.remove(); });
  $('#exDl', m).onclick = () => {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([$('#exJson', m).value], { type: 'application/json' }));
    a.download = fname; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  $('#exCopy', m).onclick = async () => {
    try { await navigator.clipboard.writeText($('#exJson', m).value); toast('Copied'); }
    catch { $('#exJson', m).select(); toast('Press Ctrl+C to copy'); }
  };
  $('#exLoad', m).onclick = () => {
    try { const d = JSON.parse($('#exJson', m).value); if (!Array.isArray(d.blocks)) throw 0; loadDesign(d); m.remove(); toast(`Loaded “${d.name}”`); }
    catch { toast('That text is not a valid design'); }
  };
}

// ---------------------------------------------------------------------------
// Example ship
// ---------------------------------------------------------------------------
function renderExamplesMenu() {
  const typeName = { atmo: 'Atmospheric', hydrogen: 'Hydrogen', ion: 'Ion' };
  const icon = { atmo: '#f0883e', hydrogen: '#ff6b6b', ion: '#58a6ff' };
  let h = '';
  for (const g of ['L', 'S']) {
    h += `<div class="mhead">${g === 'L' ? 'Large grid' : 'Small grid'}</div>`;
    for (const t of ['atmo', 'hydrogen', 'ion']) for (const e of EXAMPLES.filter(x => x.grid === g && x.type === t))
      h += `<div class="item" data-ex="${e.id}" title="${escapeHtml(e.description)}"><i class="dot" style="background:${icon[t]}"></i><span>${escapeHtml(e.name.replace(/^(LG|SG) /, ''))}</span><span class="muted small">${e.planet === 'moon' ? 'Moon/space' : 'EarthLike'}</span></div>`;
  }
  h += `<div class="mhead">Mixed propulsion</div>
    <div class="item" data-ex="mixed-L"><i class="dot" style="background:#8b949e"></i><span>LG ore hauler (H₂ + atmo + ion)</span></div>
    <div class="item" data-ex="mixed-S"><i class="dot" style="background:#8b949e"></i><span>SG miner (atmo + ion)</span></div>`;
  return h;
}
function rotFor(localDir, worldDir, localUp, worldUp) {
  for (let i = 0; i < ROTS.length; i++) {
    const a = applyRot(i, localDir);
    if (a.join() !== worldDir.join()) continue;
    if (localUp && applyRot(i, localUp).join() !== worldUp.join()) continue;
    return i;
  }
  return 0;
}
function buildExample(grid) {
  const d = newDesign(grid);
  d.name = grid === 'L' ? 'Example: LG ore hauler' : 'Example: SG miner';
  d.settings.fillPct = 25;
  const blocks = [];
  const add = (key, p, r = 0) => blocks.push({ id: `${grid}_${key}`, p, r });
  // Thruster pushing direction D: local -Z maps to D.
  const push = D => rotFor([0, 0, -1], D, [0, 1, 0], Math.abs(D[1]) ? [0, 0, 1] : [0, 1, 0]);
  const yUp = rotFor([0, 0, 1], [0, -1, 0], [0, 1, 0], [0, 0, 1]); // block back (+Z) facing down
  if (grid === 'L') {
    // Conveyor junctions set into the floor: link the lift thrusters, cargo and tank
    for (let x = -2; x <= 2; x++) { add('ConvJunc', [x, 0, 3]); add('ConvJunc', [x, 0, -3]); }
    for (const z of [-2, -1, 0]) add('ConvJunc', [0, 0, z]);
    for (let x = -2; x <= 2; x++) for (let z = -4; z <= 4; z++) add('LightArmor', [x, 0, z]);
    add('CargoL', [-1, 1, -1]);
    add('H2Tank', [-1, 1, 2]);               // its front port meets the cargo's back port
    add('Connector', [0, 4, 0], yUp);        // on top of the cargo, port facing down
    add('CockpitLG', [0, 1, -4]);
    add('ConvJunc', [0, 1, -3]); add('ConvJunc', [0, 1, -2]); add('ConvJunc', [0, 2, -2]); // cockpit → cargo
    add('Battery', [-2, 1, -4]); add('Battery', [2, 1, -4]);
    add('Gyro', [-2, 1, 3]); add('Gyro', [2, 1, 3]);
    // lift: hydrogen thrusters under the floor junctions, pushing Up
    for (const [x, z] of [[-2, -3], [2, -3], [-2, 3], [2, 3], [0, -3], [0, 3]]) add('HydroS', [x, -1, z], push([0, 1, 0]));
    for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) add('AtmoS', [x, -3, z], push([0, 1, 0]));
    // main engines at the back pushing Forward (the hydrogen one plugs into the tank's back port)
    for (const x of [-2, 0, 2]) add('IonS', [x, 0, 5], push([0, 0, -1]));
    add('HydroS', [0, 2, 5], push([0, 0, -1]));
    add('IonS', [-1, 0, -6], push([0, 0, 1])); add('IonS', [1, 0, -6], push([0, 0, 1]));
    add('IonS', [-4, 0, 0], push([1, 0, 0])); add('IonS', [3, 0, 0], push([-1, 0, 0]));
    add('IonS', [-1, 1, -3], push([0, -1, 0]));
  } else {
    // Small conveyors in the floor take ore from the drill to the cargo
    for (let z = -5; z <= 0; z++) add('ConvJunc', [0, 0, z]);
    add('ConvJunc', [0, -1, -5]);
    for (let x = -2; x <= 2; x++) for (let z = -5; z <= 5; z++) add('LightArmor', [x, 0, z]);
    add('CockpitSG', [-1, 1, -5]);
    add('CargoM', [-1, 1, -1]);
    add('Drill', [-1, -2, -11]);
    add('Battery', [-1, 1, 2]);
    add('Gyro', [-2, 1, 4]); add('Gyro', [2, 1, 4]);
    for (const [x, z] of [[-2, -4], [2, -4], [-2, 3], [2, 3]]) add('AtmoS', [x, -3, z], push([0, 1, 0]));
    for (const [x, z] of [[-1, -3], [1, -3], [0, 2]]) add('IonS', [x, -2, z], push([0, 1, 0]));
    for (const x of [-1, 1]) add('IonS', [x, 0, 6], push([0, 0, -1]));
    add('IonS', [-2, 0, -7], push([0, 0, 1])); add('IonS', [2, 0, -7], push([0, 0, 1]));
    add('IonS', [-4, 0, 0], push([1, 0, 0])); add('IonS', [3, 0, 0], push([-1, 0, 0]));
  }
  // drop overlaps
  const o = new Set(); d.blocks = [];
  for (const b of blocks) {
    const def = BLOCKS[b.id]; if (!def) continue;
    const cells = blockCells(b, def).map(c => ck(...c));
    if (cells.some(c => o.has(c))) continue;
    cells.forEach(c => o.add(c)); d.blocks.push(b);
  }
  return d;
}

// ---------------------------------------------------------------------------
// Custom blocks
// ---------------------------------------------------------------------------
function initCustomModal() {
  $('#cbCat').innerHTML = CATEGORIES.map(c => `<option value="${c.id}" ${c.id === 'custom' ? 'selected' : ''}>${c.name}</option>`).join('');
  $('#cbThrType').innerHTML += Object.entries(THRUSTER_TYPES).map(([k, v]) => `<option value="${k}">${v.name}</option>`).join('');
  $('#btnCustom').onclick = () => { $('#customModal').hidden = false; };
  $('#cbSave').onclick = () => {
    const name = $('#cbName').value.trim() || 'Custom block';
    const grid = state.design.grid;
    const id = `${grid}_custom_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
    const tt = $('#cbThrType').value;
    const def = {
      id, key: id, grid, name, cat: $('#cbCat').value, shape: tt ? 'thruster' : 'box', custom: true,
      size: [+$('#cbX').value || 1, +$('#cbY').value || 1, +$('#cbZ').value || 1], mass: +$('#cbMass').value || 0,
      inv: +$('#cbInv').value || 0, invOre: 0, invIce: 0, fuelInv: 0, minorInv: false,
      thrust: tt ? { type: tt, f: +$('#cbForce').value || 0, p: +$('#cbPower').value || 0, h2: +$('#cbH2').value || 0 } : null,
      pOut: +$('#cbPOut').value || 0, store: 0, h2: +$('#cbH2Cap').value || 0, o2: 0,
    };
    const sz = def.size, pv = $('#cbPorts').value;
    def.ports = parsePorts(pv ? pv.split(' ') : [], sz);
    def.role = $('#cbRole').value || (tt === 'hydrogen' ? 'h2thrust' : def.h2 ? 'h2tank' : def.inv ? 'cargo' : null);
    state.design.customBlocks[id] = def;
    const lib = readJSON(LS_CUSTOM, {}); lib[id] = def; writeJSON(LS_CUSTOM, lib);
    $('#customModal').hidden = true;
    selectBlockType(id); setTool('place'); autosave();
    toast(`Added “${name}”`);
  };
}

// ---------------------------------------------------------------------------
// Wire up
// ---------------------------------------------------------------------------
function init() {
  initEnvControls(); initCustomModal();
  $$('#toolSeg button').forEach(b => b.onclick = () => setTool(b.dataset.tool));
  $$('[data-rot]').forEach(b => b.onclick = () => {
    if (b.dataset.rot === 'reset') { state.rot = 0; updateRotLabel(); return; }
    if (b.dataset.rot === 'auto') { autoRotate(); return; }
    const [ax, d] = b.dataset.rot.split(','); rotateSel(ax, +d);
  });
  $('#colorPick').oninput = e => { state.color = parseInt(e.target.value.slice(1), 16); $('#useColor').checked = true; };
  $('#useColor').onchange = e => { state.color = e.target.checked ? parseInt($('#colorPick').value.slice(1), 16) : null; };
  $$('[data-mirror]').forEach(c => c.onchange = () => { state.mirror[c.dataset.mirror] = c.checked; rebuildMirrorPlanes(); showGhost(hover); });
  $$('[data-mirrorpos]').forEach(c => c.oninput = () => { state.mirrorPos[c.dataset.mirrorpos] = Math.round((+c.value || 0) * 2) / 2; rebuildMirrorPlanes(); showGhost(hover); });
  $('#layerY').oninput = e => setLayer(Math.round(+e.target.value || 0));
  $('#layerUp').onclick = () => setLayer(state.layerY + 1);
  $('#layerDown').onclick = () => setLayer(state.layerY - 1);
  $('#cutOn').onchange = e => { state.cutOn = e.target.checked; applyCut(); rebuildOverlays(); };
  $('#cutY').oninput = e => { state.cutY = Math.round(+e.target.value || 0); applyCut(); rebuildOverlays(); };
  $('#showArrows').onchange = e => { state.showArrows = e.target.checked; rebuildOverlays(); };
  $('#showCom').onchange = e => { state.showCom = e.target.checked; rebuildOverlays(); };
  $('#blockSearch').oninput = renderPalette;
  $$('#viewBtns button[data-view]').forEach(b => b.onclick = () => setView(b.dataset.view));
  $('#btnConv').onclick = () => setConveyorView(!state.convView);

  $('#designName').oninput = e => { state.design.name = e.target.value || 'Untitled'; autosave(); };
  $$('#gridSeg button').forEach(b => b.onclick = () => {
    const g = b.dataset.grid; if (g === state.design.grid) return;
    const go = () => { const d = newDesign(g); d.settings = state.design.settings; loadDesign(d); };
    if (!state.design.blocks.length) return go();
    ask('Switching grid size starts a new, empty design (large and small grid blocks can\'t mix). Save first if you want to keep this one.', 'Switch').then(ok => ok && go());
  });
  $$('#typeSeg button').forEach(b => b.onclick = () => {
    state.design.type = b.dataset.type;
    $$('#typeSeg button').forEach(x => x.classList.toggle('on', x === b)); autosave(); queueAnalysis();
  });
  $('#btnUndo').onclick = undo; $('#btnRedo').onclick = redo;
  $('#btnNew').onclick = async () => { if (state.design.blocks.length && !(await ask('Start a new, empty design? Save first if you want to keep the current one.', 'New design'))) return; const d = newDesign(state.design.grid); d.settings = state.design.settings; loadDesign(d); };
  const exDd = $('#btnExample').parentElement;
  $('#examplesMenu').innerHTML = renderExamplesMenu();
  $('#btnExample').onclick = e => { e.stopPropagation(); exDd.classList.toggle('open'); };
  document.addEventListener('click', () => exDd.classList.remove('open'));
  $('#examplesMenu').onclick = async e => {
    e.stopPropagation();
    const it = e.target.closest('[data-ex]'); if (!it) return;
    exDd.classList.remove('open');
    if (state.design.blocks.length && !(await ask('Replace the current design with this example ship? Save first if you want to keep it.', 'Load example'))) return;
    const id = it.dataset.ex;
    const d = id.startsWith('mixed-') ? buildExample(id.slice(6)) : buildExampleShip(id);
    loadDesign(d); toast(`Loaded “${d.name}”`);
  };
  $('#btnSave').onclick = saveToBrowser;
  $('#btnExport').onclick = exportDesign;
  $('#btnImport').onclick = () => $('#fileInput').click();
  $('#fileInput').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try { const d = JSON.parse(await f.text()); if (!Array.isArray(d.blocks)) throw new Error('not a design'); loadDesign(d); toast(`Loaded “${d.name}”`); }
    catch (err) { toast('That file is not a Build Planner design'); }
    e.target.value = '';
  };
  const dd = $('#btnDesigns').parentElement;
  $('#btnDesigns').onclick = e => { e.stopPropagation(); renderDesignsMenu(); dd.classList.toggle('open'); };
  document.addEventListener('click', () => dd.classList.remove('open'));
  $('#designsMenu').onclick = e => {
    e.stopPropagation();
    const del = e.target.closest('[data-del]'), ld = e.target.closest('[data-load]');
    const all = readJSON(LS_DESIGNS, {});
    if (del) { const n = decodeURIComponent(del.dataset.del); ask(`Delete saved design “${n}”?`, 'Delete').then(ok => { if (ok) { delete all[n]; writeJSON(LS_DESIGNS, all); renderDesignsMenu(); } }); return; }
    if (ld) { const n = decodeURIComponent(ld.dataset.load); loadDesign(all[n]); dd.classList.remove('open'); }
  };
  $('#btnHelp').onclick = () => { $('#helpModal').hidden = false; };
  $$('.modal').forEach(m => m.addEventListener('click', e => { if (e.target === m || e.target.dataset.close != null) m.hidden = true; }));

  const cur = readJSON(LS_CURRENT, null);
  if (cur && Array.isArray(cur.blocks)) loadDesign(cur); else loadDesign(buildExampleShip('lg-h2-light'));
  resize(); loop();
}

// Expose a small API for debugging / tests
window.SEBP = { state, rotFor, autoRotate: () => autoRotate(), setHover: h => { hover = h; showGhost(h); }, analyseConveyors: () => analyseConveyors(state.design), analyse: () => analyse(state.design, S()), loadDesign, buildExample, serialise, placeBlocks, placementAt };

init();
