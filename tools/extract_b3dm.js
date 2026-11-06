// まどあかり: extract per-building footprints and attributes from PLATEAU b3dm tiles.
// Usage: node extract_b3dm.js <tiles_dir> <out.json> [lon1,lat1,lon2,lat2]
// Needs: npm i draco3d (in this folder or a parent).
// Output: { buildings: [{ id, ring:[[lon,lat],...], z0, z1, a:{...attributes} }], report:{...} }
'use strict';
const fs = require('fs');
const path = require('path');

const KEEP = [/^gml_id$/, /^bldg:usage$/, /^bldg:class$/, /^bldg:storeysAboveGround$/, /^bldg:storeysBelowGround$/,
  /^bldg:measuredHeight$/, /^bldg:address$/, /^bldg:yearOfConstruction$/, /^uro:buildingID$/, /^uro:buildingRoofEdgeArea$/,
  /^uro:totalFloorArea$/, /^uro:buildingFootprintArea$/, /surveyYear/, /町丁目/, /丁目コード/, /区市町村コード/, /大字/, /浸水/, /継続時間/, /土砂/, /^_x$/, /^_y$/,
  /^_zmin$/, /^_zmax$/, /^city_code$/, /耐火/, /構造/];

const A = 6378137.0, F = 1 / 298.257222101, E2 = F * (2 - F);
function ecefToGeo(x, y, z) {
  const lon = Math.atan2(y, x);
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - E2));
  let h = 0;
  for (let i = 0; i < 6; i++) {
    const s = Math.sin(lat);
    const N = A / Math.sqrt(1 - E2 * s * s);
    h = p / Math.cos(lat) - N;
    lat = Math.atan2(z, p * (1 - E2 * N / (N + h)));
  }
  return [lon * 180 / Math.PI, lat * 180 / Math.PI, h];
}

function mat4mul(a, b) { // column-major
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s;
  }
  return o;
}
function nodeMatrix(n) {
  if (n.matrix) return n.matrix.slice();
  const t = n.translation || [0, 0, 0], q = n.rotation || [0, 0, 0, 1], s = n.scale || [1, 1, 1];
  const [x, y, z, w] = q;
  const m = [
    (1 - 2 * (y * y + z * z)) * s[0], (2 * (x * y + z * w)) * s[0], (2 * (x * z - y * w)) * s[0], 0,
    (2 * (x * y - z * w)) * s[1], (1 - 2 * (x * x + z * z)) * s[1], (2 * (y * z + x * w)) * s[1], 0,
    (2 * (x * z + y * w)) * s[2], (2 * (y * z - x * w)) * s[2], (1 - 2 * (x * x + y * y)) * s[2], 0,
    t[0], t[1], t[2], 1];
  return m;
}
function apply(m, p) {
  return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
}

function readBatchTable(json, bin, n) {
  const out = {};
  for (const [k, v] of Object.entries(json || {})) {
    if (k === 'extensions' || k === 'extras') continue;
    if (Array.isArray(v)) { out[k] = v; continue; }
    if (v && typeof v === 'object' && 'byteOffset' in v && bin) {
      const comp = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5124: Int32Array, 5125: Uint32Array, 5126: Float32Array, 5130: Float64Array }[
        typeof v.componentType === 'string' ? { BYTE: 5120, UNSIGNED_BYTE: 5121, SHORT: 5122, UNSIGNED_SHORT: 5123, INT: 5124, UNSIGNED_INT: 5125, FLOAT: 5126, DOUBLE: 5130 }[v.componentType] : v.componentType];
      const size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[v.type] || 1;
      if (!comp) continue;
      const arr = new comp(bin.buffer.slice(bin.byteOffset + v.byteOffset, bin.byteOffset + v.byteOffset + n * size * comp.BYTES_PER_ELEMENT));
      const vals = [];
      for (let i = 0; i < n; i++) vals.push(size === 1 ? arr[i] : Array.from(arr.slice(i * size, i * size + size)));
      out[k] = vals;
    }
  }
  return out;
}

