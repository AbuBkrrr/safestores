-- ============================================================
-- Best-effort date printed on a scanned receipt itself (see desktop's
-- utils/ocr.js's extractDocumentDate) — used as the suggested/actual
-- arrival date at apply time rather than always defaulting to whenever
-- the receipt got reviewed, which can lag actual delivery by a day or
-- more if receipts pile up before someone gets to them.
-- ============================================================

ALTER TABLE receipts ADD COLUMN IF NOT EXISTS document_date DATE;
