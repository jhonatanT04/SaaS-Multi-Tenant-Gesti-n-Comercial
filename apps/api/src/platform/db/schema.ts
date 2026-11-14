import type { ColumnType, Generated } from 'kysely';
import type { BillingTables } from '../../billing/billing.tables.js';

export type Role = 'owner' | 'admin' | 'cashier';

/** timestamptz: se lee como Date, se escribe como Date o ISO string. */
export type Timestamp = ColumnType<Date, Date | string, Date | string>;
/** Columna con DEFAULT now(): opcional al insertar. */
export type CreatedAt = ColumnType<Date, Date | string | undefined, never>;
/** numeric: `pg` lo devuelve como string para no perder precisión. */
export type Numeric = ColumnType<string, string | number, string | number>;

export interface TenantsTable {
  id: Generated<string>;
  name: string;
  slug: string;
  /** ISO 4217 en mayúsculas, p. ej. 'USD'. */
  currency: Generated<string>;
  /** Fracción en numeric(5,4): '0.1500' = 15 %. */
  tax_rate: ColumnType<string, string | number | undefined, string | number>;
  created_at: CreatedAt;
}

/** `password_hash` existe en la tabla pero app_user no tiene SELECT sobre ella. */
export interface UsersTable {
  id: Generated<string>;
  email: string;
  name: string;
  created_at: CreatedAt;
}

export interface MembershipsTable {
  tenant_id: string;
  user_id: string;
  role: Role;
  created_at: CreatedAt;
}

export interface RefreshTokensTable {
  id: string;
  tenant_id: string;
  user_id: string;
  family_id: string;
  expires_at: Timestamp;
  revoked_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  created_at: CreatedAt;
}

export interface InvitationsTable {
  id: Generated<string>;
  tenant_id: string;
  email: string;
  role: Role;
  token_hash: string;
  invited_by: string | null;
  expires_at: Timestamp;
  accepted_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  created_at: CreatedAt;
}

export type PlanCode = 'free' | 'pro';

/** Catálogo global (sin tenant). Un límite en null significa "sin límite". */
export interface PlansTable {
  code: PlanCode;
  name: string;
  max_invoices_per_month: number | null;
  max_users: number | null;
  ai_assistant: boolean;
  created_at: CreatedAt;
}

/** Solo lectura para app_user: el plan se cambia con `platform_set_tenant_plan`. */
export interface SubscriptionsTable {
  tenant_id: string;
  plan_code: PlanCode;
  created_at: CreatedAt;
  updated_at: ColumnType<Date, never, never>;
}

export interface UsageCountersTable {
  tenant_id: string;
  /** Primer día del mes (UTC), 'YYYY-MM-01'. */
  period: ColumnType<Date, string, never>;
  invoices_issued: number;
}

export interface PlanChangesTable {
  id: Generated<string>;
  tenant_id: string;
  from_plan: PlanCode;
  to_plan: PlanCode;
  changed_by: string | null;
  created_at: CreatedAt;
}

export interface PlatformTables {
  tenants: TenantsTable;
  users: UsersTable;
  memberships: MembershipsTable;
  refresh_tokens: RefreshTokensTable;
  invitations: InvitationsTable;
  plans: PlansTable;
  subscriptions: SubscriptionsTable;
  usage_counters: UsageCountersTable;
  plan_changes: PlanChangesTable;
}

export interface DB extends PlatformTables, BillingTables {}
