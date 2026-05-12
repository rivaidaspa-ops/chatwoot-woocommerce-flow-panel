-- Reparacion conservadora product_index Rivaida v8.6.10
-- Ejecutar solo si necesita reparar manualmente la tabla.
ALTER TABLE product_index ADD COLUMN IF NOT EXISTS store_id TEXT NOT NULL DEFAULT 'cl';
ALTER TABLE product_index ADD COLUMN IF NOT EXISTS variation_count INTEGER DEFAULT 0;
ALTER TABLE product_index ADD COLUMN IF NOT EXISTS search_text TEXT;
ALTER TABLE product_index ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE product_index DROP CONSTRAINT IF EXISTS product_index_pkey;
ALTER TABLE product_index ADD PRIMARY KEY (store_id, id);
CREATE INDEX IF NOT EXISTS idx_product_index_store ON product_index (store_id);
CREATE INDEX IF NOT EXISTS idx_product_index_search_text ON product_index (store_id, search_text);
