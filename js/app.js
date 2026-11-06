/* まどあかり — main script.
 * Draws PLATEAU buildings and one light per estimated household.
 * Data: data/area.json (meta, blocks, small areas) + data/area.bin (typed arrays), built by tools/estimate.py.
 */
'use strict';
(async function () {
  const C = Cesium;
  const Q = new URLSearchParams(location.search);
  const DATA = (Q.get('data') || 'data/').replace(/\/?$/, '/');
  const RENDER = Q.has('render');
  const D2R = Math.PI / 180;
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => (n == null || isNaN(n)) ? '—' : Math.round(n).toLocaleString('ja-JP');

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
  const M = doc.meta;
  const TYPES = { I: Uint32Array, i: Int32Array, f: Float32Array, B: Uint8Array, H: Uint16Array, h: Int16Array };
  const A = {};
  for (const [name, L] of Object.entries(M.layout)) A[name] = new TYPES[L.type](bin, L.offset, L.length);
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
  const blocks = doc.blocks;
  // type of each household: 0 other, 1 single, 2 elderly single.
  // Small buildings never carry their own type counts: their lights draw from a shuffled pool per block.
  const pools = blocks.map((b, k) => {
    const [h, s, e] = b.small || [0, 0, 0];
    const arr = [];
    for (let i = 0; i < e; i++) arr.push(2);
    for (let i = 0; i < s - e; i++) arr.push(1);
    while (arr.length < h) arr.push(0);
    const R = rng(9001 + k);
    for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
    return { arr, next: 0 };
  });
  let total = 0;
  for (let i = 0; i < N; i++) total += A.hh[i];
  const LB = new Uint32Array(total);     // building of each light
  const LT = new Uint8Array(total);      // type
  const LF = new Uint8Array(total);      // floor index from 0
  const LR = new Float32Array(total);    // random 0..1
  const LP = new Float64Array(total * 3);
  let n = 0;
  for (let i = 0; i < N; i++) {
    const hh = A.hh[i];
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
    // household types
    let types;
    if (A.single[i] !== 65535) {
      types = [];
      for (let k = 0; k < A.elderly[i]; k++) types.push(2);
      for (let k = 0; k < A.single[i] - A.elderly[i]; k++) types.push(1);
      while (types.length < hh) types.push(0);
      for (let k = types.length - 1; k > 0; k--) { const j = Math.floor(R() * (k + 1)); [types[k], types[j]] = [types[j], types[k]]; }
    } else {
      const pool = A.block[i] !== 65535 ? pools[A.block[i]] : null;
      types = [];
      for (let k = 0; k < hh; k++) types.push(pool && pool.next < pool.arr.length ? pool.arr[pool.next++] : 0);
    }
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
      LB[n] = i; LT[n] = types[k]; LF[n] = f; LR[n] = R();
      n++;
    }
  }
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
  const windows = scene.primitives.add(new C.BillboardCollection({ blendOption: C.BlendOption.OPAQUE_AND_TRANSLUCENT }));
  const farScale = new C.NearFarScalar(NEAR, 1.0, 9000, 0.72);
  const farCond = new C.DistanceDisplayCondition(NEAR, Number.MAX_VALUE);
  const nearCond = new C.DistanceDisplayCondition(0, NEAR);
  const P = new Array(total), W = new Array(total);
  for (let k = 0; k < total; k++) {
    const position = new C.Cartesian3(LP[3 * k], LP[3 * k + 1], LP[3 * k + 2]);
    P[k] = points.add({ position, pixelSize: 2.2, color: col(NIGHT[0][0]), scaleByDistance: farScale, distanceDisplayCondition: farCond });
    W[k] = windows.add({ position, image: WIN, sizeInMeters: true, width: 2.6, height: 1.75, color: col(NIGHT[0][0]), distanceDisplayCondition: nearCond });
  }
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
  const typeName = ['その他の世帯', '単独世帯', '65歳以上の単独世帯'];
  function lightStyle(k) {
    const i = LB[k], t = LT[k], r = LR[k];
    if (r > reveal) return [null, 0];
    if (mode === 'watch') {
      if (t === 2) return [col(HEX.elderly), 1.45];
      if (t === 1) return [col(HEX.single, 0.92), 1.0];
      return [col(HEX.dim, 0.7), 0.75];
    }
    if (mode === 'flood') {
      const fd = A.floodDepth[i];
      const under = LF[k] < A.floodFloors[i] && floodLevel >= 0.999;
      if (under) return t === 2 ? [col(HEX.priority), 1.2] : [col(HEX.under), 0.95];
      if (fd > 0 && A.floodHours[i] >= 72) return [col(HEX.isolated, 0.9), 0.85];
      return [col(HEX.calm, 0.75), 0.75];
    }
    let acc = 0, hex = NIGHT[0][0];
    const pick = (r * 7.31) % 1;
    for (const [h, w] of NIGHT) { acc += w; if (pick <= acc) { hex = h; break; } }
    return [col(hex), 1.0];
  }
  function restyle() {
    for (let k = 0; k < total; k++) {
      const [c, s] = lightStyle(k);
      const p = P[k], w = W[k];
      if (!c) { if (p.show) { p.show = false; w.show = false; } continue; }
      if (!p.show) { p.show = true; w.show = true; }
      p.color = c; p.pixelSize = 2.2 * s;
      w.color = c; w.width = 2.6 * s; w.height = 1.75 * s;
    }
    if (water) water.show = mode === 'flood';
    const showB = mode === 'flood' && floodLevel >= 0.999;
    for (const b of beaconLights) b.show = showB;
  }

  // ------------------------------------------------------------------ stats and ranking
  const T = M.totals;
  let focus = null;   // selected small area
  function rowsFor() {
    const v = focus ? focus.view : { hh: T.households, s: T.single, e: T.elderly, floodHH: T.floodHH, floodE: T.floodE, allFloors: T.allFloorsHH, longHH: T.longHH };
    if (mode === 'watch') return [
      [HEX.elderly, '65歳以上の単独世帯（推計）', v.e],
      [HEX.single, '単独世帯（65歳未満を含む）', v.s],
      [HEX.dim, 'すべての世帯（推計）', v.hh],
    ];
    if (mode === 'flood') return [
      [HEX.under, '浸水する階に住む世帯（推計）', v.floodHH],
      [HEX.priority, 'うち65歳以上の単独世帯', v.floodE],
      ['#b388ff', '全ての階が浸水する建物の世帯', v.allFloors],
      [HEX.isolated, '浸水が3日以上続く建物の世帯', v.longHH],
    ];
    return [
      ['#ffcf8a', '灯り＝世帯（推計）', v.hh],
      [HEX.single, '単独世帯', v.s],
      [HEX.elderly, '65歳以上の単独世帯（推計）', v.e],
    ];
  }
  function renderStats() {
    $('statsTitle').textContent = focus ? '選んだ町丁目' : '表示中のエリア';
    $('statsScope').textContent = focus ? focus.name : (M.cityName + ' ' + (M.name || ''));
    $('statsRows').innerHTML = rowsFor().map(([c, k, v]) =>
      `<div class="stat"><span class="dot" style="color:${c};background:${c}"></span><span class="k">${k}</span><span class="v">${fmt(v)}<small>世帯</small></span></div>`).join('');
    document.querySelector('.stats').classList.toggle('local', !!focus);
  }
  const metricOf = { night: ['世帯数（推計）', (a) => a.view.hh, '#ffcf8a'], watch: ['65歳以上の単独世帯（推計）', (a) => a.view.e, HEX.elderly], flood: ['浸水する階に住む世帯（推計）', (a) => a.view.floodHH, HEX.water || '#4fa3e8'] };
  function renderRank() {
    const [title, f, c] = metricOf[mode];
    $('rankMetric').textContent = title;
    const list = doc.areas.filter((a) => a.view && a.view.hh >= 30).sort((a, b) => f(b) - f(a)).slice(0, 12);
    const max = Math.max(1, ...list.map(f));
    $('rankList').innerHTML = list.map((a, k) =>
      `<li data-key="${a.key}" class="${focus && focus.key === a.key ? 'on' : ''}"><span class="n">${k + 1}</span><span>${a.name}</span><span class="val">${fmt(f(a))}</span><span class="bar"><i style="width:${(100 * f(a) / max).toFixed(1)}%;background:${c}"></i></span></li>`).join('');
  }
  function renderLegend() {
    const items = mode === 'watch'
      ? [[HEX.elderly, '65歳以上の単独世帯'], [HEX.single, 'その他の単独世帯'], [HEX.dim, 'その他の世帯']]
      : mode === 'flood'
        ? [['water', '想定最大規模の浸水'], [HEX.under, '浸水する階の世帯'], [HEX.priority, 'うち65歳以上の単独世帯'], [HEX.isolated, '3日以上浸水が続く']]
        : [['#ffcf8a', '灯り1つ＝1世帯（推計）']];
    $('legend').innerHTML = items.map(([c, t]) => c === 'water' ? `<span><i class="water"></i>${t}</span>` : `<span><i style="color:${c};background:${c}"></i>${t}</span>`).join('');
  }
  function setMode(m) {
    mode = m;
    document.querySelectorAll('.modes button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
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
    if (!li) return;
    const a = doc.areas.find((x) => x.key === li.dataset.key);
    focusArea(focus && focus.key === a.key ? null : a);
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
    const cls = M.usageClass[A.cls[i]] || 'その他';
    const F = A.floors[i];
    const rows = [];
    rows.push(['用途', cls], ['階数', F + '階'], ['高さ', A.height[i].toFixed(1) + ' m']);
    if (A.hh[i] > 0) {
      rows.push(['世帯数（推計）', fmt(A.hh[i]) + ' 世帯']);
      if (A.single[i] !== 65535) rows.push(['単独世帯（推計）', fmt(A.single[i])], ['うち65歳以上（推計）', fmt(A.elderly[i])]);
    }
    if (A.floodDepth[i] > 0) {
      rows.push(['想定最大の浸水深', (A.floodDepth[i] / 100).toFixed(1) + ' m']);
      if (A.floodHours[i]) rows.push(['浸水の継続', A.floodHours[i] >= 48 ? `約${Math.round(A.floodHours[i] / 24)}日` : `${A.floodHours[i]}時間`]);
      rows.push(['浸水する階', A.floodFloors[i] ? `${Math.min(F, A.floodFloors[i])}階まで` : 'なし']);
    }
    let note = '数値は国勢調査をもとにした推計で、実際の世帯を示すものではありません。';
    if (A.hh[i] > 0 && A.single[i] === 65535) note = '小さな建物の世帯の種類は、個別の建物ではなく街区ごとにまとめて表しています。' + note;
    return `<button class="x" aria-label="閉じる">×</button><h3>${cls}・${F}階建て</h3><dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl><div class="est">${note}</div>`;
  }
  const handler = new C.ScreenSpaceEventHandler(scene.canvas);
  handler.setInputAction((ev) => {
    const picked = scene.pick(ev.position);
    if (picked && picked.primitive === buildings && typeof picked.id === 'number') {
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
  $('aboutBody').innerHTML = `
    <h2>まどあかり</h2>
    <p>夜の街の窓あかりは、そこで誰かが暮らしているしるしです。まどあかりは、国勢調査の集計と国土交通省の3D都市モデル（PLATEAU）を組み合わせて、建物ごとの世帯数を推計し、1世帯を1つの灯りとして描きます。</p>
    <p>灯りの色を切りかえると、ひとり暮らしの高齢者が多い場所（見守り）や、想定最大規模の洪水で浸水する階に暮らす世帯（浸水）が見えてきます。民生委員や地域包括支援センターの見守り計画、個別避難計画の優先順位づけ、防災訓練の想定づくりに使えることをめざしています。</p>
    <h3>推計のしかた</h3>
    <ol>
      <li>PLATEAUの建物の用途・階数・面積から、建物ごとの「住戸の数の見込み」を出します（戸建てはおよそ1世帯、共同住宅は延床面積÷住戸の広さ）。</li>
      <li>国勢調査の基本単位区（街区）ごとの世帯数を、その見込みに比例して建物に配ります。街区の合計は国勢調査と一致します。</li>
      <li>町丁目ごとの単独世帯数を、建物の種類と住戸の広さで重みをつけて配ります。</li>
      <li>65歳以上の単独世帯は、区全体の数を、町丁目の単独世帯数と65歳以上人口の割合で配り、建物に配ります。</li>
      <li>PLATEAUの洪水浸水想定（想定最大規模）の浸水深と継続時間から、浸水する階と、その階に住む世帯を数えます。</li>
    </ol>
    <h3>推計の確かさ</h3>
    <p class="small">町丁目の世帯数だけを使って建物に配り、街区（基本単位区）ごとに集計し直して、国勢調査の街区の世帯数と比べました（世帯20以上の${V.method ? fmt(V.method.blocks) : '—'}街区）。</p>
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
      <li>世帯数が${M.smallBuilding}未満の建物（戸建てなど）は、世帯の種類を建物ごとには出さず、街区ごとにまとめた数を灯りの色に割りふっています。灯りの色から個々の家の世帯を知ることはできません。</li>
    </ul>
    <h3>出典</h3>
    <ul>${M.sources.map((s) => `<li>${s}</li>`).join('')}</ul>
    <p class="small">表示している推計値・加工データは、上記の出典をもとに作者が作成したものです。地図の描画には CesiumJS（Apache License 2.0）、文字には Noto Sans JP と しっぽり明朝（SIL Open Font License）を使っています。企画・プログラム・文章の作成に生成AI（Claude）を利用しています。</p>
  `;
  const about = $('about');
  $('aboutBtn').addEventListener('click', () => about.showModal());
  $('aboutClose').addEventListener('click', () => about.close());

  // ------------------------------------------------------------------ start
  setMode('night');
  home();
  if (Q.get('mode')) setMode(Q.get('mode'));
  if (Q.get('view')) {
    const [x, y, r, h, p] = Q.get('view').split(',').map(Number);
    view(x, y, r, h, p, 0);
  }
  scene.requestRender();
  $('loading').classList.add('done');
  window.__app = { viewer, scene, setMode, view, focusArea, doc, A, M, restyle, setWaterLevel, groundAt, center,
    set reveal(v) { reveal = v; }, set flood(v) { floodLevel = v; setWaterLevel(v); },
    lights: total, buildings: N };
  window.__ready = true;
})();
