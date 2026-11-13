-- Facturación: catálogo (categorías, productos/servicios) y clientes.
-- tenant_id toma por defecto el tenant de la transacción (app.tenant_id), así el
-- código de negocio nunca lo escribe a mano; la política WITH CHECK lo valida igual.
-- UNIQUE (tenant_id, id) permite FKs compuestas: una fila no puede referenciar
-- datos de otro tenant aunque conozca su uuid (las comprobaciones de FK no pasan por RLS).

CREATE TABLE categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants(id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX categories_tenant_name_key ON categories (tenant_id, lower(name));

ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON categories
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

-- Un "producto" es cualquier cosa vendible: un plato (product) o un arreglo de costura (service).
CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants(id),
  category_id uuid,
  kind text NOT NULL DEFAULT 'product' CHECK (kind IN ('product', 'service')),
  code text CHECK (code IS NULL OR length(btrim(code)) BETWEEN 1 AND 60),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  description text,
  price numeric(12,2) NOT NULL CHECK (price >= 0), -- precio unitario SIN impuesto
  taxable boolean NOT NULL DEFAULT true,           -- grava IVA
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, category_id) REFERENCES categories (tenant_id, id)
    ON DELETE SET NULL (category_id)
);
CREATE UNIQUE INDEX products_tenant_code_key ON products (tenant_id, code) WHERE code IS NOT NULL;
CREATE INDEX products_tenant_name_idx ON products (tenant_id, lower(name));
CREATE INDEX products_tenant_category_idx ON products (tenant_id, category_id);

ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE products FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON products
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants(id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  identification_type text CHECK (identification_type IN ('cedula', 'ruc', 'passport', 'other')),
  identification text CHECK (identification IS NULL OR length(btrim(identification)) BETWEEN 1 AND 30),
  email text,
  phone text,
  address text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK ((identification IS NULL) = (identification_type IS NULL))
);
CREATE UNIQUE INDEX customers_tenant_identification_key
  ON customers (tenant_id, identification) WHERE identification IS NOT NULL;
CREATE INDEX customers_tenant_name_idx ON customers (tenant_id, lower(name));

ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON customers
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());
