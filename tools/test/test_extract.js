// まどあかり: tests for tools/extract_b3dm.js on b3dm fixtures written with draco3d's encoder.
// Run: NODE_PATH=<folder with draco3d> node tools/test/test_extract.js   (exit code 1 on any failure)
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const draco3d = require('draco3d');

const EX = path.join(__dirname, '..', 'extract_b3dm.js');
const A = 6378137.0, FL = 1 / 298.257222101, E2 = FL * (2 - FL), D2R = Math.PI / 180;
const LON0 = 139.655, LAT0 = 35.787; // tile centre; RTC centre at h = 40 m

// ---- geometry (fixture coordinates are local ENU metres around LON0/LAT0)
function geoToEcef(lon, lat, h) {
  const L = lon * D2R, B = lat * D2R, N = A / Math.sqrt(1 - E2 * Math.sin(B) ** 2);
  return [(N + h) * Math.cos(B) * Math.cos(L), (N + h) * Math.cos(B) * Math.sin(L), (N * (1 - E2) + h) * Math.sin(B)];
}
const S0 = Math.sin(LAT0 * D2R), RN = A / Math.sqrt(1 - E2 * S0 * S0), RM = A * (1 - E2) / Math.pow(1 - E2 * S0 * S0, 1.5);
const enu2ll = (e, n) => [LON0 + e / (RN * Math.cos(LAT0 * D2R)) / D2R, LAT0 + n / RM / D2R];
// lon/lat -> metres with the constants of Local in estimate.py
const KX = 111320 * Math.cos(LAT0 * D2R) / Math.sqrt(1 - 0.00669438 * S0 * S0), KY = 110574 + 1110 * S0 * S0;
const toM = (p) => [(p[0] - LON0) * KX, (p[1] - LAT0) * KY];
function area(r) { let s = 0; for (let i = 0; i < r.length; i++) { const a = r[i], b = r[(i + 1) % r.length]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; }
const ringM2 = (ring) => Math.abs(area(ring.map(toM)));
const place = (pts, cx, cy, rot) => { const r = rot * D2R, c = Math.cos(r), s = Math.sin(r); return pts.map(([x, y]) => [cx + x * c - y * s, cy + x * s + y * c]); };
const rect = (cx, cy, w, d, rot) => place([[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]], cx, cy, rot || 0);
const ccw = (r) => area(r) < 0 ? r.slice().reverse() : r;
const llBox = (r) => { const ll = r.map(p => enu2ll(p[0], p[1])); return [Math.min(...ll.map(p => p[0])), Math.min(...ll.map(p => p[1])), Math.max(...ll.map(p => p[0])), Math.max(...ll.map(p => p[1]))]; };

// ear clipping for a simple ccw ring
function earClip(p) {
  const cr = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const idx = p.map((_, i) => i), out = [];
  while (idx.length > 3) {
    let cut = false;
    for (let k = 0; k < idx.length && !cut; k++) {
      const i0 = idx[(k + idx.length - 1) % idx.length], i1 = idx[k], i2 = idx[(k + 1) % idx.length];
      if (cr(p[i0], p[i1], p[i2]) <= 0) continue;
      if (idx.some(j => j !== i0 && j !== i1 && j !== i2 && cr(p[i0], p[i1], p[j]) >= 0 && cr(p[i1], p[i2], p[j]) >= 0 && cr(p[i2], p[i0], p[j]) >= 0)) continue;
      out.push([i0, i1, i2]); idx.splice(k, 1); cut = true;
    }
    if (!cut) throw new Error('earClip failed');
  }
  out.push(idx);
  return out;
}
// cap of [outer] or [outer 4-gon, hole 4s-gon] (hole corner i at index i*s next to outer corner i)
function cap(rings) {
  if (rings.length === 1) return { pts: rings[0], tris: earClip(rings[0]) };
  const m = rings[1].length, s = m / 4, tris = [], h = (t) => 4 + t % m;
  for (let i = 0; i < 4; i++) {
    tris.push([i, (i + 1) % 4, h((i + 1) * s)]);
    for (let t = (i + 1) * s; t > i * s; t--) tris.push([i, h(t), h(t - 1)]);
  }
  return { pts: rings[0].concat(rings[1]), tris };
}
// 4-gon with every edge cut into s parts (collinear extra vertices)
const subdiv = (r, s) => { const out = []; r.forEach((a, i) => { const b = r[(i + 1) % r.length]; for (let k = 0; k < s; k++) out.push([a[0] + (b[0] - a[0]) * k / s, a[1] + (b[1] - a[1]) * k / s]); }); return out; };
// faces of one LOD1 prism; each face has its own vertices (flat shaded, like most exporters)
function solidFaces(rings, z0, z1) {
  rings = rings.map(ccw);
  const c = cap(rings), faces = [];
  faces.push({ cap: 1, pts: c.pts.map(p => [p[0], p[1], z0]), tris: c.tris.map(t => [t[0], t[2], t[1]]) });
  faces.push({ cap: 1, pts: c.pts.map(p => [p[0], p[1], z1]), tris: c.tris });
  for (const r of rings) for (let k = 0; k < r.length; k++) {
    const a = r[k], b = r[(k + 1) % r.length];
    faces.push({ cap: 0, pts: [[a[0], a[1], z0], [b[0], b[1], z0], [b[0], b[1], z1], [a[0], a[1], z1]], tris: [[0, 1, 2], [0, 2, 3]] });
  }
  return faces;
}
// one prism as a single indexed face set (corners shared, so Draco has no duplicate points to merge)
function smoothSolid(rings, z0, z1) {
  const r = ccw(rings[0]), k = r.length, tris = [];
  for (const t of earClip(r)) tris.push([t[0], t[2], t[1]], [k + t[0], k + t[1], k + t[2]]);
  for (let i = 0; i < k; i++) { const j = (i + 1) % k; tris.push([i, j, k + j], [i, k + j, k + i]); }
  return [{ cap: 0, pts: r.map(p => [p[0], p[1], z0]).concat(r.map(p => [p[0], p[1], z1])), tris }];
}

// ---- b3dm writer (y-up glTF + CESIUM_RTC, like PLATEAU)
let EM = null;
function dracoBytes(P, I, B, o) {
  const mb = new EM.MeshBuilder(), mesh = new EM.Mesh();
  mb.AddFacesToMesh(mesh, I.length / 3, new Uint32Array(I));
  const posId = mb.AddFloatAttributeToMesh(mesh, EM.POSITION, P.length / 3, 3, new Float32Array(P));
  const bidId = o.bid === 'in' ? mb.AddFloatAttributeToMesh(mesh, EM.GENERIC, B.length, 1, new Float32Array(B)) : -1;
  const enc = new EM.Encoder();
  enc.SetAttributeQuantization(EM.POSITION, o.bits);
  enc.SetEncodingMethod(o.method === 'eb' ? EM.MESH_EDGEBREAKER_ENCODING : EM.MESH_SEQUENTIAL_ENCODING);
  const arr = new EM.DracoInt8Array(), len = enc.EncodeMeshToDracoBuffer(mesh, arr);
  if (!len) throw new Error('draco encode failed');
  const bytes = Buffer.alloc(len); for (let i = 0; i < len; i++) bytes[i] = arr.GetValue(i);
  EM.destroy(arr); EM.destroy(enc); EM.destroy(mesh); EM.destroy(mb);
  return { bytes, posId, bidId };
}
// o.blds: [{ parts: [[outer, hole?], ...], base, h, attrs }]; bits (16), method 'seq'|'eb', layout 'one'|'split'
// (walls in primitive 0, caps in 1), bid 'in'|'outside' (plain accessor next to Draco)|'noview' (accessor
// without bufferView)|'none', plain (no Draco), smooth (indexed prisms), trail (bytes after the glb),
// binKeys (batch table DOUBLE body), zup (z-up positions instead of y-up)
function makeB3dm(o) {
  o = Object.assign({ bits: 16, method: 'seq', layout: 'one', bid: 'in', plain: false, smooth: false, trail: 0, binKeys: [], zup: false }, o);
  const C = geoToEcef(LON0, LAT0, 40), faces = [], solid = o.smooth ? smoothSolid : solidFaces;
  o.blds.forEach((b, bi) => { for (const rings of b.parts) for (const f of solid(rings, b.base, b.base + b.h)) { f.bid = bi; faces.push(f); } });
  const groups = o.layout === 'split' ? [faces.filter(f => !f.cap), faces.filter(f => f.cap)] : [faces];
  const bufs = [], views = [], accs = [], prims = []; let off = 0;
  const view = (buf) => { views.push({ buffer: 0, byteOffset: off, byteLength: buf.length }); const p = Buffer.concat([buf, Buffer.alloc((4 - buf.length % 4) % 4)]); bufs.push(p); off += p.length; return views.length - 1; };
  for (const g of groups) {
    const P = [], I = [], B = [];
    for (const f of g) {
      const base = P.length / 3;
      for (const [e, n, u] of f.pts) {
        const ll = enu2ll(e, n), X = geoToEcef(ll[0], ll[1], u);
        if (o.zup) P.push(X[0] - C[0], X[1] - C[1], X[2] - C[2]); else P.push(X[0] - C[0], X[2] - C[2], -(X[1] - C[1]));
        B.push(f.bid);
      }
      for (const t of f.tris) I.push(base + t[0], base + t[1], base + t[2]);
    }
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < P.length; i++) { min[i % 3] = Math.min(min[i % 3], P[i]); max[i % 3] = Math.max(max[i % 3], P[i]); }
    const posAcc = { componentType: 5126, count: P.length / 3, type: 'VEC3', min, max }, idxAcc = { componentType: 5125, count: I.length, type: 'SCALAR' };
    const prim = { mode: 4, attributes: { POSITION: accs.length }, indices: accs.length + 1 };
    if (o.plain) {
      posAcc.bufferView = view(Buffer.from(new Float32Array(P).buffer));
      idxAcc.bufferView = view(Buffer.from(new Uint32Array(I).buffer));
    } else {
      const d = dracoBytes(P, I, B, o);
      prim.extensions = { KHR_draco_mesh_compression: { bufferView: view(d.bytes), attributes: { POSITION: d.posId } } };
      if (o.bid === 'in') prim.extensions.KHR_draco_mesh_compression.attributes._BATCHID = d.bidId;
    }
    accs.push(posAcc, idxAcc);
    if (o.bid !== 'none') {
      const ba = { componentType: 5126, count: B.length, type: 'SCALAR' };
      if (o.bid === 'outside' || (o.plain && o.bid === 'in')) ba.bufferView = view(Buffer.from(new Float32Array(B).buffer));
      prim.attributes._BATCHID = accs.length; accs.push(ba);
    }
    prims.push(prim);
  }
  const bin = Buffer.concat(bufs);
  const gltf = { asset: { version: '2.0', generator: 'test_extract' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: prims }],
    accessors: accs, bufferViews: views, buffers: [{ byteLength: bin.length }], extensionsUsed: ['CESIUM_RTC'], extensions: { CESIUM_RTC: { center: C } } };
  if (!o.plain) { gltf.extensionsUsed.push('KHR_draco_mesh_compression'); gltf.extensionsRequired = ['KHR_draco_mesh_compression']; }
  const pad = (b, ch, m) => Buffer.concat([b, Buffer.alloc((m - b.length % m) % m, ch)]);
  const js = pad(Buffer.from(JSON.stringify(gltf)), 0x20, 4);
  const glb = Buffer.concat([Buffer.alloc(12), Buffer.alloc(8), js, Buffer.alloc(8), bin]);
  glb.write('glTF', 0); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(js.length, 12); glb.writeUInt32LE(0x4E4F534A, 16);
  glb.writeUInt32LE(bin.length, 20 + js.length); glb.writeUInt32LE(0x004E4942, 24 + js.length);
  // batch table: JSON arrays, plus a binary DOUBLE body for o.binKeys
  const keys = new Set(); for (const b of o.blds) for (const k of Object.keys(b.attrs || {})) keys.add(k);
  const btj = {}, chunks = []; let bo = 0;
  for (const k of keys) {
    const vals = o.blds.map(b => (b.attrs && k in b.attrs) ? b.attrs[k] : null);
    if (o.binKeys.indexOf(k) < 0) { btj[k] = vals; continue; }
    const a = Buffer.from(new Float64Array(vals.map(v => v == null ? NaN : +v)).buffer);
    btj[k] = { byteOffset: bo, componentType: 'DOUBLE', type: 'SCALAR' }; chunks.push(a); bo += a.length;
  }
  const ft = pad(Buffer.from(JSON.stringify({ BATCH_LENGTH: o.blds.length })), 0x20, 8);
  const btB = pad(Buffer.concat(chunks), 0, 8);
  let btJ = Buffer.from(JSON.stringify(btj));
  const pre = 28 + ft.length; btJ = Buffer.concat([btJ, Buffer.alloc((8 - (pre + btJ.length) % 8) % 8, 0x20)]);
  const total = pre + btJ.length + btB.length + glb.length + o.trail;
  const hdr = Buffer.alloc(28);
  hdr.write('b3dm', 0); hdr.writeUInt32LE(1, 4); hdr.writeUInt32LE(total, 8); hdr.writeUInt32LE(ft.length, 12); hdr.writeUInt32LE(0, 16); hdr.writeUInt32LE(btJ.length, 20); hdr.writeUInt32LE(btB.length, 24);
  return Buffer.concat([hdr, ft, btJ, btB, glb, Buffer.alloc(o.trail)]);
}
// b3dm whose glTF has no meshes (BATCH_LENGTH 0)
function emptyB3dm() {
  const pad = (b, ch, m) => Buffer.concat([b, Buffer.alloc((m - b.length % m) % m, ch)]);
  const js = pad(Buffer.from(JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [] }] })), 0x20, 4);
  const glb = Buffer.concat([Buffer.alloc(20), js]);
  glb.write('glTF', 0); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(glb.length, 8); glb.writeUInt32LE(js.length, 12); glb.writeUInt32LE(0x4E4F534A, 16);
  const ft = pad(Buffer.from(JSON.stringify({ BATCH_LENGTH: 0 })), 0x20, 8), hdr = Buffer.alloc(28);
  hdr.write('b3dm', 0); hdr.writeUInt32LE(1, 4); hdr.writeUInt32LE(28 + ft.length + glb.length, 8); hdr.writeUInt32LE(ft.length, 12);
  return Buffer.concat([hdr, ft, glb]);
}

