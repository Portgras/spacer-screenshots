// Uploads composed screenshots to App Store Connect: the main product page and
// the custom product pages (created when missing), in every language there are
// screenshots for. Existing screenshots in each set are replaced, in order.
//
//   ASC_KEY_ID=… ASC_ISSUER_ID=… ASC_KEY_P8="$(cat key.p8)" \
//   node screenshots/upload/upload.js --dir screenshots/out --app 6778286207 [--listing] [--dry-run] [--pages main,vaping]
//
// Layout read: <dir>/<page>/<app language>/<iphone|ipad>/NN_<shot>.jpg
// A page that is in review can't be changed, so it is skipped with a note.
// Product page keywords aren't set here: assign them once in App Store Connect.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : def; };
const DRY = process.argv.includes('--dry-run');
const DIR = path.resolve(arg('dir', 'screenshots/out'));
const APP = arg('app', '6778286207');
const API = 'https://api.appstoreconnect.apple.com/v1';

// App language -> App Store locales it serves. Any other app language is its
// own App Store locale (it, ja, uk, zh-Hant…).
const LOCALES = { en: ['en-US', 'en-GB', 'en-CA', 'en-AU'], es: ['es-ES', 'es-MX'], fr: ['fr-FR', 'fr-CA'], de: ['de-DE'], nl: ['nl-NL'], pt: ['pt-BR', 'pt-PT'], ar: ['ar-SA'], zh: ['zh-Hans'], nb: ['no'], ur: [] };
const DISPLAY = { iphone: 'APP_IPHONE_67', ipad: 'APP_IPAD_PRO_3GEN_129' };
const PAGE_NAMES = { vaping: 'Vaping', smoking: 'Smoking', drinking: 'Drinking', screens: 'Screens & gaming' };
const EDITABLE = new Set(['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED', 'METADATA_REJECTED', 'INVALID_BINARY']);

// ── API ──────────────────────────────────────────────────────────────────────
let jwt = { value: '', exp: 0 };
function token() {
  const now = Math.floor(Date.now() / 1000);
  if (jwt.exp - 60 > now) return jwt.value;
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'ES256', kid: process.env.ASC_KEY_ID, typ: 'JWT' });
  const body = b64({ iss: process.env.ASC_ISSUER_ID, iat: now, exp: now + 1200, aud: 'appstoreconnect-v1' });
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key: process.env.ASC_KEY_P8, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  jwt = { value: `${head}.${body}.${sig}`, exp: now + 1200 };
  return jwt.value;
}

