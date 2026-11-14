import type { ColumnType, Generated } from 'kysely';
import type { CreatedAt, Numeric } from '../platform/db/schema.js';

/**
 * Tipos Kysely de las tablas de facturación (migraciones 0100–0199).
 *
 * `tenant_id` tiene DEFAULT current_setting('app.tenant_id'): no se escribe nunca a
 * mano, lo fija la transacción de `TenantDb`. El dinero (`numeric`) viaja como string.
 */
type TenantId = ColumnType<string, never, never>;
type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;
/**
 * Columnas con DEFAULT. `Generated<T>` de Kysely no se puede anidar sobre un
 * `ColumnType`, así que las variantes opcionales al insertar se declaran aparte.
 */
type NumericWithDefault = ColumnType<
  string,
  string | number | undefined,
  string | number
>;
type TimestampWithDefault = ColumnType<
  Date,
  Date | string | undefined,
  Date | string
>;
/** bigint: `pg` lo devuelve como string. */
type Int8WithDefault = ColumnType<
  string,
  string | number | undefined,
  string | number
>;

export type ProductKind = 'product' | 'service';
export type IdentificationType = 'cedula' | 'ruc' | 'passport' | 'other';
export type InvoiceStatus = 'draft' | 'issued' | 'voided';
export type PaymentMethod = 'cash' | 'transfer' | 'card';

export interface CategoriesTable {
  id: Generated<string>;
  tenant_id: TenantId;
  name: string;
  created_at: CreatedAt;
}

export interface ProductsTable {
  id: Generated<string>;
  tenant_id: TenantId;
  category_id: string | null;
  kind: Generated<ProductKind>;
  code: string | null;
  name: string;
  description: string | null;
  /** Precio unitario sin impuesto. */
  price: Numeric;
  taxable: Generated<boolean>;
  active: Generated<boolean>;
  created_at: CreatedAt;
  updated_at: TimestampWithDefault;
}

export interface CustomersTable {
  id: Generated<string>;
  tenant_id: TenantId;
  name: string;
  identification_type: IdentificationType | null;
  identification: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  created_at: CreatedAt;
  updated_at: TimestampWithDefault;
}

export interface InvoiceCountersTable {
  tenant_id: TenantId;
  establishment: string;
  emission_point: string;
  last_number: Int8WithDefault;
}

export interface InvoicesTable {
  id: Generated<string>;
  tenant_id: TenantId;
  status: Generated<InvoiceStatus>;
  establishment: Generated<string>;
  emission_point: Generated<string>;
  number: ColumnType<
    string | null,
    string | number | null | undefined,
    string | number | null
  >;
  customer_id: string | null;
  customer_name: string | null;
  customer_identification: string | null;
  tax_rate: NumericWithDefault;
  subtotal_taxable: NumericWithDefault;
  subtotal_exempt: NumericWithDefault;
  discount_total: NumericWithDefault;
  tax_total: NumericWithDefault;
  total: NumericWithDefault;
  notes: string | null;
  created_by: string;
  issued_at: NullableTimestamp;
  issued_by: string | null;
  voided_at: NullableTimestamp;
  voided_by: string | null;
  void_reason: string | null;
  sri_access_key: string | null;
  sri_status: string | null;
  sri_authorization_number: string | null;
  sri_authorized_at: NullableTimestamp;
  created_at: CreatedAt;
  updated_at: TimestampWithDefault;
}

export interface InvoiceItemsTable {
  id: Generated<string>;
  tenant_id: TenantId;
  invoice_id: string;
  position: number;
  product_id: string | null;
  name: string;
  unit_price: Numeric;
  quantity: Numeric;
  discount_amount: NumericWithDefault;
  taxable: boolean;
  line_subtotal: Numeric;
}

export interface PaymentsTable {
  id: Generated<string>;
  tenant_id: TenantId;
  invoice_id: string;
  method: PaymentMethod;
  amount: Numeric;
  reference: string | null;
  paid_at: TimestampWithDefault;
  created_by: string;
  created_at: CreatedAt;
}

export interface BillingTables {
  categories: CategoriesTable;
  products: ProductsTable;
  customers: CustomersTable;
  invoice_counters: InvoiceCountersTable;
  invoices: InvoicesTable;
  invoice_items: InvoiceItemsTable;
  payments: PaymentsTable;
}
