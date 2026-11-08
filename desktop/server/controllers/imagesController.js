const crypto = require('crypto');
const db = require('../db');
const { emitToStore } = require('../realtime');

function listImages(req, res) {
  const { storeId } = req.params;
  res.json(db.prepare('SELECT * FROM images WHERE store_id = ? ORDER BY created_at DESC').all(storeId));
}

function uploadImage(req, res) {
  const { storeId } = req.params;
  const { label } = req.body;
  if (!req.file) return res.status(400).json({ error: 'No file uploaded (field name must be "photo")' });

  const id = crypto.randomUUID();
  const url = `/uploads/${req.file.filename}`;
  db.prepare('INSERT INTO images (id, store_id, url, label, created_by) VALUES (?,?,?,?,?)')
    .run(id, storeId, url, label || null, req.user.sub);

  res.status(201).json(db.prepare('SELECT * FROM images WHERE id = ?').get(id));
  emitToStore(storeId, 'image:uploaded', db.prepare('SELECT * FROM images WHERE id = ?').get(id));
}

function deleteImage(req, res) {
  const { storeId, imageId } = req.params;
  const result = db.prepare('DELETE FROM images WHERE id = ? AND store_id = ?').run(imageId, storeId);
  if (result.changes === 0) return res.status(404).json({ error: 'Image not found' });
  res.status(204).end();
  emitToStore(storeId, 'image:deleted', { id: imageId });
}

function barcodeLookup(req, res) {
  const { storeId } = req.params;
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: 'code query param required' });

  const product = db.prepare(
    'SELECT * FROM products WHERE store_id = ? AND (sku = ? OR barcode = ?) AND archived_at IS NULL ORDER BY (barcode = ?) DESC LIMIT 1'
  ).get(storeId, code, code, code);
  if (!product) return res.status(404).json({ error: 'No product found for this code' });
  res.json(product);
}

module.exports = { listImages, uploadImage, deleteImage, barcodeLookup };
