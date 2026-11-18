-- ============================================================
-- SAFE Stores — SQLite Schema (embedded desktop version)
-- Applied automatically on first launch by server/db.js
-- ============================================================

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS super_admins (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Store size tiers — Super Admin assigns each store a size category, which
-- drives plan limits (max products/users) instead of a fixed plan picked at
-- signup. The admin can pick a starting tier at signup; the Super Admin can
-- correct/change it any time from Manage Stores.
CREATE TABLE IF NOT EXISTS store_tiers (
    tier TEXT PRIMARY KEY CHECK (tier IN ('mini', 'midi', 'mega')),
    label TEXT NOT NULL,
    max_products INTEGER, -- NULL = unlimited
    max_users INTEGER,    -- NULL = unlimited
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT OR IGNORE INTO store_tiers (tier, label, max_products, max_users) VALUES
 ('mini', 'Mini Store', 200, 5),
 ('midi', 'Midi Store', 2000, 20),
 ('mega', 'Mega Store', NULL, NULL);

CREATE TABLE IF NOT EXISTS stores (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    store_tier TEXT NOT NULL DEFAULT 'mini' REFERENCES store_tiers(tier),
    subscription_status TEXT NOT NULL DEFAULT 'pending',
    billing_model TEXT NOT NULL DEFAULT 'daily_percentage' CHECK (billing_model IN ('daily_percentage', 'custom')),
    daily_rate_percent REAL NOT NULL DEFAULT 1.00,
    grace_period_minutes INTEGER NOT NULL DEFAULT 5,
    custom_billing_notes TEXT,
    locked INTEGER NOT NULL DEFAULT 0,
    access_code_id TEXT,
    sync_key TEXT,
    -- Marketer/affiliate email or phone this store was referred by, if
    -- any — see backend's 023_referral_tracking.sql for the full
    -- rationale (this desktop-side copy exists for when a Super Admin
    -- registers a store directly rather than via the public web signup).
    referral_contact TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS access_codes (
    id TEXT PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    intended_tier TEXT REFERENCES store_tiers(tier),
    status TEXT NOT NULL DEFAULT 'active',
    issued_by TEXT REFERENCES super_admins(id),
    used_by_store TEXT REFERENCES stores(id),
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    password_hash TEXT,
    role TEXT NOT NULL DEFAULT 'staff',
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (store_id, email)
);

CREATE TABLE IF NOT EXISTS invites (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    email TEXT,
    role TEXT NOT NULL DEFAULT 'staff',
    status TEXT NOT NULL DEFAULT 'pending',
    claimed_by_user TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    sku TEXT NOT NULL,
    category TEXT,
    supplier TEXT,
    unit TEXT NOT NULL DEFAULT 'unit',
    location TEXT, -- free-text: e.g. "Aisle 3, Shelf B, Ground Floor"
    cost_price REAL NOT NULL DEFAULT 0,
    price_multiplier REAL NOT NULL DEFAULT 1.3,
    reorder_level INTEGER NOT NULL DEFAULT 5,
    -- Smart Replenishment: lead_time_days/min_order_qty feed the dynamic
    -- reorder-point calculation (see server/utils/replenishment.js);
    -- auto_reorder opts this specific product into automatic draft-PO
    -- generation once its supplier is "approved" — see replenishmentJob.js.
    lead_time_days INTEGER NOT NULL DEFAULT 7,
    min_order_qty INTEGER NOT NULL DEFAULT 1,
    auto_reorder INTEGER NOT NULL DEFAULT 0,
    -- Supplier Performance Analytics: normalized link alongside the
    -- free-text `supplier` column (kept for backward compat/display
    -- fallback) — see utils/supplierLookup.js.
    supplier_id TEXT REFERENCES suppliers(id) ON DELETE SET NULL,
    -- Marketplace listing fields — only meaningful for a store that's
    -- opted into the online marketplace (see marketplace-profile), but
    -- harmless to have on every product either way. image_url is picked
    -- from this store's own captured photos or uploaded directly; the
    -- marketplace frontend falls back to a generic category placeholder
    -- when it's null.
    brand TEXT,
    image_url TEXT,
    -- Perishable goods: default 'ambient' preserves today's behavior for
    -- every existing product. 'refrigerated'/'frozen' opt a product into
    -- a much tighter expiry-urgency curve (see utils/batches.js's
    -- suggestedDiscountPct and expiryJob.js) — fresh dairy, produce, and
    -- especially ice cream can go from fine to a write-off in days, not
    -- the weeks the default curve assumes for shelf-stable goods.
    storage_type TEXT NOT NULL DEFAULT 'ambient' CHECK (storage_type IN ('ambient', 'refrigerated', 'frozen')),
    backroom_qty INTEGER NOT NULL DEFAULT 0,
    shelf_qty INTEGER NOT NULL DEFAULT 0,
    sold_qty INTEGER NOT NULL DEFAULT 0,
    damaged_qty INTEGER NOT NULL DEFAULT 0,
    -- Products are never hard-deleted (see productsController.js's
    -- deleteProduct) — stock_arrivals/stock_movements/shelf_audits/batches
    -- all ON DELETE CASCADE off product_id, so a real delete would
    -- silently wipe that product's entire history along with it.
    -- Archiving instead means that history — and any backup sync of it —
    -- is never at risk no matter what an admin does in the product list.
    archived_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (store_id, sku)
);

CREATE TABLE IF NOT EXISTS stock_arrivals (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    quantity INTEGER NOT NULL,
    invoice_number TEXT,
    expiry_date TEXT,
    batch_number TEXT,
    -- Set when this arrival came from a scanned receipt (see
    -- receiptsController.js's applyReceipt) rather than the manual Stock
    -- Arrival form, so the admin can trace an arrival back to the original
    -- scanned document/photo (receipts.image_url) for record purposes.
    receipt_id TEXT REFERENCES receipts(id) ON DELETE SET NULL,
    received_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS stock_movements (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    note TEXT,
    performed_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS shelf_audits (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    counted_qty INTEGER NOT NULL,
    expected_qty INTEGER NOT NULL,
    discrepancy INTEGER NOT NULL,
    confidence_source TEXT NOT NULL DEFAULT 'manual_count',
    auto_adjusted INTEGER NOT NULL DEFAULT 0,
    -- Physical location the count was taken at, so a store-wide audit can
    -- be organized/reconciled by where stock actually sits, not just by
    -- product. 'shelf' compares against products.shelf_qty; 'backroom' and
    -- 'warehouse' compare against products.backroom_qty (see
    -- inventoryController.createAudit / stockMath's backroom_adjustment).
    area TEXT NOT NULL DEFAULT 'shelf' CHECK (area IN ('shelf', 'backroom', 'warehouse')),
    floor_number TEXT,
    shelf_number TEXT,
    row_number TEXT,
    zone TEXT, -- warehouse bay/aisle/section identifier, when area = 'warehouse'
    -- Multi-stocktaker conflict tracking: if two different people count the
    -- same product+location within the recount window and disagree, both
    -- rows (and any subsequent recount rows) share a conflict_group_id and
    -- flip to 'needs_recount' until the disputing stocktakers physically
    -- recount together and one submits an agreed figure that the other(s)
    -- accept — see inventoryController.js's detectAuditConflict /
    -- acceptRecount for the full flow.
    status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'needs_recount', 'resolved')),
    conflict_group_id TEXT,
    resolved_by TEXT REFERENCES users(id),
    resolved_at TEXT,
    performed_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_shelf_audits_conflict ON shelf_audits(conflict_group_id);

-- Which of the ORIGINAL conflicting stocktakers (not whoever submitted the
-- final recount figure) have accepted it. A conflict resolves once every
-- distinct performer from the conflict, other than the recount submitter,
-- has one of these rows.
CREATE TABLE IF NOT EXISTS audit_conflict_acceptances (
    id TEXT PRIMARY KEY,
    conflict_group_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id),
    accepted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (conflict_group_id, user_id)
);

-- Store-level notifications — distinct from the Super Admin's billing
-- notifications table. 'amber' severity is the recount-needed alert shown
-- to the admin and both stocktakers involved; 'info' is used for the
-- resolution confirmation once a recount is accepted.
CREATE TABLE IF NOT EXISTS store_notifications (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    type TEXT NOT NULL, -- recount_needed | recount_resolved
    severity TEXT NOT NULL DEFAULT 'amber' CHECK (severity IN ('amber', 'info')),
    audience_role TEXT, -- 'admin' broadcasts to every admin of the store
    user_id TEXT REFERENCES users(id), -- targets one specific user instead (e.g. a stocktaker)
    conflict_group_id TEXT,
    message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'unread' CHECK (status IN ('unread', 'read')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_store_notifications_store ON store_notifications(store_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS receipts (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    image_url TEXT,
    raw_ocr_text TEXT,
    parsed_items TEXT NOT NULL DEFAULT '[]',
    -- Best-effort date printed on the receipt itself (see
    -- utils/ocr.js's extractDocumentDate) — shown at review time as the
    -- suggested arrival date, since the receipt might not get reviewed
    -- same-day as the goods actually arrived.
    document_date TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    applied_at TEXT,
    uploaded_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS images (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    label TEXT,
    created_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Tracks, per remote source (a LAN peer's address, or the cloud), the
-- timestamp of the last change this device has successfully pulled from
-- it — so each sync pass only asks for "what's new since last time"
-- instead of re-fetching everything.
CREATE TABLE IF NOT EXISTS sync_cursors (
    peer_key TEXT PRIMARY KEY,     -- e.g. "cloud" or "lan:192.168.1.42:4000"
    store_id TEXT NOT NULL,
    last_pulled_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z',
    last_pushed_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z',
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- POS checkout/cashier — works fully offline, same as everything else in
-- this edition. See backend/migrations/004_pos_checkout.sql for the full
-- rationale (split vs merged checkout falls out of role alone).
CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending_payment',
    subtotal REAL NOT NULL DEFAULT 0,
    total REAL NOT NULL DEFAULT 0,
    created_by TEXT REFERENCES users(id),
    paid_by TEXT REFERENCES users(id),
    payment_method TEXT,
    receipt_number TEXT UNIQUE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    paid_at TEXT,
    cancelled_at TEXT
);

CREATE TABLE IF NOT EXISTS order_items (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL REFERENCES products(id),
    quantity INTEGER NOT NULL,
    unit_price REAL NOT NULL,
    line_total REAL NOT NULL,
    added_via TEXT NOT NULL DEFAULT 'scan',
    movement_id TEXT REFERENCES stock_movements(id),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ============================================================
-- Billing automation (desktop port — see server/billingJob.js)
-- ============================================================
CREATE TABLE IF NOT EXISTS billing_charges (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    charge_date TEXT NOT NULL,             -- the day (YYYY-MM-DD) this charge is FOR
    transaction_total REAL NOT NULL DEFAULT 0,
    rate_percent REAL NOT NULL,
    amount_due REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'waived', 'overdue')),
    warning_sent_at TEXT,
    locked_at TEXT,
    paid_at TEXT,
    marked_paid_by TEXT REFERENCES super_admins(id),
    -- Store-admin's own "I've Paid" claim, pending Super Admin confirmation.
    claim_method TEXT,                     -- ussd | bank_transfer | cash | card
    claim_reference TEXT,
    claimed_at TEXT,
    waived_at TEXT,
    waived_by TEXT REFERENCES super_admins(id),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (store_id, charge_date)
);
CREATE INDEX IF NOT EXISTS idx_billing_charges_store ON billing_charges(store_id, charge_date DESC);

-- Surfaces payment claims, overdue warnings, and lockouts to the Super Admin.
CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,                    -- payment_claim | overdue_warning | store_locked
    store_id TEXT REFERENCES stores(id) ON DELETE CASCADE,
    billing_charge_id TEXT REFERENCES billing_charges(id) ON DELETE CASCADE,
    message TEXT NOT NULL,
    read_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(read_at, created_at DESC);

-- Single row of manual payment-collection instructions, editable by the
-- Super Admin from Tiers & Codes, shown to every store admin on Billing.
CREATE TABLE IF NOT EXISTS payment_settings (
    id TEXT PRIMARY KEY DEFAULT 'default',
    account_number TEXT,
    account_name TEXT,
    bank_or_provider TEXT,
    methods TEXT NOT NULL DEFAULT '[]',    -- JSON array, e.g. ["ussd","bank_transfer","cash","card"]
    instructions TEXT,
    -- Placeholder for a future payment gateway integration (Paystack,
    -- Flutterwave, Stripe). See backend/migrations/026_payment_gateway_placeholder.sql
    -- for the full rationale — nothing reads these to actually process a
    -- payment yet; today's flow is entirely manual (claimPayment/markPaid
    -- in billingController.js).
    gateway_provider TEXT NOT NULL DEFAULT 'none' CHECK (gateway_provider IN ('none', 'paystack', 'flutterwave', 'stripe')),
    gateway_enabled INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT OR IGNORE INTO payment_settings (id, account_number, account_name, bank_or_provider, methods, instructions)
VALUES ('default', '8032540215', 'SAFE Stores', 'OPAY',
        '["ussd","bank_transfer","cash","card"]',
        'Pay via USSD, bank transfer, cash, or card to the OPAY account above, then click "I''ve Paid" and enter your payment reference.');

-- Which currency amounts are shown in across the whole app — a single
-- Super-Admin-editable setting, not per-store (a deployment serves one
-- currency at a time; switching currencies mid-deployment doesn't convert
-- historical amounts, it only changes the symbol/code shown going forward).
CREATE TABLE IF NOT EXISTS currency_settings (
    id TEXT PRIMARY KEY DEFAULT 'default',
    code TEXT NOT NULL DEFAULT 'NGN',
    symbol TEXT NOT NULL DEFAULT '₦',
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT OR IGNORE INTO currency_settings (id, code, symbol) VALUES ('default', 'NGN', '₦');

-- Smart Replenishment: purchase orders generated either manually from the
-- Replenishment page or automatically by replenishmentJob.js for products
-- with auto_reorder = 1. Receiving one creates real 'arrival' stock_movements
-- rows, same as the manual Stock Arrival flow — see
-- replenishmentController.js's receivePurchaseOrder.
-- Supplier Performance Analytics. products.supplier / purchase_orders.supplier
-- (free text) are kept for backward compat/display fallback — supplier_id
-- on both is what performance/pricing analytics actually query against.
-- See utils/supplierLookup.js for how it gets populated.
CREATE TABLE IF NOT EXISTS suppliers (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    contact_name TEXT,
    phone TEXT,
    email TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (store_id, name)
);
CREATE INDEX IF NOT EXISTS idx_suppliers_store ON suppliers(store_id);

CREATE TABLE IF NOT EXISTS purchase_orders (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    supplier TEXT NOT NULL, -- free-text, matches products.supplier
    supplier_id TEXT REFERENCES suppliers(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'received', 'cancelled')),
    auto_generated INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    total_cost REAL NOT NULL DEFAULT 0,
    created_by TEXT REFERENCES users(id),
    sent_at TEXT,
    -- Sent time + that PO's average product lead_time_days — see
    -- replenishmentController.js's sendPurchaseOrder. Compared against
    -- received_at for on-time-delivery performance.
    expected_at TEXT,
    received_by TEXT REFERENCES users(id),
    received_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_store ON purchase_orders(store_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS purchase_order_items (
    id TEXT PRIMARY KEY,
    purchase_order_id TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL REFERENCES products(id),
    quantity INTEGER NOT NULL,
    unit_cost REAL NOT NULL DEFAULT 0,
    received_quantity INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_po_items_po ON purchase_order_items(purchase_order_id);

-- Expiry & Batch Tracking — created automatically when an arrival has an
-- expiry date (see inventoryController.js's createArrival). Remaining
-- quantity is computed at read time (utils/batches.js), not stored — see
-- the Postgres migration's header for why.
CREATE TABLE IF NOT EXISTS batches (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    batch_number TEXT,
    expiry_date TEXT NOT NULL,
    quantity_received INTEGER NOT NULL,
    arrival_id TEXT UNIQUE REFERENCES stock_arrivals(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_batches_product_expiry ON batches(product_id, expiry_date ASC);
CREATE INDEX IF NOT EXISTS idx_batches_store ON batches(store_id);

-- Cycle Counting & Inventory Accuracy.
--
-- Deliberately separate from shelf_audits — that models a formal,
-- engagement-gated, external-auditor process with physical-location
-- tracking and multi-stocktaker conflict detection (see
-- requireActiveEngagement / inventoryController.createAudit). Cycle
-- counting is the opposite: frequent, informal, staff-initiated spot
-- checks on individual products, available any time with no engagement
-- required. A cycle count validates a product's TOTAL on-hand quantity
-- (shelf + backroom combined) rather than a specific physical location,
-- and any discrepancy is applied as a plain 'adjustment' movement — see
-- cycleCountController.js for why that's the right simplification here.
--
-- cycle_count_tasks is the schedule: which product should be spot-checked
-- next, and by when. Generated automatically (see cycleCountJob.js) by
-- ranking products by a simple risk score — value at stake, recent
-- discrepancy history, and how long since it was last counted — and
-- assigning higher-risk products a shorter recount cadence. A small batch
-- of new tasks is created per store per day (never every product at
-- once), which is what "automates count scheduling" means in practice: a
-- manageable daily list, not a flood.
--
-- cycle_counts is the actual count record — optionally linked back to the
-- task it fulfilled, but ad-hoc counts with no task at all are also
-- allowed (a staff member noticing something looks off shouldn't have to
-- wait for a scheduled task to check it).
CREATE TABLE IF NOT EXISTS cycle_count_tasks (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    risk_tier TEXT NOT NULL CHECK (risk_tier IN ('high', 'medium', 'low')),
    due_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'overdue', 'skipped')),
    cycle_count_id TEXT REFERENCES cycle_counts(id) ON DELETE SET NULL, -- set once completed
    generated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_cycle_tasks_store_status ON cycle_count_tasks(store_id, status, due_date);
CREATE INDEX IF NOT EXISTS idx_cycle_tasks_product ON cycle_count_tasks(product_id, generated_at DESC);

CREATE TABLE IF NOT EXISTS cycle_counts (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    task_id TEXT REFERENCES cycle_count_tasks(id) ON DELETE SET NULL,
    counted_qty INTEGER NOT NULL,
    expected_qty INTEGER NOT NULL, -- shelf_qty + backroom_qty at the moment of counting
    discrepancy INTEGER NOT NULL,
    auto_adjusted INTEGER NOT NULL DEFAULT 0,
    performed_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_cycle_counts_store ON cycle_counts(store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cycle_counts_product ON cycle_counts(product_id, created_at DESC);

-- Outbound webhooks — the generic "integrations" answer. events is a JSON
-- array (SQLite has no native array type) — see utils/webhooks.js.
CREATE TABLE IF NOT EXISTS webhooks (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    secret TEXT NOT NULL,
    events TEXT NOT NULL DEFAULT '[]', -- JSON array, e.g. ["receipt.applied","order.paid"]
    active INTEGER NOT NULL DEFAULT 1,
    last_triggered_at TEXT,
    last_status_code INTEGER,
    created_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    -- Sync support: last-write-wins merge on updated_at; deleted_at is a
    -- tombstone (not a hard delete) so a delete propagates to other
    -- devices instead of getting silently resurrected — see
    -- backend migration 018's header.
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_webhooks_store ON webhooks(store_id, active);

-- Tracks the last support-ticket reply this device has already dispatched
-- a 'support_ticket.replied' webhook for, so re-fetching a ticket (the
-- frontend polls) doesn't re-fire the same event — see
-- controllers/supportController.js's getTicket proxy.
CREATE TABLE IF NOT EXISTS webhook_ticket_markers (
    ticket_id TEXT PRIMARY KEY,
    last_reply_id TEXT
);

-- Customer credit tracking ("owing book") — SQLite counterpart of backend
-- migration 027_credit_loyalty_lending.sql's store_customers /
-- customer_ledger_entries tables. Only the same-store, same-device
-- feature is mirrored here (in-person regulars a cashier tracks by name/
-- phone) — the marketplace self-service customer accounts and the
-- cross-store lending-partner registry from that migration are genuinely
-- cloud-only concepts (they need a central directory this standalone
-- install has no concept of) and stay off the desktop edition, same as
-- the marketplace/auditor nav section already is.
CREATE TABLE IF NOT EXISTS store_customers (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    phone TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    archived_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_store_customers_store ON store_customers(store_id);

-- A running ledger, not a single mutable balance column — same
-- reasoning as the cloud migration: every credit sale and repayment is
-- its own auditable row, and the balance is always a SUM over real
-- entries rather than a counter that could drift out of sync.
CREATE TABLE IF NOT EXISTS customer_ledger_entries (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    store_customer_id TEXT NOT NULL REFERENCES store_customers(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('credit_sale', 'payment', 'adjustment')),
    amount REAL NOT NULL CHECK (amount <> 0),
    order_id TEXT REFERENCES orders(id) ON DELETE SET NULL,
    note TEXT,
    recorded_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_ledger_customer ON customer_ledger_entries(store_customer_id, created_at);

CREATE INDEX IF NOT EXISTS idx_products_store ON products(store_id);
CREATE INDEX IF NOT EXISTS idx_movements_store_product ON stock_movements(store_id, product_id);
CREATE INDEX IF NOT EXISTS idx_users_store ON users(store_id);
CREATE INDEX IF NOT EXISTS idx_invites_store ON invites(store_id);
CREATE INDEX IF NOT EXISTS idx_receipts_store ON receipts(store_id);
CREATE INDEX IF NOT EXISTS idx_audits_store ON shelf_audits(store_id);
