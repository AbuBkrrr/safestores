// Puts the English text-reading data (Tesseract eng.traineddata, ~10 MB)
// into desktop/tessdata so the installer carries it. Without it, the first
// invoice scan on a computer that has never been online cannot read text.
// Never fails the build: if the download is impossible, the app falls back
// to fetching the data on its first online scan, as before.
const fs = require('fs');
const path = require('path');
const https = require('https');

const URL = 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz';
const dir = path.join(__dirname, '..', 'tessdata');
const file = path.join(dir, 'eng.traineddata.gz');

function get(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        resolve(get(new URL(res.headers.location, url).toString(), redirects - 1));
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

(async () => {
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(file) && fs.statSync(file).size > 1e6) {
    console.log('✅ OCR data already present');
    return;
  }
  try {
    const data = await get(URL);
    if (data.length < 1e6) throw new Error('download too small');
    fs.writeFileSync(file, data);
    console.log(`✅ OCR data bundled (${Math.round(data.length / 1e6)} MB)`);
  } catch (err) {
    console.warn(`⚠️  Could not bundle OCR data (${err.message}); invoice scanning will download it on first online use.`);
  }
})();
