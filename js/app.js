// Space Engineers Build Planner — editor & UI
import * as THREE from './vendor/three.module.min.js?v=20261107-2';
import { OrbitControls } from './vendor/OrbitControls.js?v=20261107-2';
import { parsePorts, BLOCKS, CATEGORIES, CAT_COLORS, PLANETS, ITEMS, INVENTORY_MULTIPLIERS, THRUSTER_TYPES, DIRS, GRID, G0, thrusterEffectiveness } from './data.js?v=20261107-2';
import { ROTS, rotateAbout, mirrorRot, rotatedSize, applyRot, rotIndex } from './rotations.js?v=20261107-2';
import { analyse, getDef, thrustersNeeded, thrustDirOf, fmt, productionAnalysis } from './calc.js?v=20261107-2';
import { buildBlockObject, blockColor, makeArrow } from './geometry.js?v=20261107-2';
import { analyseConveyors, worldPorts } from './conveyor.js?v=20261107-2';
import { EXAMPLES, buildExampleShip } from './examples.js?v=20261107-2';
import { flightAnalysis, planetOf } from './flight.js?v=20261107-2';
import { encodeDesign, decodeDesign } from './share.js?v=20261107-2';
import { buildSheetHtml, SHEET_CSS } from './sheet.js?v=20261107-2';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const LS_DESIGNS = 'sebp.designs.v1', LS_CURRENT = 'sebp.current.v1', LS_CUSTOM = 'sebp.customlib.v1';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const defaultSettings = () => ({
  planetId: 'earth', g: 1, density: 1, invMult: 1, itemId: 'ore', customLPerKg: 0.37,
  fillPct: 100, fillMinor: false, extraMass: 0, targetTwr: 1.5, suggestDir: 'up', speedCap: 100,
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
  layerY: 0, cutOn: false, cutY: 0, showArrows: true, showCom: true, showAxes: true,
  undo: [], redo: [], dirty: false,
  convView: false, focusUid: null,
  selection: new Set(), clipboard: null, pasteIsMove: false, layers: {}, selAllHeights: true,
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
function restore(snap) { state.design.blocks = withUids(JSON.parse(snap)); state.selection.clear(); changed(); }
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
  axisGroup.visible = state.showAxes;
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
  if (state.convView) lastConv = analyseConveyors(state.design);
  applyConveyorView();
  rebuildOverlays();
}
function clearScene() { for (const o of objByUid.values()) blockRoot.remove(o); objByUid.clear(); }
const layerOf = def => (def && def.cat) || 'misc';
const isHidden = def => !!(state.layers[layerOf(def)] && state.layers[layerOf(def)].hidden);
const isLocked = def => !!(state.layers[layerOf(def)] && state.layers[layerOf(def)].locked);
function applyCut() {
  for (const b of state.design.blocks) {
    const o = objByUid.get(b.uid); if (!o) continue;
    const def = getDef(state.design, b.id);
    o.visible = (!state.cutOn || b.p[1] <= state.cutY) && !isHidden(def);
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
const tintCache = new Map();
function tintMat(mt) {
  if (!tintCache.has(mt.uuid)) {
    const c = mt.clone();
    if (c.emissive) { c.emissive = new THREE.Color(0xff8c00); c.emissiveIntensity = 0.55; } else c.color = new THREE.Color(0xffb44d);
    tintCache.set(mt.uuid, c);
  }
  return tintCache.get(mt.uuid);
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
    const sel = state.selection.has(uid);
    o.traverse(n => {
      if (n.isMesh) {
        if (!n.userData.origMat) n.userData.origMat = n.material;
        n.material = m ? (sel ? tintMat(m) : m) : (sel ? tintMat(n.userData.origMat) : n.userData.origMat);
      }
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
function focusBlocks(uids, { conveyor = true } = {}) {
  if (!uids || !uids.length) return;
  if (conveyor && !state.convView) setConveyorView(true);
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

function setShowAxes(on) {
  state.showAxes = on;
  if (axisGroup) axisGroup.visible = on;
  const cb = $('#showAxes'); if (cb) cb.checked = on;
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

function placeBox(h, ws) {
  const c = targetCell(h), n = h.normal, p = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    if (n[i] > 0) p[i] = c[i];
    else if (n[i] < 0) p[i] = c[i] - ws[i] + 1;
    else p[i] = c[i] - Math.floor((ws[i] - 1) / 2);
  }
  return p;
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
  if (list[0]) { noteRecent(list[0].id); setTimeout(renderPalette, 0); }
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
  if (isLocked(def)) { toast(`${CATEGORIES.find(c => c.id === layerOf(def)).name} layer is locked`); return; }
  const ws = rotatedSize(b.r, def.size);
  const victims = new Set([b.uid]);
  for (const v of mirroredVariants({ p: b.p, r: b.r, ws })) {
    const centre = v.p.map((x, i) => x + Math.floor(ws[i] / 2));
    const u = occ.get(ck(...centre)); if (u != null) victims.add(u);
  }
  commit(() => { state.design.blocks = state.design.blocks.filter(x => !victims.has(x.uid)); });
}

function paintAt(h) {
  const b0 = state.design.blocks.find(x => x.uid === h.uid);
  if (b0 && isLocked(getDef(state.design, b0.id))) { toast('That layer is locked'); return; }
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
  if (state.tool === 'select') {
    if (selDrag && selDrag.moved) {
      const [mn, mx] = selBoxCells(selDrag.start, selCellOf(h));
      const lo = state.selAllHeights ? -60 : mn[1], hi = state.selAllHeights ? 60 : mx[1] + 1;
      const box = new THREE.Box3(new THREE.Vector3(mn[0] * c, lo * c, mn[2] * c), new THREE.Vector3((mx[0] + 1) * c, hi * c, (mx[2] + 1) * c));
      ghostGroup.add(new THREE.Box3Helper(box, 0xffb44d));
      $('#stCell').textContent = `Area ${mx[0] - mn[0] + 1} × ${mx[2] - mn[2] + 1}` + (state.selAllHeights ? ' (all heights)' : ` × ${mx[1] - mn[1] + 1}`);
    } else if (h.kind === 'block') {
      const o = objByUid.get(h.uid);
      if (o) ghostGroup.add(new THREE.Box3Helper(new THREE.Box3().setFromObject(o), 0xffb44d));
    }
    return;
  }
  if (state.tool === 'paste') { showPasteGhost(h); return; }
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


// ---------------------------------------------------------------------------
// Selection, clipboard, group transforms
// ---------------------------------------------------------------------------
let selDrag = null;
function selCellOf(h) { return h.kind === 'block' ? h.inside : [h.inside[0], state.layerY, h.inside[2]]; }
function selBoxCells(a, b) { return [[0, 1, 2].map(i => Math.min(a[i], b[i])), [0, 1, 2].map(i => Math.max(a[i], b[i]))]; }
function selectable(b) { const def = getDef(state.design, b.id); if (!def) return false; const o = objByUid.get(b.uid); return !isLocked(def) && (!o || o.visible); }
function setSelection(uids, add = false) {
  state.groupPivot = null;
  if (!add) state.selection = new Set();
  for (const u of uids) state.selection.add(u);
  applyConveyorView(); renderSelectionPanel();
}
function clickSelect(uid, toggle) {
  const b = state.design.blocks.find(x => x.uid === uid);
  if (!b || !selectable(b)) { if (b) toast('That layer is locked'); return; }
  if (toggle) { if (state.selection.has(uid)) state.selection.delete(uid); else state.selection.add(uid); applyConveyorView(); renderSelectionPanel(); }
  else setSelection([uid]);
}
function areaSelect(a, b, add) {
  const [mn, mx] = selBoxCells(a, b);
  const lo = state.selAllHeights ? -Infinity : mn[1], hi = state.selAllHeights ? Infinity : mx[1];
  const out = [];
  for (const bl of state.design.blocks) {
    if (!selectable(bl)) continue;
    const def = getDef(state.design, bl.id); const ws = rotatedSize(bl.r, def.size);
    if (bl.p[0] <= mx[0] && bl.p[0] + ws[0] - 1 >= mn[0] && bl.p[2] <= mx[2] && bl.p[2] + ws[2] - 1 >= mn[2] && bl.p[1] <= hi && bl.p[1] + ws[1] - 1 >= lo) out.push(bl.uid);
  }
  setSelection(out, add);
  if (out.length) toast(`${state.selection.size} block${state.selection.size > 1 ? 's' : ''} selected`);
}
function selectAll() { setSelection(state.design.blocks.filter(selectable).map(b => b.uid)); }
function selectSameType() {
  const ids = new Set(selectedBlocks().map(b => b.id));
  if (!ids.size) { toast('Select a block first'); return; }
  setSelection(state.design.blocks.filter(b => ids.has(b.id) && selectable(b)).map(b => b.uid));
}
function selectLayer(cat) { setTool('select'); setSelection(state.design.blocks.filter(b => layerOf(getDef(state.design, b.id)) === cat && selectable(b)).map(b => b.uid)); }
function selectedBlocks() { return state.design.blocks.filter(b => state.selection.has(b.uid)); }
function boundsOf(list) {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const b of list) { const def = getDef(state.design, b.id); const ws = rotatedSize(b.r, def.size);
    for (let i = 0; i < 3; i++) { mn[i] = Math.min(mn[i], b.p[i]); mx[i] = Math.max(mx[i], b.p[i] + ws[i]); } }
  return { mn, mx };
}
/** Rotate a list of blocks by 90° about a world axis through `pivot` (cell units). */
function latticePivot(pivot, ax) {
  // keep the lattice: the two in-plane pivot coordinates need the same fractional part
  const plane = { x: [1, 2], y: [0, 2], z: [0, 1] }[ax];
  const pv = [...pivot];
  const frac = v => ((v % 1) + 1) % 1;
  if (Math.abs(frac(pv[plane[0]]) - frac(pv[plane[1]])) > 1e-9) pv[plane[1]] -= 0.5;
  return pv;
}
function rotateList(list, ax, dir, pivot) {
  const g = rotateAbout(0, ax, dir);
  const pv = latticePivot(pivot, ax);
  return list.map(b => {
    const def = getDef(state.design, b.id);
    const ws = rotatedSize(b.r, def.size);
    const c = [0, 1, 2].map(i => b.p[i] + ws[i] / 2 - pv[i]);
    const c2 = applyRot(g, c);
    const r2 = rotateAbout(b.r, ax, dir);
    const ws2 = rotatedSize(r2, def.size);
    return { ...b, p: [0, 1, 2].map(i => Math.round(pv[i] + c2[i] - ws2[i] / 2)), r: r2 };
  });
}
function mirrorList(list, axis, twiceM) {
  const i = { x: 0, y: 1, z: 2 }[axis];
  return list.map(b => {
    const def = getDef(state.design, b.id); const ws = rotatedSize(b.r, def.size);
    const p = [...b.p]; p[i] = twiceM - b.p[i] - ws[i];
    return { ...b, p, r: mirrorRot(b.r, axis) };
  });
}
/** Replace the selected blocks with `next` (transformed copies) if they fit; keeps them selected. */
function replaceSelection(next, keepOriginals = false, label = 'Done') {
  const selSet = state.selection;
  const others = new Map();
  for (const b of state.design.blocks) {
    if (!keepOriginals && selSet.has(b.uid)) continue;
    const def = getDef(state.design, b.id); if (!def) continue;
    for (const c of blockCells(b, def)) others.set(ck(...c), b.uid);
  }
  const mine = new Set();
  for (const b of next) {
    const def = getDef(state.design, b.id);
    for (const c of blockCells(b, def)) { const k = ck(...c); if (others.has(k) || mine.has(k)) { toast("Can't do that: blocks would overlap"); return false; } mine.add(k); }
  }
  const newUids = [];
  commit(() => {
    if (!keepOriginals) state.design.blocks = state.design.blocks.filter(b => !selSet.has(b.uid));
    for (const b of next) { const nb = { id: b.id, p: b.p, r: b.r, uid: uidSeq++ }; if (b.color != null) nb.color = b.color; state.design.blocks.push(nb); newUids.push(nb.uid); }
  });
  setSelection(newUids);
  if (label) toast(label);
  return true;
}
function rotateGroup(ax, dir) {
  if (state.tool === 'paste' && state.clipboard) {
    const cb = state.clipboard;
    const piv = cb.size.map(v => v / 2);
    let list = rotateList(cb.blocks, ax, dir, piv);
    const { mn, mx } = boundsOf(list);
    list = list.map(b => ({ ...b, p: b.p.map((v, i) => v - mn[i]) }));
    state.clipboard = { blocks: list, size: mx.map((v, i) => v - mn[i]) };
    showGhost(hover); return;
  }
  const list = selectedBlocks(); if (!list.length) return;
  const { mn, mx } = boundsOf(list);
  // reuse the pivot of the previous turn so that turning back restores the exact position
  const pv = latticePivot(state.groupPivot || mn.map((v, i) => (v + mx[i]) / 2), ax);
  if (replaceSelection(rotateList(list, ax, dir, pv), false, null)) state.groupPivot = pv;
}
function mirrorSel(axis, copy) {
  const list = selectedBlocks(); if (!list.length) { toast('Select some blocks first'); return; }
  const i = { x: 0, y: 1, z: 2 }[axis];
  if (copy) {
    const twice = Math.round(state.mirrorPos[axis] * 2);
    replaceSelection(mirrorList(list, axis, twice), true, `Mirrored copy across the ${axis.toUpperCase()} symmetry plane (${state.mirrorPos[axis]})`);
  } else {
    const { mn, mx } = boundsOf(list);
    replaceSelection(mirrorList(list, axis, mn[i] + mx[i]), false, `Flipped along ${axis.toUpperCase()}`);
  }
}
function nudgeSel(d) {
  const list = selectedBlocks(); if (!list.length) return;
  replaceSelection(list.map(b => ({ ...b, p: b.p.map((v, i) => v + d[i]) })), false, null);
}
function deleteSel() {
  const n = state.selection.size; if (!n) return;
  const set = state.selection;
  commit(() => { state.design.blocks = state.design.blocks.filter(b => !set.has(b.uid)); });
  setSelection([]); toast(`Deleted ${n} block${n > 1 ? 's' : ''}`);
}
function copySel(quiet) {
  const list = selectedBlocks(); if (!list.length) return;
  const { mn, mx } = boundsOf(list);
  state.clipboard = { blocks: list.map(b => ({ id: b.id, p: b.p.map((v, i) => v - mn[i]), r: b.r, ...(b.color != null ? { color: b.color } : {}) })), size: mx.map((v, i) => v - mn[i]) };
  if (!quiet) toast(`Copied ${list.length} block${list.length > 1 ? 's' : ''}`);
  renderSelectionPanel();
}
function cutSel() { copySel(true); const n = state.selection.size; deleteSel(); toast(`Cut ${n} blocks: Ctrl+V to paste`); }
function moveSel() {
  if (!state.selection.size) return;
  copySel(true); deleteSel(); pasteStart(true);
}
function pasteStart(isMove) {
  if (!state.clipboard) { toast('Nothing copied yet'); return; }
  state.pasteIsMove = isMove;
  setTool('paste');
  toast(isMove ? 'Click where the blocks should go (W/A/S/D/Q/E rotate, Esc cancels)' : 'Click to paste (W/A/S/D/Q/E rotate, Esc stops pasting)');
}
function cancelPaste() {
  if (state.pasteIsMove) { state.pasteIsMove = false; undo(); toast('Move cancelled'); }
  setTool('select');
}
function pastePlacement(h) {
  const cb = state.clipboard; if (!cb) return null;
  const off = placeBox(h, cb.size);
  const list = cb.blocks.map(b => ({ ...b, p: b.p.map((v, i) => v + off[i]) }));
  const tmp = new Set(); let ok = true;
  for (const b of list) { const def = getDef(state.design, b.id); if (!def) { ok = false; continue; }
    for (const c of blockCells(b, def)) { const k = ck(...c); if (occ.has(k) || tmp.has(k)) ok = false; tmp.add(k); } }
  return { list, ok, off };
}
function showPasteGhost(h) {
  const pp = pastePlacement(h); if (!pp) return;
  const c = cellSize();
  if (pp.list.length <= 500) {
    for (const b of pp.list) {
      const def = getDef(state.design, b.id); if (!def) continue;
      const g = buildBlockObject(def, b, c, { ghost: true, ghostOk: pp.ok });
      g.traverse(o => { o.raycast = () => {}; }); ghostGroup.add(g);
    }
  }
  const cb = state.clipboard;
  const box = new THREE.Box3(new THREE.Vector3(...pp.off.map(v => v * c)), new THREE.Vector3(...pp.off.map((v, i) => (v + cb.size[i]) * c)));
  ghostGroup.add(new THREE.Box3Helper(box, pp.ok ? 0xffb44d : 0xff4444));
  $('#stCell').textContent = `Paste ${cb.blocks.length} blocks at ${pp.off.join(', ')}` + (pp.ok ? '' : ' (overlaps!)');
}
function pasteAt(h) {
  const pp = pastePlacement(h); if (!pp) return;
  if (!pp.ok) { toast("Can't paste here: blocks would overlap"); return; }
  const newUids = [];
  commit(() => { for (const b of pp.list) { const nb = { id: b.id, p: b.p, r: b.r, uid: uidSeq++ }; if (b.color != null) nb.color = b.color; state.design.blocks.push(nb); newUids.push(nb.uid); } });
  if (state.pasteIsMove) { state.pasteIsMove = false; state.tool = 'select'; $$('#toolSeg button').forEach(b => b.classList.toggle('on', b.dataset.tool === 'select')); }
  setSelection(newUids);
  showGhost(hover);
}
function paintSel(color) {
  const set = state.selection; if (!set.size) return;
  const uids = [];
  commit(() => {
    state.design.blocks = state.design.blocks.map(b => {
      if (!set.has(b.uid)) return b;
      const nb = { ...b, uid: uidSeq++ }; if (color == null) delete nb.color; else nb.color = color; uids.push(nb.uid); return nb;
    });
  });
  setSelection(uids);
}

function renderSelectionPanel() {
  const el = $('#selSection'); if (!el) return;
  const n = state.selection.size;
  const show = state.tool === 'select' || state.tool === 'paste' || n > 0;
  el.style.display = show ? '' : 'none';
  if (!show) return;
  const list = selectedBlocks();
  const mass = list.reduce((s, b) => s + (getDef(state.design, b.id)?.mass || 0), 0);
  const { mn, mx } = list.length ? boundsOf(list) : { mn: [0, 0, 0], mx: [0, 0, 0] };
  $('#selInfo').innerHTML = state.tool === 'paste'
    ? `<b>Pasting ${state.clipboard ? state.clipboard.blocks.length : 0} blocks</b> · click to place · Esc to ${state.pasteIsMove ? 'cancel the move' : 'stop'}`
    : n ? `<b>${n}</b> selected · ${fmt.kg(mass)} · ${mx.map((v, i) => v - mn[i]).join('×')} cells` : '<span class="muted">Click a block, or drag across an area. Shift adds to the selection.</span>';
  $$('#selSection [data-needsel]').forEach(b => b.disabled = !n);
  $('#selPaste').disabled = !state.clipboard;
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
  if (state.tool === 'select') { const h = pick(e); if (h) { selDrag = { start: selCellOf(h), moved: false }; canvas.setPointerCapture(e.pointerId); } return; }
  if (state.tool === 'place' && e.shiftKey) { const h = pick(e); if (h) { fillStart = h; canvas.setPointerCapture(e.pointerId); } }
});
canvas.addEventListener('pointermove', e => {
  hover = pick(e);
  if (selDrag && downPos && Math.hypot(e.clientX - downPos[0], e.clientY - downPos[1]) > 5) selDrag.moved = true;
  showGhost(hover);
  updateHoverInfo(hover);
});
canvas.addEventListener('pointerleave', () => { ghostGroup.clear(); $('#hoverInfo').style.display = 'none'; });
canvas.addEventListener('pointerup', e => {
  if (e.button !== 0 || !downPos) return;
  const moved = Math.hypot(e.clientX - downPos[0], e.clientY - downPos[1]) > 5;
  downPos = null;
  const h = pick(e);
  if (state.tool === 'select' && selDrag) {
    const sd = selDrag; selDrag = null;
    if (sd.moved && h) areaSelect(sd.start, selCellOf(h), e.shiftKey);
    else if (h && h.kind === 'block') clickSelect(h.uid, e.shiftKey || e.ctrlKey);
    else if (!e.shiftKey) setSelection([]);
    showGhost(pick(e)); return;
  }
  if (state.tool === 'paste') { if (!moved && h) pasteAt(h); return; }
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
  if ((e.ctrlKey || e.metaKey) && k === 'c') { if (state.selection.size) { e.preventDefault(); copySel(); } return; }
  if ((e.ctrlKey || e.metaKey) && k === 'x') { if (state.selection.size) { e.preventDefault(); cutSel(); } return; }
  if ((e.ctrlKey || e.metaKey) && k === 'v') { e.preventDefault(); pasteStart(false); return; }
  if ((e.ctrlKey || e.metaKey) && k === 'a') { e.preventDefault(); setTool('select'); selectAll(); return; }
  if ((e.ctrlKey || e.metaKey) && k === 'd') { e.preventDefault(); if (state.selection.size) { copySel(true); pasteStart(false); } return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const groupMode = state.tool === 'paste' || (state.tool === 'select' && state.selection.size);
  if (groupMode && ['w', 's', 'a', 'd', 'q', 'e'].includes(k)) {
    const m = { w: ['x', 1], s: ['x', -1], a: ['y', 1], d: ['y', -1], q: ['z', 1], e: ['z', -1] }[k];
    rotateGroup(m[0], m[1]); return;
  }
  if (state.tool === 'select' && state.selection.size) {
    const nud = { arrowleft: [-1, 0, 0], arrowright: [1, 0, 0], arrowup: [0, 0, -1], arrowdown: [0, 0, 1], pageup: [0, 1, 0], pagedown: [0, -1, 0] }[k];
    if (nud) { e.preventDefault(); nudgeSel(nud); return; }
    if (k === 'delete' || k === 'backspace') { e.preventDefault(); deleteSel(); return; }
    if (k === 'm') { moveSel(); return; }
  }
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
  else if (['1', '2', '3', '4', '5'].includes(k)) setTool(['place', 'erase', 'pick', 'paint', 'select'][+k - 1]);
  else if (k === 'pageup' || k === ']') setLayer(state.layerY + 1);
  else if (k === 'pagedown' || k === '[') setLayer(state.layerY - 1);
  else if (k === 'escape') {
    fillStart = null;
    if (state.tool === 'paste') cancelPaste();
    else if (state.selection.size) setSelection([]);
    showGhost(hover);
  }
});
function rotateSel(ax, dir) { state.rot = rotateAbout(state.rot, ax, dir); updateRotLabel(); showGhost(hover); }
function updateRotLabel() {
  const def = getDef(state.design, state.selId);
  let s = '';
  if (def && def.thrust) { const d = DIRS.find(x => x.v.join() === thrustDirOf(state.rot).join()); s = `→ pushes ${d.name}`; }
  else { const f = applyRot(state.rot, [0, 0, -1]); const d = DIRS.find(x => x.v.join() === f.join()); s = `front faces ${d.name}`; }
  $('#rotLabel2').textContent = s;
  $('#rotLabel').textContent = state.tool === 'place' && def ? `${def.name} · ${s}` : state.tool === 'paste' ? 'Pasting: W/A/S/D/Q/E rotate · Esc stops' : '';
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
const LS_FAVS = 'sebp.favs.v1', LS_RECENT = 'sebp.recent.v1', LS_TAB = 'sebp.lefttab.v1';
let favs = new Set(readJSON(LS_FAVS, []));
let recent = readJSON(LS_RECENT, []);
function toggleFav(id) {
  if (favs.has(id)) favs.delete(id); else favs.add(id);
  writeJSON(LS_FAVS, [...favs]); renderPalette();
}
function noteRecent(id) {
  recent = [id, ...recent.filter(x => x !== id)].slice(0, 12);
  writeJSON(LS_RECENT, recent);
}
function paletteItem(d) {
  const it = document.createElement('div');
  it.className = 'bitem' + (d.id === state.selId ? ' sel' : '');
  it.title = `${d.name}\n${d.size.join('×')} cells · ${fmt.kg(d.mass)}` + (d.thrust ? `\n${fmt.N(d.thrust.f)} ${THRUSTER_TYPES[d.thrust.type].name}` : '') + (d.approx ? '\n≈ value from older game data' : '');
  const col = '#' + blockColor(d).toString(16).padStart(6, '0');
  const meta = d.thrust ? fmt.N(d.thrust.f) : d.inv ? fmt.L(d.inv) : fmt.kg(d.mass);
  const on = favs.has(d.id);
  it.innerHTML = `<span class="sw" style="background:${col}"></span><span>${d.name}${d.approx ? ' <span class="muted">≈</span>' : ''}</span><span class="meta">${d.size.join('×')} · ${meta}</span><span class="fav ${on ? 'on' : ''}" title="${on ? 'Remove from' : 'Add to'} favourites">${on ? '★' : '☆'}</span>`;
  it.onclick = e => {
    if (e.target.classList.contains('fav')) { e.stopPropagation(); toggleFav(d.id); return; }
    selectBlockType(d.id); setTool('place');
  };
  return it;
}
function paletteGroup(pal, title, items, cls = '', key = title) {
  if (!items.length) return;
  const div = document.createElement('div'); div.className = 'cat ' + cls + (state.closedCats && state.closedCats.has(key) ? ' closed' : '');
  div.innerHTML = `<div class="cathead">▾ ${title} <span class="muted">(${items.length})</span></div><div class="blist"></div>`;
  div.firstChild.onclick = () => {
    div.classList.toggle('closed');
    state.closedCats = state.closedCats || new Set();
    if (div.classList.contains('closed')) state.closedCats.add(key); else state.closedCats.delete(key);
  };
  for (const d of items) div.lastChild.appendChild(paletteItem(d));
  pal.appendChild(div);
}
function renderPalette() {
  const q = $('#blockSearch').value.trim().toLowerCase();
  const pal = $('#palette'); const scroll = pal.scrollTop; pal.innerHTML = '';
  const defs = allDefsForGrid();
  const match = d => !q || d.name.toLowerCase().includes(q);
  const byId = new Map(defs.map(d => [d.id, d]));
  const favItems = defs.filter(d => favs.has(d.id) && match(d)).sort((a, b) => a.name.localeCompare(b.name));
  paletteGroup(pal, '★ Favourites', favItems, 'favs', 'favs');
  if (!favItems.length && !q) {
    const hint = document.createElement('div'); hint.className = 'small muted'; hint.style.margin = '2px 2px 8px';
    hint.textContent = '★ Favourites: click the ☆ on any block to pin it here.'; pal.appendChild(hint);
  }
  paletteGroup(pal, '⟲ Recently used', recent.map(id => byId.get(id)).filter(d => d && match(d) && !favs.has(d.id)).slice(0, 8), 'recent', 'recent');
  for (const cat of CATEGORIES) paletteGroup(pal, cat.name, defs.filter(d => d.cat === cat.id && match(d)), '', cat.id);
  pal.scrollTop = scroll;
}
function setLeftTab(t) {
  $$('#leftTabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  if ($('#tabBlocks')) $('#tabBlocks').hidden = t !== 'blocks';
  if ($('#tabTools')) $('#tabTools').hidden = t !== 'tools';
  try { localStorage.setItem(LS_TAB, t); } catch {}
}
function selectBlockType(id) {
  state.selId = id; renderPalette(); updateRotLabel();
  const def = getDef(state.design, id);
  $('#stSel').textContent = def ? `Selected: ${def.name}` : '';
}
function setTool(t) {
  if (state.tool === 'paste' && t !== 'paste' && state.pasteIsMove) { state.pasteIsMove = false; }
  state.tool = t;
  if (t === 'select' || t === 'paste') setLeftTab('tools');
  renderSelectionPanel();
  updateRotLabel();
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

  // Flight -------------------------------------------------------------------
  try { renderFlight(a, flightAnalysis(d, env, a), env, station); } catch (err) { console.error(err); }
  renderProduction(productionAnalysis(d), a);
  renderLayers();

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

function renderProduction(P, a) {
  const el = $('#productionSection'); if (!el) return;
  if (!P.rows.length && !P.modules) { el.innerHTML = ''; el.style.display = 'none'; return; }
  el.style.display = '';
  const kindName = { refinery: 'refining', assembler: 'assembling', kit: 'stone & basics' };
  const rows = P.rows.map((r, i) => {
    const mods = r.canModules
      ? ['speed', 'yield', 'power'].filter(k => r.counts[k]).map(k => `${r.counts[k]} ${k}`).join(', ') || '<span class="muted">none</span>'
      : '<span class="muted">no module ports</span>';
    return `<tr data-prow="${i}" style="cursor:pointer" title="Show this block"><td>${escapeHtml(r.name)}</td><td class="small">${mods}</td>
      <td>${r.speedPct}%${r.kind === 'refinery' ? `<div class="small muted">rate ×${r.rate.toFixed(2)}</div>` : ''}</td>
      <td>${r.yieldPct != null ? r.yieldPct.toFixed(0) + '%' : '—'}</td><td>${r.kw >= 1000 ? (r.kw / 1000).toFixed(2) + ' MW' : r.kw.toFixed(0) + ' kW'}</td></tr>`;
  }).join('');
  const pOutKw = a.pOut * 1000;
  el.innerHTML = `<h3>Production</h3>
    ${P.rows.length ? `<table class="t"><thead><tr><th>Block</th><th>Modules</th><th>Speed</th><th>Yield</th><th>Power</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="kv" style="margin-top:6px"><span class="k">All production running at once</span><span class="v"><b>${P.totalKw >= 1000 ? (P.totalKw / 1000).toFixed(2) + ' MW' : P.totalKw.toFixed(0) + ' kW'}</b></span>
      <span class="k">Grid power output</span><span class="v">${fmt.num(a.pOut)} MW</span></div>
    ${pOutKw && P.totalKw > pOutKw ? '<div class="note warn">Production can draw more power than the grid makes, so it will slow down when everything runs together.</div>' : ''}` : ''}
    ${P.loose.length ? `<div class="note warn">${P.loose.length} upgrade module${P.loose.length > 1 ? 's are' : ' is'} not touching a Refinery or Assembler, so ${P.loose.length > 1 ? 'they do' : 'it does'} nothing. Place modules directly against one (the Refinery takes them on its back, the Assembler on any side).</div>` : ''}
    ${P.wasted.length ? `<div class="note warn">${P.wasted.length} module${P.wasted.length > 1 ? 's have' : ' has'} no effect: Yield modules only work on Refineries, and each block takes at most 4 modules.</div>` : ''}
    <div class="small muted" style="margin-top:4px">Each module adds 2 attachment points: Speed +100% speed (and power); Yield ×1.19 ingots (Refinery only, 200% with 4); Power Efficiency ×0.67 power per module. Modules count for the block they touch.</div>`;
  $$('[data-prow]', el).forEach(tr => tr.onclick = () => focusBlocks([P.rows[+tr.dataset.prow].uid], { conveyor: false }));
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
// Layers (one per block category)
// ---------------------------------------------------------------------------
function renderLayers() {
  const el = $('#layersList'); if (!el) return;
  const counts = {};
  for (const b of state.design.blocks) { const d = getDef(state.design, b.id); if (d) counts[layerOf(d)] = (counts[layerOf(d)] || 0) + 1; }
  const cats = CATEGORIES.filter(c => counts[c.id]);
  if (!cats.length) { el.innerHTML = '<div class="muted small">Layers appear as you place blocks.</div>'; return; }
  el.innerHTML = cats.map(c => {
    const L = state.layers[c.id] || {};
    return `<div class="layer ${L.hidden ? 'hid' : ''}">
      <button class="mini eye ${L.hidden ? '' : 'on'}" data-leye="${c.id}" title="Show / hide">${L.hidden ? '◌' : '●'}</button>
      <button class="mini lock ${L.locked ? 'on' : ''}" data-llock="${c.id}" title="Lock (can't be erased, painted or selected)">${L.locked ? '🔒' : '🔓'}</button>
      <i style="background:#${(CAT_COLORS[c.id] ?? 0x888888).toString(16).padStart(6, '0')}"></i>
      <span class="ln">${c.name}</span><span class="muted small">${counts[c.id]}</span>
      <button class="mini" data-lsolo="${c.id}" title="Show only this layer">Solo</button>
      <button class="mini" data-lsel="${c.id}" title="Select every block in this layer">Select</button></div>`;
  }).join('') + `<div class="row"><button class="mini" id="layersAll">Show all</button><button class="mini" id="layersUnlock">Unlock all</button></div>`;
  const L = id => (state.layers[id] = state.layers[id] || {});
  $$('[data-leye]', el).forEach(b => b.onclick = () => { const l = L(b.dataset.leye); l.hidden = !l.hidden; layersChanged(); });
  $$('[data-llock]', el).forEach(b => b.onclick = () => { const l = L(b.dataset.llock); l.locked = !l.locked; layersChanged(); });
  $$('[data-lsolo]', el).forEach(b => b.onclick = () => { for (const c of cats) L(c.id).hidden = c.id !== b.dataset.lsolo; layersChanged(); });
  $$('[data-lsel]', el).forEach(b => b.onclick = () => selectLayer(b.dataset.lsel));
  $('#layersAll').onclick = () => { for (const c of cats) L(c.id).hidden = false; layersChanged(); };
  $('#layersUnlock').onclick = () => { for (const c of cats) L(c.id).locked = false; layersChanged(); };
}
function layersChanged() {
  // hidden/locked blocks drop out of the selection
  for (const b of state.design.blocks) if (state.selection.has(b.uid)) { const d = getDef(state.design, b.id); if (isHidden(d) || isLocked(d)) state.selection.delete(b.uid); }
  applyCut(); applyConveyorView(); rebuildOverlays(); renderLayers(); renderSelectionPanel();
}

// ---------------------------------------------------------------------------
// Design-wide repaint
// ---------------------------------------------------------------------------
function openRepaint() {
  const used = new Map();
  for (const b of state.design.blocks) { const d = getDef(state.design, b.id); if (!d) continue; const c = blockColor(d, b); used.set(c, (used.get(c) || 0) + 1); }
  const types = [...new Set(state.design.blocks.map(b => b.id))].map(id => getDef(state.design, id)).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
  const cats = CATEGORIES.filter(c => state.design.blocks.some(b => layerOf(getDef(state.design, b.id)) === c.id));
  const m = document.createElement('div'); m.className = 'modal';
  m.innerHTML = `<div class="box"><button class="close" data-close>×</button><h2>Repaint</h2>
    <div class="formgrid">
      <label>Which blocks</label><select id="rpScope">
        <option value="all">Every block (${state.design.blocks.length})</option>
        ${state.selection.size ? `<option value="sel" selected>Selection (${state.selection.size})</option>` : ''}
        <optgroup label="Layer">${cats.map(c => `<option value="cat:${c.id}">${c.name}</option>`).join('')}</optgroup>
        <optgroup label="Block type">${types.map(d => `<option value="id:${d.id}">${escapeHtml(d.name)}</option>`).join('')}</optgroup>
        <optgroup label="Blocks currently this colour">${[...used.entries()].map(([c, n]) => `<option value="col:${c}">■ #${c.toString(16).padStart(6, '0')} (${n})</option>`).join('')}</optgroup>
      </select>
      <label>New colour</label><div class="inline"><input type="color" id="rpColor" value="#${(state.color ?? 0x3d6e9e).toString(16).padStart(6, '0')}">
        <label class="chk"><input type="checkbox" id="rpDefault"> reset to default colours</label></div>
    </div>
    <div class="swatches">${['#b1bac4','#6e7681','#30363d','#f0f6fc','#9a4f14','#d4a72c','#3fb950','#1f6feb','#8957e5','#da3633','#2b3d52','#5a6b3c'].map(c => `<button class="swatch" data-sw="${c}" style="background:${c}"></button>`).join('')}</div>
    <div class="row" style="justify-content:flex-end"><button data-close>Cancel</button><button class="primary" id="rpApply">Repaint</button></div></div>`;
  document.body.appendChild(m);
  m.addEventListener('click', e => { if (e.target === m || e.target.dataset.close != null) m.remove(); });
  $$('[data-sw]', m).forEach(b => b.onclick = () => { $('#rpColor', m).value = b.dataset.sw; $('#rpDefault', m).checked = false; });
  $('#rpApply', m).onclick = () => {
    const sc = $('#rpScope', m).value;
    const color = $('#rpDefault', m).checked ? null : parseInt($('#rpColor', m).value.slice(1), 16);
    const match = b => {
      const d = getDef(state.design, b.id); if (!d) return false;
      if (sc === 'all') return true;
      if (sc === 'sel') return state.selection.has(b.uid);
      if (sc.startsWith('cat:')) return layerOf(d) === sc.slice(4);
      if (sc.startsWith('id:')) return b.id === sc.slice(3);
      if (sc.startsWith('col:')) return blockColor(d, b) === +sc.slice(4);
      return false;
    };
    let n = 0;
    commit(() => {
      state.design.blocks = state.design.blocks.map(b => {
        if (!match(b) || isLocked(getDef(state.design, b.id))) return b;
        n++; const nb = { ...b, uid: uidSeq++ }; if (color == null) delete nb.color; else nb.color = color; return nb;
      });
    });
    state.selection.clear(); renderSelectionPanel();
    m.remove(); toast(`Repainted ${n} block${n === 1 ? '' : 's'}`);
  };
}

// ---------------------------------------------------------------------------
// Flight analysis panels
// ---------------------------------------------------------------------------
const mps = v => v == null || !isFinite(v) ? '—' : v.toFixed(1);
const dist = v => v == null || !isFinite(v) ? '—' : v >= 1000 ? (v / 1000).toFixed(2) + ' km' : v.toFixed(0) + ' m';
function renderFlight(a, f, env, station) {
  if (station) { ['#speedSection', '#enduranceSection', '#handlingSection'].forEach(id => $(id).innerHTML = ''); return; }
  const cap = env.speedCap || 100;
  const sF = f.speedFull, sE = f.speedEmpty;
  const rows = sF.rows.map((r, i) => {
    const e = sE.rows[i];
    return `<tr><td>${r.label}</td><td>${mps(r.a)}<div class="small muted">${mps(e.a)}</div></td>
      <td>${r.tCap ? fmt.time(r.tCap) : '<span class="pill fail">never</span>'}<div class="small muted">${e.tCap ? fmt.time(e.tCap) : '—'}</div></td>
      <td>${dist(r.dCap)}</td>
      <td>${r.dBrake != null ? dist(r.dBrake) : '<span class="pill fail">can\'t</span>'}<div class="small muted">${dist(e.dBrake)}</div></td></tr>`;
  }).join('');
  const land = sF.landing;
  $('#speedSection').innerHTML = `<h3>Speed &amp; stopping <span class="muted small">(full / <span class="small">empty</span>, ${cap} m/s cap)</span></h3>
    <table class="t"><thead><tr><th>Motion</th><th>Accel m/s²</th><th>0 → ${cap} m/s</th><th>Distance</th><th>Stop from ${cap}</th></tr></thead><tbody>${rows}</tbody></table>
    ${env.g > 0 ? (land ? `<div class="note">Landing with full cargo: to stop in time, descend no faster than ${land.map(x => `<b>${x.v.toFixed(0)} m/s</b> from ${x.h} m`).join(', ')}.
      Braking uses Up thrust minus gravity (${mps(sF.brakeDecel)} m/s²).</div>`
      : `<div class="note warn">With full cargo the Up thrusters can't beat gravity, so the ship can't stop a descent. Land empty, or add lift.</div>`) : ''}
    <div class="small muted" style="margin-top:4px">Stopping a motion uses the thrusters on the opposite side, at full power as inertial dampeners do.</div>`;

  // Endurance --------------------------------------------------------------
  const eF = f.enduranceFull, eE = f.enduranceEmpty;
  const hrs = h => h == null ? '—' : h === Infinity ? 'unlimited*' : fmt.time(h * 3600);
  const asc = f.ascentFull, ascE = f.ascentEmpty;
  const ascLine = (x, lbl) => {
    if (!x.applicable) return '';
    if (x.reached) {
      const parts = [];
      if (x.h2Used > 0) parts.push(`${fmt.L(x.h2Used)} H₂ (${x.h2Cap ? Math.round(x.h2Used / x.h2Cap * 100) : '∞'}% of tanks)`);
      if (x.mwhUsed > 0) parts.push(`${fmt.num(x.mwhUsed, 2)} MWh battery (${x.mwhCap ? Math.round(x.mwhUsed / x.mwhCap * 100) : '∞'}%)`);
      const out = x.h2Out != null || x.batOut != null;
      return `<div class="check"><span class="pill ${out ? 'marginal' : 'ok'}">${out ? '!' : '✓'}</span> <b>${lbl}:</b> reaches space (${fmt.num(x.edge / 1000, 1)} km) in ${fmt.time(x.time)}${parts.length ? ', using ' + parts.join(' and ') : ''}.
        ${x.h2Out != null ? `<br><span class="small">Hydrogen runs out at ${fmt.num(x.h2Out / 1000, 1)} km; it only makes it on the other thrusters.</span>` : ''}${x.batOut != null ? `<br><span class="small">Batteries run flat at ${fmt.num(x.batOut / 1000, 1)} km.</span>` : ''}</div>`;
    }
    const why = x.atmoLossAt != null ? ' (atmospheric thrusters fade as the air thins)' : '';
    return `<div class="check"><span class="pill fail">✗</span> <b>${lbl}:</b> stalls at ${fmt.num((x.stallAt ?? x.altitude) / 1000, 1)} km${why}. Space starts at ${fmt.num(x.edge / 1000, 1)} km.
      ${x.h2Out != null ? `<br><span class="small">Hydrogen ran out at ${fmt.num(x.h2Out / 1000, 1)} km.</span>` : ''}${x.batOut != null ? `<br><span class="small">Batteries ran flat at ${fmt.num(x.batOut / 1000, 1)} km.</span>` : ''}</div>`;
  };
  $('#enduranceSection').innerHTML = `<h3>Endurance &amp; reaching space</h3>
    <div class="kv">
      <span class="k">Battery storage</span><span class="v">${fmt.num(eF.batteryMWh)} MWh</span>
      ${eF.genOut ? `<span class="k">Reactors / H₂ engines output</span><span class="v">${fmt.num(eF.genOut)} MW</span>` : ''}
      ${eF.solarOut ? `<span class="k">Solar (full sun)</span><span class="v">${fmt.num(eF.solarOut, 3)} MW</span>` : ''}
      ${env.g > 0 && eF.hoverMW != null ? `<span class="k">Hover power draw (full / empty)</span><span class="v">${fmt.num(eF.hoverMW)} / ${fmt.num(eE.hoverMW ?? 0)} MW</span>` : ''}
      ${env.g > 0 && eF.hoverMW ? `<span class="k">Hover time on batteries (full / empty)</span><span class="v">${hrs(eF.hoverBatteryH)} / ${hrs(eE.hoverBatteryH)}</span>` : ''}
      ${env.g > 0 && eF.hoverH2S != null ? `<span class="k">Hover time on hydrogen (full / empty)</span><span class="v">${fmt.time(eF.hoverH2S)} / ${fmt.time(eE.hoverH2S)}</span>` : ''}
      ${eF.cruiseMW ? `<span class="k">Full forward thrust on batteries</span><span class="v">${hrs(eF.cruiseBatteryH)}</span>` : ''}
      ${eF.cruiseH2S != null ? `<span class="k">Full forward thrust on hydrogen</span><span class="v">${fmt.time(eF.cruiseH2S)}</span>` : ''}
    </div>
    ${asc.applicable ? `<div style="margin-top:6px">${ascLine(asc, 'Full cargo')}${ascLine(ascE, 'Empty')}</div>
      <div class="small muted">Simulated straight-up climb from the surface of ${escapeHtml(asc.planet.name)}: gravity falls off above the hills, air thins to nothing at ${fmt.num(asc.planet.atmoAlt, 1)} km.</div>` : '<div class="small muted">No gravity here, so there is nothing to climb out of.</div>'}
    ${eF.hoverBatteryH === Infinity ? '<div class="small muted">* Reactors or hydrogen engines cover the draw for as long as they have fuel.</div>' : ''}`;

  // Handling: jump, gyros, landing ---------------------------------------------
  let h = '<h3>Handling, landing &amp; jumping</h3>';
  const g = f.gyroFull, gE = f.gyroEmpty;
  if (g) {
    h += `<div class="small muted">Gyroscopes: ${g.count} · turn acceleration from gyro torque ÷ the ship's rotational inertia (estimate).</div>
    <table class="t"><thead><tr><th>Axis</th><th>Full °/s²</th><th>Empty °/s²</th><th>90° turn (full)</th><th></th></tr></thead><tbody>
    ${g.axes.map((x, i) => `<tr><td>${x.name}</td><td>${fmt.num(x.alpha, 1)}</td><td>${fmt.num(gE.axes[i].alpha, 1)}</td><td>${x.t90 ? x.t90.toFixed(1) + ' s' : '—'}</td>
      <td><span class="pill ${x.status}">${x.status === 'ok' ? (x.alpha >= 30 ? 'Agile' : 'OK') : x.status === 'marginal' ? 'Sluggish' : g.count ? 'Very slow' : 'No gyros'}</span></td></tr>`).join('')}</tbody></table>`;
    const worst = Math.min(...g.axes.map(x => x.alpha));
    if (g.count && worst < 8) {
      const need = Math.ceil(g.count * 8 / Math.max(worst, 0.01)) - g.count;
      h += `<div class="note warn">Turning is sluggish with full cargo. About ${need} more gyroscope${need > 1 ? 's' : ''} would bring the slowest axis to ~8 °/s².</div>`;
    } else if (!g.count) h += `<div class="note warn">No gyroscopes: the ship can't turn (or stay level in gravity).</div>`;
  }
  const L = f.landing;
  if (L) {
    h += `<div class="check" style="margin-top:6px"><span class="pill ${L.stable ? 'ok' : 'fail'}">${L.stable ? '✓' : '✗'}</span> ${L.stable
      ? `Centre of mass is <b>${fmt.num(L.margin, 1)} m inside</b> the footprint of the ${L.source}; it rests level and would tip on slopes steeper than ~${L.tipDeg.toFixed(0)}°.`
      : `Centre of mass is <b>${fmt.num(-L.margin, 1)} m outside</b> the footprint of the ${L.source}, so it will tip over when landed.`}
      <br><span class="small muted">CoM is ${fmt.num(L.height, 1)} m above the bottom, offset ${fmt.num(L.offset[0], 1)} m sideways / ${fmt.num(-L.offset[1], 1)} m forward of the footprint centre.${L.source === 'lowest blocks' ? ' Add Landing Gear to check against your feet instead.' : ''}</span></div>`;
    if (env.g > 0 && env.density > 0) h += L.chutes
      ? `<div class="check"><span class="pill ${L.chuteOk ? 'ok' : 'marginal'}">${L.chuteOk ? '✓' : '!'}</span> ${L.chutes} parachute hatch${L.chutes > 1 ? 'es' : ''} handle ≈ ${fmt.kg(L.chuteKg)} (rule of thumb) vs ${fmt.kg(a.loadedMass)} full.</div>`
      : `<div class="small muted">No parachutes. Rule of thumb: one large-grid hatch per ~100 t, one small-grid hatch per ~10 t.</div>`;
  }
  const J = f.jump;
  if (J) h += `<div class="kv" style="margin-top:8px">
      <span class="k">Jump drives</span><span class="v">${J.count}</span>
      <span class="k">Jump range empty / full</span><span class="v"><b>${fmt.num(J.empty, 0)} km</b> / <b>${fmt.num(J.full, 0)} km</b></span>
      <span class="k">Max range (light ship)</span><span class="v">${fmt.num(J.maxKm, 0)} km up to ${fmt.kg(J.threshold)}</span>
      <span class="k">Energy to charge all</span><span class="v">${fmt.num(J.chargeMWh)} MWh</span></div>
      ${a.loadedMass > J.threshold ? `<div class="small muted">Heavier than ${fmt.kg(J.threshold)}, so range falls in proportion to mass.</div>` : ''}`;
  else if (state.design.grid === 'L' || true) h += `<div class="small muted" style="margin-top:6px">No jump drive. Large grid: up to 2,000 km per drive below 1,250 t; Prototech drives go further.</div>`;
  $('#handlingSection').innerHTML = h;
}

// ---------------------------------------------------------------------------
// Sharing: link, comparison, build sheet
// ---------------------------------------------------------------------------
function textPrompt(msg, value = '') {
  return new Promise(res => {
    const m = document.createElement('div'); m.className = 'modal';
    m.innerHTML = `<div class="box" style="width:min(440px,92vw)"><p>${escapeHtml(msg)}</p><input id="tpv" style="width:100%" value="${escapeHtml(value)}">
      <div class="row" style="justify-content:flex-end"><button data-a="0">Cancel</button><button class="primary" data-a="1">OK</button></div></div>`;
    document.body.appendChild(m);
    const inp = $('#tpv', m); inp.focus(); inp.select();
    const done = ok => { m.remove(); res(ok ? inp.value.trim() : null); };
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
    m.addEventListener('click', e => { const a = e.target.dataset.a; if (e.target === m || a != null) done(a === '1'); });
  });
}
async function saveVariant() {
  const name = await textPrompt('Save the current design as a variant called:', state.design.name + ' (variant)');
  if (!name) return;
  state.design.name = name; $('#designName').value = name;
  saveToBrowser();
}

async function openShare() {
  const code = await encodeDesign(serialise());
  const url = location.origin + location.pathname + '#design=' + code;
  const m = document.createElement('div'); m.className = 'modal';
  const local = location.protocol === 'file:' || /^(localhost|127\.|192\.168\.|10\.)/.test(location.hostname);
  m.innerHTML = `<div class="box"><button class="close" data-close>×</button><h2>Share by link</h2>
    <p class="small muted">The whole design (blocks, colours, custom blocks and settings) is packed into this link; nothing is uploaded anywhere. Anyone opening it gets their own copy.</p>
    <textarea id="shUrl" readonly style="width:100%;height:110px;background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:6px;font:12px monospace">${escapeHtml(url)}</textarea>
    <div class="small muted">${url.length.toLocaleString()} characters${url.length > 8000 ? ' · <span style="color:var(--warn)">long: some chat apps cut links this size. Use Export for big ships.</span>' : ''}</div>
    ${local ? '<div class="note warn">This copy runs on your own computer, so the link only works here. Host the planner (e.g. GitHub Pages) to share it with others.</div>' : ''}
    <div class="row" style="justify-content:flex-end"><button id="shCopy" class="primary">Copy link</button></div></div>`;
  document.body.appendChild(m);
  m.addEventListener('click', e => { if (e.target === m || e.target.dataset.close != null) m.remove(); });
  $('#shCopy', m).onclick = async () => {
    try { await navigator.clipboard.writeText(url); toast('Link copied'); } catch { $('#shUrl', m).select(); toast('Press Ctrl+C to copy'); }
  };
}
async function loadFromHash() {
  const hm = /^#design=(.+)$/.exec(location.hash);
  if (!hm) return false;
  try {
    const d = await decodeDesign(hm[1]);
    const cur = readJSON(LS_CURRENT, null);
    if (cur && cur.blocks && cur.blocks.length) {
      const all = readJSON(LS_DESIGNS, {});
      all[`${cur.name} (before opening a shared link)`] = cur; writeJSON(LS_DESIGNS, all);
    }
    loadDesign(d);
    history.replaceState(null, '', location.pathname + location.search);
    toast(`Opened shared design “${d.name}”`);
    return true;
  } catch (e) { toast('That share link is damaged or incomplete'); return false; }
}

const COMPARE_METRICS = [
  { k: 'Grid / blocks', f: x => `${x.d.grid === 'L' ? 'Large' : 'Small'} · ${x.a.blockCount}` },
  { k: 'Size (W × H × L m)', f: x => x.a.bounds ? x.a.bounds.meters.map(v => v.toFixed(1)).join(' × ') : '—' },
  { k: 'Empty mass', n: x => x.a.emptyMass, fmt: fmt.kg, better: 'low' },
  { k: 'Cargo space', n: x => x.a.fillableBaseL * x.a.mult, fmt: fmt.L, better: 'high' },
  { k: 'Full mass', n: x => x.a.loadedMass, fmt: fmt.kg, better: 'low' },
  ...DIRS.map(d => ({ k: `TWR full: ${d.name}`, n: x => { const r = x.a.dirs.find(y => y.id === d.id); return isFinite(r.twrLoaded) ? r.twrLoaded : null; }, fmt: v => v.toFixed(2), better: 'high' })),
  { k: 'Forward accel (full)', n: x => x.a.dirs.find(y => y.id === 'forward').accLoaded, fmt: v => v.toFixed(1) + ' m/s²', better: 'high' },
  { k: 'Max cargo at target TWR', n: x => x.a.dirs[0].maxCargoShownKg, fmt: fmt.kg, better: 'high' },
  { k: 'Power output', n: x => x.a.pOut, fmt: v => fmt.num(v) + ' MW', better: 'high' },
  { k: 'Battery storage', n: x => x.a.store, fmt: v => fmt.num(v) + ' MWh', better: 'high' },
  { k: 'Hydrogen capacity', n: x => x.a.h2Cap, fmt: fmt.L, better: 'high' },
  { k: 'Reach space (full)', f: x => !x.f.ascentFull.applicable ? 'n/a' : x.f.ascentFull.reached ? 'Yes · ' + fmt.time(x.f.ascentFull.time) : 'No · ' + fmt.num((x.f.ascentFull.stallAt ?? 0) / 1000, 1) + ' km' },
  { k: 'Jump range (full)', n: x => x.f.jump ? x.f.jump.full : null, fmt: v => fmt.num(v, 0) + ' km', better: 'high' },
  { k: 'Slowest turn (full)', n: x => x.f.gyroFull ? Math.min(...x.f.gyroFull.axes.map(a => a.alpha)) : null, fmt: v => fmt.num(v, 1) + ' °/s²', better: 'high' },
  { k: 'Landing stable', f: x => x.f.landing ? (x.f.landing.stable ? 'Yes' : 'No') : '—' },
  { k: 'Conveyor issues', n: x => x.cv.issues.length, fmt: v => String(v), better: 'low' },
];
function compareSources() {
  const saved = readJSON(LS_DESIGNS, {});
  return [
    { id: 'cur', label: `Current: ${state.design.name}`, get: () => serialise() },
    ...Object.keys(saved).sort().map(n => ({ id: 'saved:' + n, label: n, get: () => saved[n] })),
    ...EXAMPLES.map(e => ({ id: 'ex:' + e.id, label: 'Example: ' + e.name, get: () => buildExampleShip(e.id) })),
  ];
}
function openCompare() {
  const src = compareSources();
  const opts = sel => src.map(x => `<option value="${escapeHtml(x.id)}" ${x.id === sel ? 'selected' : ''}>${escapeHtml(x.label)}</option>`).join('');
  const m = document.createElement('div'); m.className = 'modal';
  m.innerHTML = `<div class="box wide"><button class="close" data-close>×</button><h2>Compare designs</h2>
    <div class="formgrid"><label>Design A</label><select id="cmpA">${opts('cur')}</select>
      <label>Design B</label><select id="cmpB">${opts(src[1] ? src[1].id : 'cur')}</select>
      <label>Environment</label><select id="cmpEnv"><option value="cur">Current settings for both (fair comparison)</option><option value="own">Each design's own saved settings</option></select></div>
    <div id="cmpOut" style="margin-top:10px"></div>
    <div class="small muted">Tip: “Designs ▾ → Save as variant” keeps several versions of a ship to compare.</div></div>`;
  document.body.appendChild(m);
  m.addEventListener('click', e => { if (e.target === m || e.target.dataset.close != null) m.remove(); });
  const run = () => {
    const ctx = id => {
      const d0 = src.find(x => x.id === id).get();
      const d = { ...newDesign(d0.grid), ...d0, settings: { ...defaultSettings(), ...(d0.settings || {}) }, customBlocks: d0.customBlocks || {}, overrides: d0.overrides || {} };
      d.blocks = (d0.blocks || []).map((b, i) => ({ ...b, uid: i + 1 }));
      const env = $('#cmpEnv', m).value === 'cur' ? S() : d.settings;
      const a = analyse(d, env);
      return { d, a, f: flightAnalysis(d, env, a), cv: analyseConveyors(d) };
    };
    const A = ctx($('#cmpA', m).value), B = ctx($('#cmpB', m).value);
    const rows = COMPARE_METRICS.map(mt => {
      if (mt.f) return `<tr><td>${mt.k}</td><td>${mt.f(A)}</td><td>${mt.f(B)}</td><td></td></tr>`;
      const va = mt.n(A), vb = mt.n(B);
      const show = v => v == null ? '—' : mt.fmt(v);
      let diff = '';
      if (va != null && vb != null && isFinite(va) && isFinite(vb) && va !== vb) {
        const better = mt.better === 'high' ? vb > va : vb < va;
        const pct = va !== 0 ? ` (${vb > va ? '+' : ''}${((vb - va) / Math.abs(va) * 100).toFixed(0)}%)` : '';
        diff = `<span style="color:${better ? 'var(--ok)' : 'var(--bad)'}">${better ? '▲' : '▼'} B${pct}</span>`;
      }
      return `<tr><td>${mt.k}</td><td>${show(va)}</td><td>${show(vb)}</td><td>${diff}</td></tr>`;
    }).join('');
    $('#cmpOut', m).innerHTML = `<table class="t cmp"><thead><tr><th>Metric</th><th>A: ${escapeHtml(A.d.name)}</th><th>B: ${escapeHtml(B.d.name)}</th><th>B vs A</th></tr></thead><tbody>${rows}</tbody></table>`;
  };
  ['#cmpA', '#cmpB', '#cmpEnv'].forEach(id => $(id, m).onchange = run);
  run();
}

function snapshotViews() {
  const keep = { pos: camera.position.clone(), tgt: controls.target.clone() };
  const vis = { g: ghostGroup.visible, m: mirrorGroup.visible, a: axisGroup && axisGroup.visible, gr: gridHelper.visible };
  ghostGroup.visible = false; mirrorGroup.visible = false; if (axisGroup) axisGroup.visible = false;
  const out = [];
  for (const [v, label] of [['iso', '3D view'], ['front', 'Front'], ['side', 'Side'], ['top', 'Top']]) {
    setView(v); controls.update(); renderer.render(scene, camera);
    out.push({ label, url: renderer.domElement.toDataURL('image/jpeg', 0.85) });
  }
  ghostGroup.visible = vis.g; mirrorGroup.visible = vis.m; if (axisGroup) axisGroup.visible = vis.a;
  camera.position.copy(keep.pos); controls.target.copy(keep.tgt); controls.update();
  return out;
}
function openSheet() {
  if (!state.design.blocks.length) { toast('Nothing to print yet'); return; }
  if (!$('#sheetCss')) { const st = document.createElement('style'); st.id = 'sheetCss'; st.textContent = SHEET_CSS; document.head.appendChild(st); }
  const env = S();
  const a = analyse(state.design, env), f = flightAnalysis(state.design, env, a), cv = analyseConveyors(state.design);
  const html = buildSheetHtml({ design: state.design, a, f, cv, env, planetName: planetOf(env).name, snapshots: snapshotViews() });
  let el = $('#sheet'); if (el) el.remove();
  el = document.createElement('div'); el.id = 'sheet';
  el.innerHTML = `<div class="sbar"><b style="margin-right:auto">Build sheet: ${escapeHtml(state.design.name)}</b>
    <button class="primary" id="shtPrint">Print / save as PDF</button><button id="shtDl">Download HTML</button><button id="shtClose">Close</button></div>${html}`;
  document.body.appendChild(el);
  $('#shtClose').onclick = () => el.remove();
  $('#shtPrint').onclick = () => {
    document.body.classList.add('printing');
    const after = () => { document.body.classList.remove('printing'); window.removeEventListener('afterprint', after); };
    window.addEventListener('afterprint', after);
    try { window.print(); } catch { toast('Printing is blocked here: use Download HTML and print that file'); }
    setTimeout(after, 1500);
  };
  $('#shtDl').onclick = () => {
    const doc = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(state.design.name)}: build sheet</title><style>${SHEET_CSS.replace(/#sheet/g, 'body')}</style></head><body>${html}</body></html>`;
    const aEl = document.createElement('a'); aEl.href = URL.createObjectURL(new Blob([doc], { type: 'text/html' }));
    aEl.download = (state.design.name || 'ship').replace(/[^\w\- ]+/g, '_') + ' - build sheet.html'; aEl.click();
  };
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
  $('#speedCap').oninput = e => { S().speedCap = Math.max(1, +e.target.value || 100); envChanged(); };
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
  $('#extraMass').value = s.extraMass; $('#targetTwr').value = s.targetTwr; $('#fillMinor').checked = s.fillMinor; $('#speedCap').value = s.speedCap || 100;
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
  state.selection = new Set();
  if (state.tool === 'paste') state.tool = 'place';
  if (!keepUndo) { state.undo = []; state.redo = []; }
  clearScene();
  setShowAxes(design.type !== 'station');
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
  $('#designsMenu').innerHTML = `<div class="item" id="dmVariant"><span><b>＋ Save current as variant…</b></span></div>` + (names.length ? names.map(n => `<div class="item" data-load="${encodeURIComponent(n)}"><span>${escapeHtml(n)}</span>
     <span class="muted small">${all[n].grid === 'S' ? 'SG' : 'LG'} · ${all[n].blocks.length}</span><button class="mini" data-del="${encodeURIComponent(n)}">✕</button></div>`).join('')
    : '<div class="empty">No saved designs yet. Click Save.</div>');
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
  $$('#leftTabs button').forEach(b => b.onclick = () => setLeftTab(b.dataset.tab));
  setLeftTab((() => { try { return localStorage.getItem(LS_TAB) || 'blocks'; } catch { return 'blocks'; } })());
  initEnvControls(); initCustomModal();
  $$('#toolSeg button').forEach(b => b.onclick = () => setTool(b.dataset.tool));
  $$('[data-rot]').forEach(b => b.onclick = () => {
    if (b.dataset.rot === 'reset') { state.rot = 0; updateRotLabel(); return; }
    if (b.dataset.rot === 'auto') { autoRotate(); return; }
    const [ax, d] = b.dataset.rot.split(',');
    if (state.tool === 'paste' || (state.tool === 'select' && state.selection.size)) rotateGroup(ax, +d); else rotateSel(ax, +d);
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
  $('#showAxes').onchange = e => setShowAxes(e.target.checked);
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
    setShowAxes(state.design.type !== 'station');   // bases don't need direction arrows; the toggle turns them back on
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
    if (e.target.closest('#dmVariant')) { dd.classList.remove('open'); saveVariant(); return; }
    const del = e.target.closest('[data-del]'), ld = e.target.closest('[data-load]');
    const all = readJSON(LS_DESIGNS, {});
    if (del) { const n = decodeURIComponent(del.dataset.del); ask(`Delete saved design “${n}”?`, 'Delete').then(ok => { if (ok) { delete all[n]; writeJSON(LS_DESIGNS, all); renderDesignsMenu(); } }); return; }
    if (ld) { const n = decodeURIComponent(ld.dataset.load); loadDesign(all[n]); dd.classList.remove('open'); }
  };
  $('#btnHelp').onclick = () => { $('#helpModal').hidden = false; };
  const shDd = $('#btnShare').parentElement;
  $('#btnShare').onclick = e => { e.stopPropagation(); shDd.classList.toggle('open'); };
  document.addEventListener('click', () => shDd.classList.remove('open'));
  $('#shareMenu').onclick = e => {
    e.stopPropagation(); const it = e.target.closest('[data-sh]'); if (!it) return; shDd.classList.remove('open');
    ({ link: openShare, compare: openCompare, sheet: openSheet, export: exportDesign, import: () => $('#fileInput').click() })[it.dataset.sh]();
  };
  $('#btnRepaint').onclick = openRepaint;
  $('#selAllHeights').onchange = e => { state.selAllHeights = e.target.checked; };
  const act = { copy: () => copySel(), cut: cutSel, paste: () => pasteStart(false), del: deleteSel, move: moveSel, dup: () => { copySel(true); pasteStart(false); },
    all: selectAll, same: selectSameType, none: () => setSelection([]), paint: () => paintSel(state.color),
    fx: () => mirrorSel('x', false), fy: () => mirrorSel('y', false), fz: () => mirrorSel('z', false),
    mx: () => mirrorSel('x', true), my: () => mirrorSel('y', true), mz: () => mirrorSel('z', true) };
  $$('[data-sel]').forEach(b => b.onclick = () => act[b.dataset.sel]());
  $$('.modal').forEach(m => m.addEventListener('click', e => { if (e.target === m || e.target.dataset.close != null) m.hidden = true; }));

  const cur = readJSON(LS_CURRENT, null);
  if (cur && Array.isArray(cur.blocks)) loadDesign(cur); else loadDesign(buildExampleShip('lg-h2-light'));
  resize(); loop();
  loadFromHash();
  window.addEventListener('hashchange', loadFromHash);
  renderSelectionPanel();
}

// Expose a small API for debugging / tests
window.SEBP = { state, rotFor, setSelection, rotateGroup, mirrorSel, copySel, pasteStart, pasteAt, deleteSel, nudgeSel, openShare, openCompare, openSheet, encodeDesign, decodeDesign, flight: () => { const a = analyse(state.design, S()); return flightAnalysis(state.design, S(), a); }, autoRotate: () => autoRotate(), setHover: h => { hover = h; showGhost(h); }, analyseConveyors: () => analyseConveyors(state.design), analyse: () => analyse(state.design, S()), loadDesign, buildExample, serialise, placeBlocks, placementAt };

try { init(); }
catch (err) {
  console.error(err);
  // Usually a half-updated browser cache (new and old files mixed). Tell the user how to fix it.
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;left:50%;top:70px;transform:translateX(-50%);z-index:999;background:#3b2300;color:#ffd8a8;border:1px solid #f0883e;padding:14px 18px;border-radius:8px;max-width:560px;font:14px/1.5 Segoe UI,sans-serif;box-shadow:0 8px 30px #000a';
  d.innerHTML = '<b>The planner didn\'t start properly.</b><br>This usually means it was just updated and your browser is mixing old and new files. Press <b>Ctrl + Shift + R</b> (or Ctrl + F5) to reload. Your saved designs are kept.<br><span style="opacity:.7;font-size:12px">' + String(err && err.message || err).replace(/</g, '&lt;') + '</span>';
  document.body.appendChild(d);
}