async function api(method, url, body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url.startsWith('http') ? url : API + url, {
      method,
      headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    // Apple allows about 3600 calls an hour: when that runs out, wait a minute
    // at a time (up to two hours) rather than fail a long upload halfway.
    if (res.status === 429 && attempt < 120) { if (attempt % 10 === 0) console.log('  rate limited by Apple, waiting'); await new Promise(r => setTimeout(r, 60_000)); continue; }
    if (res.status >= 500 && attempt < 5) { await new Promise(r => setTimeout(r, 2000 * (attempt + 1))); continue; }
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${(json.errors || []).map(e => e.detail || e.title).join('; ')}`);
    return json;
  }
}
async function all(url) {
  const out = [];
  for (let next = url; next;) { const page = await api('GET', next); out.push(...page.data); next = page.links && page.links.next; }
  return out;
}
const rel = (type, id) => ({ data: { type, id } });

// ── Screenshot sets ──────────────────────────────────────────────────────────
async function uploadFile(setId, file) {
  const data = fs.readFileSync(file);
  const made = await api('POST', '/appScreenshots', {
    data: { type: 'appScreenshots', attributes: { fileName: path.basename(file), fileSize: data.length }, relationships: { appScreenshotSet: rel('appScreenshotSets', setId) } },
  });
  for (const op of made.data.attributes.uploadOperations) {
    const headers = Object.fromEntries(op.requestHeaders.map(h => [h.name, h.value]));
    const res = await fetch(op.url, { method: op.method, headers, body: data.subarray(op.offset, op.offset + op.length) });
    if (!res.ok) throw new Error(`upload part of ${file} -> ${res.status}`);
  }
  await api('PATCH', `/appScreenshots/${made.data.id}`, {
    data: { type: 'appScreenshots', id: made.data.id, attributes: { uploaded: true, sourceFileChecksum: crypto.createHash('md5').update(data).digest('hex') } },
  });
  return made.data.id;
}

/** Replace every screenshot of one display type in one localization. */
async function replaceSet(setsUrl, ownerRel, displayType, files, label) {
  if (DRY) { console.log(`  would upload ${files.length} to ${label} ${displayType}`); return; }
  let set = (await all(setsUrl)).find(s => s.attributes.screenshotDisplayType === displayType);
  if (!set) {
    set = (await api('POST', '/appScreenshotSets', { data: { type: 'appScreenshotSets', attributes: { screenshotDisplayType: displayType }, relationships: ownerRel } })).data;
  }
  for (const old of await all(`/appScreenshotSets/${set.id}/appScreenshots`)) await api('DELETE', `/appScreenshots/${old.id}`);
  const ids = [];
  for (const f of files) ids.push(await uploadFile(set.id, f));
  await api('PATCH', `/appScreenshotSets/${set.id}/relationships/appScreenshots`, { data: ids.map(id => ({ type: 'appScreenshots', id })) });
  console.log(`  ${label} ${displayType}: ${ids.length} uploaded`);
}

// What's on disk for one page: { 'en-US': { iphone: [files], ipad: [files] }, ... }
function shotsFor(page) {
  const out = {};
  const root = path.join(DIR, page);
  if (!fs.existsSync(root)) return out;
  for (const lang of fs.readdirSync(root)) {
    for (const device of Object.keys(DISPLAY)) {
      const dir = path.join(root, lang, device);
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir).filter(f => /\.(jpe?g|png)$/i.test(f)).sort().map(f => path.join(dir, f));
      for (const locale of LOCALES[lang] ?? [lang]) (out[locale] ??= {})[device] = files;
    }
  }
  return out;
}

// ── Main product page ────────────────────────────────────────────────────────
async function mainPage() {
  const shots = shotsFor('main');
  if (!Object.keys(shots).length) return;
  const versions = await all(`/apps/${APP}/appStoreVersions?filter[platform]=IOS&limit=20`);
  const version = versions.find(v => EDITABLE.has(v.attributes.appStoreState));
  if (!version) { console.log('main page: no editable version. Create the next version in App Store Connect, then run again.'); return; }
  console.log(`main page: version ${version.attributes.versionString}`);
  const locs = await all(`/appStoreVersions/${version.id}/appStoreVersionLocalizations?limit=50`);
  for (const [locale, devices] of Object.entries(shots)) {
    let loc = locs.find(l => l.attributes.locale === locale);
    if (!loc && !DRY) {
      loc = (await api('POST', '/appStoreVersionLocalizations', { data: { type: 'appStoreVersionLocalizations', attributes: { locale }, relationships: { appStoreVersion: rel('appStoreVersions', version.id) } } })).data;
    }
    for (const [device, files] of Object.entries(devices)) {
      await replaceSet(loc ? `/appStoreVersionLocalizations/${loc.id}/appScreenshotSets` : '', { appStoreVersionLocalization: rel('appStoreVersionLocalizations', loc && loc.id) }, DISPLAY[device], files, locale);
    }
  }
}

// ── Listing text (store.config.json) ─────────────────────────────────────────
// Name, subtitle and privacy link live on the app info; description, keywords,
// promo text and what's new on the version. Missing languages are created.
const failures = [];
async function listing() {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../../store.config.json'), 'utf8')).apple;
  const infos = await all(`/apps/${APP}/appInfos`);
  const info = infos.find(i => EDITABLE.has(i.attributes.state) || EDITABLE.has(i.attributes.appStoreState));
  const versions = await all(`/apps/${APP}/appStoreVersions?filter[platform]=IOS&limit=20`);
  const version = versions.find(v => EDITABLE.has(v.attributes.appStoreState));
  if (!info || !version) { console.log('listing: no editable version. Create the next version in App Store Connect, then run again.'); return; }
  console.log(`listing: version ${version.attributes.versionString}, ${Object.keys(config.info).length} languages`);
  if (DRY) return;
  if (config.copyright) await api('PATCH', `/appStoreVersions/${version.id}`, { data: { type: 'appStoreVersions', id: version.id, attributes: { copyright: config.copyright } } });
  const infoLocs = await all(`/appInfos/${info.id}/appInfoLocalizations?limit=50`);
  const versionLocs = await all(`/appStoreVersions/${version.id}/appStoreVersionLocalizations?limit=50`);
  const firstVersion = versions.length === 1;
  for (const [locale, t] of Object.entries(config.info)) {
    try {
      const a = { name: t.title, subtitle: t.subtitle, privacyPolicyUrl: t.privacyPolicyUrl };
      const il = infoLocs.find(l => l.attributes.locale === locale);
      if (il) await api('PATCH', `/appInfoLocalizations/${il.id}`, { data: { type: 'appInfoLocalizations', id: il.id, attributes: a } });
      else await api('POST', '/appInfoLocalizations', { data: { type: 'appInfoLocalizations', attributes: { locale, ...a }, relationships: { appInfo: rel('appInfos', info.id) } } });
      const b = { description: t.description, keywords: (t.keywords || []).join(','), promotionalText: t.promoText, supportUrl: t.supportUrl, marketingUrl: t.marketingUrl };
      if (!firstVersion && t.releaseNotes) b.whatsNew = t.releaseNotes;
      for (const key of Object.keys(b)) if (b[key] === undefined) delete b[key];
      const vl = versionLocs.find(l => l.attributes.locale === locale);
      if (vl) await api('PATCH', `/appStoreVersionLocalizations/${vl.id}`, { data: { type: 'appStoreVersionLocalizations', id: vl.id, attributes: b } });
      else await api('POST', '/appStoreVersionLocalizations', { data: { type: 'appStoreVersionLocalizations', attributes: { locale, ...b }, relationships: { appStoreVersion: rel('appStoreVersions', version.id) } } });
      console.log(`  ${locale}: listing updated`);
    } catch (e) {
      failures.push(`${locale}: ${e.message}`);
      console.log(`  ${locale}: FAILED ${e.message}`);
    }
  }
}

// ── Custom product pages ─────────────────────────────────────────────────────
async function productPage(page) {
  const shots = shotsFor(page);
  if (!Object.keys(shots).length) return;
  const name = PAGE_NAMES[page];
  const existing = (await all(`/apps/${APP}/appCustomProductPages?limit=50`)).find(p => p.attributes.name === name);
  let pageId = existing && existing.id;
  if (!pageId) {
    console.log(`${name}: creating the product page`);
    if (DRY) return;
    const made = await api('POST', '/appCustomProductPages', {
      data: { type: 'appCustomProductPages', attributes: { name }, relationships: { app: rel('apps', APP), appCustomProductPageVersions: { data: [{ type: 'appCustomProductPageVersions', id: '${version}' }] } } },
      included: [
        { type: 'appCustomProductPageVersions', id: '${version}', relationships: { appCustomProductPageLocalizations: { data: [{ type: 'appCustomProductPageLocalizations', id: '${loc}' }] } } },
        { type: 'appCustomProductPageLocalizations', id: '${loc}', attributes: { locale: 'en-US' } },
      ],
    });
    pageId = made.data.id;
  }
  const versions = await all(`/appCustomProductPages/${pageId}/appCustomProductPageVersions`);
  let version = versions.find(v => v.attributes.state === 'PREPARE_FOR_SUBMISSION' || v.attributes.state === 'REJECTED');
  if (!version && versions.some(v => ['IN_REVIEW', 'WAITING_FOR_REVIEW', 'READY_FOR_REVIEW'].includes(v.attributes.state))) {
    console.log(`${name}: in review, skipped`); return;
  }
  if (!version && !DRY) {
    version = (await api('POST', '/appCustomProductPageVersions', { data: { type: 'appCustomProductPageVersions', relationships: { appCustomProductPage: rel('appCustomProductPages', pageId) } } })).data;
  }
  console.log(`${name}: ${Object.keys(shots).length} languages`);
  const locs = version ? await all(`/appCustomProductPageVersions/${version.id}/appCustomProductPageLocalizations?limit=50`) : [];
  for (const [locale, devices] of Object.entries(shots)) {
    let loc = locs.find(l => l.attributes.locale === locale);
    if (!loc && !DRY) {
      loc = (await api('POST', '/appCustomProductPageLocalizations', { data: { type: 'appCustomProductPageLocalizations', attributes: { locale }, relationships: { appCustomProductPageVersion: rel('appCustomProductPageVersions', version.id) } } })).data;
    }
    for (const [device, files] of Object.entries(devices)) {
      await replaceSet(loc ? `/appCustomProductPageLocalizations/${loc.id}/appScreenshotSets` : '', { appCustomProductPageLocalization: rel('appCustomProductPageLocalizations', loc && loc.id) }, DISPLAY[device], files, `${name} ${locale}`);
    }
  }
}

(async () => {
  for (const k of ['ASC_KEY_ID', 'ASC_ISSUER_ID', 'ASC_KEY_P8']) if (!process.env[k]) throw new Error(`${k} is not set`);
  if (process.argv.includes('--listing')) await listing();
  const pages = arg('pages', 'main,vaping,smoking,drinking,screens').split(',');
  if (pages.includes('main')) await mainPage();
  for (const p of pages.filter(p => p !== 'main')) await productPage(p);
  console.log('\nProduct page keywords are set once by hand: App Store Connect > your app > Custom Product Pages > each page.');
  console.log('New or changed product pages need submitting for review there too.');
  if (failures.length) { console.error(`\n${failures.length} listing languages failed:\n${failures.join('\n')}`); process.exit(1); }
})().catch(e => { console.error(e.message); process.exit(1); });
