// まどあかり: extract per-building footprints and attributes from PLATEAU b3dm tiles.
// Usage: node extract_b3dm.js <tiles_dir> <out.json> [lon1,lat1,lon2,lat2]
// Needs: npm i draco3d (in this folder or a parent).
// Output: { buildings: [{ id, ring:[[lon,lat],...], z0, z1, fp?, a:{...attributes} }], report:{...} }
//   fp = net footprint area in m2 (outer rings minus courtyards), only when it differs from the ring's area by >1%.
//   report: bbox (argument or null), bboxChecked/bboxMismatch (ring vs batch-table _xmin.._ymax > 2e-5 deg),
//   fpWritten, hullFallbacks, openRings (footprint outline not closed), maxPrimitivesPerMesh, dracoAttributes,
//   noBatchIdPrimitives, errors, ...
'use strict';
const fs = require('fs');
const path = require('path');

// PLATEAU batch tables name uro attributes with their parent first, e.g. 'uro:BuildingDetailAttribute_uro:buildingRoofEdgeArea',
// so the uro keys match at the end of the name.
const KEEP = [/^gml_id$/, /^bldg:usage$/, /^bldg:class$/, /^bldg:storeysAboveGround$/, /^bldg:storeysBelowGround$/,
  /^bldg:measuredHeight$/, /^bldg:address$/, /^bldg:yearOfConstruction$/, /(^|_)uro:buildingID$/, /(^|_)uro:buildingRoofEdgeArea$/,
  /(^|_)uro:totalFloorArea$/, /(^|_)uro:buildingFootprintArea$/, /延べ面積換算係数/, /surveyYear/, /町丁目/, /丁目コード/, /区市町村コード/, /大字/, /浸水/, /継続時間/, /土砂/, /^_x$/, /^_y$/,
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
  // stop at the glb's declared length: writers may pad the b3dm after it (Cesium does the same)
  const end = Math.min(glb.readUInt32LE(8), glb.length);
  while (o + 8 <= end) {
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

// signed shoelace area of a lon/lat ring, offset by its first vertex (keeps precision)
function ringArea(r) {
  const x0 = r[0][0], y0 = r[0][1]; let s = 0;
  for (let i = 1; i + 1 < r.length; i++) s += (r[i][0] - x0) * (r[i + 1][1] - y0) - (r[i + 1][0] - x0) * (r[i][1] - y0);
  return s / 2;
}
function boxOf(r) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const p of r) { if (p[0] < x1) x1 = p[0]; if (p[0] > x2) x2 = p[0]; if (p[1] < y1) y1 = p[1]; if (p[1] > y2) y2 = p[1]; }
  return [x1, y1, x2, y2];
}
const ek = (a, b) => a < b ? a + '|' + b : b + '|' + a;

