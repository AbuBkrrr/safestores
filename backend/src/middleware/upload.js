// Multer upload middleware — now backed by the storage abstraction in
// utils/storage.js (local disk or S3-compatible object storage depending
// on whether S3_BUCKET is set). Kept as a thin re-export so every existing
// `require('../middleware/upload')` import elsewhere keeps working
// unchanged.
module.exports = require('../utils/storage');
