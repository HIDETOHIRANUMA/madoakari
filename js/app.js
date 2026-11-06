/* まどあかり — main script.
 * Draws PLATEAU buildings and one light per estimated household.
 * Data: data/area.json (meta, blocks, small areas) + data/area.bin (typed arrays incl. the type of every light),
 * built by tools/estimate.py (data contract v2).
 */
'use strict';
(async function () {
  const C = Cesium;
  const Q = new URLSearchParams(location.search);
  const dq = Q.get('data');   // only a relative folder of this site
  const DATA = (dq && /^[\w-]+(\/[\w-]+)*\/?$/.test(dq) ? dq : 'data/').replace(/\/?$/, '/');
  const RENDER = Q.has('render');
  const D2R = Math.PI / 180;
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => (n == null || isNaN(n)) ? '—' : Math.round(n).toLocaleString('ja-JP');
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);   // data strings in innerHTML

  // ------------------------------------------------------------------ colours
  const HEX = {
    building: '#1a2234', buildingRes: '#1d2639', buildingSel: '#3b4c78', ground: '#070b15',
    single: '#9ec9ff', elderly: '#ffb35c', dim: '#3d4558',
    under: '#3c6f93', priority: '#ff6b86', isolated: '#ffd36b', calm: '#8f7f66',
  };
  const NIGHT = [['#ffcf8a', 0.42], ['#ffe2b0', 0.22], ['#fff3de', 0.16], ['#ffb766', 0.1], ['#dfe9ff', 0.07], ['#b9d3ff', 0.03]];
  const colorCache = new Map();
  const col = (hex, a = 1) => {
    const k = hex + a;
    if (!colorCache.has(k)) colorCache.set(k, C.Color.fromCssColorString(hex).withAlpha(a));
    return colorCache.get(k);
  };

  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ------------------------------------------------------------------ data
  const loadingMsg = $('loadingMsg');
  let doc, bin;
  try {
    [doc, bin] = await Promise.all([
      fetch(DATA + 'area.json').then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }),
      fetch(DATA + 'area.bin').then((r) => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); }),
    ]);
  } catch (e) {
    loadingMsg.textContent = 'データを読みこめませんでした（' + e.message + '）';
    return;
  }
  // data contract v2: area.bin holds the type of every light (the estimator deals them out)
  const M = doc.meta || {};
  const TYPES = { I: Uint32Array, i: Int32Array, f: Float32Array, B: Uint8Array, H: Uint16Array, h: Int16Array };
  const A = {};
  let total = 0;
  try {
    if (M.version !== 2 || !M.totals || !Array.isArray(doc.areas) || !Array.isArray(doc.blocks)) throw new Error('version');
    for (const [name, L] of Object.entries(M.layout)) A[name] = new TYPES[L.type](bin, L.offset, L.length);
    for (let i = 0; i < A.hh.length; i++) total += A.hh[i];
    if (!A.lightType || A.lightType.length !== total) throw new Error('lightType');
  } catch (e) {
    loadingMsg.textContent = 'データの形式が古いため表示できません。tools/estimate.py で作り直してください。';
    return;
  }
  const N = A.base.length;
  const [LON0, LAT0] = M.origin;
  const KX = M.kx, KY = M.ky;

  // geodetic -> ECEF (WGS84/GRS80) written into an array
  const WA = 6378137.0, WE2 = 6.69437999014e-3;
  function ecef(x, y, h, out, o) {
    const lon = (LON0 + x / KX) * D2R, lat = (LAT0 + y / KY) * D2R;
    const sl = Math.sin(lat), cl = Math.cos(lat);
    const n = WA / Math.sqrt(1 - WE2 * sl * sl);
    out[o] = (n + h) * cl * Math.cos(lon);
    out[o + 1] = (n + h) * cl * Math.sin(lon);
    out[o + 2] = (n * (1 - WE2) + h) * sl;
  }
  const lo0 = LON0 * D2R, la0 = LAT0 * D2R;
  const EAST = [-Math.sin(lo0), Math.cos(lo0), 0];
  const NORTH = [-Math.sin(la0) * Math.cos(lo0), -Math.sin(la0) * Math.sin(lo0), Math.cos(la0)];
  const UP = [Math.cos(la0) * Math.cos(lo0), Math.cos(la0) * Math.sin(lo0), Math.sin(la0)];
  const cart = (x, y, h) => { const t = [0, 0, 0]; ecef(x, y, h, t, 0); return new C.Cartesian3(t[0], t[1], t[2]); };

  const G = M.grid;
  function groundAt(x, y) {
    const fi = (x - G.x1) / G.cell, fj = (y - G.y1) / G.cell;
    const i = Math.max(0, Math.min(G.nx - 2, Math.floor(fi))), j = Math.max(0, Math.min(G.ny - 2, Math.floor(fj)));
    const u = Math.max(0, Math.min(1, fi - i)), v = Math.max(0, Math.min(1, fj - j));
    const g = (ii, jj) => A.ground[jj * G.nx + ii] / 10;
    return (g(i, j) * (1 - u) + g(i + 1, j) * u) * (1 - v) + (g(i, j + 1) * (1 - u) + g(i + 1, j + 1) * u) * v;
  }

  // per-building helpers
  const ringOf = (i) => {
    const s = A.ringStart[i], e = A.ringStart[i + 1], pts = [];
    for (let k = s; k < e; k++) pts.push([A.ringXY[2 * k] / 100, A.ringXY[2 * k + 1] / 100]);
    return pts;
  };
  const center = new Float64Array(2 * N);
  for (let i = 0; i < N; i++) {
    const r = ringOf(i);
    let cx = 0, cy = 0;
    for (const p of r) { cx += p[0]; cy += p[1]; }
    center[2 * i] = cx / r.length; center[2 * i + 1] = cy / r.length;
  }

  // ------------------------------------------------------------------ viewer
  loadingMsg.textContent = '建物を組み立てています';
  const viewer = new C.Viewer('cesium', {
    baseLayer: false, terrainProvider: new C.EllipsoidTerrainProvider(), scene3DOnly: true,
    animation: false, timeline: false, baseLayerPicker: false, geocoder: false, homeButton: false,
    sceneModePicker: false, navigationHelpButton: false, fullscreenButton: false, infoBox: false,
    selectionIndicator: false, skyBox: false, skyAtmosphere: false, orderIndependentTranslucency: false,
    msaaSamples: RENDER ? 1 : (+Q.get('msaa') || 4), useBrowserRecommendedResolution: !RENDER,
    contextOptions: { webgl: { preserveDrawingBuffer: true, antialias: false } },
  });
  const scene = viewer.scene;
  scene.backgroundColor = C.Color.fromCssColorString('#04060e');
  scene.globe.baseColor = C.Color.fromCssColorString('#03060c');
  scene.globe.showGroundAtmosphere = false;
  scene.globe.enableLighting = false;
  scene.globe.depthTestAgainstTerrain = true;
  scene.fog.enabled = false;
  if (scene.sun) scene.sun.show = false;
  if (scene.moon) scene.moon.show = false;
  scene.light = new C.DirectionalLight({
    direction: new C.Cartesian3(-UP[0] * 0.75 - EAST[0] * 0.45 + NORTH[0] * 0.5, -UP[1] * 0.75 - EAST[1] * 0.45 + NORTH[1] * 0.5, -UP[2] * 0.75 - EAST[2] * 0.45 + NORTH[2] * 0.5),
    color: new C.Color(0.62, 0.72, 1.0, 1), intensity: 0.9,
  });
  const bloom = scene.postProcessStages.bloom;
  bloom.enabled = true;
  bloom.uniforms.glowOnly = false;
  bloom.uniforms.contrast = 128;
  bloom.uniforms.brightness = -0.22;
  bloom.uniforms.delta = 1.0;
  bloom.uniforms.sigma = 2.6;
  bloom.uniforms.stepSize = 1.4;
  scene.postProcessStages.fxaa.enabled = true;
  const ctrl = scene.screenSpaceCameraController;
  ctrl.minimumZoomDistance = 40;
  ctrl.maximumZoomDistance = 20000;
  viewer.cesiumWidget.creditContainer.style.display = RENDER ? 'none' : '';

  // ------------------------------------------------------------------ buildings
  const instances = [];
  const tmp = [0, 0, 0];
  for (let i = 0; i < N; i++) {
    const r = ringOf(i);
    const n = r.length;
    if (n < 3) continue;
    const z0 = A.base[i] - 0.5, z1 = A.base[i] + A.height[i];
    const nv = 5 * n;
    const pos = new Float64Array(nv * 3), nor = new Float32Array(nv * 3);
    const idx = [];
    for (let k = 0; k < n; k++) {
      const p = r[k], q = r[(k + 1) % n];
      const dx = q[0] - p[0], dy = q[1] - p[1];
      const L = Math.hypot(dx, dy) || 1;
      const nx = dy / L, ny = -dx / L;
      const v = 4 * k;
      ecef(p[0], p[1], z0, pos, 3 * v);
      ecef(q[0], q[1], z0, pos, 3 * (v + 1));
      ecef(q[0], q[1], z1, pos, 3 * (v + 2));
      ecef(p[0], p[1], z1, pos, 3 * (v + 3));
      for (let m = 0; m < 3; m++) tmp[m] = EAST[m] * nx + NORTH[m] * ny;
      for (let w = 0; w < 4; w++) nor.set(tmp, 3 * (v + w));
      idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
    }
    const rv = 4 * n;
    const flat = [];
    for (let k = 0; k < n; k++) {
      ecef(r[k][0], r[k][1], z1, pos, 3 * (rv + k));
      nor.set(UP, 3 * (rv + k));
      flat.push(new C.Cartesian2(r[k][0], r[k][1]));
    }
    let tri;
    try { tri = C.PolygonPipeline.triangulate(flat); } catch (e) { tri = null; }
    if (!tri || tri.length < 3) { tri = []; for (let k = 1; k < n - 1; k++) tri.push(0, k, k + 1); }
    for (let t = 0; t < tri.length; t += 3) {
      const a = r[tri[t]], b = r[tri[t + 1]], c = r[tri[t + 2]];
      const ar = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
      if (ar >= 0) idx.push(rv + tri[t], rv + tri[t + 1], rv + tri[t + 2]);
      else idx.push(rv + tri[t], rv + tri[t + 2], rv + tri[t + 1]);
    }
    const geometry = new C.Geometry({
      attributes: {
        position: new C.GeometryAttribute({ componentDatatype: C.ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: pos }),
        normal: new C.GeometryAttribute({ componentDatatype: C.ComponentDatatype.FLOAT, componentsPerAttribute: 3, values: nor }),
      },
      indices: new Uint16Array(idx),
      primitiveType: C.PrimitiveType.TRIANGLES,
      boundingSphere: C.BoundingSphere.fromVertices(pos),
    });
    instances.push(new C.GeometryInstance({
      geometry, id: i,
      attributes: { color: C.ColorGeometryInstanceAttribute.fromColor(col(A.hh[i] > 0 ? HEX.buildingRes : HEX.building)) },
    }));
  }
  const buildings = scene.primitives.add(new C.Primitive({
    geometryInstances: instances,
    appearance: new C.PerInstanceColorAppearance({ flat: false, translucent: false, closed: true }),
    asynchronous: false, compressVertices: true, releaseGeometryInstances: true, allowPicking: true,
  }));

  // ------------------------------------------------------------------ ground
  function gridGeometry(heightOf, keepCell, skirt) {
    const nx = G.nx, ny = G.ny;
    const pos = new Float64Array(nx * ny * 3), nor = new Float32Array(nx * ny * 3), st = new Float32Array(nx * ny * 2);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const v = j * nx + i, x = G.x1 + i * G.cell, y = G.y1 + j * G.cell;
      const h = heightOf(i, j);
      ecef(x, y, h, pos, 3 * v);
      const hx = heightOf(Math.min(nx - 1, i + 1), j) - heightOf(Math.max(0, i - 1), j);
      const hy = heightOf(i, Math.min(ny - 1, j + 1)) - heightOf(i, Math.max(0, j - 1));
      let a = -hx / (2 * G.cell), b = -hy / (2 * G.cell), c = 1;
      const l = Math.hypot(a, b, c); a /= l; b /= l; c /= l;
      for (let m = 0; m < 3; m++) nor[3 * v + m] = EAST[m] * a + NORTH[m] * b + UP[m] * c;
      st[2 * v] = x / 60; st[2 * v + 1] = y / 60;
    }
    const idx = [];
    for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
      if (keepCell && !keepCell(i, j)) continue;
      const v = j * nx + i;
      idx.push(v, v + 1, v + nx + 1, v, v + nx + 1, v + nx);
    }
    if (!idx.length) return null;
    const attrs = {
      position: new C.GeometryAttribute({ componentDatatype: C.ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: pos }),
      normal: new C.GeometryAttribute({ componentDatatype: C.ComponentDatatype.FLOAT, componentsPerAttribute: 3, values: nor }),
    };
    if (skirt === 'st') attrs.st = new C.GeometryAttribute({ componentDatatype: C.ComponentDatatype.FLOAT, componentsPerAttribute: 2, values: st });
    return new C.Geometry({ attributes: attrs, indices: new Uint32Array(idx), primitiveType: C.PrimitiveType.TRIANGLES, boundingSphere: C.BoundingSphere.fromVertices(pos) });
  }
  const gH = (i, j) => A.ground[j * G.nx + i] / 10;
  scene.primitives.add(new C.Primitive({
    geometryInstances: new C.GeometryInstance({ geometry: gridGeometry(gH), attributes: { color: C.ColorGeometryInstanceAttribute.fromColor(col(HEX.ground)) } }),
    appearance: new C.PerInstanceColorAppearance({ flat: false, translucent: false }),
    asynchronous: false, allowPicking: false,
  }));

  // ------------------------------------------------------------------ flood water (expected maximum, L2)
  const wRaw = (i, j) => A.water[j * G.nx + i];
  const wetPt = (i, j) => wRaw(i, j) !== -32768;
  function wH(i, j) {
    if (wetPt(i, j)) return wRaw(i, j) / 10;
    let s = 0, n = 0;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      const ii = i + di, jj = j + dj;
      if (ii >= 0 && jj >= 0 && ii < G.nx && jj < G.ny && wetPt(ii, jj)) { s += wRaw(ii, jj) / 10; n++; }
    }
    return n ? s / n : gH(i, j) - 1;
  }
  const waterGeom = gridGeometry(wH, (i, j) => (wetPt(i, j) + wetPt(i + 1, j) + wetPt(i, j + 1) + wetPt(i + 1, j + 1)) >= 3, 'st');
  let water = null;
  const WATER_DROP = 7.0;
  if (waterGeom) {
    const material = C.Material.fromType('Water', {
      baseWaterColor: new C.Color(0.09, 0.32, 0.55, 0.78),
      blendColor: new C.Color(0.05, 0.2, 0.4, 0.8),
      normalMap: C.buildModuleUrl('Assets/Textures/waterNormals.jpg'),
      frequency: 900.0, animationSpeed: 0.012, amplitude: 4.0, specularIntensity: 0.55,
    });
    water = scene.primitives.add(new C.Primitive({
      geometryInstances: new C.GeometryInstance({ geometry: waterGeom }),
      appearance: new C.MaterialAppearance({ material, translucent: true, faceForward: true, flat: false, materialSupport: C.MaterialAppearance.MaterialSupport.TEXTURED }),
      asynchronous: false, allowPicking: false, show: false,
    }));
  }
  function setWaterLevel(t) { // 0 = hidden below ground, 1 = expected depth
    if (!water) return;
    const d = -(1 - t) * WATER_DROP;
    water.modelMatrix = C.Matrix4.fromTranslation(new C.Cartesian3(UP[0] * d, UP[1] * d, UP[2] * d));
  }
  setWaterLevel(1);

  // ------------------------------------------------------------------ lights: one per estimated household
  loadingMsg.textContent = '灯りをともしています';
  // Building i owns the lights L0[i] .. L0[i+1]-1, in order. Their types (0 other, 1 single, 2 elderly single)
  // come from area.bin; small buildings share shuffled pools there, so no building shows its own counts.
  const LB = new Uint32Array(total);     // building of each light
  const LT = A.lightType;                // type
  const LF = new Uint8Array(total);      // floor index from 0
  const LR = new Float32Array(total);    // random 0..1
  const LP = new Float64Array(total * 3);
  const L0 = new Uint32Array(N + 1);
  let n = 0;
  for (let i = 0; i < N; i++) {
    const hh = A.hh[i];
    L0[i] = n;
    if (!hh) continue;
    const R = rng(1 + i);
    const r = ringOf(i);
    const F = Math.max(1, A.floors[i]);
    const fh = Math.min(3.6, Math.max(2.6, A.height[i] / F));
    // facade segments: apartments light the two longest sides, houses any side
    const segs = [];
    for (let k = 0; k < r.length; k++) {
      const p = r[k], q = r[(k + 1) % r.length];
      segs.push({ p, q, L: Math.hypot(q[0] - p[0], q[1] - p[1]) });
    }
    let use = segs;
    if (hh >= 6 && segs.length >= 4) use = segs.slice().sort((a, b) => b.L - a.L).slice(0, 2);
    const per = use.reduce((s, g) => s + g.L, 0) || 1;
    const perFloor = Math.ceil(hh / F);
    for (let k = 0; k < hh; k++) {
      const f = F === 1 ? 0 : (k % F);
      const slot = Math.floor(k / F);
      const jitter = hh >= 6 ? 0 : (R() - 0.5) * 0.5;
      let t = ((slot + 0.5 + jitter) / perFloor) * per;
      let g = use[0];
      for (const s of use) { if (t <= s.L) { g = s; break; } t -= s.L; }
      const u = Math.max(0.05, Math.min(0.95, t / (g.L || 1)));
      const dx = g.q[0] - g.p[0], dy = g.q[1] - g.p[1], L = g.L || 1;
      const x = g.p[0] + dx * u + (dy / L) * 0.45, y = g.p[1] + dy * u - (dx / L) * 0.45;
      const z = A.base[i] + f * fh + fh * 0.55;
      ecef(x, y, z, LP, 3 * n);
      LB[n] = i; LF[n] = f; LR[n] = R();
      n++;
    }
  }
  L0[N] = n;
  function rectImage(w, h, pad) {
    const c = document.createElement('canvas'); c.width = w + 2 * pad; c.height = h + 2 * pad;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(c.width / 2, c.height / 2, 1, c.width / 2, c.height / 2, Math.max(c.width, c.height) / 2);
    grd.addColorStop(0, 'rgba(255,255,255,0.35)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#ffffff'; g.fillRect(pad, pad, w, h);
    return c.toDataURL('image/png');
  }
  function ringImage() {
    const c = document.createElement('canvas'); c.width = 48; c.height = 48;
    const g = c.getContext('2d');
    g.strokeStyle = '#ffffff'; g.lineWidth = 4; g.beginPath(); g.arc(24, 24, 17, 0, Math.PI * 2); g.stroke();
    g.fillStyle = '#ffffff'; g.beginPath(); g.arc(24, 24, 6, 0, Math.PI * 2); g.fill();
    return c.toDataURL('image/png');
  }
  // far: round points in pixels; near: window-sized rectangles in metres
  const NEAR = 950;
  const WIN = rectImage(10, 7, 1);
  const points = scene.primitives.add(new C.PointPrimitiveCollection({ blendOption: C.BlendOption.OPAQUE }));
  const farScale = new C.NearFarScalar(NEAR, 1.0, 9000, 0.72);
  const farCond = new C.DistanceDisplayCondition(NEAR, Number.MAX_VALUE);
  const nearCond = new C.DistanceDisplayCondition(0, NEAR);
  // window rectangles are grouped in tiles; tiles far from the camera are switched off as a whole.
  // Points and windows carry their building index as id, so a click on a light picks its building.
  const TILE = 450;
  const tiles = new Map();
  const P = new Array(total), W = new Array(total);
  for (let k = 0; k < total; k++) {
    const position = new C.Cartesian3(LP[3 * k], LP[3 * k + 1], LP[3 * k + 2]);
    const i = LB[k];
    P[k] = points.add({ position, pixelSize: 2.2, color: col(NIGHT[0][0]), scaleByDistance: farScale, distanceDisplayCondition: farCond, id: i });
    const key = Math.floor(center[2 * i] / TILE) + ':' + Math.floor(center[2 * i + 1] / TILE);
    let t = tiles.get(key);
    if (!t) {
      const [tx, ty] = key.split(':').map(Number);
      const cx = (tx + 0.5) * TILE, cy = (ty + 0.5) * TILE;
      t = { coll: scene.primitives.add(new C.BillboardCollection({ blendOption: C.BlendOption.OPAQUE_AND_TRANSLUCENT })), center: cart(cx, cy, groundAt(cx, cy) + 20) };
      t.coll.show = false;
      tiles.set(key, t);
    }
    W[k] = t.coll.add({ position, image: WIN, sizeInMeters: true, width: 2.6, height: 1.75, color: col(NIGHT[0][0]), distanceDisplayCondition: nearCond, id: i });
  }
  const tileList = [...tiles.values()];
  const reach = NEAR + TILE * 0.75 + 60;
  function updateTiles() {
    const cp = viewer.camera.positionWC;
    for (const t of tileList) t.coll.show = C.Cartesian3.distance(cp, t.center) < reach;
  }
  viewer.camera.percentageChanged = 0.02;
  viewer.camera.changed.addEventListener(updateTiles);
  scene.preRender.addEventListener(() => { if (!RENDER) return; updateTiles(); });
  // beacons on the water above elderly single households on flooded floors
  const beacons = scene.primitives.add(new C.BillboardCollection());
  const RING = ringImage();
  function waterAt(x, y) {
    const i = Math.round((x - G.x1) / G.cell), j = Math.round((y - G.y1) / G.cell);
    if (i < 0 || j < 0 || i >= G.nx || j >= G.ny) return null;
    return wetPt(i, j) ? wRaw(i, j) / 10 : null;
  }
  const lightXY = (k) => { const c = C.Cartographic.fromCartesian(new C.Cartesian3(LP[3 * k], LP[3 * k + 1], LP[3 * k + 2])); return [(c.longitude / D2R - LON0) * KX, (c.latitude / D2R - LAT0) * KY]; };
  const beaconLights = [];
  for (let k = 0; k < total; k++) {
    const i = LB[k];
    if (LT[k] !== 2 || !(LF[k] < A.floodFloors[i])) continue;
    const [x, y] = lightXY(k);
    const wl = waterAt(x, y);
    const z = (wl !== null ? wl : A.base[i] + A.floodDepth[i] / 100) + 0.4;
    beaconLights.push(beacons.add({ position: cart(x, y, z), image: RING, width: 15, height: 15, color: col(HEX.priority, 0.95),
      scaleByDistance: new C.NearFarScalar(150, 1.6, 7000, 0.35), show: false }));
  }

  // ------------------------------------------------------------------ labels for small areas
  const labels = scene.primitives.add(new C.LabelCollection());
  for (const ar of doc.areas) {
    if (!ar.name || !ar.view || ar.view.hh < 30) continue;
    labels.add({
      position: cart(ar.c[0], ar.c[1], groundAt(ar.c[0], ar.c[1]) + 6),
      text: ar.name, font: '500 13px "Noto Sans JP", sans-serif',
      fillColor: new C.Color(0.82, 0.86, 0.95, 0.72), showBackground: false,
      horizontalOrigin: C.HorizontalOrigin.CENTER, verticalOrigin: C.VerticalOrigin.CENTER,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      distanceDisplayCondition: new C.DistanceDisplayCondition(0, 5200),
      translucencyByDistance: new C.NearFarScalar(800, 1.0, 5200, 0.0),
    });
  }

  // ------------------------------------------------------------------ outline of a selected small area
  const outlines = scene.primitives.add(new C.PolylineCollection());
  function showOutline(ar) {
    outlines.removeAll();
    if (!ar) return;
    const ring = ar.ring.concat([ar.ring[0]]);
    const dense = [];
    for (let k = 0; k < ring.length - 1; k++) {
      const [x1, y1] = ring[k], [x2, y2] = ring[k + 1];
      const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / 15));
      for (let s = 0; s < steps; s++) {
        const x = x1 + (x2 - x1) * s / steps, y = y1 + (y2 - y1) * s / steps;
        dense.push(cart(x, y, groundAt(x, y) + 1.2));
      }
    }
    dense.push(dense[0]);
    outlines.add({ positions: dense, width: 2.0, material: C.Material.fromType('Color', { color: new C.Color(1, 0.88, 0.7, 0.55) }) });
  }

  // ------------------------------------------------------------------ modes
  let mode = 'night';
  let reveal = 1;        // 0..1 share of lights shown (intro animation)
  let floodLevel = 1;    // 0..1 water rise
  let beaconAlpha = 1;
  function styleOf(k, m) {   // [hex, alpha, scale]
    const i = LB[k], t = LT[k], r = LR[k];
    if (m === 'watch') {
      if (t === 2) return [HEX.elderly, 1, 1.45];
      if (t === 1) return [HEX.single, 0.92, 1.0];
      return [HEX.dim, 0.7, 0.75];
    }
    if (m === 'flood') {
      if (LF[k] < A.floodFloors[i]) return t === 2 ? [HEX.priority, 1, 1.2] : [HEX.under, 1, 0.95];
      if (A.floodDepth[i] >= 50 && A.floodHours[i] >= 72) return [HEX.isolated, 0.9, 0.85];   // same rule as longHH
      return [HEX.calm, 0.75, 0.75];
    }
    let acc = 0, hex = NIGHT[0][0];
    const pick = (r * 7.31) % 1;
    for (const [h, w] of NIGHT) { acc += w; if (pick <= acc) { hex = h; break; } }
    return [hex, 1, 1.0];
  }
  const STY = {};
  for (const m of ['night', 'watch', 'flood']) {
    const arr = new Float32Array(total * 5);
    for (let k = 0; k < total; k++) {
      const [hex, al, sc] = styleOf(k, m);
      const c = col(hex, al);
      arr[5 * k] = c.red; arr[5 * k + 1] = c.green; arr[5 * k + 2] = c.blue; arr[5 * k + 3] = c.alpha; arr[5 * k + 4] = sc;
    }
    STY[m] = arr;
  }
  const scratch = new C.Color();
  let focusBlock = -1, focusDim = 0;   // tour: dim every light outside one block
  function paint(mA, mB, u) {
    const a = STY[mA], b = STY[mB || mA], v = 1 - u;
    for (let k = 0; k < total; k++) {
      const p = P[k], w = W[k];
      if (LR[k] > reveal) { if (p.show) { p.show = false; w.show = false; } continue; }
      if (!p.show) { p.show = true; w.show = true; }
      const o = 5 * k;
      scratch.red = a[o] * v + b[o] * u; scratch.green = a[o + 1] * v + b[o + 1] * u;
      scratch.blue = a[o + 2] * v + b[o + 2] * u; scratch.alpha = a[o + 3] * v + b[o + 3] * u;
      const s = a[o + 4] * v + b[o + 4] * u;
      if (focusDim > 0 && A.block[LB[k]] !== focusBlock) scratch.alpha *= 1 - 0.82 * focusDim;
      p.color = scratch; p.pixelSize = 2.2 * s;
      w.color = scratch; w.width = 2.6 * s; w.height = 1.75 * s;
    }
  }
  function showFlood(on) {
    if (water) water.show = on;
    const showB = on && floodLevel >= 0.999 && beaconAlpha > 0.01;
    for (const b of beaconLights) {
      b.show = showB;
      if (showB) { scratch.red = 1; scratch.green = 0.42; scratch.blue = 0.53; scratch.alpha = 0.95 * beaconAlpha; b.color = scratch; }
    }
  }
  function restyle() { paint(mode, mode, 0); showFlood(mode === 'flood'); }

  // ------------------------------------------------------------------ stats and ranking
  const T = M.totals;
  const place = M.name ? `${M.cityName}・${M.name}` : `${M.cityName}の一部`;
  const partOf = (a) => a.coverage != null && a.coverage < 0.95;   // 町丁目 cut by the edge of the view
  const noCensus = (a) => !a.census || a.census.single == null;    // no single-household count in the tables
  const NA = '—（集計なし）';
  let focus = null;   // selected small area
  function rowsFor() {
    const v = focus ? focus.view : { hh: T.households, s: T.single, e: T.elderly, floodHH: T.floodHH, floodE: T.floodE, allFloors: T.allFloorsHH, longHH: T.longHH };
    const nc = !!focus && noCensus(focus);
    const se = (x) => nc ? NA : x;   // single and elderly rows
    if (mode === 'watch') return [
      [HEX.elderly, '65歳以上の単独世帯（推計）', se(v.e)],
      [HEX.single, '単独世帯（65歳未満を含む）', se(v.s)],
      [HEX.dim, 'すべての世帯（推計）', v.hh],
    ];
    if (mode === 'flood') return [
      [HEX.under, '浸水する階に住む世帯（推計）', v.floodHH],
      [HEX.priority, 'うち65歳以上の単独世帯', se(v.floodE)],
      ['#b388ff', '全ての階が浸水する建物の世帯', v.allFloors],
      [HEX.isolated, '浸水が3日以上続く建物の世帯', v.longHH],
    ];
    return [
      ['#ffcf8a', '灯り＝世帯（推計）', v.hh],
      [HEX.single, '単独世帯', se(v.s)],
      [HEX.elderly, '65歳以上の単独世帯（推計）', se(v.e)],
    ];
  }
  function renderStats() {
    $('statsTitle').textContent = focus ? '選んだ町丁目' : '表示中のエリア';
    $('statsScope').textContent = focus ? focus.name + (partOf(focus) ? '（表示範囲内）' : '') : place;
    $('statsRows').innerHTML = rowsFor().map(([c, k, v]) =>
      `<div class="stat"><span class="dot" style="color:${c};background:${c}"></span><span class="k">${k}</span>` +
      (v === NA ? `<span class="v na">${NA}</span>` : `<span class="v">${fmt(v)}<small>世帯</small></span>`) + '</div>').join('');
    document.querySelector('.stats').classList.toggle('local', !!focus);
  }
  const metricOf = { night: ['世帯数（推計）', (a) => a.view.hh, '#ffcf8a'], watch: ['65歳以上の単独世帯（推計）', (a) => a.view.e, HEX.elderly], flood: ['浸水する階に住む世帯（推計）', (a) => a.view.floodHH, HEX.water || '#4fa3e8'] };
  function renderRank() {
    const [title, f, c] = metricOf[mode];
    $('rankMetric').textContent = title;
    const list = doc.areas.filter((a) => a.view && a.view.hh >= 30 && !(mode === 'watch' && noCensus(a))).sort((a, b) => f(b) - f(a)).slice(0, 12);
    const max = Math.max(1, ...list.map(f));
    $('rankList').innerHTML = list.map((a, k) =>
      `<li data-i="${doc.areas.indexOf(a)}" class="${focus === a ? 'on' : ''}"><span class="n">${k + 1}</span><span>${esc(a.name)}${partOf(a) ? '<span class="part">（一部）</span>' : ''}</span><span class="val">${fmt(f(a))}</span><span class="bar"><i style="width:${(100 * f(a) / max).toFixed(1)}%;background:${c}"></i></span></li>`).join('');
  }
  function renderLegend() {
    const items = mode === 'watch'
      ? [[HEX.elderly, '65歳以上の単独世帯'], [HEX.single, 'その他の単独世帯'], [HEX.dim, 'その他の世帯']]
      : mode === 'flood'
        ? [['water', '想定最大規模の浸水'], [HEX.under, '浸水する階の世帯'], [HEX.priority, 'うち65歳以上の単独世帯'], [HEX.isolated, '3日以上浸水が続く']]
        : [['#ffcf8a', '灯り1つ＝1世帯（推計）']];
    $('legend').innerHTML = items.map(([c, t]) => c === 'water' ? `<span><i class="water"></i>${t}</span>` : `<span><i style="color:${c};background:${c}"></i>${t}</span>`).join('');
  }
  const pressMode = (m) => document.querySelectorAll('.modes button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
  function setMode(m) {
    mode = m;
    pressMode(m);
    restyle(); renderStats(); renderRank(); renderLegend();
  }
  document.querySelectorAll('.modes button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

  // ------------------------------------------------------------------ camera
  const bbx = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < N; i++) {
    const x = center[2 * i], y = center[2 * i + 1];
    if (x < bbx[0]) bbx[0] = x; if (y < bbx[1]) bbx[1] = y; if (x > bbx[2]) bbx[2] = x; if (y > bbx[3]) bbx[3] = y;
  }
  const mid = [(bbx[0] + bbx[2]) / 2, (bbx[1] + bbx[3]) / 2];
  function view(x, y, range, headingDeg, pitchDeg, dur) {
    const target = cart(x, y, groundAt(x, y));
    const hpr = new C.HeadingPitchRange(headingDeg * D2R, pitchDeg * D2R, range);
    if (!dur) {
      viewer.camera.lookAt(target, hpr);
      viewer.camera.lookAtTransform(C.Matrix4.IDENTITY);
      return;
    }
    viewer.camera.flyToBoundingSphere(new C.BoundingSphere(target, 1), { offset: hpr, duration: dur });
  }
  const home = () => view(mid[0], mid[1], Math.max(bbx[2] - bbx[0], bbx[3] - bbx[1]) * 1.05, 18, -34, 0);

  function focusArea(a, fly = true) {
    focus = a;
    showOutline(a);
    renderStats(); renderRank();
    if (a && fly) {
      const xs = a.ring.map((p) => p[0]), ys = a.ring.map((p) => p[1]);
      const size = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
      view(a.c[0], a.c[1], Math.max(600, size * 2.1), 20, -36, 2.2);
    }
  }
  $('rankList').addEventListener('click', (e) => {
    const li = e.target.closest('li');
    const a = li && doc.areas[+li.dataset.i];
    if (a) focusArea(focus === a ? null : a);
  });
  $('statsBack').addEventListener('click', () => { focusArea(null, false); home(); });

  // ------------------------------------------------------------------ picking
  const popup = $('popup');
  let selected = null;
  function highlight(i) {
    if (selected !== null) {
      const at = buildings.getGeometryInstanceAttributes(selected);
      if (at) at.color = C.ColorGeometryInstanceAttribute.toValue(col(A.hh[selected] > 0 ? HEX.buildingRes : HEX.building));
    }
    selected = i;
    if (i !== null) {
      const at = buildings.getGeometryInstanceAttributes(i);
      if (at) at.color = C.ColorGeometryInstanceAttribute.toValue(col(HEX.buildingSel));
    }
  }
  function describe(i) {
    const cls = esc((M.usageClass || [])[A.cls[i]] || 'その他');
    const F = A.floors[i];
    const ar = A.area[i] !== 65535 ? doc.areas[A.area[i]] : null;
    const rows = [];
    rows.push(['用途', cls], ['階数', F + '階'], ['高さ', A.height[i].toFixed(1) + ' m']);
    if (A.hh[i] > 0) {
      rows.push(['世帯数（推計）', fmt(A.hh[i]) + ' 世帯']);
      const nc = !!ar && noCensus(ar);
      if (A.single[i] !== 65535) rows.push(['単独世帯（推計）', nc ? NA : fmt(A.single[i])], ['うち65歳以上（推計）', nc ? NA : fmt(A.elderly[i])]);
    }
    if (A.floodDepth[i] > 0) {
      rows.push(['想定最大の浸水深', (A.floodDepth[i] / 100).toFixed(1) + ' m']);
      if (A.floodHours[i]) rows.push(['浸水の継続', A.floodHours[i] >= 48 ? `約${Math.round(A.floodHours[i] / 24)}日` : `${A.floodHours[i]}時間`]);
      rows.push(['浸水する階', A.floodFloors[i] ? `${Math.min(F, A.floodFloors[i])}階まで` : 'なし']);
    }
    let note = '数値は国勢調査をもとにした推計で、実際の世帯を示すものではありません。';
    if (A.hh[i] > 0 && A.single[i] === 65535) note = '小さな建物の世帯の種類は、個別の建物ではなく、街区などでまとめた数を灯りに割りふっています。' + note;
    return `<button class="x" aria-label="閉じる">×</button><h3>${cls}・${F}階建て</h3><dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl><div class="est">${note}</div>`;
  }
  const handler = new C.ScreenSpaceEventHandler(scene.canvas);
  handler.setInputAction((ev) => {
    const picked = scene.pick(ev.position);   // a building, or one of its lights (id = building index)
    if (picked && typeof picked.id === 'number') {
      highlight(picked.id);
      popup.innerHTML = describe(picked.id);
      popup.style.display = 'block';
      const w = popup.offsetWidth, h = popup.offsetHeight;
      popup.style.left = Math.min(window.innerWidth - w - 12, ev.position.x + 14) + 'px';
      popup.style.top = Math.min(window.innerHeight - h - 12, Math.max(12, ev.position.y - h / 2)) + 'px';
    } else {
      highlight(null); popup.style.display = 'none';
    }
  }, C.ScreenSpaceEventType.LEFT_CLICK);
  popup.addEventListener('click', (e) => { if (e.target.classList.contains('x')) { popup.style.display = 'none'; highlight(null); } });

  // ------------------------------------------------------------------ about
  const V = M.validation || {};
  const pct = (x) => x == null ? '—' : (x * 100).toFixed(1) + '%';
  const SB = M.smallBuilding != null ? M.smallBuilding : 10;
  const PM = Object.assign({ households: 10, buildings: 3 }, M.poolMin);
  // same content as docs/method.md
  $('aboutBody').innerHTML = `
    <h2>まどあかり</h2>
    <p>夜の街の窓あかりは、そこで誰かが暮らしているしるしです。まどあかりは、国勢調査の集計と国土交通省の3D都市モデル（PLATEAU）を組み合わせて、建物ごとの世帯数を推計し、1世帯を1つの灯りとして描きます。</p>
    <p>灯りの色を切りかえると、ひとり暮らしの高齢者が多い場所（見守り）や、想定最大規模の洪水で浸水する階に暮らす世帯（浸水）が見えてきます。民生委員や地域包括支援センターの見守り計画、個別避難計画の優先順位づけ、防災訓練の想定づくりに使えることをめざしています。</p>
    <h3>推計のしかた</h3>
    <ol>
      <li>PLATEAUの建物の用途・階数・建築面積から、建物ごとの「住戸の数の見込み」を出します（戸建てはおよそ1世帯、共同住宅は延床面積×0.85÷55㎡など。住宅でない建物は0）。</li>
      <li>国勢調査の基本単位区（街区）ごとの世帯数を、その見込みに比例して、中心がその街区にある建物に配ります。中心のある住宅がない街区では、建築面積の5％以上・50㎡以上がその街区に入る住宅（いくつかの街区にまたがる団地の棟など）に、それもなければ30㎡以上の建物（工場・倉庫を除く）に配ります。それでも建物がない街区の世帯は描けません。街区ごとの合計は国勢調査と一致します（データ範囲の境で切れる街区は、範囲内の割合の分）。</li>
      <li>町丁目ごとの単独世帯数（世帯人員1人の一般世帯）に、その町丁目で建物に置けた世帯の割合をかけた数を、建物の種類（共同住宅は重く、戸建ては軽く）と住戸の広さで重みをつけて、各建物の世帯数を上限に配ります。</li>
      <li>65歳以上の単独世帯は、区全体の数（${fmt(M.wardElderlySingle)}世帯）を、町丁目ごとに「単独世帯数 × 65歳以上人口の割合」で配り、手順3と同じように建物の単独世帯数の比で配ります（戸建て・店舗等併用住宅・作業所併用住宅は1.15倍の重み、上限は各建物の単独世帯数）。</li>
      <li>手順3・4では、上限を守ったまま重みに比例した小数の値を求め、決まった順に建物をたどって足し上げながら四捨五入で整数にします。1世帯の戸建てにも、全体として正しい割合で単独世帯が現れます。</li>
    </ol>
    <p class="small">推計は建物データがそろった範囲（データ範囲）全体で行い、画面にはその内側の表示範囲を描きます。表示範囲の境で切れる町丁目は「（一部）」と示し、範囲内の分だけを数えます。画面の数は、すべて描いている灯りを数えたものです。</p>
    <h3>浸水の数え方</h3>
    <ul>
      <li>PLATEAUの洪水浸水想定のうち、想定最大規模（L2）の最も深い浸水深を使います（L2のない建物は計画規模などの最も深い値）。継続時間は、その規模で浸水する想定の最も長い値です（L2に継続時間がなければ、浸水する計画規模の想定の値）。</li>
      <li>階 k（0から）の床の高さを 0.5m + k × 階高（高さ÷階数を2.6〜3.6mに収めた値）とし、床が浸水深より低い階を「浸水する階」とします。世帯は下の階から1世帯ずつ順にくり返し置き（3階建てに5世帯なら1・2・3・1・2階）、浸水する階に置いた世帯を数えます。</li>
      <li>「全ての階が浸水する建物の世帯」は、その建物のすべての世帯が浸水する階に置かれる建物の世帯です。「浸水が3日以上続く建物の世帯」は、浸水深0.5m以上・継続時間72時間以上の建物の世帯です。</li>
    </ul>
    <h3>推計の確かさ</h3>
    <p class="small">町丁目の世帯数だけを使って建物に配り、街区（基本単位区）ごとに集計し直して、国勢調査の街区の世帯数と比べました（データ範囲に全体が入る、世帯20以上の${V.method ? fmt(V.method.blocks) : '—'}街区）。</p>
    <table>
      <tr><th>配り方</th><th>誤差の中央値</th><th>誤差25%以内の街区</th></tr>
      <tr><td>まどあかり（用途・階数・面積）</td><td class="num">${pct(V.method && V.method.median_ape)}</td><td class="num">${pct(V.method && V.method.within_25pct)}</td></tr>
      <tr><td>建物の延床面積だけ</td><td class="num">${pct(V.floor_area_only && V.floor_area_only.median_ape)}</td><td class="num">${pct(V.floor_area_only && V.floor_area_only.within_25pct)}</td></tr>
      <tr><td>建物の面積だけ</td><td class="num">${pct(V.footprint_only && V.footprint_only.median_ape)}</td><td class="num">${pct(V.footprint_only && V.footprint_only.within_25pct)}</td></tr>
    </table>
    <h3>プライバシーへの配慮</h3>
    <ul>
      <li>使っているのは公開された統計の集計値だけです。個人や世帯の情報は使っていません。</li>
      <li>建物ごとの数は推計で、実際にその建物に誰が住んでいるかを示すものではありません。</li>
      <li>世帯数が${esc(SB)}未満の建物は、世帯の種類を建物ごとには出しません。同じ街区（小さな建物が${esc(PM.buildings)}棟以上・合計${esc(PM.households)}世帯以上のとき）、同じ町丁目、または表示範囲全体でまとめた数を、灯りの色にランダムに割りふっています。灯りの色から個々の家の世帯を知ることはできません。</li>
    </ul>
    <h3>出典</h3>
    <ul>${(M.sources || []).map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
    <p class="small">表示している推計値・加工データは、上記の出典をもとに作者が作成したものです。地図の描画には CesiumJS（Apache License 2.0）、文字には Noto Sans JP と しっぽり明朝（SIL Open Font License）を使っています。企画・プログラム・文章の作成に生成AI（Claude）を利用しています。</p>
  `;
  const about = $('about');
  $('aboutBtn').addEventListener('click', () => about.showModal());
  $('aboutClose').addEventListener('click', () => about.close());

  // ------------------------------------------------------------------ tour (live) and frame-by-frame rendering
  const span = Math.max(bbx[2] - bbx[0], bbx[3] - bbx[1]);
  const dist = (i, j) => Math.hypot(center[2 * i] - center[2 * j], center[2 * i + 1] - center[2 * j + 1]);
  function computeAnchors() {
    const big = [];
    for (let i = 0; i < N; i++) if (A.hh[i] > 0) big.push(i);
    big.sort((a, b) => A.hh[b] - A.hh[a]);
    const top = big.slice(0, 150);
    let best = top[0], bestN = -1;
    for (const i of top) {
      let n = 0;
      for (const j of top) if (dist(i, j) < 450) n += A.hh[j];
      if (n > bestN) { bestN = n; best = i; }
    }
    const near = top.filter((j) => dist(best, j) < 450);
    const wsum = near.reduce((s, j) => s + A.hh[j], 0) || 1;
    const dx = near.reduce((s, j) => s + center[2 * j] * A.hh[j], 0) / wsum;
    const dy = near.reduce((s, j) => s + center[2 * j + 1] * A.hh[j], 0) / wsum;
    let pop = near.filter((j) => A.floodFloors[j] > 0 && A.single[j] !== 65535).sort((a, b) => A.hh[b] - A.hh[a])[0];
    if (pop === undefined) pop = near[0];
    const areas = doc.areas.filter((x) => x.view && x.view.hh >= 30);
    const wTop = areas.filter((x) => !noCensus(x)).sort((p, q) => q.view.e - p.view.e)[0] || areas[0];
    const fTop = areas.slice().sort((p, q) => q.view.floodHH - p.view.floodHH)[0] || areas[0];
    // a block near the estate with a mix of buildings, to show how block totals are shared out.
    // Only blocks drawn completely, whose buildings hold exactly the census count.
    let blk = -1, bd = Infinity;
    const perBlock = new Map();
    for (let i = 0; i < N; i++) { if (A.hh[i] > 0 && A.block[i] !== 65535) { const q = perBlock.get(A.block[i]) || []; q.push(i); perBlock.set(A.block[i], q); } }
    for (const [k, list] of perBlock) {
      const b = doc.blocks[k];
      if (!b || b.partial || b.hh == null) continue;
      const hh = b.hh;
      if (hh < 60 || hh > 600 || list.length < 6) continue;
      if (list.reduce((s2, i) => s2 + A.hh[i], 0) !== hh) continue;
      const kinds = new Set(list.map((i) => A.cls[i]));
      if (kinds.size < 2) continue;
      const cx = list.reduce((s2, i) => s2 + center[2 * i], 0) / list.length, cy = list.reduce((s2, i) => s2 + center[2 * i + 1], 0) / list.length;
      const d = Math.hypot(cx - dx, cy - dy);
      if (d > 250 && d < bd) { bd = d; blk = k; }
    }
    let bxy = [dx, dy];
    if (blk >= 0) { const r2 = doc.blocks[blk].ring; bxy = [r2.reduce((s2, p) => s2 + p[0], 0) / r2.length, r2.reduce((s2, p) => s2 + p[1], 0) / r2.length]; }
    return {
      mid: [mid[0], mid[1]], danchi: [dx, dy], block: bxy, blockIndex: blk, watch: wTop ? [wTop.c[0], wTop.c[1]] : mid, flood: fTop ? [fTop.c[0], fTop.c[1]] : mid,
      watchArea: wTop, floodArea: fTop, popup: pop,
    };
  }
  const AN = computeAnchors();
  const KEYS = [   // time, anchor, range, heading, pitch
    [0, 'mid', span * 1.25, 8, -40], [11, 'mid', span * 1.0, 16, -34], [21, 'block', 900, 22, -40],
    [27.5, 'block', 520, 30, -38], [35, 'danchi', 950, 34, -18], [49, 'danchi', 430, 62, -11], [58, 'danchi', 1250, 84, -30],
    [76, 'watch', 1150, 102, -32], [90, 'mid', span * 0.8, 120, -36], [106, 'danchi', 1500, 138, -27],
    [122, 'danchi', 640, 152, -15], [138, 'flood', 1500, 168, -40], [153, 'mid', span * 1.05, 188, -36],
    [172, 'mid', span * 1.3, 200, -42],
  ];
  const TOUR_LEN = 172;
  const ramp = (t, a, b) => Math.max(0, Math.min(1, (t - a) / (b - a)));
  const ease = (u) => u * u * (3 - 2 * u);
  function camAt(t) {
    let i = 0;
    while (i < KEYS.length - 2 && t >= KEYS[i + 1][0]) i++;
    const u = Math.max(0, Math.min(1, (t - KEYS[i][0]) / (KEYS[i + 1][0] - KEYS[i][0])));
    const kv = (k) => { const q = KEYS[Math.max(0, Math.min(KEYS.length - 1, k))]; const p = AN[q[1]]; return [p[0], p[1], Math.log(q[2]), q[3], q[4]]; };
    const p0 = kv(i - 1), p1 = kv(i), p2 = kv(i + 1), p3 = kv(i + 2);
    const u2 = u * u, u3 = u2 * u;
    return p1.map((_, d) => 0.5 * (2 * p1[d] + (-p0[d] + p2[d]) * u + (2 * p0[d] - 5 * p1[d] + 4 * p2[d] - p3[d]) * u2 + (-p0[d] + 3 * p1[d] - 3 * p2[d] + p3[d]) * u3));
  }
  const totalHH = T.households;
  const man = (n) => n >= 10000 ? `約${(n / 10000).toFixed(1)}万` : `約${fmt(Math.round(n / 100) * 100)}`;
  const scen = Object.keys(M.floodScenarios || {})[0] || '';
  const river = scen ? scen.replace(/（.*$/, '').replace(/_.*$/, '').replace(/^.*水系/, '') : '川';
  const CAPS = [
    [1, 8.5, '夜の窓あかりは、そこで誰かが暮らしているしるし。', ''],
    [10, 20.5, '国勢調査は、5年に1度、すべての人と世帯を数えます。', 'けれど公表されるのは、町丁目や街区ごとの合計です。'],
    [21.5, 34, 'その数を、3D都市モデルで建物に配る。', 'PLATEAUの用途・階数・面積から住戸の数を見込み、街区の世帯数を按分します。'],
    [36, 47.5, '灯りひとつが、ひと世帯。', `${place}の${man(totalHH)}世帯（推計）を、窓の灯りで描いています。`],
    [59, 70, '見守り', '琥珀色の灯りは、65歳以上のひとり暮らし（推計）。'],
    [72, 86, `区全体の${man(M.wardElderlySingle)}世帯を、町丁目ごとに建物へ配る。`, '小さな建物は世帯の種類を街区や町丁目でまとめて割りふり、個々の家はわからないようにしています。'],
    [92, 103, '浸水', `${river}などが氾濫したら（想定最大規模）。PLATEAUの建物ごとの浸水深と継続時間を使います。`],
    [106, 118, '水の下になる階に、どれだけの暮らしがあるか。', '赤い輪は、浸水する階にいる65歳以上のひとり暮らし（推計）。'],
    [139, 151.5, '見守りの計画に。個別避難計画の優先順位に。訓練の想定に。', '町丁目ごとのランキングと建物ごとの推計を、ブラウザだけで。'],
  ];
  if (M.validation && M.validation.method) {
    const v = M.validation.method;
    CAPS.splice(4, 0, [49.5, 56.5, '推計の確かさ', `町丁目の数だけから街区の世帯数を再現すると、誤差の中央値は${(v.median_ape * 100).toFixed(0)}%（${fmt(v.blocks)}街区で検証）。`]);
  }
  const BIG = [
    [38, 47.5, () => T.households, '灯り＝世帯（推計）', '#ffcf8a'],
    [62, 70.5, () => T.elderly, '65歳以上の単独世帯（推計）', HEX.elderly],
    [120, 128.5, () => T.floodHH, '浸水する階に住む世帯（推計）', '#8cc4ef'],
    [129, 137.5, () => T.floodE, 'うち65歳以上のひとり暮らし（推計）', HEX.priority],
  ];
  const lin = (t, pts) => { // piecewise linear
    if (t <= pts[0][0]) return pts[0][1];
    for (let k = 1; k < pts.length; k++) if (t <= pts[k][0]) { const [t0, v0] = pts[k - 1], [t1, v1] = pts[k]; return v0 + (v1 - v0) * ease((t - t0) / (t1 - t0)); }
    return pts[pts.length - 1][1];
  };
  const REVEAL = [[0, 0], [1.2, 0], [9.5, 1], [TOUR_LEN, 1]];
  const WATER = [[0, 0], [93.5, 0], [101.5, 1], [149.5, 1], [152.5, 0]];
  const BEACON = [[0, 0], [103, 0], [105, 1], [149, 1], [150.5, 0]];
  const MODES = [[0, 'night', 'night'], [57, 'night', 'watch'], [59.5, 'watch', 'watch'], [91, 'watch', 'night'], [93, 'night', 'night'],
    [99.5, 'night', 'flood'], [102.5, 'flood', 'flood'], [149.5, 'flood', 'night'], [152.5, 'night', 'night']];
  function modeAt(t) {
    let k = 0;
    while (k < MODES.length - 1 && t >= MODES[k + 1][0]) k++;
    const [t0, a, b] = MODES[k];
    if (a === b) return [a, a, 0];
    const t1 = MODES[k + 1] ? MODES[k + 1][0] : t0 + 1;
    return [a, b, ease(ramp(t, t0, t1))];
  }
  const capEl = $('caption'), bigEl = $('bignum'), fadeEl = $('fade'), endEl = $('endcard');
  const blockLines = scene.primitives.add(new C.PolylineCollection());
  const blockLabel = scene.primitives.add(new C.LabelCollection());
  let blockLine = null, blockText = null;
  if (AN.blockIndex >= 0) {
    const b = doc.blocks[AN.blockIndex];
    const ring = b.ring.concat([b.ring[0]]);
    const pts = [];
    for (let k = 0; k < ring.length - 1; k++) {
      const [x1, y1] = ring[k], [x2, y2] = ring[k + 1];
      const st = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / 10));
      for (let q = 0; q < st; q++) { const x = x1 + (x2 - x1) * q / st, y = y1 + (y2 - y1) * q / st; pts.push(cart(x, y, groundAt(x, y) + 1.5)); }
    }
    pts.push(pts[0]);
    blockLine = blockLines.add({ positions: pts, width: 3, material: C.Material.fromType('Color', { color: new C.Color(1, 0.85, 0.6, 0) }) });
    const [bx, by] = AN.block;
    blockText = blockLabel.add({
      position: cart(bx, by, groundAt(bx, by) + 70), text: `この街区の世帯数　${fmt(b.hh)}（国勢調査）`,
      font: '700 22px "Noto Sans JP", sans-serif', fillColor: new C.Color(1, 0.95, 0.86, 0), showBackground: true,
      backgroundColor: new C.Color(0.03, 0.05, 0.1, 0), backgroundPadding: new C.Cartesian2(14, 9),
      horizontalOrigin: C.HorizontalOrigin.CENTER, verticalOrigin: C.VerticalOrigin.BOTTOM,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    });
  }
  const uiEls = ['.stats', '.rank', '.legend', '.modes'].map((q) => document.querySelector(q));
  let lastMode = '', lastU = -1, lastReveal = -1, lastUiMode = '';
  function applyAt(t) {
    const c = camAt(t);
    view(c[0], c[1], Math.exp(c[2]), c[3], c[4], 0);
    if (endEl && !endEl.dataset.ready) {
      endEl.dataset.ready = '1';
      endEl.querySelector('.src').textContent = (M.sources || []).join('／') + '。建物ごとの数は推計です。';
    }
    updateTiles();
    reveal = lin(t, REVEAL);
    floodLevel = lin(t, WATER);
    beaconAlpha = lin(t, BEACON);
    setWaterLevel(floodLevel);
    const [mA, mB, u] = modeAt(t);
    const key = mA + mB;
    if (key !== lastMode || Math.abs(u - lastU) > 1e-3 || Math.abs(reveal - lastReveal) > 1e-4) {
      paint(mA, mB, u); lastMode = key; lastU = u; lastReveal = reveal;
    }
    showFlood(floodLevel > 0.001);
    mode = u > 0.5 ? mB : mA;
    // method: one block lit, the rest dimmed
    const fb = ramp(t, 23, 24.5) * (1 - ramp(t, 32.5, 34));
    if (AN.blockIndex >= 0) {
      focusBlock = AN.blockIndex;
      if (Math.abs(fb - focusDim) > 1e-3) { focusDim = fb; paint(mA, mB, u); }
      blockLine.material.uniforms.color.alpha = 0.9 * fb;
      blockText.fillColor = new C.Color(1, 0.95, 0.86, fb);
      blockText.backgroundColor = new C.Color(0.03, 0.05, 0.1, 0.8 * fb);
      blockLine.show = blockText.show = fb > 0.001;
    }
    // fade from and to black, and the end card
    fadeEl.style.opacity = String(Math.max(1 - ramp(t, 0, 2.2), ramp(t, TOUR_LEN - 2, TOUR_LEN)));
    endEl.style.opacity = String(ramp(t, 157, 159) * (1 - ramp(t, TOUR_LEN - 2.5, TOUR_LEN - 0.5)));
    // captions
    const cap = CAPS.find((q) => t >= q[0] && t <= q[1]);
    if (cap) {
      capEl.querySelector('.l1').textContent = cap[2];
      capEl.querySelector('.l2').textContent = cap[3];
      capEl.style.opacity = String(ramp(t, cap[0], cap[0] + 0.9) * (1 - ramp(t, cap[1] - 0.9, cap[1])));
    } else capEl.style.opacity = '0';
    const big = BIG.find((q) => t >= q[0] && t <= q[1]);
    if (big) {
      const v = big[2]() * (1 - Math.pow(1 - ramp(t, big[0], big[0] + 1.8), 3));
      bigEl.querySelector('.v').textContent = fmt(v);
      bigEl.querySelector('.v').style.color = big[4];
      bigEl.querySelector('.k').textContent = big[3];
      bigEl.style.opacity = String(ramp(t, big[0], big[0] + 0.7) * (1 - ramp(t, big[1] - 0.7, big[1])));
    } else bigEl.style.opacity = '0';
    // app UI and a building card near the end
    const ui = ramp(t, 138.5, 140) * (1 - ramp(t, 151, 152.5));
    document.body.classList.toggle('showui', ui > 0.001);
    uiEls.forEach((e) => { if (e) e.style.opacity = String(ui); });
    if (ui > 0.001) {
      if (lastUiMode !== 'flood') { mode = 'flood'; pressMode('flood'); focus = AN.floodArea; renderStats(); renderRank(); renderLegend(); showOutline(AN.floodArea); lastUiMode = 'flood'; }
    } else if (lastUiMode) { focus = null; showOutline(null); lastUiMode = ''; }
    const pu = ramp(t, 124, 124.8) * (1 - ramp(t, 135.5, 136.3));
    if (pu > 0.001 && AN.popup !== undefined) {
      const i = AN.popup;
      popup.innerHTML = describe(i);
      popup.style.display = 'block';
      const top = cart(center[2 * i], center[2 * i + 1], A.base[i] + A.height[i]);
      const sc = C.SceneTransforms.worldToWindowCoordinates(scene, top);
      if (sc) {   // next to the roof, inside the window, and not over the big number
        const w = popup.offsetWidth, h = popup.offsetHeight, H = window.innerHeight, b = bigEl.getBoundingClientRect();
        let x = Math.max(20, Math.min(window.innerWidth - w - 20, sc.x + 24)), y = Math.max(20, Math.min(H - h - 20, sc.y - h - 10));
        if (x < b.right && b.left < x + w && y < b.bottom && b.top < y + h) {   // below it, above it, or else to its left
          if (b.bottom + 12 + h <= H - 8) y = b.bottom + 12;
          else if (b.top - h - 12 >= 8) y = b.top - h - 12;
          else x = Math.max(20, b.left - w - 16);
        }
        popup.style.left = x + 'px'; popup.style.top = y + 'px';
      }
      popup.style.opacity = String(pu);
    } else { popup.style.display = 'none'; }
  }
  if (RENDER) {
    document.body.classList.add('render');
    viewer.useDefaultRenderLoop = false;
    const epoch = C.JulianDate.fromIso8601('2020-10-01T12:00:00Z');
    window.__tourLength = TOUR_LEN;
    window.__frame = (t) => { applyAt(t); scene.render(C.JulianDate.addSeconds(epoch, t, new C.JulianDate())); return true; };
  }
  let tourRun = 0;   // a stopped tour's frame loop sees a newer number and quits
  function playTour() {
    const run = ++tourRun;
    highlight(null); popup.style.display = 'none';
    document.body.classList.add('render', 'touring');
    $('tourBtn').setAttribute('aria-pressed', 'true');
    const t0 = performance.now();
    const step = () => {
      if (run !== tourRun) return;
      const t = (performance.now() - t0) / 1000;
      if (t > TOUR_LEN) { stopTour(); return; }
      applyAt(t);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  function stopTour() {
    tourRun++;
    // undo everything applyAt() changed
    fadeEl.style.opacity = '0'; endEl.style.opacity = '0'; popup.style.opacity = '';
    focusDim = 0; focusBlock = -1;
    if (blockLine) { blockLine.show = false; blockText.show = false; }
    lastMode = ''; lastU = -1; lastReveal = -1; lastUiMode = '';
    document.body.classList.remove('render', 'touring', 'showui');
    $('tourBtn').setAttribute('aria-pressed', 'false');
    uiEls.forEach((e) => { if (e) e.style.opacity = ''; });
    capEl.style.opacity = '0'; bigEl.style.opacity = '0'; popup.style.display = 'none'; highlight(null);
    reveal = 1; floodLevel = 1; beaconAlpha = 1; setWaterLevel(1); focus = null; showOutline(null);
    setMode('night'); home(); updateTiles();
  }
  $('tourBtn').addEventListener('click', () => { if (document.body.classList.contains('touring')) stopTour(); else playTour(); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.body.classList.contains('touring')) stopTour(); });

  // ------------------------------------------------------------------ check: the printed numbers are the drawn lights
  function checkCounts() {
    const diffs = [];
    const per = new Uint32Array(4 * N);   // per building: single, elderly, flooded, flooded elderly
    for (let k = 0; k < total; k++) {
      const i = LB[k], o = 4 * i, t = LT[k];
      if (t >= 1) per[o]++;
      if (t === 2) per[o + 1]++;
      if (LF[k] < A.floodFloors[i]) { per[o + 2]++; if (t === 2) per[o + 3]++; }
    }
    const big = Number.isFinite(+M.smallBuilding) ? +M.smallBuilding : 10;
    const c = { buildings: N, residential: 0, households: 0, single: 0, elderly: 0, floodHH: 0, floodE: 0, floodBuildings: 0, allFloorsHH: 0, longHH: 0 };
    const va = doc.areas.map(() => ({ hh: 0, s: 0, e: 0, floodHH: 0, floodBuildings: 0, floodE: 0, allFloors: 0, longHH: 0 }));
    for (let i = 0; i < N; i++) {
      const hh = A.hh[i], o = 4 * i, s = per[o], e = per[o + 1], fl = per[o + 2], fe = per[o + 3];
      const own = hh >= big ? s + '/' + e : '65535/65535';   // small buildings carry no counts of their own
      if (A.single[i] + '/' + A.elderly[i] !== own) diffs.push([`building ${i} single/elderly`, own, A.single[i] + '/' + A.elderly[i]]);
      if (A.floodHH[i] !== fl) diffs.push([`building ${i} floodHH`, fl, A.floodHH[i]]);
      const fb = A.floodDepth[i] > 0 && hh > 0 ? 1 : 0;
      const all = fb && fl === hh ? hh : 0;
      const lng = A.floodDepth[i] >= 50 && A.floodHours[i] >= 72 ? hh : 0;
      c.residential += hh > 0 ? 1 : 0; c.households += hh; c.single += s; c.elderly += e; c.floodHH += fl; c.floodE += fe;
      c.floodBuildings += fb; c.allFloorsHH += all; c.longHH += lng;
      const v = va[A.area[i]];
      if (v) { v.hh += hh; v.s += s; v.e += e; v.floodHH += fl; v.floodBuildings += fb; v.floodE += fe; v.allFloors += all; v.longHH += lng; }
    }
    for (const k in c) if (T[k] !== c[k]) diffs.push(['totals.' + k, c[k], T[k]]);
    doc.areas.forEach((a, j) => { for (const k in va[j]) if (!a.view || a.view[k] !== va[j][k]) diffs.push([`areas[${j}].view.${k}`, va[j][k], a.view && a.view[k]]); });
    if (beaconLights.length !== T.floodE) diffs.push(['rings', beaconLights.length, T.floodE]);
    return { ok: diffs.length === 0, diffs };
  }

  // ------------------------------------------------------------------ start
  setMode('night');
  home();
  updateTiles();
  const qm = Q.get('mode');
  if (['night', 'watch', 'flood'].includes(qm)) setMode(qm);
  const qv = (Q.get('view') || '').split(',');   // x, y, range, heading, pitch
  const vv = qv.slice(0, 5).map((s) => (s.trim() ? Number(s) : NaN));
  if (qv.length >= 5 && vv.every(Number.isFinite)) {
    view(vv[0], vv[1], Math.min(ctrl.maximumZoomDistance, Math.max(ctrl.minimumZoomDistance, vv[2])), vv[3], vv[4], 0);
    updateTiles();
  }
  const credit = $('credit');
  if (credit) credit.textContent = (M.sources || []).join('／');
  if (Q.has('tour')) playTour();
  scene.requestRender();
  $('loading').classList.add('done');
  const winXY = (p) => { const s = C.SceneTransforms.worldToWindowCoordinates(scene, p); return s ? [s.x, s.y] : null; };
  window.__app = { viewer, scene, setMode, view, focusArea, doc, A, M, restyle, setWaterLevel, groundAt, center,
    set reveal(v) { reveal = v; }, set flood(v) { floodLevel = v; setWaterLevel(v); },
    lights: total, buildings: N, totals: M.totals, version: M.version, checkCounts,
    get mode() { return mode; }, get selected() { return selected; },
    tourBlock: AN.blockIndex,
    // for tests: window positions of a light and of a building's roof centre
    lightsOf: (i) => [L0[i], L0[i + 1]],   // the lights of building i: k from .. to-1
    lightOnScreen: (k) => winXY(new C.Cartesian3(LP[3 * k], LP[3 * k + 1], LP[3 * k + 2])),
    roofOnScreen: (i) => winXY(cart(center[2 * i], center[2 * i + 1], A.base[i] + A.height[i])) };
  if (Q.has('debug')) {
    const r = checkCounts();
    if (r.ok) console.log('checkCounts: ok');
    else console.warn('checkCounts: ' + r.diffs.length + ' differences ' + JSON.stringify(r.diffs.slice(0, 40)));
  }
  window.__ready = true;
})();
