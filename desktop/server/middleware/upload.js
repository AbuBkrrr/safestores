const multer = require('multer');
const path = require('path');
const { uploadsDir } = require('../db');

// Picture types we accept, and the only extensions files are saved with.
const SAFE_EXT = { 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
  'image/heic': '.heic', 'image/heif': '.heif', 'image/bmp': '.bmp', 'application/pdf': '.pdf' };
const safeExt = (file) => SAFE_EXT[String(file.mimetype || '').toLowerCase()] || '.bin';
const isSafeImage = (file) => /^image\//.test(file.mimetype) && !!SAFE_EXT[String(file.mimetype).toLowerCase()];

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${unique}${safeExt(file)}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    if (isSafeImage(file)) cb(null, true);
    else cb(new Error('Only photo uploads (JPG, PNG, WEBP, GIF, HEIC) are allowed'));
  },
});

module.exports = { upload, uploadsDir };
