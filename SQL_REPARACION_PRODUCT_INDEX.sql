-- Reparacion segura del indice de productos Rivaida Commerce Hub v8.6.9
-- Ejecutar solo si EasyPanel/PostgreSQL sigue mostrando: columna "moneda" no existe o columna "currency" no existe.

ALTER TABLE product_index ADD COLUMN IF NOT EXISTS store_id TEXT NOT NULL DEFAULT 'cl';
ALTER TABLE product_index ADD COLUMN IF NOT EXISTS moneda TEXT;
ALTER TABLE product_index ADD COLUMN IF NOT EXISTS currency TEXT;

UPDATE product_index
SET moneda = COALESCE(moneda, payload->>'moneda', payload->>'currency', CASE WHEN store_id='co' THEN 'COP' ELSE 'CLP' END),
    currency = COALESCE(currency, payload->>'currency', payload->>'moneda', CASE WHEN store_id='co' THEN 'COP' ELSE 'CLP' END)
WHERE moneda IS NULL OR currency IS NULL;

CREATE INDEX IF NOT EXISTS idx_product_index_store ON product_index (store_id);
CREATE INDEX IF NOT EXISTS idx_product_index_search_text ON product_index (store_id, search_text);