function parseB3dm(buf) {
  if (buf.toString('ascii', 0, 4) !== 'b3dm') throw new Error('not b3dm');
  const ftj = buf.readUInt32LE(12), ftb = buf.readUInt32LE(16), btj = buf.readUInt32LE(20), btb = buf.readUInt32LE(24);
  let o = 28;
  const featureTable = ftj ? JSON.parse(buf.toString('utf8', o, o + ftj).trim() || '{}') : {}; o += ftj;
  const ftBin = buf.subarray(o, o + ftb); o += ftb;
  const batchJson = btj ? JSON.parse(buf.toString('utf8', o, o + btj).trim() || '{}') : {}; o += btj;
  const batchBin = buf.subarray(o, o + btb); o += btb;
  const glb = buf.subarray(o);
  return { featureTable, ftBin, batchJson, batchBin, glb };
}

function parseGlb(glb) {
  if (glb.toString('ascii', 0, 4) !== 'glTF') throw new Error('no glb');
  let o = 12; let json = null, bin = null;
  while (o < glb.length) {
    const len = glb.readUInt32LE(o), type = glb.readUInt32LE(o + 4);
    const chunk = glb.subarray(o + 8, o + 8 + len);
    if (type === 0x4E4F534A) json = JSON.parse(chunk.toString('utf8'));
    else if (type === 0x004E4942) bin = chunk;
    o += 8 + len;
  }
  return { json, bin };
}

function accessorData(gltf, bin, idx) {
  const acc = gltf.accessors[idx];
  const bv = gltf.bufferViews[acc.bufferView];
  const comp = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array }[acc.componentType];
  const size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[acc.type];
  const start = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const stride = bv.byteStride || size * comp.BYTES_PER_ELEMENT;
  const out = new Float64Array(acc.count * size);
  const dv = new DataView(bin.buffer, bin.byteOffset);
  for (let i = 0; i < acc.count; i++) for (let k = 0; k < size; k++) {
    const off = start + i * stride + k * comp.BYTES_PER_ELEMENT;
    let v;
    switch (acc.componentType) {
      case 5126: v = dv.getFloat32(off, true); break;
      case 5125: v = dv.getUint32(off, true); break;
      case 5123: v = dv.getUint16(off, true); break;
      case 5122: v = dv.getInt16(off, true); break;
      case 5121: v = dv.getUint8(off); break;
      default: v = dv.getInt8(off);
    }
    out[i * size + k] = v;
  }
  return { data: out, size, count: acc.count };
}

function decodeDraco(dm, bytes, attrIds) {
  const decoder = new dm.Decoder();
  const buffer = new dm.DecoderBuffer();
  buffer.Init(new Int8Array(bytes), bytes.length);
  const mesh = new dm.Mesh();
  const st = decoder.DecodeBufferToMesh(buffer, mesh);
  if (!st.ok() || mesh.ptr === 0) throw new Error('draco decode failed: ' + st.error_msg());
  const nf = mesh.num_faces(), np = mesh.num_points();
  const idx = new Uint32Array(nf * 3);
  const ia = new dm.DracoInt32Array();
  for (let f = 0; f < nf; f++) { decoder.GetFaceFromMesh(mesh, f, ia); idx[f * 3] = ia.GetValue(0); idx[f * 3 + 1] = ia.GetValue(1); idx[f * 3 + 2] = ia.GetValue(2); }
  dm.destroy(ia);
  const attrs = {};
  for (const [name, id] of Object.entries(attrIds)) {
    const at = decoder.GetAttributeByUniqueId(mesh, id);
    if (!at || at.ptr === 0) continue;
    const comps = at.num_components();
    const arr = new dm.DracoFloat32Array();
    decoder.GetAttributeFloatForAllPoints(mesh, at, arr);
    const out = new Float64Array(np * comps);
    for (let i = 0; i < np * comps; i++) out[i] = arr.GetValue(i);
    dm.destroy(arr);
    attrs[name] = { data: out, size: comps, count: np };
  }
  dm.destroy(mesh); dm.destroy(buffer); dm.destroy(decoder);
  return { idx, attrs };
}

function convexHull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  up.pop(); lo.pop();
  return lo.concat(up);
}

