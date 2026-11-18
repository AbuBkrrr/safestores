// Builds the React frontend and copies the output into desktop/frontend-dist
// so electron-builder can bundle it into the packaged app.
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// scripts/ -> desktop/ -> repo root -> frontend/
const frontendDir = path.join(__dirname, '..', '..', 'frontend');
const distSrc = path.join(frontendDir, 'dist');
const distDest = path.join(__dirname, '..', 'frontend-dist');

console.log('📦 Installing frontend dependencies (if needed)...');
execSync('npm install', { cwd: frontendDir, stdio: 'inherit' });

console.log('🏗️  Building frontend...');
execSync('npm run build', { cwd: frontendDir, stdio: 'inherit' });

console.log('📁 Copying build output into desktop/frontend-dist...');
fs.rmSync(distDest, { recursive: true, force: true });
fs.cpSync(distSrc, distDest, { recursive: true });

console.log('✅ Frontend ready at', distDest);
