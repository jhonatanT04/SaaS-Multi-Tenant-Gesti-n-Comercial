-- Facturación: contador de secuencial, comprobantes, ítems y pagos.

-- Un contador por tenant y punto de emisión. Se incrementa con bloqueo de fila
-- dentro de la misma transacción que emite el comprobante: sin huecos ni duplicados.
CREATE TABLE invoice_counters (
  tenant_id uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants(id),
  establishment text NOT NULL CHECK (establishment ~ '^[0-9]{3}$'),
  emission_point text NOT NULL CHECK (emission_point ~ '^[0-9]{3}$'),
  last_number bigint NOT NULL DEFAULT 0 CHECK (last_number >= 0),
  PRIMARY KEY (tenant_id, establishment, emission_point)
);

ALTER TABLE invoice_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invoice_counters
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

CREATE TABLE invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants(id),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued', 'voided')),
  establishment text NOT NULL DEFAULT '001' CHECK (establishment ~ '^[0-9]{3}$'),
  emission_point text NOT NULL DEFAULT '001' CHECK (emission_point ~ '^[0-9]{3}$'),
  number bigint CHECK (number > 0),          -- secuencial; se asigna al emitir
  customer_id uuid,                          -- NULL = consumidor final
  customer_name text,                        -- copia de los datos del cliente al emitir
  customer_identification text,
  tax_rate numeric(6,4) NOT NULL DEFAULT 0 CHECK (tax_rate >= 0 AND tax_rate <= 1), -- fracción: 0.1500 = 15 %
  subtotal_taxable numeric(12,2) NOT NULL DEFAULT 0 CHECK (subtotal_taxable >= 0), -- base gravada, ya con descuentos
  subtotal_exempt numeric(12,2) NOT NULL DEFAULT 0 CHECK (subtotal_exempt >= 0),   -- base no gravada, ya con descuentos
  discount_total numeric(12,2) NOT NULL DEFAULT 0 CHECK (discount_total >= 0),
  tax_total numeric(12,2) NOT NULL DEFAULT 0 CHECK (tax_total >= 0),
  total numeric(12,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
  notes text,
  created_by uuid NOT NULL,
  issued_at timestamptz,
  issued_by uuid,
  voided_at timestamptz,
  voided_by uuid,
  void_reason text,
  -- Reservados para facturación electrónica del SRI (fuera de alcance por ahora).
  sri_access_key text,
  sri_status text,
  sri_authorization_number text,
  sri_authorized_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, establishment, emission_point, number),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  CHECK ((status = 'draft') = (number IS NULL)),
  CHECK ((status = 'draft') = (issued_at IS NULL)),
  CHECK ((status = 'voided') = (voided_at IS NOT NULL)),
  CHECK (total = subtotal_taxable + subtotal_exempt + tax_total)
);
CREATE INDEX invoices_tenant_status_issued_idx ON invoices (tenant_id, status, issued_at DESC);
CREATE INDEX invoices_tenant_created_idx ON invoices (tenant_id, created_at DESC);
CREATE INDEX invoices_tenant_customer_idx ON invoices (tenant_id, customer_id);

ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invoices
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

CREATE TABLE invoice_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants(id),
  invoice_id uuid NOT NULL,
  position integer NOT NULL CHECK (position >= 1),
  product_id uuid,                              -- NULL = ítem libre
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200), -- copia del nombre al vender
  unit_price numeric(12,2) NOT NULL CHECK (unit_price >= 0),       -- copia del precio al vender
  quantity numeric(12,3) NOT NULL CHECK (quantity > 0),
  discount_amount numeric(12,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  taxable boolean NOT NULL,
  line_subtotal numeric(12,2) NOT NULL CHECK (line_subtotal >= 0), -- cantidad × precio − descuento, sin impuesto
  UNIQUE (tenant_id, invoice_id, position),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id)
);
CREATE INDEX invoice_items_tenant_product_idx ON invoice_items (tenant_id, product_id);

