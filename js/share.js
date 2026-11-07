// Share-by-link: pack a design into a compact string for the URL (#design=...).
// Format: JSON with block ids de-duplicated, deflated (CompressionStream), base64url.

const b64url = bytes => {
  let s = ''; const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64url = str => {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};
async function pipe(bytes, stream) {
  const res = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await res.arrayBuffer());
}

export function compact(d) {
  const ids = [];
  const idx = new Map();
  const b = d.blocks.map(x => {
    if (!idx.has(x.id)) { idx.set(x.id, ids.length); ids.push(x.id); }
    const row = [idx.get(x.id), x.p[0], x.p[1], x.p[2], x.r];
    if (x.color != null) row.push(x.color);
    return row;
  });
  const out = { v: 1, n: d.name, g: d.grid, t: d.type, i: ids, b, s: d.settings };
  if (d.customBlocks && Object.keys(d.customBlocks).length) {
    // only custom blocks that are used
    const used = {};
    for (const id of ids) if (d.customBlocks[id]) used[id] = d.customBlocks[id];
    if (Object.keys(used).length) out.c = used;
  }
  if (d.overrides && Object.keys(d.overrides).length) out.o = d.overrides;
  return out;
}
export function expand(c) {
  return {
    format: 'se-build-planner', version: 1, name: c.n, grid: c.g, type: c.t || 'ship', settings: c.s || {},
    blocks: c.b.map(r => ({ id: c.i[r[0]], p: [r[1], r[2], r[3]], r: r[4], ...(r.length > 5 ? { color: r[5] } : {}) })),
    customBlocks: c.c || {}, overrides: c.o || {},
  };
}

export async function encodeDesign(d) {
  const json = new TextEncoder().encode(JSON.stringify(compact(d)));
  if (typeof CompressionStream !== 'undefined') {
    try { return 'z' + b64url(await pipe(json, new CompressionStream('deflate-raw'))); } catch { /* fall through */ }
  }
  return 'j' + b64url(json);
}
export async function decodeDesign(s) {
  const kind = s[0], body = unb64url(s.slice(1));
  let bytes = body;
  if (kind === 'z') bytes = await pipe(body, new DecompressionStream('deflate-raw'));
  else if (kind !== 'j') throw new Error('Unknown link format');
  const c = JSON.parse(new TextDecoder().decode(bytes));
  if (!c || !Array.isArray(c.b)) throw new Error('Not a design');
  return expand(c);
}
