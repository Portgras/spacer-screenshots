// Frames every raw capture into an App Store screenshot.
//
//   node screenshots/compose/compose.js --raw screenshots/raw --out screenshots/out \
//        --langs en,fr --devices iphone,ipad [--pages main,vaping]
//
// raw/<device>/<lang>/<page>_<shot>.png  (from the Maestro flows)
//   -> out/<page>/<lang>/<device>/<NN>_<shot>.jpg  (exact App Store pixel size)
//
// Product pages capture only the screens that change with their habit (ring,
// path, when) and reuse the main page's captures for the rest. A language
// without translated headlines is skipped, so English headlines never end up
// on another language's page.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { chromium } = require('playwright');

const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name);
  return i > 0 ? process.argv[i + 1] : def;
};
const here = __dirname;
const raw = path.resolve(arg('raw', 'screenshots/raw'));
const out = path.resolve(arg('out', 'screenshots/out'));
const ctx = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(here, 'shots.js'), 'utf8'), ctx);
const { SHOTS, PAGES, HEADLINES, DEVICES } = ctx.window;
const langs = arg('langs', 'en').split(',');
const devices = arg('devices', 'iphone,ipad').split(',');
const pages = arg('pages', Object.keys(PAGES).join(',')).split(',');
const PAGE_SHOTS = ['ring', 'path', 'when'];

(async () => {
  // PW_CHANNEL=msedge (or chrome) uses an installed browser instead of Playwright's own.
  const browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});
  let made = 0, missing = 0;
  for (const device of devices) {
    const dev = DEVICES[device];
    const page = await browser.newPage({ viewport: { width: dev.width, height: dev.height }, deviceScaleFactor: 1 });
    for (const lang of langs) {
      if (!HEADLINES[lang]) { console.log(`skip ${lang}: no headlines translated yet`); continue; }
      for (const pageId of pages) {
        const order = PAGES[pageId].order.filter(id => !SHOTS[id].devices || SHOTS[id].devices.includes(device));
        for (const [n, shotId] of order.entries()) {
          const shot = SHOTS[shotId];
          let src = '';
          if (shot.kind === 'framed') {
            const from = PAGE_SHOTS.includes(shotId) ? pageId : 'main';
            const file = path.join(raw, device, lang, `${from}_${shotId}.png`);
            if (!fs.existsSync(file)) { console.log(`missing ${path.relative(raw, file)}`); missing++; continue; }
            src = 'file://' + file.replace(/\\/g, '/');
          }
          const q = new URLSearchParams({ page: pageId, shot: shotId, lang, device, src });
          await page.goto('file://' + path.join(here, 'frame.html').replace(/\\/g, '/') + '?' + q);
          await page.evaluate(() => document.fonts.ready);
          await page.waitForLoadState('networkidle');
          const dir = path.join(out, pageId, lang, device);
          fs.mkdirSync(dir, { recursive: true });
          await page.locator('#shot').screenshot({
            path: path.join(dir, `${String(n + 1).padStart(2, '0')}_${shotId}.jpg`),
            type: 'jpeg', quality: 92,
          });
          made++;
        }
      }
    }
    await page.close();
  }
  await browser.close();
  console.log(`composed ${made} screenshots${missing ? `, ${missing} captures missing` : ''}`);
  if (missing) process.exitCode = 1;
})();