// ~n LOD1 prisms (houses, L-shapes, slabs) on a w x w m tile, bases 37.5-45.5 m ellipsoidal
function town(n, w, seed) {
  let s = seed; const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const g = Math.ceil(Math.sqrt(n)), cell = w / g, blds = [];
  for (let i = 0; i < n; i++) {
    const cx = -w / 2 + cell * (i % g + 0.5), cy = -w / 2 + cell * (Math.floor(i / g) + 0.5);
    const kind = rnd(), rot = rnd() < 0.5 ? 0 : rnd() * 90;
    let ring;
    if (kind < 0.6) ring = rect(cx, cy, 7 + rnd() * 8, 6 + rnd() * 6, rot);
    else if (kind < 0.8) { const a = 10 + rnd() * 8, b = 8 + rnd() * 6; ring = place([[0, 0], [a, 0], [a, b / 2], [a / 2, b / 2], [a / 2, b], [0, b]].map(([x, y]) => [x - a / 2, y - b / 2]), cx, cy, rot); }
    else ring = rect(cx, cy, Math.min(cell * 0.9, 20 + rnd() * 30), 9 + rnd() * 4, rot);
    const h = kind < 0.8 ? 3 + rnd() * 7 : 10 + rnd() * 30;
    blds.push({ parts: [[ring]], base: 37.5 + 8 * rnd(), h, attrs: { gml_id: 'q' + i } });
  }
  return blds;
}
// n features of two solids: a house with a 0.1 m jog (coarse Draco steps collapse it) and a 4x3 annex 2 m away
function jogTown(n, w, seed) {
  let s = seed; const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const g = Math.ceil(Math.sqrt(n)), cell = w / g, blds = [];
  for (let i = 0; i < n; i++) {
    const cx = -w / 2 + cell * (i % g + 0.5) - 3, cy = -w / 2 + cell * (Math.floor(i / g) + 0.5);
    const a = 8 + rnd() * 6, d = 7 + rnd() * 5, t = 0.3 + 0.4 * rnd();
    // starts at the jog so that the ear clipper cuts the 0.1 m sliver triangle first
    const house = [[a * t, 0], [a * t, 0.1], [a, 0.1], [a, d], [0, d], [0, 0]].map(([x, y]) => [cx + x - a / 2, cy + y - d / 2]);
    blds.push({ parts: [[house], [rect(cx + a / 2 + 4, cy, 4, 3)]], base: 37.5 + 8 * rnd(), h: 3 + 7 * rnd(), attrs: { gml_id: 'j' + i } });
  }
  return blds;
}