function outline(tris, geo) {
  // tris: array of [i,j,k] vertex indices into geo (lon,lat,h)
  // returns { ring:[[lon,lat],...], zmin, zmax, area (m2 of ring), fp (net m2 of all rings, or null), hull }
  let zmin = Infinity, zmax = -Infinity;
  for (const t of tris) for (const v of t) { zmin = Math.min(zmin, geo[v][2]); zmax = Math.max(zmax, geo[v][2]); }
  const key = (v) => Math.round(geo[v][0] * 1e7) + ',' + Math.round(geo[v][1] * 1e7);
  // LOD1 prisms have two height levels; Draco quantisation moves vertices by up to ~2 steps (0.2 m at 11 bits)
  const tol = Math.max(0.15, Math.min(1.0, 0.25 * (zmax - zmin)));
  for (const level of [zmin, zmax]) {
    const flat = tris.filter(t => t.every(v => Math.abs(geo[v][2] - level) < tol));
    if (!flat.length) continue;
    const count = new Map(), pos = new Map(), side = new Map();
    for (const t of flat) {
      const ks = [key(t[0]), key(t[1]), key(t[2])];
      if (ks[0] === ks[1] || ks[1] === ks[2] || ks[0] === ks[2]) continue; // collapsed by quantisation: no area
      for (let e = 0; e < 3; e++) {
        const a = ks[e], k = ek(a, ks[(e + 1) % 3]);
        pos.set(a, [geo[t[e]][0], geo[t[e]][1]]);
        count.set(k, (count.get(k) || 0) + 1);
        side.set(k, ks[(e + 2) % 3]); // for a boundary edge: the cap lies on this vertex's side
      }
    }
    const next = new Map();
    for (const [k, c] of count) if (c === 1) {
      const [a, b] = k.split('|');
      if (!next.has(a)) next.set(a, []); if (!next.has(b)) next.set(b, []);
      next.get(a).push([b, k]); next.get(b).push([a, k]);
    }
    if (!next.size) continue;
    // walk each boundary edge once; cut a walk where it comes back to a vertex, so rings that touch at one
    // point (courtyard touching the outside, parts sharing a corner) come out as separate rings
    const usedE = new Set(), rings = []; let open = false;
    for (const start of next.keys()) for (;;) {
      const walk = [start]; let cur = start, nb;
      while ((nb = next.get(cur).find(x => !usedE.has(x[1])))) { usedE.add(nb[1]); cur = nb[0]; walk.push(cur); if (cur === start) break; }
      if (walk.length === 1) break;
      if (cur !== start) open = true;
      const st = [], at = new Map();
      for (const v of walk) {
        if (at.has(v)) { const loop = st.splice(at.get(v)); for (const u of loop) at.delete(u); if (loop.length >= 3) rings.push(loop); }
        at.set(v, st.length); st.push(v);
      }
      if (cur !== start && st.length >= 3) rings.push(st);
    }
    if (!rings.length) continue;
    // m2 per square degree, same constants as Local in estimate.py
    const la = pos.get(rings[0][0])[1] * Math.PI / 180, s2 = Math.sin(la) ** 2;
    const k2 = 111320 * Math.cos(la) / Math.sqrt(1 - 0.00669438 * s2) * (110574 + 1110 * s2);
    const R = rings.map(ks => {
      const pts = ks.map(k => pos.get(k)), s = ringArea(pts); let m = 0;
      // hole = the cap lies outside the ring: side of the cap triangles vs the ring's own orientation
      for (let i = 0; i < ks.length; i++) {
        const w = side.get(ek(ks[i], ks[(i + 1) % ks.length])); if (w === undefined) continue;
        const p = pts[i], q = pts[(i + 1) % pts.length], W = pos.get(w);
        m += (q[0] - p[0]) * (W[1] - p[1]) - (q[1] - p[1]) * (W[0] - p[0]);
      }
      return { pts, area: Math.abs(s) * k2, hole: s * m < 0 };
    });
    // footprint = the ring with the largest area (not the most vertices: courtyards, multi-solid)
    R.sort((a, b) => b.area - a.area);
    // fp = outer rings minus holes; only if every walk closed
    let fp = null;
    if (!open) { fp = 0; for (const r of R) fp += r.hole ? -r.area : r.area; }
    return { ring: R[0].pts, zmin, zmax, area: R[0].area, fp, hull: false, open };
  }
  const all = [];
  for (const t of tris) for (const v of t) all.push([geo[v][0], geo[v][1]]);
  return { ring: convexHull(all), zmin, zmax, area: null, fp: null, hull: true, open: false };
}

const BID = ['_BATCHID', '_FEATURE_ID_0', 'BATCHID'];
const num = (v) => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) ? +v : NaN;

