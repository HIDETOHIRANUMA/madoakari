// End-to-end test of the app in a real browser (Playwright, one Chromium, SwiftShader WebGL).
// usage: node tools/test/e2e_app.js BASE_URL     (BASE_URL serves the repo root, e.g. http://127.0.0.1:8771/)
// Needs data-dev/ (see README). E2E_SHOTS=<dir> also saves screenshots there; E2E_ONLY=main,params,fixtures,mobile
// runs some parts only. Exits non-zero on failure.
'use strict';
const path = require('path');
const { chromium } = require('playwright');

const BASE = (process.argv[2] || 'http://127.0.0.1:8771/').replace(/\/?$/, '/');
const ORIGIN = new URL(BASE).origin;
const SHOTS = process.env.E2E_SHOTS || '';
const ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
const OLD_MSG = 'データの形式が古いため表示できません。tools/estimate.py で作り直してください。';
const PAY = '<img src=x onerror=window.__pwn=1>';
const NA = '—（集計なし）';

let fails = 0, checks = 0;
function check(name, ok, info) {
  checks++;
  if (!ok) fails++;
  console.log((ok ? 'ok    ' : 'FAIL  ') + name + (ok || info === undefined ? '' : '  ' + JSON.stringify(info).slice(0, 600)));
}
const offOrigin = [], pageErrors = [];

