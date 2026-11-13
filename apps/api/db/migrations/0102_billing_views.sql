-- Vistas curadas para el asistente text-to-SQL (rol ai_readonly).
-- security_invoker = true: los permisos y el RLS de las tablas base se evalúan con el
-- rol que consulta, así que la vista solo devuelve filas del tenant fijado en app.tenant_id.
-- Por lo mismo ai_readonly necesita SELECT sobre las tablas base: se le da solo a nivel
-- de columna y solo sobre las columnas que las vistas usan (nada de contacto de
-- clientes, notas, usuarios ni campos del SRI).

CREATE VIEW v_ventas WITH (security_invoker = true) AS
SELECT
  i.id AS comprobante_id,
  i.establishment || '-' || i.emission_point || '-' || lpad(i.number::text, 9, '0') AS numero,
  i.issued_at AS fecha_emision,
  coalesce(i.customer_name, 'Consumidor final') AS cliente,
  i.subtotal_taxable + i.subtotal_exempt AS subtotal,
  i.discount_total AS descuento,
  i.tax_total AS iva,
  i.total,
  coalesce(p.pagado, 0)::numeric(12,2) AS pagado,
  (i.total - coalesce(p.pagado, 0))::numeric(12,2) AS saldo,
  CASE
    WHEN coalesce(p.pagado, 0) >= i.total THEN 'pagado'
    WHEN coalesce(p.pagado, 0) > 0 THEN 'parcial'
    ELSE 'pendiente'
  END AS estado_pago
FROM invoices i
LEFT JOIN LATERAL (
  SELECT sum(pay.amount) AS pagado FROM payments pay WHERE pay.invoice_id = i.id
) p ON true
WHERE i.status = 'issued';

COMMENT ON VIEW v_ventas IS 'Una fila por comprobante emitido (no incluye borradores ni anulados). Montos en la moneda del negocio; subtotal es sin IVA y ya con descuentos.';

CREATE VIEW v_productos_vendidos WITH (security_invoker = true) AS
SELECT
  i.id AS comprobante_id,
  i.issued_at AS fecha_emision,
  it.product_id AS producto_id,
  it.name AS producto,
  c.name AS categoria,
  it.quantity AS cantidad,
  it.unit_price AS precio_unitario,
  it.discount_amount AS descuento,
  it.line_subtotal AS subtotal,
  it.taxable AS grava_iva
FROM invoice_items it
JOIN invoices i ON i.id = it.invoice_id
LEFT JOIN products pr ON pr.id = it.product_id
LEFT JOIN categories c ON c.id = pr.category_id
WHERE i.status = 'issued';

COMMENT ON VIEW v_productos_vendidos IS 'Una fila por ítem de comprobante emitido. producto y precio_unitario son los del momento de la venta; subtotal = cantidad × precio_unitario − descuento, sin IVA.';

GRANT SELECT ON v_ventas, v_productos_vendidos TO ai_readonly;
GRANT SELECT (id, status, establishment, emission_point, number, issued_at, customer_name,
              subtotal_taxable, subtotal_exempt, discount_total, tax_total, total)
  ON invoices TO ai_readonly;
GRANT SELECT (invoice_id, amount) ON payments TO ai_readonly;
GRANT SELECT (invoice_id, product_id, name, quantity, unit_price, discount_amount, line_subtotal, taxable)
  ON invoice_items TO ai_readonly;
GRANT SELECT (id, category_id) ON products TO ai_readonly;
GRANT SELECT (id, name) ON categories TO ai_readonly;