function outline(tris, geo) {
  // tris: array of [i,j,k] vertex indices into geo (lon,lat,h); returns ring of [lon,lat]
  let zmin = Infinity, zmax = -Infinity;
  for (const t of tris) for (const v of t) { zmin = Math.min(zmin, geo[v][2]); zmax = Math.max(zmax, geo[v][2]); }
  const key = (v) => Math.round(geo[v][0] * 1e7) + ',' + Math.round(geo[v][1] * 1e7);
  for (const level of [zmin, zmax]) {
    const flat = tris.filter(t => t.every(v => Math.abs(geo[v][2] - level) < 0.15));
    if (!flat.length) continue;
    const count = new Map(), pos = new Map();
    for (const t of flat) for (let e = 0; e < 3; e++) {
      const a = key(t[e]), b = key(t[(e + 1) % 3]);
      pos.set(a, [geo[t[e]][0], geo[t[e]][1]]); pos.set(b, [geo[t[(e + 1) % 3]][0], geo[t[(e + 1) % 3]][1]]);
      const k = a < b ? a + '|' + b : b + '|' + a;
      count.set(k, (count.get(k) || 0) + 1);
    }
    const next = new Map();
    for (const [k, c] of count) if (c === 1) {
      const [a, b] = k.split('|');
      if (!next.has(a)) next.set(a, []); if (!next.has(b)) next.set(b, []);
      next.get(a).push(b); next.get(b).push(a);
    }
    if (!next.size) continue;
    // chain rings, keep the longest
    const used = new Set(); let best = null;
    for (const start of next.keys()) {
      if (used.has(start)) continue;
      const ring = [start]; used.add(start);
      let prev = null, cur = start;
      for (let guard = 0; guard < 10000; guard++) {
        const nb = (next.get(cur) || []).filter(x => x !== prev && !used.has(x));
        if (!nb.length) break;
        prev = cur; cur = nb[0]; used.add(cur); ring.push(cur);
      }
      if (!best || ring.length > best.length) best = ring;
    }
    if (best && best.length >= 3) return { ring: best.map(k => pos.get(k)), zmin, zmax };
  }
  const all = [];
  for (const t of tris) for (const v of t) all.push([geo[v][0], geo[v][1]]);
  return { ring: convexHull(all), zmin, zmax };
}