// a page that records errors, console messages and every request
async function open(ctx, query, opts = {}) {
  const page = await ctx.newPage();
  const log = { console: [], requests: [] };
  page.on('pageerror', (e) => pageErrors.push(query + ': ' + e.message.slice(0, 200)));
  page.on('console', (m) => log.console.push([m.type(), m.text().slice(0, 300)]));
  page.on('request', (r) => {
    const u = r.url();
    log.requests.push(u);
    if (!/^(data|blob):/.test(u) && new URL(u).origin !== ORIGIN) offOrigin.push(query + ' -> ' + u);
  });
  if (opts.route) await opts.route(page);
  await page.goto(BASE + query);
  if (opts.ready !== false) await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000 });
  return { page, log };
}
const frames = (page, n = 2) => page.evaluate((n) => new Promise((r) => { const f = () => (--n <= 0 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };
const popupState = (page) => page.evaluate(() => {
  const e = document.getElementById('popup'), cs = getComputedStyle(e);
  return { display: cs.display, opacity: cs.opacity, selected: window.__app.selected, text: e.textContent.slice(0, 200) };
});

// screen position of a lit window of building b that really picks as that light (not a wall in front of it).
// Near the camera lights are window billboards, beyond 950 m points.
async function findLight(page, b, range, kind) {
  for (const hd of [180, 0, 90, 270]) {
    await page.evaluate(([b, hd, range]) => { const a = window.__app; a.view(a.center[2 * b], a.center[2 * b + 1], range, hd, range > 950 ? -35 : -12, 0); }, [b, hd, range]);
    await frames(page, 3);
    const hit = await page.evaluate(([b, kind]) => {
      const a = window.__app, C = Cesium, [k0, k1] = a.lightsOf(b), W = innerWidth, H = innerHeight, c = [];
      for (let k = k0; k < k1; k++) {
        const p = a.lightOnScreen(k);
        if (p && p[0] > 40 && p[1] > 40 && p[0] < W - 40 && p[1] < H - 40) c.push([Math.hypot(p[0] - W / 2, p[1] - H / 2), k, Math.round(p[0]), Math.round(p[1])]);
      }
      c.sort((u, v) => u[0] - v[0]);
      for (const [, k, x, y] of c.slice(0, 10)) {
        if ((document.elementFromPoint(x, y) || {}).tagName !== 'CANVAS') continue;
        const q = a.scene.pick(new C.Cartesian2(x, y));
        if (q && q.id === b && q.primitive instanceof C[kind]) return { b, k, x, y };
      }
      return null;
    }, [b, kind]);
    if (hit) return hit;
  }
  return null;
}
// screen position of a roof that picks as its building, among the tallest buildings
const findRoof = (page) => page.evaluate(() => {
  const a = window.__app, C = Cesium, A = a.A;
  const idx = [...A.height.keys()].sort((p, q) => A.height[q] - A.height[p]).slice(0, 40);
  for (const i of idx) {
    const p = a.roofOnScreen(i);
    if (!p) continue;
    const x = Math.round(p[0]), y = Math.round(p[1]);
    if (x < 20 || y < 20 || x > innerWidth - 20 || y > innerHeight - 20 || (document.elementFromPoint(x, y) || {}).tagName !== 'CANVAS') continue;
    const q = a.scene.pick(new C.Cartesian2(x, y));
    if (q && q.id === i && !(q.primitive instanceof C.Billboard) && !(q.primitive instanceof C.PointPrimitive)) return { i, x, y };
  }
  return null;
});
// drawn colours: 見守り follows area.bin's lightType, 浸水 the flooded-floor rule and the longHH rule (≥ 0.5 m, ≥ 72 h)
const colourCheck = (page) => page.evaluate(() => {
  const a = window.__app, A = a.A, C = Cesium, P = a.scene.primitives;
  let pts = null;
  for (let j = 0; j < P.length; j++) if (P.get(j) instanceof C.PointPrimitiveCollection) pts = P.get(j);
  const c = (h) => C.Color.fromCssColorString(h);
  const same = (p, q) => Math.abs(p.red - q.red) < 0.01 && Math.abs(p.green - q.green) < 0.01 && Math.abs(p.blue - q.blue) < 0.01;
  const W = [c('#3d4558'), c('#9ec9ff'), c('#ffb35c')], U = c('#3c6f93'), R = c('#ff6b86'), I = c('#ffd36b'), K = c('#8f7f66');
  const bad = { watch: 0, flood: 0 }, seen = { isolated: 0, shallowLong: 0 };
  a.setMode('watch');
  for (let k = 0; k < a.lights; k++) if (!same(pts.get(k).color, W[A.lightType[k]])) bad.watch++;
  a.setMode('flood');
  for (let i = 0, k = 0; i < A.hh.length; i++) {
    const F = Math.max(1, A.floors[i]);
    for (let j = 0; j < A.hh[i]; j++, k++) {
      const fl = (F === 1 ? 0 : j % F) < A.floodFloors[i];
      const want = fl ? (A.lightType[k] === 2 ? R : U) : (A.floodDepth[i] >= 50 && A.floodHours[i] >= 72 ? I : K);
      if (want === I) seen.isolated++;
      if (!fl && A.floodDepth[i] > 0 && A.floodDepth[i] < 50 && A.floodHours[i] >= 72) seen.shallowLong++;
      if (!same(pts.get(k).color, want)) bad.flood++;
    }
  }
  a.setMode('night');
  return { n: pts.length, lights: a.lights, bad, seen };
});
// light points dimmed by the tour's block scene, and the block label
const lightState = (page) => page.evaluate(() => {
  const C = Cesium, P = window.__app.scene.primitives;
  let dim = 0, n = 0, label = false, text = '';
  for (let j = 0; j < P.length; j++) {
    const c = P.get(j);
    if (c instanceof C.PointPrimitiveCollection) for (let k = 0; k < c.length; k++) { const p = c.get(k); n++; if (p.show && p.color.alpha < 0.5) dim++; }
    if (c instanceof C.LabelCollection) for (let k = 0; k < c.length; k++) { const l = c.get(k); if (l.text.startsWith('この街区')) { text = l.text; label = label || l.show; } }
  }
  const g = (id) => document.getElementById(id);
  return { dim, n, label, text, body: document.body.className, fade: g('fade').style.opacity, endcard: g('endcard').style.opacity, popup: g('popup').style.opacity };
});

async function mainPage(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  // virtual clock for the tour: performance.now() returns window.__vt when it is set
  await ctx.addInitScript(() => { window.__vt = null; const real = performance.now.bind(performance); performance.now = () => (window.__vt === null ? real() : window.__vt); });
  const { page, log } = await open(ctx, '?data=data-dev/&debug');
  check('ready on ?data=data-dev/', true);
  const info = await page.evaluate(() => {
    const a = window.__app; let s = 0;
    for (const h of a.A.hh) s += h;
    return { version: a.version, lights: a.lights, sum: s, lightType: a.A.lightType.length, households: a.totals.households };
  });
  check('data v2: one light per household', info.version === 2 && info.lights === info.sum && info.lightType === info.sum && info.households === info.sum, info);
  const cc = await page.evaluate(() => window.__app.checkCounts());
  check('checkCounts().ok: totals and every area view recounted from the lights', cc.ok, cc.diffs.slice(0, 5));
  const dbg = log.console.filter(([, s]) => s.includes('checkCounts'));
  check('?debug runs checkCounts on load without a warning', dbg.some(([t, s]) => t === 'log' && s.includes('ok')) && !dbg.some(([t]) => t === 'warning'), dbg);

  const colours = await colourCheck(page);
  check('見守り colours = lightType; 浸水 colours = flooded floor / longHH rule', colours.n === colours.lights && colours.bad.watch === 0 && colours.bad.flood === 0 && colours.seen.isolated > 0, colours);

  // about dialog: the method's privacy rule and the sources
  const about = await page.evaluate(() => ({ text: document.getElementById('aboutBody').textContent, src: [...document.querySelectorAll('#aboutBody li')].map((e) => e.textContent), want: window.__app.M.sources }));
  const PRIV = '世帯数が10未満の建物は、世帯の種類を建物ごとには出しません。同じ街区（小さな建物が3棟以上・合計10世帯以上のとき）、同じ町丁目、または表示範囲全体でまとめた数を、灯りの色にランダムに割りふっています。灯りの色から個々の家の世帯を知ることはできません。';
  check('about dialog: the privacy rule word for word, and the three sources', about.text.includes(PRIV) && about.want.length === 3 && about.want.every((s) => about.src.includes(s)), { src: about.src.slice(-3) });

  // credit line: the sources, never on top of a panel
  const cr = await page.evaluate(() => {
    const e = document.getElementById('credit'), cs = getComputedStyle(e);
    return { text: e.textContent, want: window.__app.M.sources.join('／'), display: cs.display, pe: cs.pointerEvents, fs: parseFloat(cs.fontSize) };
  });
  check('credit line shows the sources (small, no pointer events)', cr.text === cr.want && cr.display !== 'none' && cr.pe === 'none' && cr.fs <= 12, cr);
  const overlaps = [];
  for (const [w, h] of [[1920, 1080], [1366, 768], [1280, 720]]) {
    await page.setViewportSize({ width: w, height: h });
    for (const m of ['night', 'watch', 'flood']) {
      const hit = await page.evaluate((m) => {
        window.__app.setMode(m);
        const box = (e) => e.getBoundingClientRect(), cr = document.getElementById('credit'), rg = document.createRange();
        rg.selectNodeContents(cr);
        const rects = [box(cr), ...rg.getClientRects()], out = [];
        for (const sel of ['.brand', '.modes', '.stats', '.rank', '.legend', '.tools', '.cesium-widget-credits']) {
          const e = document.querySelector(sel);
          if (!e || getComputedStyle(e).display === 'none') continue;
          const b = box(e);
          if (rects.some((r) => r.left < b.right && b.left < r.right && r.top < b.bottom && b.top < r.bottom)) out.push(sel);
        }
        return out;
      }, m);
      if (hit.length) overlaps.push([w + 'x' + h, m, hit]);
    }
  }
  check('credit line overlaps nothing at 1920x1080, 1366x768, 1280x720 in all modes', overlaps.length === 0, overlaps);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => window.__app.setMode('night'));

  // 町丁目 cut by the view
  const rk = await page.evaluate(() => [...document.querySelectorAll('#rankList li')].map((li) => {
    const ar = window.__app.doc.areas[+li.dataset.i];
    return [li.children[1].textContent, ar.name, ar.coverage];
  }));
  const badRows = rk.filter(([txt, name, cov]) => txt !== name + (cov < 0.95 ? '（一部）' : ''));
  check('ranking marks partial 町丁目 「（一部）」', rk.length > 0 && rk.some((r) => r[2] < 0.95) && badRows.length === 0, { badRows, rk: rk.slice(0, 3) });
  const sc = await page.evaluate(() => {
    const a = window.__app, p = a.doc.areas.find((x) => x.coverage < 0.95), f = a.doc.areas.find((x) => x.coverage >= 0.95), s = () => document.getElementById('statsScope').textContent;
    a.focusArea(p, false); const s1 = s();
    a.focusArea(f, false); const s2 = s();
    a.focusArea(null, false); const s3 = s();
    return { s1, p: p.name, s2, f: f.name, s3, want: a.M.cityName + '・' + a.M.name };
  });
  check('scope: 「（表示範囲内）」 for a focused partial 町丁目, city・name for the view', sc.s1 === sc.p + '（表示範囲内）' && sc.s2 === sc.f && sc.s3 === sc.want, sc);

  // a click on a lit window opens the popup of its building
  const big = await page.evaluate(() => { const A = window.__app.A; let b = 0; for (let i = 1; i < A.hh.length; i++) if (A.hh[i] > A.hh[b]) b = i; return b; });
  for (const [range, kind] of [[260, 'Billboard'], [1400, 'PointPrimitive']]) {
    const lit = await findLight(page, big, range, kind);
    check(`a lit window (${kind} at ${range} m) of the largest building is on screen and picks as that building`, !!lit, lit);
    if (!lit) continue;
    if (await page.evaluate(() => window.__app.selected !== null)) await page.click('#popup .x');   // close the last popup first
    await page.mouse.click(lit.x, lit.y);
    await page.waitForFunction((b) => window.__app.selected === b, lit.b, { timeout: 60000 }).catch(() => {});
    const pu = await popupState(page);
    check(`a click on that lit window opens the building popup (${kind})`, pu.display === 'block' && pu.selected === lit.b, pu);
    await shot(page, 'main_window_click_' + range);
  }

  // the tour, on a virtual clock, to the end
  const T0 = 1e7, T1 = 2e7;
  const setT = async (base, t, n = 2) => { await page.evaluate((v) => { window.__vt = v; }, base + t * 1000); await frames(page, n); };
  await page.evaluate((v) => { window.__vt = v; }, T0);
  await page.click('#tourBtn');
  let late = null, mid = null, pop = null, scene = null;
  const texts = {};
  for (const t of [0.5, 3, 12, 25, 40, 60, 80, 100, 110, 125, 136, 145, 158, 166, 171.5]) {
    await setT(T0, t);
    if (t === 40 || t === 80 || t === 166) texts[t] = await page.evaluate(() => [document.querySelector('#caption .l2').textContent, document.querySelector('#endcard .src').textContent, document.getElementById('endcard').style.opacity]);
    if (t === 125) pop = await page.evaluate(() => {
      const r = (id) => document.getElementById(id).getBoundingClientRect(), p = r('popup'), b = r('bignum');
      return { display: getComputedStyle(document.getElementById('popup')).display, big: +document.getElementById('bignum').style.opacity, p: [p.left, p.top, p.right, p.bottom].map(Math.round),
        inside: p.left >= 0 && p.top >= 0 && p.right <= innerWidth && p.bottom <= innerHeight, overBig: p.left < b.right && b.left < p.right && p.top < b.bottom && b.top < p.bottom };
    });
    if (t === 145) scene = await page.evaluate(() => ({ pressed: document.querySelector('.modes button[aria-pressed="true"]').dataset.mode, metric: document.getElementById('rankMetric').textContent, rows: document.querySelectorAll('#statsRows .stat').length }));
    if (t === 136) mid = await lightState(page);
    if (t === 171.5) late = await lightState(page);
  }
  check('tour popup (125 s) is inside the window and clear of the big number', pop.display === 'block' && pop.big > 0.5 && pop.inside && !pop.overBig, pop);
  check('tour app scene (145 s): the 浸水 button is pressed, as in the panel and the ranking', scene.pressed === 'flood' && scene.metric === '浸水する階に住む世帯（推計）' && scene.rows === 4, scene);
  const M = await page.evaluate(() => ({ cityName: window.__app.M.cityName, name: window.__app.M.name, src: window.__app.M.sources.join('／') }));
  check('tour caption names the view as city・name', texts[40][0].startsWith(`${M.cityName}・${M.name}の約`), texts[40]);
  check('tour caption at 72–86 s: small buildings pooled by 街区 or 町丁目', texts[80][0] === '小さな建物は世帯の種類を街区や町丁目でまとめて割りふり、個々の家はわからないようにしています。', texts[80]);
  check('end card: the sources (no extra 出典：) and the estimate note', +texts[166][2] > 0.9 && texts[166][1] === M.src + '。建物ごとの数は推計です。', texts[166]);
  await setT(T0, 172.6, 3);
  const end = await lightState(page);
  check('the tour plays (popup fading at 136 s, black at 171.5 s) and stops by itself', +mid.popup > 0 && +mid.popup < 1 && +late.fade > 0.5 && !/touring|render/.test(end.body), { mid, late, end });
  const endC = await page.evaluate(() => ['fade', 'endcard'].map((id) => getComputedStyle(document.getElementById(id)).opacity));
  check('after the tour: #fade and #endcard opacity 0', end.fade === '0' && end.endcard === '0' && endC.every((o) => +o === 0), { end, endC });
  await shot(page, 'main_after_tour');
  const roof = await findRoof(page);
  check('a roof is on screen after the tour', !!roof, roof);
  if (roof) {
    await page.mouse.click(roof.x, roof.y);
    await page.waitForFunction((i) => window.__app.selected === i, roof.i, { timeout: 60000 }).catch(() => {});
    const pu = await popupState(page);
    check('after the tour a building click shows the popup at full opacity', pu.display === 'block' && +pu.opacity === 1 && pu.selected === roof.i, pu);
    await shot(page, 'main_after_tour_click');
  }

  // Escape during the block scene
  await page.evaluate((v) => { window.__vt = v; }, T1);
  await page.click('#tourBtn');
  await setT(T1, 10);
  await setT(T1, 28, 3);
  const blk = await lightState(page);
  check('tour at 28 s: lights outside the block are dimmed and the block label is shown', blk.dim > 0 && blk.label, blk);
  const tb = await page.evaluate(() => {
    const a = window.__app, k = a.tourBlock;
    if (k < 0) return null;
    const b = a.doc.blocks[k];
    let s = 0;
    for (let i = 0; i < a.A.hh.length; i++) if (a.A.block[i] === k) s += a.A.hh[i];
    return { k, partial: b.partial, hh: b.hh, sum: s, label: 'この街区の世帯数　' + b.hh.toLocaleString('ja-JP') + '（国勢調査）' };
  });
  check('the tour block is drawn completely and its label is its census count', !!tb && tb.partial === false && tb.sum === tb.hh && blk.text === tb.label, { tb, text: blk.text });
  await page.keyboard.press('Escape');
  await frames(page, 3);
  const esc = await lightState(page);
  check('Escape mid-tour: no light dimmed, block label hidden, overlays reset', esc.dim === 0 && !esc.label && !/touring|render/.test(esc.body) && esc.fade === '0' && esc.endcard === '0' && esc.popup === '', esc);
  await shot(page, 'main_escape');
  await ctx.close();
}

async function paramPages(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  const state = (page) => page.evaluate(() => {
    const c = window.__app.viewer.camera;
    return { mode: window.__app.mode, pressed: document.querySelector('.modes button[aria-pressed="true"]').dataset.mode,
      heading: c.heading * 180 / Math.PI, finite: [c.positionWC.x, c.positionWC.y, c.positionWC.z].every(Number.isFinite),
      cesiumError: !!document.querySelector('.cesium-widget-errorPanel') };
  });
  let { page } = await open(ctx, '?data=data-dev/&mode=Watch&view=0,0,0,30,-40');
  await frames(page, 4);
  let s = await state(page);
  check('?mode=Watch: ready, stays in night mode', s.mode === 'night' && s.pressed === 'night', s);
  check('?view= with 5 numbers is applied (range 0 clamped, no render error)', Math.abs(s.heading - 30) < 1 && s.finite && !s.cesiumError, s);
  await page.close();
  ({ page } = await open(ctx, '?data=data-dev/&mode=flood&view=0,0,800'));
  await frames(page, 4);
  await page.waitForTimeout(1000);
  s = await state(page);
  check('?view=0,0,800: ready, no Cesium error panel, camera finite', !s.cesiumError && s.finite, s);
  check('?mode=flood is applied', s.mode === 'flood' && s.pressed === 'flood', s);
  await page.close();

  // ?data= pointing at another site: nothing leaves the origin
  for (const q of ['http://127.0.0.1:1/', '//127.0.0.1:1/']) {
    const before = offOrigin.length;
    const r = await open(ctx, '?data=' + encodeURIComponent(q), { ready: false });
    await r.page.waitForFunction(() => window.__ready === true || /読みこめません|古い/.test(document.getElementById('loadingMsg').textContent), null, { timeout: 240000 });
    check(`?data=${q}: no request leaves the origin (falls back to data/)`, offOrigin.length === before && r.log.requests.some((u) => u.startsWith(BASE + 'data/area.json')), { off: offOrigin.slice(before), req: r.log.requests.filter((u) => /area\./.test(u)) });
    await r.page.close();
  }
  await ctx.close();
}

async function fixturePages(browser, dev) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const serve = (name, json, bin) => async (page) => {
    await page.route(BASE + name + '/area.json', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(json) }));
    await page.route(BASE + name + '/area.bin', (r) => r.fulfill({ status: 200, contentType: 'application/octet-stream', body: bin }));
  };
  const clone = () => JSON.parse(JSON.stringify(dev.json));

  // old or broken format: a message, and the app stops
  const v1 = clone(); v1.meta.version = 1;
  const noLT = clone(); delete noLT.meta.layout.lightType;
  for (const [name, fx] of [['e2e-v1', v1], ['e2e-nolighttype', noLT]]) {
    const { page } = await open(ctx, `?data=${name}/`, { ready: false, route: serve(name, fx, dev.bin) });
    await page.waitForFunction((m) => document.getElementById('loadingMsg').textContent === m, OLD_MSG, { timeout: 60000 }).catch(() => {});
    const r = await page.evaluate(() => ({ msg: document.getElementById('loadingMsg').textContent, ready: !!window.__ready }));
    check(`${name}: 「データの形式が古いため…」 and the app stops`, r.msg === OLD_MSG && !r.ready, r);
    await page.close();
  }

  // data strings with markup are shown as text; an area without census singles
  const fx = clone();
  fx.areas.forEach((a) => { a.name = PAY; a.key = PAY; });
  let nc = 0;
  fx.areas.forEach((a, j) => { if (a.view.e > fx.areas[nc].view.e) nc = j; });
  Object.assign(fx.areas[nc].census, { general: null, single: null, p65: null, elderlySingleEst: null });
  Object.assign(fx.meta, { name: PAY, cityName: PAY, smallBuilding: PAY, poolMin: { households: PAY, buildings: PAY }, floodScenarios: { [PAY]: 1 } });
  fx.meta.sources = fx.meta.sources.map((s) => s + PAY);
  fx.meta.usageClass = fx.meta.usageClass.map((s) => s + PAY);
  fx.blocks.forEach((b) => { b.partial = true; });   // no block is drawn completely: the tour shows none
  // a few buildings with a shallow (0.3 m) but long flood: dry floors, so their lights must not get the 3-day colour
  const fbin = Buffer.from(dev.bin), L = fx.meta.layout;
  for (let i = 0, n = 0; i < L.hh.length && n < 20; i++) {
    const at = (k, s) => L[k].offset + s * i;
    if (fbin.readUInt16LE(at('hh', 2)) && fbin.readUInt16LE(at('floodDepth', 2)) >= 50 && fbin.readUInt16LE(at('floodHours', 2)) >= 72) {
      fbin.writeUInt16LE(30, at('floodDepth', 2)); fbin.writeUInt8(0, at('floodFloors', 1)); fbin.writeUInt16LE(0, at('floodHH', 2)); n++;
    }
  }
  const { page, log } = await open(ctx, '?data=e2e-fixture/', { route: serve('e2e-fixture', fx, fbin) });
  check('every block partial: no tour block is chosen', await page.evaluate(() => window.__app.tourBlock) === -1);
  const col = await colourCheck(page);
  check('浸水 colours: a shallow long flood (0.3 m, ≥ 72 h) does not get the 3-day colour', col.bad.flood === 0 && col.seen.shallowLong > 0, col);
  await page.click('#aboutBtn');
  await page.waitForTimeout(300);
  await page.click('#aboutClose');
  const roof = await findRoof(page);
  if (roof) {
    await page.mouse.click(roof.x, roof.y);
    await page.waitForFunction((i) => window.__app.selected === i, roof.i, { timeout: 60000 }).catch(() => {});
  }
  const ranks = await page.evaluate((nc) => {
    const a = window.__app, ids = () => [...document.querySelectorAll('#rankList li')].map((li) => +li.dataset.i), out = {};
    for (const m of ['watch', 'night']) { a.setMode(m); out[m] = ids().includes(nc); }
    a.focusArea(a.doc.areas[nc], false);
    out.rows = [...document.querySelectorAll('#statsRows .v')].map((e) => e.textContent);
    a.setMode('watch');
    out.watchRows = [...document.querySelectorAll('#statsRows .v')].map((e) => e.textContent);
    a.focusArea(null, false);
    a.setMode('night');
    return out;
  }, nc);
  check('area without census singles: left out of the 見守り ranking only', !ranks.watch && ranks.night, ranks);
  check(`area without census singles: single and elderly rows show 「${NA}」`, ranks.rows[1] === NA && ranks.rows[2] === NA && ranks.rows[0] !== NA &&
    ranks.watchRows[0] === NA && ranks.watchRows[1] === NA && ranks.watchRows[2] !== NA, ranks);
  await page.waitForTimeout(1500);
  const x = await page.evaluate((PAY) => {
    const t = (id) => document.getElementById(id).textContent;
    // any <img> outside Cesium's own widgets (its credit logo is one) came from the data
    const imgs = [...document.querySelectorAll('img')].filter((e) => !e.closest('.cesium-viewer-bottom, .cesium-widget')).length;
    return { pwn: window.__pwn === undefined ? 'unset' : window.__pwn, imgs, rank: t('rankList').includes(PAY), about: t('aboutBody').includes(PAY),
      popup: t('popup').includes(PAY), scope: t('statsScope').includes(PAY), credit: t('credit').includes(PAY) };
  }, PAY);
  check('markup in area names, sources, usage classes and meta does not run and is shown as text',
    x.pwn === 'unset' && x.imgs === 0 && x.rank && x.about && x.popup && x.scope && x.credit && !log.requests.some((u) => u === BASE + 'x'), x);
  await shot(page, 'fixture_markup');
  await ctx.close();
}

