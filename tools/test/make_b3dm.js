// Make a Draco-compressed b3dm with two LOD1 prisms near Takashimadaira, y-up local coords + CESIUM_RTC.
const fs = require('fs');
const draco3d = require('draco3d');
const A = 6378137.0, F = 1 / 298.257222101, E2 = F * (2 - F);
function geoToEcef(lon, lat, h) { const L = lon * Math.PI / 180, B = lat * Math.PI / 180; const N = A / Math.sqrt(1 - E2 * Math.sin(B) ** 2); return [(N + h) * Math.cos(B) * Math.cos(L), (N + h) * Math.cos(B) * Math.sin(L), (N * (1 - E2) + h) * Math.sin(B)]; }
function enuToEcefOffset(lon, lat, e, n, u) { const L = lon * Math.PI / 180, B = lat * Math.PI / 180; return [-Math.sin(L) * e - Math.sin(B) * Math.cos(L) * n + Math.cos(B) * Math.cos(L) * u, Math.cos(L) * e - Math.sin(B) * Math.sin(L) * n + Math.cos(B) * Math.sin(L) * u, Math.cos(B) * n + Math.sin(B) * u]; }
(async () => {
  const em = await draco3d.createEncoderModule({});
  const lon0 = 139.661, lat0 = 35.789, h0 = 40.0;
  const center = geoToEcef(lon0, lat0, h0);
  // two prisms: slab 60x10 rotated 20deg, h 14.5 ; L-shaped? keep a 20x15 box h 7
  const boxes = [{ cx: -40, cy: 0, w: 60, d: 10, rot: 20, h: 14.5 }, { cx: 40, cy: 20, w: 20, d: 15, rot: 0, h: 7 }];
  const P = [], I = [], B = [];
  boxes.forEach((bx, bi) => {
    const r = bx.rot * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
    const corners = [[-bx.w / 2, -bx.d / 2], [bx.w / 2, -bx.d / 2], [bx.w / 2, bx.d / 2], [-bx.w / 2, bx.d / 2]].map(([x, y]) => [bx.cx + x * c - y * s, bx.cy + x * s + y * c]);
    const base = P.length / 3;
    for (const z of [0, bx.h]) for (const [e, n] of corners) {
      const o = enuToEcefOffset(lon0, lat0, e, n, z - 2.0);
      P.push(o[0], o[2], -o[1]); B.push(bi);
    }
    const q = (a, b2, c2) => I.push(base + a, base + b2, base + c2);
    q(0, 2, 1); q(0, 3, 2); // bottom
    q(4, 5, 6); q(4, 6, 7); // top
    for (let k = 0; k < 4; k++) { const k2 = (k + 1) % 4; q(k, k2, 4 + k2); q(k, 4 + k2, 4 + k); }
  });
  const mb = new em.MeshBuilder(), mesh = new em.Mesh();
  mb.AddFacesToMesh(mesh, I.length / 3, new Uint32Array(I));
  const posId = mb.AddFloatAttributeToMesh(mesh, em.POSITION, P.length / 3, 3, new Float32Array(P));
  const bidId = mb.AddFloatAttributeToMesh(mesh, em.GENERIC, B.length, 1, new Float32Array(B));
  const enc = new em.Encoder();
  enc.SetAttributeQuantization(em.POSITION, 16);
  enc.SetEncodingMethod(em.MESH_SEQUENTIAL_ENCODING);
  const out = new em.DracoInt8Array();
  const len = enc.EncodeMeshToDracoBuffer(mesh, out);
  const draco = Buffer.alloc(len); for (let i = 0; i < len; i++) draco[i] = out.GetValue(i);
  const pad = (b, ch = 0) => Buffer.concat([b, Buffer.alloc((4 - b.length % 4) % 4, ch)]);
  const bin = pad(draco);
  const gltf = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ mode: 4, attributes: { POSITION: 0, _BATCHID: 1 }, indices: 2, extensions: { KHR_draco_mesh_compression: { bufferView: 0, attributes: { POSITION: posId, _BATCHID: bidId } } } }] }],
    accessors: [{ componentType: 5126, count: P.length / 3, type: 'VEC3', min: [-100, -100, -100], max: [100, 100, 100] }, { componentType: 5126, count: B.length, type: 'SCALAR' }, { componentType: 5125, count: I.length, type: 'SCALAR' }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: len }], buffers: [{ byteLength: bin.length }],
    extensionsUsed: ['KHR_draco_mesh_compression', 'CESIUM_RTC'], extensionsRequired: ['KHR_draco_mesh_compression'], extensions: { CESIUM_RTC: { center } } };
  const js = pad(Buffer.from(JSON.stringify(gltf)), 0x20);
  const glb = Buffer.concat([Buffer.alloc(12), Buffer.alloc(8), js, Buffer.alloc(8), bin]);
  glb.write('glTF', 0); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(js.length, 12); glb.writeUInt32LE(0x4E4F534A, 16);
  glb.writeUInt32LE(bin.length, 20 + js.length); glb.writeUInt32LE(0x004E4942, 24 + js.length);
  const ft = pad(Buffer.from(JSON.stringify({ BATCH_LENGTH: 2 })), 0x20);
  const bt = pad(Buffer.from(JSON.stringify({ gml_id: ['bldg_a', 'bldg_b'], 'bldg:usage': ['共同住宅', '住宅'], 'bldg:storeysAboveGround': [5, 2], 'bldg:measuredHeight': [14.5, 7], 'uro:buildingRoofEdgeArea': [600, 300], '町丁目コード': ['13119027002', '13119027002'], '荒川_想定最大規模_浸水深': [2.4, 1.1], attributes: ['{}', '{}'] })), 0x20);
  const hdr = Buffer.alloc(28);
  const total = 28 + ft.length + bt.length + glb.length;
  hdr.write('b3dm', 0); hdr.writeUInt32LE(1, 4); hdr.writeUInt32LE(total, 8); hdr.writeUInt32LE(ft.length, 12); hdr.writeUInt32LE(0, 16); hdr.writeUInt32LE(bt.length, 20); hdr.writeUInt32LE(0, 24);
  fs.mkdirSync('test/tiles/data', { recursive: true });
  fs.writeFileSync('test/tiles/data/data1.b3dm', Buffer.concat([hdr, ft, bt, glb]));
  console.log('wrote', total);
})();
