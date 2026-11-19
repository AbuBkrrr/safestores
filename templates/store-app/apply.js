#!/usr/bin/env node
// Turns the shared app into one store's own app before it is built.
// Used by .github/workflows/store-app.yml; run it by hand the same way to
// try a build locally (on a throw-away checkout: it edits files in place).
//
//   STORE_ID=42 STORE_NAME="Mama Nkechi Mart" STORE_TIER=midi \
//   API_URL=https://app.example.com/api node templates/store-app/apply.js desktop|android
//
// What it changes:
//   - every visible "SAFE Stores" in the app screens and translations → the store's name
//   - app name, app id (unique per store) and publisher/author
//   - VITE_* settings so the app opens straight onto this store
// Icons with the store's initials come from make-icons.sh.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const PLATFORM = 'SAFE Stores';
const target = process.argv[2];
const id = String(process.env.STORE_ID || '').replace(/[^0-9a-zA-Z]/g, '');
const name = String(process.env.STORE_NAME || '').replace(/[\r\n"<>\\]/g, '').trim().slice(0, 60);
const tier = ['mini', 'midi', 'mega'].includes(process.env.STORE_TIER) ? process.env.STORE_TIER : 'mini';
const apiUrl = String(process.env.API_URL || '').trim();
if (!['desktop', 'android'].includes(target) || !id || !name) {
  console.error('usage: STORE_ID=.. STORE_NAME=.. [STORE_TIER=..] [API_URL=..] node apply.js desktop|android');
  process.exit(1);
}
const appId = `com.storeapp.s${id.toLowerCase()}`;
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const write = (p, s) => fs.writeFileSync(path.join(ROOT, p), s);
const xml = (s) => s.replace(/&/g, '&amp;').replace(/'/g, "\\'");

// 1. App screens and translations: the store's name instead of the platform's.
function walk(dir, out = []) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) walk(rel, out);
    else if (/\.(jsx?|json|html|css)$/.test(e.name)) out.push(rel);
  }
  return out;
}
let changed = 0;
for (const f of [...walk('frontend/src'), 'frontend/public/manifest.json', 'frontend/public/sw.js', 'frontend/index.html']) {
  const s = read(f);
  if (!s.includes(PLATFORM)) continue;
  // Plain apostrophes become ’ so the name is safe inside quotes and JSX text alike.
  const enc = f.endsWith('.json') ? JSON.stringify(name).slice(1, -1) : name.replace(/'/g, '’').replace(/[`$]/g, '');
  write(f, s.split(PLATFORM).join(enc));
  changed++;
}
write('frontend/.env.production.local', [
  `VITE_BRAND_NAME=${name}`, `VITE_STORE_ID=${id}`, `VITE_STORE_TIER=${tier}`,
  ...(target === 'android' && apiUrl ? [`VITE_API_URL=${apiUrl}`] : []),
].join('\n') + '\n');

// 2. The app itself.
if (target === 'desktop') {
  const pkg = JSON.parse(read('desktop/package.json'));
  pkg.name = `store-${id}`.toLowerCase();
  pkg.productName = name;
  pkg.description = name;
  pkg.author = name;
  pkg.build.appId = appId;
  pkg.build.productName = name;
  pkg.build.nsis = { ...(pkg.build.nsis || {}), shortcutName: name, uninstallDisplayName: name };
  pkg.build.publish = null;
  write('desktop/package.json', JSON.stringify(pkg, null, 2) + '\n');
} else {
  const cap = JSON.parse(read('mobile/capacitor.config.json'));
  cap.appId = appId;
  cap.appName = name;
  write('mobile/capacitor.config.json', JSON.stringify(cap, null, 2) + '\n');
  write('mobile/android/app/src/main/res/values/strings.xml', `<?xml version='1.0' encoding='utf-8'?>
<resources>
    <string name="app_name">${xml(name)}</string>
    <string name="title_activity_main">${xml(name)}</string>
    <string name="package_name">${appId}</string>
    <string name="custom_url_scheme">${appId}</string>
</resources>
`);
  const gradle = read('mobile/android/app/build.gradle').replace(/applicationId "[^"]+"/, `applicationId "${appId}"`);
  write('mobile/android/app/build.gradle', gradle);
}
console.log(`Store app ready to build: "${name}" (${tier}, ${appId}); ${changed} screen/translation files renamed.`);