async function mobilePage(browser) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  // the virtual clock of mainPage; ?tour starts on load, so the clock is held right after it (the tour is then a few seconds in)
  await ctx.addInitScript(() => { window.__vt = null; const real = performance.now.bind(performance); performance.now = () => (window.__vt === null ? real() : window.__vt); });
  const { page } = await open(ctx, '?data=data-dev/&tour');
  await page.evaluate(() => { window.__vt = performance.now(); });
  await frames(page, 3);
  await page.waitForTimeout(3000);
  const r = await page.evaluate(() => {
    const b = document.getElementById('tourBtn'), q = b.getBoundingClientRect(), cs = getComputedStyle(b);
    const zTools = +getComputedStyle(document.querySelector('.tools')).zIndex, zFade = +getComputedStyle(document.getElementById('fade')).zIndex;
    return { touring: document.body.classList.contains('touring'), display: cs.display, visibility: cs.visibility, x: q.left, y: q.top, w: q.width, h: q.height,
      onTop: document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2) === b, aboveFade: zTools > zFade,
      about: getComputedStyle(document.getElementById('aboutBtn')).display, credit: getComputedStyle(document.getElementById('credit')).display };
  });
  check('390x844 while touring: the stop button is visible', r.touring && r.display !== 'none' && r.visibility === 'visible' && r.w >= 24 && r.h >= 24 &&
    r.x >= 0 && r.y >= 0 && r.x + r.w <= 390 && r.y + r.h <= 844 && r.onTop && r.aboveFade, r);
  check('390x844: no credit line, no about button while touring', r.credit === 'none' && r.about === 'none', r);
  await shot(page, 'mobile_touring');
  // the tour's app scene (140–151 s) on a phone: the phone layout, and the caption clear of the stats panel
  await page.evaluate(() => { window.__vt += 141000; });   // t ≈ 141–150 s
  await page.waitForFunction(() => document.body.classList.contains('showui') && document.querySelector('.stats').style.opacity === '1', null, { timeout: 60000 }).catch(() => {});
  const ui = await page.evaluate(() => {
    const vis = (s) => getComputedStyle(document.querySelector(s)).display !== 'none';
    const c = document.getElementById('caption').getBoundingClientRect(), s = document.querySelector('.stats').getBoundingClientRect();
    return { showui: document.body.classList.contains('showui'), rank: vis('.rank'), legend: vis('.legend'), stats: vis('.stats'), clear: c.bottom <= s.top || s.bottom <= c.top,
      pressed: document.querySelector('.modes button[aria-pressed="true"]').dataset.mode };
  });
  check('390x844, tour app scene: phone layout (no ranking, no legend), caption clear of the stats panel', ui.showui && !ui.rank && !ui.legend && ui.stats && ui.clear && ui.pressed === 'flood', ui);
  await shot(page, 'mobile_tour_ui');
  await page.tap('#tourBtn');
  await frames(page, 3);
  const stopped = await page.evaluate(() => !document.body.classList.contains('touring') && getComputedStyle(document.getElementById('fade')).opacity === '0');
  check('390x844: tapping it stops the tour', stopped);
  await ctx.close();
}

(async () => {
  const killer = setTimeout(() => { console.log('FAIL  timeout'); process.exit(2); }, 30 * 60 * 1000);
  killer.unref();
  const t0 = Date.now();
  const browser = await chromium.launch({ args: ARGS });
  try {
    const dev = { json: await (await fetch(BASE + 'data-dev/area.json')).json(), bin: Buffer.from(await (await fetch(BASE + 'data-dev/area.bin')).arrayBuffer()) };
    const only = (process.env.E2E_ONLY || 'main,params,fixtures,mobile').split(',');   // run some parts only
    if (only.includes('main')) await mainPage(browser);
    if (only.includes('params')) await paramPages(browser);
    if (only.includes('fixtures')) await fixturePages(browser, dev);
    if (only.includes('mobile')) await mobilePage(browser);
  } catch (e) {
    check('no exception', false, String(e && e.stack || e).slice(0, 600));
  }
  check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 5));
  check('no request left the origin', offOrigin.length === 0, offOrigin.slice(0, 5));
  await browser.close();
  console.log(`${checks - fails}/${checks} checks passed in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  process.exit(fails ? 1 : 0);
})();