async function main() {
  const [dir, out, bboxArg] = process.argv.slice(2);
  if (!dir || !out) { console.error('usage: node extract_b3dm.js <tiles_dir> <out.json> [lon1,lat1,lon2,lat2]'); process.exit(1); }
  const bbox = bboxArg ? bboxArg.split(',').map(Number) : null;
  const draco3d = require('draco3d');
  const dm = await draco3d.createDecoderModule({});
  const files = [];
  (function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); const s = fs.statSync(p); if (s.isDirectory()) walk(p); else if (f.toLowerCase().endsWith('.b3dm')) files.push(p); } })(dir);
  files.sort();
  const seen = new Set();
  const buildings = [];
  const report = { tiles: files.length, features: 0, kept: 0, dup: 0, axisModes: {}, errors: [], keys: {} };
  for (const f of files) {
    try {
      const b = parseB3dm(fs.readFileSync(f));
      const n = b.featureTable.BATCH_LENGTH || 0;
      const bt = readBatchTable(b.batchJson, b.batchBin, n);
      for (const k of Object.keys(bt)) report.keys[k] = (report.keys[k] || 0) + 1;
      const { json: gltf, bin } = parseGlb(b.glb);
      const rtc = (gltf.extensions && gltf.extensions.CESIUM_RTC && gltf.extensions.CESIUM_RTC.center) || b.featureTable.RTC_CENTER || [0, 0, 0];
      // node matrices per mesh
      const meshMats = new Map();
      const I4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
      const nodes = gltf.nodes || [];
      let roots;
      if (gltf.scenes && gltf.scenes.length) roots = gltf.scenes[gltf.scene || 0].nodes || [];
      else { const child = new Set(); nodes.forEach(n => (n.children || []).forEach(c => child.add(c))); roots = nodes.map((_, i) => i).filter(i => !child.has(i)); }
      const visit = (ni, parent) => {
        const node = nodes[ni];
        const m = mat4mul(parent, nodeMatrix(node));
        if (node.mesh !== undefined) { if (!meshMats.has(node.mesh)) meshMats.set(node.mesh, []); meshMats.get(node.mesh).push(m); }
        for (const c of node.children || []) visit(c, m);
      };
      roots.forEach(r => visit(r, I4));
      const feats = new Map(); // batchId -> {verts:[[x,y,z]], tris:[[a,b,c]]}
      gltf.meshes.forEach((mesh, mi) => {
        const mats = meshMats.get(mi) || [[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]];
        for (const prim of mesh.primitives) {
          let pos, bid, idx;
          const ext = prim.extensions && prim.extensions.KHR_draco_mesh_compression;
          if (ext) {
            const bv = gltf.bufferViews[ext.bufferView];
            const bytes = bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
            const d = decodeDraco(dm, bytes, ext.attributes);
            pos = d.attrs.POSITION; bid = d.attrs._BATCHID || d.attrs._FEATURE_ID_0 || d.attrs.BATCHID; idx = d.idx;
          } else {
            pos = accessorData(gltf, bin, prim.attributes.POSITION);
            const ba = prim.attributes._BATCHID ?? prim.attributes._FEATURE_ID_0 ?? prim.attributes.BATCHID;
            bid = ba !== undefined ? accessorData(gltf, bin, ba) : null;
            if (prim.indices !== undefined) idx = Uint32Array.from(accessorData(gltf, bin, prim.indices).data);
            else idx = Uint32Array.from({ length: pos.count }, (_, i) => i);
          }
          for (const m of mats) {
            const local = [];
            for (let i = 0; i < pos.count; i++) local.push(apply(m, [pos.data[i * 3], pos.data[i * 3 + 1], pos.data[i * 3 + 2]]));
            for (let t = 0; t < idx.length; t += 3) {
              const a = idx[t], bb = idx[t + 1], c = idx[t + 2];
              const id = bid ? Math.round(bid.data[a]) : 0;
              if (!feats.has(id)) feats.set(id, { verts: [], map: new Map(), tris: [] });
              const F = feats.get(id);
              const tri = [a, bb, c].map(v => { if (!F.map.has(v)) { F.map.set(v, F.verts.length); F.verts.push(local[v]); } return F.map.get(v); });
              F.tris.push(tri);
            }
          }
        }
      });
      // decide axis mode (y-up -> z-up rotation or not) using the first feature
      const toGeoModes = {
        yup: (p) => ecefToGeo(rtc[0] + p[0], rtc[1] - p[2], rtc[2] + p[1]),
        zup: (p) => ecefToGeo(rtc[0] + p[0], rtc[1] + p[1], rtc[2] + p[2]),
      };
      let mode = 'yup';
      const first = feats.values().next().value;
      if (first) {
        const ok = (m) => { const g = toGeoModes[m](first.verts[0]); return g[0] > 122 && g[0] < 154 && g[1] > 20 && g[1] < 46 && g[2] > -200 && g[2] < 4000; };
        if (!ok('yup') && ok('zup')) mode = 'zup';
      }
      report.axisModes[mode] = (report.axisModes[mode] || 0) + 1;
      for (const [id, F] of feats) {
        report.features++;
        const geo = F.verts.map(toGeoModes[mode]);
        const o = outline(F.tris, geo);
        if (!o.ring || o.ring.length < 3) continue;
        let cx = 0, cy = 0; for (const p of o.ring) { cx += p[0]; cy += p[1]; } cx /= o.ring.length; cy /= o.ring.length;
        if (bbox && !(cx >= bbox[0] && cx <= bbox[2] && cy >= bbox[1] && cy <= bbox[3])) continue;
        const a = {};
        for (const [k, arr] of Object.entries(bt)) if (KEEP.some(r => r.test(k))) { const v = arr[id]; if (v !== null && v !== undefined && v !== '') a[k] = v; }
        const gid = a.gml_id || (path.basename(f) + '#' + id);
        if (seen.has(gid)) { report.dup++; continue; }
        seen.add(gid);
        buildings.push({ id: gid, ring: o.ring.map(p => [+p[0].toFixed(7), +p[1].toFixed(7)]), z0: +o.zmin.toFixed(2), z1: +o.zmax.toFixed(2), a });
        report.kept++;
      }
    } catch (e) {
      report.errors.push(path.basename(f) + ': ' + e.message);
    }
  }
  fs.writeFileSync(out, JSON.stringify({ buildings, report }));
  console.log(JSON.stringify({ tiles: report.tiles, features: report.features, kept: report.kept, dup: report.dup, axisModes: report.axisModes, errors: report.errors.slice(0, 5), keyCount: Object.keys(report.keys).length }));
}
main().catch(e => { console.error(e); process.exit(1); });
