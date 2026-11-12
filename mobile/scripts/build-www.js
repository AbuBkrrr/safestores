// Builds the React frontend pointed at your DEPLOYED backend (not
// localhost) and copies the output into mobile/www, so Capacitor bundles
// it directly into the iOS/Android app. This is what makes the app shell
// itself load instantly with zero connectivity — only the API calls need
// a network, and those already queue-and-sync via frontend/src/offline/.
//
// Usage:
//   SAFE_STORES_API_URL=https://api.yourdomain.com/api node scripts/build-www.js
//
// (If your backend and frontend are on the same domain behind one reverse
// proxy, use that domain + /api.)
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const apiUrl = process.env.SAFE_STORES_API_URL;
if (!apiUrl) {
  console.error('\n✖ Set SAFE_STORES_API_URL to your deployed backend before building, e.g.\n');
  console.error('  SAFE_STORES_API_URL=https://api.yourdomain.com/api node scripts/build-www.js\n');
  process.exit(1);
}

const frontendDir = path.join(__dirname, '..', '..', 'frontend');
const distSrc = path.join(frontendDir, 'dist');
const wwwDest = path.join(__dirname, '..', 'www');

console.log(`📦 Installing frontend dependencies (if needed)...`);
execSync('npm install', { cwd: frontendDir, stdio: 'inherit' });

console.log(`🏗️  Building frontend with VITE_API_URL=${apiUrl} ...`);
execSync('npm run build', {
  cwd: frontendDir,
  stdio: 'inherit',
  env: { ...process.env, VITE_API_URL: apiUrl },
});

console.log('📁 Copying build output into mobile/www...');
fs.rmSync(wwwDest, { recursive: true, force: true });
fs.cpSync(distSrc, wwwDest, { recursive: true });

console.log('✅ Frontend ready at', wwwDest);
console.log('   Next: npx cap sync   (then open in Xcode / Android Studio)');
