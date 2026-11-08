-- ============================================================
-- SAFE Stores — PostgreSQL Schema
-- ============================================================
-- Run with: psql -U <user> -d safestores -f migrations/schema.sql

CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- for gen_random_uuid()

-- ------------------------------------------------------------
-- Super Admins (system-wide control)
-- ------------------------------------------------------------
CREATE TABLE super_admins (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(120) NOT NULL,
    email VARCHAR(160) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- Subscription Plans (seeded, editable by super admin)
-- ------------------------------------------------------------
CREATE TABLE subscription_plans (
    id VARCHAR(30) PRIMARY KEY,           -- 'basic' | 'premium' | 'enterprise'
    label VARCHAR(60) NOT NULL,
    price_cents INTEGER NOT NULL,
    max_products INTEGER,                  -- NULL = unlimited
    max_stores INTEGER,
    max_users INTEGER,
    api_access BOOLEAN NOT NULL DEFAULT false
);

INSERT INTO subscription_plans (id, label, price_cents, max_products, max_stores, max_users, api_access) VALUES
 ('basic', 'Basic', 2900, 500, 1, 3, false),
 ('premium', 'Premium', 7900, NULL, 3, 10, false),
 ('enterprise', 'Enterprise', 19900, NULL, NULL, NULL, true);

-- ------------------------------------------------------------
-- Stores (tenants)
-- ------------------------------------------------------------
CREATE TABLE stores (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(160) NOT NULL,
    plan_id VARCHAR(30) NOT NULL REFERENCES subscription_plans(id),
    subscription_status VARCHAR(20) NOT NULL DEFAULT 'pending',
        -- pending | active | suspended
    access_code_id UUID,                   -- code used to activate (set on activation)
    -- Shared secret so devices belonging to this store can sync directly
    -- with each other (LAN, no internet) or with the cloud without every
    -- device needing to validate every other device's individual user
    -- login — they just need to prove they're the same store. Delivered
    -- to a device once at login; never shown in the UI.
    sync_key UUID NOT NULL DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- Access Codes (super admin issues, store redeems to activate)
-- ------------------------------------------------------------
CREATE TABLE access_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(20) UNIQUE NOT NULL,
    plan_id VARCHAR(30) NOT NULL REFERENCES subscription_plans(id),
    status VARCHAR(20) NOT NULL DEFAULT 'active', -- active | used | revoked | expired
    issued_by UUID REFERENCES super_admins(id),
    used_by_store UUID REFERENCES stores(id),
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- Users (store admins + invited staff)
-- ------------------------------------------------------------
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    name VARCHAR(120) NOT NULL,
    email VARCHAR(160) NOT NULL,
    password_hash TEXT,                   -- NULL for invite-code-only users
    role VARCHAR(30) NOT NULL DEFAULT 'staff', -- admin | manager | staff | auditor
    status VARCHAR(20) NOT NULL DEFAULT 'active', -- active | disabled
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (store_id, email)
);

-- ------------------------------------------------------------
-- Invites (one-time codes for bulk/individual user onboarding)
-- ------------------------------------------------------------
CREATE TABLE invites (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    code VARCHAR(20) UNIQUE NOT NULL,
    name VARCHAR(120) NOT NULL,
    email VARCHAR(160),
    role VARCHAR(30) NOT NULL DEFAULT 'staff',
    status VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending | claimed | revoked
    claimed_by_user UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- Products
-- ------------------------------------------------------------
CREATE TABLE products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    name VARCHAR(200) NOT NULL,
    sku VARCHAR(80) NOT NULL,
    category VARCHAR(100),
    supplier VARCHAR(150),
    unit VARCHAR(30) NOT NULL DEFAULT 'unit',
    location VARCHAR(150), -- free-text: e.g. "Aisle 3, Shelf B, Ground Floor" — lets a store
                            -- split stock-taking across multiple people by physical section
                            -- instead of everyone working off the same undivided product list
    cost_price NUMERIC(12,2) NOT NULL DEFAULT 0,
    price_multiplier NUMERIC(6,3) NOT NULL DEFAULT 1.3,
    reorder_level INTEGER NOT NULL DEFAULT 5,
    backroom_qty INTEGER NOT NULL DEFAULT 0,
    shelf_qty INTEGER NOT NULL DEFAULT 0,
    sold_qty INTEGER NOT NULL DEFAULT 0,
    damaged_qty INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (store_id, sku)
);

-- Upgrading an existing deployment that already ran this file before the
-- `location` column existed? The CREATE TABLE above will fail with
-- "relation already exists" — instead just run this one line by hand:
--   ALTER TABLE products ADD COLUMN IF NOT EXISTS location VARCHAR(150);
CREATE INDEX IF NOT EXISTS idx_products_location ON products (store_id, location);

-- Selling price is derived: cost_price * price_multiplier (kept as a view helper in queries)

-- ------------------------------------------------------------
-- Stock Arrivals (deliveries into backroom)
-- ------------------------------------------------------------
CREATE TABLE stock_arrivals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    quantity INTEGER NOT NULL,
    invoice_number VARCHAR(100),
    expiry_date DATE,
    received_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- Stock Movements (transfers, sales, damage, adjustments)
-- ------------------------------------------------------------
CREATE TABLE stock_movements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    type VARCHAR(30) NOT NULL,
        -- 'transfer_to_shelf' | 'sale' | 'damage' | 'expiry' | 'adjustment' | 'arrival'
    quantity INTEGER NOT NULL,             -- signed: positive or negative depending on type
    note TEXT,
    performed_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- Shelf Audits
-- ------------------------------------------------------------
CREATE TABLE shelf_audits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    counted_qty INTEGER NOT NULL,
    expected_qty INTEGER NOT NULL,
    discrepancy INTEGER NOT NULL,
    confidence_source VARCHAR(30) NOT NULL DEFAULT 'manual_count',
    auto_adjusted BOOLEAN NOT NULL DEFAULT false,
    performed_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- Receipts (OCR-based one-time-apply stock entries)
-- ------------------------------------------------------------
CREATE TABLE receipts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    image_url TEXT,
    raw_ocr_text TEXT,
    parsed_items JSONB NOT NULL DEFAULT '[]',
    status VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending | applied | rejected
    applied_at TIMESTAMPTZ,
    uploaded_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- Gallery Images (from camera capture)
-- ------------------------------------------------------------
CREATE TABLE images (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    label VARCHAR(150),
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- Indexes for common lookups
-- ------------------------------------------------------------
CREATE INDEX idx_products_store ON products(store_id);
CREATE INDEX idx_movements_store_product ON stock_movements(store_id, product_id);
CREATE INDEX idx_users_store ON users(store_id);
CREATE INDEX idx_invites_store ON invites(store_id);
CREATE INDEX idx_receipts_store ON receipts(store_id);
CREATE INDEX idx_audits_store ON shelf_audits(store_id);
