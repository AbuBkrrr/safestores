// ------------------------------------------------------------
// Camera/gallery images for the standalone web edition. Postgres-flavored
// twin of desktop/server/controllers/imagesController.js — uploads go
// through utils/storage.js's persistUpload()/deleteUpload() so they land
// on S3 when configured instead of an ephemeral local disk.
// ------------------------------------------------------------

const db = require('../config/db');
const { persistUpload, deleteUpload } = require('../utils/storage');
const { emitToStore } = require('../realtime');

// GET /api/stores/:storeId/images
async function listImages(req, res) {
  const { storeId } = req.params;
  const { rows } = await db.query('SELECT * FROM images WHERE store_id = $1 ORDER BY created_at DESC', [storeId]);
  res.json(rows);
}

// POST /api/stores/:storeId/images  (multipart field name: "photo")
async function uploadImage(req, res) {
  const { storeId } = req.params;
  const { label } = req.body;
  if (!req.file) return res.status(400).json({ error: 'No file uploaded (field name must be "photo")' });

  const { url, key } = await persistUpload(req.file, { keyPrefix: `stores/${storeId}/images` });
  const { rows } = await db.query(
    `INSERT INTO images (store_id, url, storage_key, label, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [storeId, url, key, label || null, req.user.sub]
  );
  res.status(201).json(rows[0]);
  emitToStore(storeId, 'image:uploaded', rows[0]);
}

// DELETE /api/stores/:storeId/images/:imageId
async function deleteImage(req, res) {
  const { storeId, imageId } = req.params;
  const { rows } = await db.query('SELECT * FROM images WHERE id = $1 AND store_id = $2', [imageId, storeId]);
  const image = rows[0];
  if (!image) return res.status(404).json({ error: 'Image not found' });

  await db.query('DELETE FROM images WHERE id = $1', [imageId]);
  await deleteUpload(image.storage_key);
  res.status(204).end();
  emitToStore(storeId, 'image:deleted', { id: imageId });
}

// GET /api/stores/:storeId/barcode-lookup?code=
async function barcodeLookup(req, res) {
  const { storeId } = req.params;
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: 'code query param required' });

  const { rows } = await db.query('SELECT * FROM products WHERE store_id = $1 AND sku = $2', [storeId, code]);
  if (!rows[0]) return res.status(404).json({ error: 'No product found for this code' });
  res.json(rows[0]);
}

module.exports = { listImages, uploadImage, deleteImage, barcodeLookup };