ALTER TABLE invoice_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invoice_items
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants(id),
  invoice_id uuid NOT NULL,
  method text NOT NULL CHECK (method IN ('cash', 'transfer', 'card')),
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  reference text,
  paid_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices (tenant_id, id)
);
CREATE INDEX payments_tenant_invoice_idx ON payments (tenant_id, invoice_id);
CREATE INDEX payments_tenant_paid_at_idx ON payments (tenant_id, paid_at);

ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payments
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

-- Inmutabilidad en la base (defensa en profundidad; el servicio valida lo mismo).
-- ERRCODE propio 'BL001' para que la API lo traduzca a 409.
-- Excepción deliberada: una sesión abierta por el dueño de la tabla (migrator:
-- migraciones, baja de un tenant, limpieza de tests) no pasa por estos candados.
-- Se mira session_user y no current_user porque las acciones de FK en cascada
-- cambian current_user al dueño; la API siempre inicia sesión como app_user.
CREATE FUNCTION billing_is_owner_session(rel oid) RETURNS boolean
  LANGUAGE sql STABLE
  AS $$ SELECT relowner = session_user::regrole FROM pg_class WHERE oid = rel $$;

CREATE FUNCTION billing_guard_invoice() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  sri_keys constant text[] := ARRAY['sri_access_key', 'sri_status', 'sri_authorization_number', 'sri_authorized_at', 'updated_at'];
  void_keys constant text[] := ARRAY['status', 'voided_at', 'voided_by', 'void_reason'];
BEGIN
  IF billing_is_owner_session(TG_RELID) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'un comprobante % no se puede eliminar', OLD.status USING ERRCODE = 'BL001';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'draft' THEN
    IF NEW.status = 'voided' THEN
      RAISE EXCEPTION 'un borrador no se anula, se elimina' USING ERRCODE = 'BL001';
    END IF;
  ELSIF OLD.status = 'issued' THEN
    IF NEW.status = 'draft' THEN
      RAISE EXCEPTION 'un comprobante emitido no vuelve a borrador' USING ERRCODE = 'BL001';
    END IF;
    IF to_jsonb(NEW) - sri_keys - void_keys IS DISTINCT FROM to_jsonb(OLD) - sri_keys - void_keys THEN
      RAISE EXCEPTION 'un comprobante emitido es inmutable salvo anulación' USING ERRCODE = 'BL001';
    END IF;
  ELSE -- voided
    IF to_jsonb(NEW) - sri_keys IS DISTINCT FROM to_jsonb(OLD) - sri_keys THEN
      RAISE EXCEPTION 'un comprobante anulado es inmutable' USING ERRCODE = 'BL001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER invoices_guard BEFORE UPDATE OR DELETE ON invoices
  FOR EACH ROW EXECUTE FUNCTION billing_guard_invoice();

-- Los ítems solo cambian mientras el comprobante está en borrador. FOR SHARE espera
-- a una emisión concurrente del mismo comprobante y ve su estado final.
-- (En un DELETE en cascada el comprobante ya no existe: se permite.)
CREATE FUNCTION billing_guard_invoice_item() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_id uuid;
  parent_status text;
BEGIN
  IF billing_is_owner_session(TG_RELID) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.invoice_id IS DISTINCT FROM OLD.invoice_id THEN
    RAISE EXCEPTION 'un ítem no se mueve entre comprobantes' USING ERRCODE = 'BL001';
  END IF;
  IF TG_OP = 'DELETE' THEN parent_id := OLD.invoice_id; ELSE parent_id := NEW.invoice_id; END IF;
  SELECT status INTO parent_status FROM invoices WHERE id = parent_id FOR SHARE;
  IF FOUND AND parent_status <> 'draft' THEN
    RAISE EXCEPTION 'los ítems de un comprobante % son inmutables', parent_status USING ERRCODE = 'BL001';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER invoice_items_guard BEFORE INSERT OR UPDATE OR DELETE ON invoice_items
  FOR EACH ROW EXECUTE FUNCTION billing_guard_invoice_item();