// ---- runner
let TMP = null, fails = 0, seq = 0;
function check(ok, msg) { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) fails++; }
const near = (v, t, rel) => typeof v === 'number' && Math.abs(v - t) <= rel * t;
function runEx(tilesDir, extra) {
  const out = tilesDir + '.json';
  const r = cp.spawnSync(process.execPath, [EX, tilesDir, out].concat(extra || []), { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('extractor exit ' + r.status + ': ' + String(r.stderr).slice(0, 400));
  return { log: JSON.parse(r.stdout.trim().split('\n').pop()), d: JSON.parse(fs.readFileSync(out, 'utf8')) };
}
function extract(tiles, extra) { // tiles: { 'name.b3dm': Buffer }
  const dir = path.join(TMP, 'case' + (++seq)), data = path.join(dir, 'data');
  fs.mkdirSync(data, { recursive: true });
  for (const f of Object.keys(tiles)) fs.writeFileSync(path.join(data, f), tiles[f]);
  return runEx(dir, extra);
}
const byId = (d) => new Map(d.buildings.map(b => [b.id, b]));

const cases = {
  'b3dm-1: Draco position quantisation (LOD1 prisms, bases 37.5-45.5 m)'() {
    for (const [bits, method, w, n] of [[11, 'eb', 450, 300], [11, 'seq', 450, 300], [12, 'eb', 450, 300], [12, 'seq', 450, 300], [12, 'eb', 1000, 800]]) {
      const blds = town(n, w, 7), truth = blds.map(b => Math.abs(area(b.parts[0][0])));
      const { d } = extract({ 'q.b3dm': makeB3dm({ blds, bits, method }) }), by = byId(d);
      let good = 0, worst = 0, zerr = 0;
      blds.forEach((b, i) => {
        const o = by.get(b.attrs.gml_id); if (!o) return;
        const e = ringM2(o.ring) / truth[i] - 1;
        if (Math.abs(e) <= 0.10) good++;
        if (Math.abs(e) > Math.abs(worst)) worst = e;
        zerr = Math.max(zerr, Math.abs(o.z0 - b.base), Math.abs(o.z1 - b.base - b.h));
      });
      const tag = `${w} m tile, ${bits} bits ${method}:`;
      check(d.report.kept === n && d.report.errors.length === 0, `${tag} kept ${d.report.kept}/${n}, errors ${d.report.errors.length}`);
      check(good >= 0.99 * n, `${tag} ${good}/${n} rings within 10% of the true area (worst ${(worst * 100).toFixed(1)}%)`);
      check(zerr < 0.5, `${tag} z0/z1 within 0.5 m (max error ${zerr.toFixed(2)} m)`);
      check(d.report.hullFallbacks === 0 && d.report.openRings === 0 && d.report.fpWritten === 0, `${tag} hullFallbacks ${d.report.hullFallbacks}, openRings ${d.report.openRings}, fpWritten ${d.report.fpWritten} (all 0)`);
    }
    // collapsed jog triangles must not break the boundary: fp (house + annex) still written
    const blds = jogTown(300, 450, 3);
    const { d } = extract({ 'j.b3dm': makeB3dm({ blds, bits: 11, method: 'eb' }) }), by = byId(d);
    let ringOk = 0, fpOk = 0;
    for (const b of blds) {
      const o = by.get(b.attrs.gml_id), main = Math.abs(area(b.parts[0][0])); if (!o) continue;
      if (Math.abs(ringM2(o.ring) / main - 1) <= 0.10) ringOk++;
      if (near(o.fp, main + 12, 0.05)) fpOk++;
    }
    check(d.report.kept === 300 && ringOk >= 297 && fpOk >= 297 && d.report.openRings === 0, `450 m tile, 11 bits eb, house with 0.1 m jog + annex: kept ${d.report.kept}/300, rings within 10% ${ringOk}, fp within 5% ${fpOk}, openRings ${d.report.openRings}`);
  },
  'b3dm-2: bytes after the glb'() {
    const blds = [0, 1, 2].map(i => ({ parts: [[rect(i * 30, 0, 20, 10)]], base: 40, h: 9, attrs: { gml_id: 'p' + i } }));
    for (const trail of [4, 8]) {
      const { d } = extract({ 'p.b3dm': makeB3dm({ blds, trail }) });
      check(d.report.kept === 3 && d.report.errors.length === 0, `${trail} trailing bytes: kept ${d.report.kept}/3, errors ${JSON.stringify(d.report.errors)}`);
    }
  },
  'b3dm-3: courtyard and two-solid footprints'() {
    const blds = [
      { parts: [[rect(0, 0, 60, 60), rect(0, 0, 30, 30)]], base: 40, h: 20, attrs: { gml_id: 'court' } },
      { parts: [[rect(0, 150, 60, 60), subdiv(rect(0, 150, 30, 30), 3)]], base: 40, h: 20, attrs: { gml_id: 'court12' } }, // hole has more vertices
      { parts: [[rect(150, 0, 40, 12)], [rect(150, 30, 40, 12)]], base: 40, h: 10, attrs: { gml_id: 'two' } },
      { parts: [[rect(-150, 0, 20, 10)]], base: 40, h: 6, attrs: { gml_id: 'plain' } },
    ];
    for (const method of ['seq', 'eb']) {
      const { d } = extract({ 'h.b3dm': makeB3dm({ blds, method }) }), by = byId(d);
      for (const id of ['court', 'court12']) {
        const c = by.get(id);
        check(c && near(ringM2(c.ring), 3600, 0.01) && near(c.fp, 2700, 0.01), `${method}: 60x60 with 30x30 courtyard (${id}) -> ring ${c && ringM2(c.ring).toFixed(1)} m2 (3600), fp ${c && c.fp} (2700)`);
      }
      const t = by.get('two'), p = by.get('plain');
      check(t && near(ringM2(t.ring), 480, 0.01) && near(t.fp, 960, 0.01), `${method}: two 40x12 solids -> ring ${t && ringM2(t.ring).toFixed(1)} m2 (480), fp ${t && t.fp} (960)`);
      check(p && p.fp === undefined && near(ringM2(p.ring), 200, 0.01), `${method}: plain 20x10 -> ring ${p && ringM2(p.ring).toFixed(1)} m2, no fp`);
      check(d.report.fpWritten === 3, `${method}: report.fpWritten ${d.report.fpWritten} (3)`);
    }
  },
  'b3dm-3: rings touching at one vertex'() {
    // 60x60 with a triangular courtyard touching the south wall at (30,0); drawn as two parts with a shared cut
    const sh = (r) => r.map(([x, y]) => [x - 30, y - 30]);
    const A = [[0, 0], [30, 0], [20, 20], [30, 20], [30, 60], [0, 60]], B = [[30, 0], [60, 0], [60, 60], [30, 60], [30, 20], [40, 20]];
    const blds = [{ parts: [[sh(A)], [sh(B)]], base: 40, h: 15, attrs: { gml_id: 'pinch' } },
      { parts: [[rect(105, 5, 10, 10)], [rect(115, 15, 10, 10)]], base: 40, h: 8, attrs: { gml_id: 'corner' } }];
    for (const method of ['seq', 'eb']) {
      const { d } = extract({ 't.b3dm': makeB3dm({ blds, method }) }), by = byId(d), p = by.get('pinch'), c = by.get('corner');
      check(p && near(ringM2(p.ring), 3600, 0.01) && near(p.fp, 3400, 0.01), `${method}: courtyard touching the outer wall -> ring ${p && ringM2(p.ring).toFixed(1)} m2 (3600), fp ${p && p.fp} (3400)`);
      check(c && near(ringM2(c.ring), 100, 0.01) && near(c.fp, 200, 0.01), `${method}: two 10x10 parts sharing a corner -> ring ${c && ringM2(c.ring).toFixed(1)} m2 (100), fp ${c && c.fp} (200)`);
      check(d.report.openRings === 0, `${method}: openRings ${d.report.openRings} (0)`);
    }
  },
  'axis: z-up glTF with an RTC centre'() {
    const blds = town(40, 200, 5), { d } = extract({ 'z.b3dm': makeB3dm({ blds, zup: true }) }), by = byId(d);
    const good = blds.filter(b => { const o = by.get(b.attrs.gml_id); return o && near(ringM2(o.ring), Math.abs(area(b.parts[0][0])), 0.05); }).length;
    check(JSON.stringify(d.report.axisModes) === '{"zup":1}' && good === 40 && d.report.hullFallbacks === 0, `axisModes ${JSON.stringify(d.report.axisModes)}, ${good}/40 rings within 5%, hullFallbacks ${d.report.hullFallbacks}`);
  },
  'robustness: empty tile, bbox with an empty field'() {
    const blds = [0, 1].map(i => ({ parts: [[rect(i * 30, 0, 20, 10)]], base: 40, h: 9, attrs: { gml_id: 'e' + i } }));
    const { d } = extract({ 'a.b3dm': emptyB3dm(), 'b.b3dm': makeB3dm({ blds }) });
    check(d.report.tiles === 2 && d.report.kept === 2 && d.report.errors.length === 0, `tile without meshes + normal tile: kept ${d.report.kept}/2, errors ${JSON.stringify(d.report.errors)}`);
    const bad = cp.spawnSync(process.execPath, [EX, path.join(TMP, 'case' + seq), path.join(TMP, 'bad2.json'), '139.65,,139.66,35.79'], { encoding: 'utf8' });
    check(bad.status === 1 && !fs.existsSync(path.join(TMP, 'bad2.json')), `bbox with an empty field -> exit ${bad.status}`);
  },
  'b3dm-4: one building split over two primitives'() {
    const L = place([[0, 0], [30, 0], [30, 10], [10, 10], [10, 30], [0, 30]], 60, 0, 0);
    const blds = [{ parts: [[rect(0, 0, 40, 15, 20)]], base: 40, h: 12, attrs: { gml_id: 'slab' } }, { parts: [[L]], base: 41, h: 7, attrs: { gml_id: 'L' } }, { parts: [[rect(-60, 40, 10, 8)]], base: 39, h: 6, attrs: { gml_id: 'house' } }];
    const { d } = extract({ 's.b3dm': makeB3dm({ blds, layout: 'split' }) }), by = byId(d);
    for (const [id, t] of [['slab', 600], ['L', 500], ['house', 80]]) { const b = by.get(id); check(b && near(ringM2(b.ring), t, 0.01) && b.fp === undefined, `split primitives: ${id} ring ${b && ringM2(b.ring).toFixed(1)} m2 (${t})`); }
    check(d.report.maxPrimitivesPerMesh === 2, `report.maxPrimitivesPerMesh ${d.report.maxPrimitivesPerMesh} (2)`);
  },
  'b3dm-5: primitives without batch ids'() {
    const blds = [0, 1, 2].map(i => ({ parts: [[rect(i * 30, 0, 20, 10)]], base: 40, h: 9, attrs: { gml_id: 'n' + i } }));
    const allRight = (d) => { const by = byId(d); return d.report.kept === 3 && blds.every(b => by.has(b.attrs.gml_id) && near(ringM2(by.get(b.attrs.gml_id).ring), 200, 0.01)); };
    const skipped = (d) => d.report.kept === 0 && d.report.noBatchIdPrimitives === 1 && d.report.errors.some(e => /batch ids/.test(e));
    const say = (d) => `kept ${d.report.kept}, noBatchIdPrimitives ${d.report.noBatchIdPrimitives}, errors ${JSON.stringify(d.report.errors)}`;
    // no usable batch ids and BATCH_LENGTH 3: skipped with an error, never merged into one building
    for (const [bid, plain, smooth, method] of [['none'], ['noview'], ['noview', true], ['outside', false, true, 'eb']]) {
      const { d } = extract({ 'n.b3dm': makeB3dm({ blds, bid, plain, smooth, method }) });
      check(skipped(d), `${plain ? 'plain glTF' : 'Draco ' + (method || 'seq')}, batch ids ${bid}, BATCH_LENGTH 3: ${say(d)}`);
    }
    // batch ids next to the Draco data: used only when they line up (sequential, same point count)
    const fl = extract({ 'n.b3dm': makeB3dm({ blds, bid: 'outside' }) }).d;
    check(skipped(fl) || allRight(fl), `Draco seq, flat-shaded, batch ids outside (points merged by the encoder): ${say(fl)}`);
    const sm = extract({ 'n.b3dm': makeB3dm({ blds, bid: 'outside', smooth: true }) }).d;
    check(allRight(sm) && sm.report.errors.length === 0, `Draco seq, indexed, batch ids outside: ${say(sm)}`);
    const one = extract({ 'n1.b3dm': makeB3dm({ blds: blds.slice(0, 1), bid: 'none' }) }).d;
    check(one.report.kept === 1 && one.report.errors.length === 0, `BATCH_LENGTH 1 without batch ids: kept ${one.report.kept}/1, errors ${one.report.errors.length}`);
    const pl = extract({ 'pl.b3dm': makeB3dm({ blds, plain: true }) }).d;
    check(allRight(pl) && JSON.stringify(pl.report.dracoAttributes) === '[]', `plain glTF with a _BATCHID accessor: kept ${pl.report.kept}/3, dracoAttributes ${JSON.stringify(pl.report.dracoAttributes)}`);
  },
  'X5: batch-table bbox check'() {
    const rings = [rect(0, 0, 20, 10), rect(40, 0, 12, 9, 30), rect(0, 40, 30, 12, 75), rect(-40, -20, 9, 8)];
    const mk = (fn) => rings.map((r, i) => { const b = fn(llBox(r), i); return { parts: [[r]], base: 40, h: 8, attrs: { gml_id: 'x' + i, _xmin: b[0], _ymin: b[1], _xmax: b[2], _ymax: b[3] } }; });
    const binKeys = ['_xmin', '_ymin', '_xmax', '_ymax'];
    const ok = extract({ 'x.b3dm': makeB3dm({ blds: mk(b => b), binKeys }) });
    check(ok.d.report.bboxChecked === 4 && ok.d.report.bboxMismatch === 0, `true _xmin/_xmax/_ymin/_ymax (binary DOUBLE): checked ${ok.d.report.bboxChecked}/4, bboxMismatch ${ok.d.report.bboxMismatch} (0)`);
    const sw = extract({ 'x.b3dm': makeB3dm({ blds: mk(b => [b[1], b[0], b[3], b[2]]) }) });
    check(sw.d.report.bboxChecked === 4 && sw.d.report.bboxMismatch === 0, `lat/lon order (JSON arrays): checked ${sw.d.report.bboxChecked}/4, bboxMismatch ${sw.d.report.bboxMismatch} (0)`);
    const bad = extract({ 'x.b3dm': makeB3dm({ blds: mk((b, i) => i === 2 ? [b[0] - 1e-4, b[1], b[2], b[3]] : b), binKeys }) });
    check(bad.d.report.bboxMismatch === 1, `one _xmin off by 1e-4 deg: bboxMismatch ${bad.d.report.bboxMismatch} (1)`);
    const none = extract({ 'x.b3dm': makeB3dm({ blds: rings.map((r, i) => ({ parts: [[r]], base: 40, h: 8, attrs: { gml_id: 'x' + i } })) }) });
    check(none.d.report.bboxChecked === 0 && none.d.report.bboxMismatch === 0, `no bbox keys: checked ${none.d.report.bboxChecked}, bboxMismatch ${none.d.report.bboxMismatch}`);
    const keys = ['bbox', 'bboxChecked', 'bboxMismatch', 'fpWritten', 'hullFallbacks', 'openRings', 'maxPrimitivesPerMesh', 'dracoAttributes', 'noBatchIdPrimitives'];
    check(keys.every(k => k in ok.log) && JSON.stringify(ok.log.dracoAttributes) === '["POSITION","_BATCHID"]', 'console summary has ' + keys.join(', '));
  },
  'X5: report.bbox and the bbox filter'() {
    const blds = [-100, 0, 100].map((x, i) => ({ parts: [[rect(x, 0, 20, 10)]], base: 40, h: 9, attrs: { gml_id: 'b' + i } }));
    const tile = { 'b.b3dm': makeB3dm({ blds }) };
    const lo = enu2ll(-50, -50), hi = enu2ll(50, 50), arg = [lo[0], lo[1], hi[0], hi[1]].map(v => v.toFixed(6)).join(',');
    const r = extract(tile, [arg]);
    check(JSON.stringify(r.d.report.bbox) === JSON.stringify(arg.split(',').map(Number)) && JSON.stringify(r.log.bbox) === JSON.stringify(r.d.report.bbox), `report.bbox ${JSON.stringify(r.d.report.bbox)} echoes ${arg}`);
    check(r.d.report.kept === 1 && r.d.buildings[0].id === 'b1', `bbox keeps only the middle building (${r.d.buildings.map(b => b.id)})`);
    const n = extract(tile);
    check(n.d.report.bbox === null && n.d.report.kept === 3, `no bbox argument: report.bbox ${n.d.report.bbox}, kept ${n.d.report.kept}/3`);
    const bad = cp.spawnSync(process.execPath, [EX, path.join(TMP, 'case' + seq), path.join(TMP, 'bad.json'), '139.7,35.8,139.6'], { encoding: 'utf8' });
    check(bad.status !== 0 && !fs.existsSync(path.join(TMP, 'bad.json')), `malformed bbox argument -> exit ${bad.status}`);
  },
  'kept attributes: PLATEAU uro keys with a parent prefix'() {
    const attrs = { gml_id: 'k0', 'bldg:usage': '共同住宅', 'uro:BuildingDetailAttribute_uro:buildingRoofEdgeArea': 200.5,
      'uro:BuildingIDAttribute_uro:buildingID': '13119-bldg-1', '延べ面積換算係数': 1.2, 'uro:BuildingDetailAttribute_uro:landUseType': '住宅用地' };
    const { d } = extract({ 'k.b3dm': makeB3dm({ blds: [{ parts: [[rect(0, 0, 20, 10)]], base: 40, h: 9, attrs }] }) });
    const a = d.buildings.length === 1 ? d.buildings[0].a : {};
    check(a['uro:BuildingDetailAttribute_uro:buildingRoofEdgeArea'] === 200.5 && a['uro:BuildingIDAttribute_uro:buildingID'] === '13119-bldg-1' && a['延べ面積換算係数'] === 1.2,
      `roof-edge area, building ID and 延べ面積換算係数 kept: ${JSON.stringify(a)}`);
    check(!('uro:BuildingDetailAttribute_uro:landUseType' in a), 'other uro detail keys are not kept');
  },
  'make_b3dm.js fixture'() {
    const dir = path.join(TMP, 'repo'); fs.mkdirSync(dir, { recursive: true });
    const r = cp.spawnSync(process.execPath, [path.join(__dirname, 'make_b3dm.js')], { cwd: dir, encoding: 'utf8' });
    check(r.status === 0, 'make_b3dm.js runs: ' + String(r.stdout || r.stderr).trim().slice(0, 200));
    const { d } = runEx(path.join(dir, 'test', 'tiles')), by = byId(d);
    const a = by.get('bldg_a'), b = by.get('bldg_b');
    check(d.report.kept === 2 && d.report.errors.length === 0 && a && b && near(ringM2(a.ring), 600, 0.01) && near(ringM2(b.ring), 300, 0.01) && !('fp' in a) && !('fp' in b),
      `bldg_a ${a && ringM2(a.ring).toFixed(1)} m2 (600), bldg_b ${b && ringM2(b.ring).toFixed(1)} m2 (300), z ${a && a.z0}-${a && a.z1}`);
  },
};

(async () => {
  EM = await draco3d.createEncoderModule({});
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'madoakari-x-'));
  for (const name of Object.keys(cases)) {
    console.log('# ' + name);
    try { cases[name](); } catch (e) { check(false, name + ': ' + (e && e.stack || e)); }
  }
  if (fails) console.log('fixtures kept in ' + TMP); else fs.rmSync(TMP, { recursive: true, force: true });
  console.log(fails ? fails + ' check(s) FAILED' : 'all checks passed');
  process.exit(fails ? 1 : 0);
})();
