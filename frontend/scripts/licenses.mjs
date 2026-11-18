// Generates public/third-party-licenses.json: every production dependency
// bundled into the app, with its licence and copyright notice. MIT/BSD/
// Apache licences require these notices to ship with the software; the
// /licenses page shows this file. Runs automatically before `vite build`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const seen = new Map();

function readNotice(dir) {
  for (const f of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'LICENCE', 'license.md', 'LICENSE-MIT']) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').slice(0, 6000);
  }
  return null;
}

function resolveDir(name, fromDir) {
  let dir = fromDir;
  while (true) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function walk(name, fromDir) {
  const dir = resolveDir(name, fromDir);
  if (!dir) return;
  const p = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const key = `${p.name}@${p.version}`;
  if (seen.has(key)) return;
  const license = typeof p.license === 'string' ? p.license : (p.license?.type || (Array.isArray(p.licenses) ? p.licenses.map((l) => l.type || l).join(' OR ') : 'UNKNOWN'));
  seen.set(key, { name: p.name, version: p.version, license, homepage: p.homepage || (typeof p.repository === 'string' ? p.repository : p.repository?.url) || null, notice: readNotice(dir) });
  for (const dep of Object.keys(p.dependencies || {})) walk(dep, dir);
}

for (const dep of Object.keys(pkg.dependencies || {})) walk(dep, root);
const list = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
fs.writeFileSync(path.join(root, 'public', 'third-party-licenses.json'), JSON.stringify({ generatedAt: new Date().toISOString(), packages: list }, null, 1));
const byLicense = list.reduce((m, p) => ({ ...m, [p.license]: (m[p.license] || 0) + 1 }), {});
console.log(`third-party-licenses.json: ${list.length} packages`, byLicense);
