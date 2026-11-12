// ------------------------------------------------------------
// File storage abstraction — local disk (default, unchanged behavior)
// or S3-compatible object storage (AWS S3, Cloudflare R2, Backblaze B2,
// DigitalOcean Spaces, Supabase Storage, MinIO — anything speaking the
// S3 API).
//
// WHY THIS EXISTS: uploaded receipt/camera images used to only ever be
// written to local disk (`backend/uploads/`). Most PaaS hosts (Render,
// Railway, Fly) run an EPHEMERAL filesystem by default — every redeploy
// or restart silently wipes that folder, which means every receipt photo
// and camera capture a store has ever taken (and the DB rows that point
// at them) go dead with no warning. Local disk still works for pure
// local dev, but the moment this is deployed anywhere with ephemeral
// storage, set S3_BUCKET (+ credentials) below to make uploads durable.
// Nothing else in the app needs to change — receiptsController and
// imagesController both go through persistUpload()/deleteUpload() here.
// ------------------------------------------------------------

const multer = require('multer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const S3_BUCKET = process.env.S3_BUCKET;
const usingS3 = !!S3_BUCKET;

let s3Client = null;
let PutObjectCommand, DeleteObjectCommand;

if (usingS3) {
  // Lazy-required so a local-disk-only deployment never needs this
  // package installed at all.
  const S3 = require('@aws-sdk/client-s3');
  PutObjectCommand = S3.PutObjectCommand;
  DeleteObjectCommand = S3.DeleteObjectCommand;
  s3Client = new S3.S3Client({
    region: process.env.S3_REGION || 'auto',
    // Leave unset for real AWS S3. Set for R2/Spaces/B2/MinIO, e.g.
    // https://<account-id>.r2.cloudflarestorage.com
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    credentials: process.env.S3_ACCESS_KEY_ID
      ? {
          accessKeyId: process.env.S3_ACCESS_KEY_ID,
          secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
        }
      : undefined, // falls back to the default AWS credential chain if unset
  });
  console.log(`📦 Object storage: S3 mode (bucket "${S3_BUCKET}") — uploads are durable across redeploys.`);
} else {
  console.warn(
    '⚠️  Object storage: LOCAL DISK mode (no S3_BUCKET set). Fine for local dev — ' +
    'if this is a production deploy on Render/Railway/Fly or similar, uploaded receipt/camera ' +
    'images WILL be lost on the next redeploy or restart unless you attach a persistent volume. ' +
    'Set S3_BUCKET (+ S3_* credentials) in .env to fix this — see .env.example.'
  );
}

// Local-disk fallback dir. Always created (even in S3 mode) since nothing
// currently relies on it being absent, and it's a harmless no-op either way.
const uploadDir = path.join(__dirname, '..', '..', process.env.UPLOAD_DIR || 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// Multer: memory storage when S3 is configured (the buffer goes straight to
// S3 and never touches local disk — nothing to lose on redeploy), disk
// storage otherwise (unchanged from before).
const storage = usingS3
  ? multer.memoryStorage()
  : multer.diskStorage({
      destination: (req, file, cb) => cb(null, uploadDir),
      filename: (req, file, cb) => {
        const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
        cb(null, `${unique}${path.extname(file.originalname)}`);
      },
    });

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    if (/^image\//.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only image uploads are allowed'));
  },
});

/**
 * Persists an already-multer-handled file and returns { url, key }.
 * - Disk mode: the file is already on disk by the time this runs (multer
 *   wrote it); this just builds the public URL. `key` is the filename,
 *   used later by deleteUpload().
 * - S3 mode: this is the actual upload (buffer → object storage). `key`
 *   is the object key.
 */
async function persistUpload(file, { keyPrefix = 'uploads' } = {}) {
  if (!usingS3) {
    return { url: `/uploads/${file.filename}`, key: file.filename };
  }

  const key = `${keyPrefix}/${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname)}`;
  await s3Client.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    Body: file.buffer,
    ContentType: file.mimetype,
    // Omit ACL entirely for buckets that reject them (e.g. Cloudflare R2,
    // or any bucket with "Object Ownership: Bucket owner enforced"). Set
    // S3_ACL=public-read only if your bucket actually needs/accepts it.
    ...(process.env.S3_ACL ? { ACL: process.env.S3_ACL } : {}),
  }));

  const url = process.env.S3_PUBLIC_URL_BASE
    ? `${process.env.S3_PUBLIC_URL_BASE.replace(/\/$/, '')}/${key}`
    : `https://${S3_BUCKET}.s3.${process.env.S3_REGION || 'us-east-1'}.amazonaws.com/${key}`;

  return { url, key };
}

/** Deletes a previously persisted upload by its storage key. */
async function deleteUpload(key) {
  if (!key) return;
  if (!usingS3) {
    const filePath = path.join(uploadDir, key);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return;
  }
  await s3Client.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key }));
}

/**
 * Whatever runOcr() should read from — a local file path in disk mode
 * (Tesseract reads paths directly), or the in-memory buffer in S3 mode
 * (Tesseract.js also accepts a Buffer directly — no temp file needed, so
 * OCR never touches disk in S3 mode either).
 */
function ocrSource(file) {
  return usingS3 ? file.buffer : file.path;
}

module.exports = { upload, uploadDir, usingS3, persistUpload, deleteUpload, ocrSource };