async function main() {
  const [dir, out, bboxArg] = process.argv.slice(2);
  const usage = 'usage: node extract_b3dm.js <tiles_dir> <out.json> [lon1,lat1,lon2,lat2]';
  if (!dir || !out) { console.error(usage); process.exit(1); }
  const bbox = bboxArg ? bboxArg.split(',').map(s => s.trim() ? Number(s) : NaN) : null;
  if (bbox && !(bbox.length === 4 && bbox.every(Number.isFinite) && bbox[0] < bbox[2] && bbox[1] < bbox[3])) {
    console.error('bad bbox (need lon1<lon2, lat1<lat2): ' + bboxArg + '\n' + usage); process.exit(1);
  }
  const draco3d = require('draco3d');
  const dm = await draco3d.createDecoderModule({});
  const files = [];
  (function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); const s = fs.statSync(p); if (s.isDirectory()) walk(p); else if (f.toLowerCase().endsWith('.b3dm')) files.push(p); } })(dir);
  files.sort();
  const seen = new Set();
  const buildings = [];
  const report = { tiles: files.length, features: 0, kept: 0, dup: 0, axisModes: {}, errors: [], keys: {}, bbox,
    bboxChecked: 0, bboxMismatch: 0, fpWritten: 0, hullFallbacks: 0, openRings: 0, maxPrimitivesPerMesh: 0, dracoAttributes: [], noBatchIdPrimitives: 0 };
  const dracoAttrs = new Set();
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
      const feats = new Map(); // batchId -> {verts:[[x,y,z]], tris:[[a,b,c]], map, inst}
      let inst = 0, noBid = 0;
      (gltf.meshes || []).forEach((mesh, mi) => {
        const mats = meshMats.get(mi) || [[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]];
        report.maxPrimitivesPerMesh = Math.max(report.maxPrimitivesPerMesh, mesh.primitives.length);
        for (const prim of mesh.primitives) {
          let pos, bid = null, idx;
          const ext = prim.extensions && prim.extensions.KHR_draco_mesh_compression;
          const ba = BID.map(k => prim.attributes[k]).find(v => v !== undefined);
          const baOk = ba !== undefined && !!gltf.accessors[ba] && gltf.accessors[ba].bufferView !== undefined;
          if (ext) {
            const bv = gltf.bufferViews[ext.bufferView];
            const bytes = bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
            const d = decodeDraco(dm, bytes, ext.attributes);
            for (const k of Object.keys(ext.attributes)) dracoAttrs.add(k);
            pos = d.attrs.POSITION; idx = d.idx;
            const dk = BID.find(k => d.attrs[k]);
            if (dk) bid = d.attrs[dk];
            // batch ids kept outside the Draco data line up only with sequential encoding (header byte 8 = 0)
            else if (baOk && bytes[8] === 0) bid = accessorData(gltf, bin, ba);
          } else {
            pos = accessorData(gltf, bin, prim.attributes.POSITION);
            if (baOk) bid = accessorData(gltf, bin, ba);
            if (prim.indices !== undefined) idx = Uint32Array.from(accessorData(gltf, bin, prim.indices).data);
            else idx = Uint32Array.from({ length: pos.count }, (_, i) => i);
          }
          if (bid && bid.count !== pos.count) bid = null;
          if (!bid && n > 1) { noBid++; continue; } // never merge a whole primitive into one building
          for (const m of mats) {
            inst++; // vertex indices restart in every primitive and node instance: fresh per-feature maps
            const local = [];
            for (let i = 0; i < pos.count; i++) local.push(apply(m, [pos.data[i * 3], pos.data[i * 3 + 1], pos.data[i * 3 + 2]]));
            for (let t = 0; t < idx.length; t += 3) {
              const a = idx[t], bb = idx[t + 1], c = idx[t + 2];
              const id = bid ? Math.round(bid.data[a]) : 0;
              if (!feats.has(id)) feats.set(id, { verts: [], map: null, inst: 0, tris: [] });
              const F = feats.get(id);
              if (F.inst !== inst) { F.inst = inst; F.map = new Map(); }
              const tri = [a, bb, c].map(v => { if (!F.map.has(v)) { F.map.set(v, F.verts.length); F.verts.push(local[v]); } return F.map.get(v); });
              F.tris.push(tri);
            }
          }
        }
      });
      if (noBid) {
        report.noBatchIdPrimitives += noBid;
        report.errors.push(path.basename(f) + ': ' + noBid + ' primitive(s) without batch ids skipped (BATCH_LENGTH ' + n + ')');
      }
      // decide axis mode (y-up -> z-up rotation or not) from the first features
      const toGeoModes = {
        yup: (p) => ecefToGeo(rtc[0] + p[0], rtc[1] - p[2], rtc[2] + p[1]),
        zup: (p) => ecefToGeo(rtc[0] + p[0], rtc[1] + p[1], rtc[2] + p[2]),
      };
      let mode = 'yup';
      const first = feats.values().next().value;
      if (first) {
        const ok = (m) => { const g = toGeoModes[m](first.verts[0]); return g[0] > 122 && g[0] < 154 && g[1] > 20 && g[1] < 46 && g[2] > -200 && g[2] < 4000; };
        if (!ok('yup') && ok('zup')) mode = 'zup';
        else if (ok('zup')) { // with an RTC centre both read as Japan: LOD1 caps are flat only in the right axis order
          const fs10 = [...feats.values()].slice(0, 10), caps = (m) => fs10.filter(F => !outline(F.tris, F.verts.map(toGeoModes[m])).hull).length;
          const y = caps('yup'); if (2 * y < fs10.length && caps('zup') > y) mode = 'zup';
        }
      }
      report.axisModes[mode] = (report.axisModes[mode] || 0) + 1;
      const keepKeys = Object.keys(bt).filter(k => KEEP.some(r => r.test(k)));
      const hasBox = ['_xmin', '_ymin', '_xmax', '_ymax'].every(k => Array.isArray(bt[k]));
      for (const [id, F] of feats) {
        report.features++;
        const geo = F.verts.map(toGeoModes[mode]);
        const o = outline(F.tris, geo);
        if (!o.ring || o.ring.length < 3) continue;
        let cx = 0, cy = 0; for (const p of o.ring) { cx += p[0]; cy += p[1]; } cx /= o.ring.length; cy /= o.ring.length;
        if (bbox && !(cx >= bbox[0] && cx <= bbox[2] && cy >= bbox[1] && cy <= bbox[3])) continue;
        const a = {};
        for (const k of keepKeys) { const v = bt[k][id]; if (v !== null && v !== undefined && v !== '') a[k] = v; }
        const gid = a.gml_id || (path.basename(f) + '#' + id);
        if (seen.has(gid)) { report.dup++; continue; }
        seen.add(gid);
        const ring = o.ring.map(p => [+p[0].toFixed(7), +p[1].toFixed(7)]);
        const bld = { id: gid, ring, z0: +o.zmin.toFixed(2), z1: +o.zmax.toFixed(2) };
        if (o.fp !== null && o.fp > 0 && Math.abs(o.fp - o.area) > 0.01 * o.area) { bld.fp = Math.round(o.fp * 10) / 10; report.fpWritten++; }
        bld.a = a;
        buildings.push(bld);
        report.kept++;
        if (o.hull) report.hullFallbacks++;
        if (o.open) report.openRings++;
        if (hasBox) { // ring bbox vs the batch table's own bbox (degrees, either axis order)
          const t = [bt._xmin[id], bt._ymin[id], bt._xmax[id], bt._ymax[id]].map(num);
          if (t.every(v => Number.isFinite(v) && Math.abs(v) <= 180)) {
            const r = boxOf(ring);
            const off = (s) => Math.max(Math.abs(r[0] - s[0]), Math.abs(r[1] - s[1]), Math.abs(r[2] - s[2]), Math.abs(r[3] - s[3]));
            report.bboxChecked++;
            if (Math.min(off(t), off([t[1], t[0], t[3], t[2]])) > 2e-5) report.bboxMismatch++;
          }
        }
      }
    } catch (e) {
      report.errors.push(path.basename(f) + ': ' + e.message);
    }
  }
  report.dracoAttributes = [...dracoAttrs].sort();
  fs.writeFileSync(out, JSON.stringify({ buildings, report }));
  const R = report;
  console.log(JSON.stringify({ tiles: R.tiles, features: R.features, kept: R.kept, dup: R.dup, axisModes: R.axisModes, errorCount: R.errors.length, errors: R.errors.slice(0, 5), keyCount: Object.keys(R.keys).length,
    bbox: R.bbox, bboxChecked: R.bboxChecked, bboxMismatch: R.bboxMismatch, fpWritten: R.fpWritten, hullFallbacks: R.hullFallbacks, openRings: R.openRings,
    maxPrimitivesPerMesh: R.maxPrimitivesPerMesh, dracoAttributes: R.dracoAttributes, noBatchIdPrimitives: R.noBatchIdPrimitives }));
}
main().catch(e => { console.error(e); process.exit(1); });
