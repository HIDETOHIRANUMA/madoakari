// Render the scripted tour frame by frame with headless Chromium (no GPU needed).
// node tools/render_video.js <url> <outdir> [fps=30] [width=1920] [height=1080] [from=0] [to=end] [every=1]
// The page must be opened with ?render; it exposes window.__frame(t) and window.__tourLength.
// Then: ffmpeg -framerate 30 -i outdir/f_%05d.jpg -c:v libx264 -pix_fmt yuv420p -crf 17 tour.mp4
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
(async () => {
  const [url, outdir, fpsA, wA, hA, fromA, toA, everyA] = process.argv.slice(2);
  const fps = +fpsA || 30, w = +wA || 1920, h = +hA || 1080, every = +everyA || 1;
  fs.mkdirSync(outdir, { recursive: true });
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.log('console', m.text().slice(0, 300)); });
  await page.goto(url);
  await page.waitForFunction(() => window.__ready === true && typeof window.__frame === 'function', null, { timeout: 300000 });
  await page.evaluate(() => document.fonts.ready);
  const len = await page.evaluate(() => window.__tourLength);
  const from = +fromA || 0, to = toA ? +toA : len;
  const f0 = Math.round(from * fps), f1 = Math.round(to * fps);
  const t0 = Date.now();
  let done = 0;
  for (let f = f0; f < f1; f += every) {
    const file = path.join(outdir, 'f_' + String(f).padStart(5, '0') + '.jpg');
    if (fs.existsSync(file)) continue;
    await page.evaluate((t) => window.__frame(t), f / fps);
    await page.screenshot({ path: file, type: 'jpeg', quality: 93 });
    done++;
    if (done % 25 === 0) {
      const per = (Date.now() - t0) / done / 1000;
      console.log(`frame ${f} / ${f1}  ${per.toFixed(2)} s/frame  eta ${((f1 - f) / every * per / 60).toFixed(1)} min`);
    }
  }
  console.log('done', done, 'frames in', ((Date.now() - t0) / 1000).toFixed(0), 's');
  await browser.close();
})();
