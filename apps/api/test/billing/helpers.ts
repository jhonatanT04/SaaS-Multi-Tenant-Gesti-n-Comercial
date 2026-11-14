import { randomBytes } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import { CatalogService } from '../../src/billing/catalog/catalog.service.js';
import { CustomersService } from '../../src/billing/customers/customers.service.js';
import { InvoicesService } from '../../src/billing/invoices/invoices.service.js';
import { PaymentsService } from '../../src/billing/payments/payments.service.js';
import { ReportsService } from '../../src/billing/reports/reports.service.js';
import { ENV_FILE, envSchema } from '../../src/platform/config/env.js';
import { DatabaseModule } from '../../src/platform/db/database.module.js';
import { TenantDb } from '../../src/platform/db/tenant-db.service.js';
import { PlanService } from '../../src/platform/plans/plan.service.js';

try {
  process.loadEnvFile(ENV_FILE);
} catch {
  // Sin .env (CI): las variables llegan por el entorno.
}

/** Prefijo único por ejecución para slugs y correos de prueba. */
export const RUN = `bil${randomBytes(4).toString('hex')}`;

const URLS = {
  app_user: 'DATABASE_URL',
  migrator: 'MIGRATE_DATABASE_URL',
  ai_readonly: 'AI_DATABASE_URL',
} as const;

/** Conexión directa a Postgres con el rol indicado. */
export async function connect(role: keyof typeof URLS): Promise<pg.Client> {
  const url = process.env[URLS[role]];
  if (!url) throw new Error(`Falta ${URLS[role]}`);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}

/** Servicios de facturación sobre el `TenantDb` real (Postgres, rol app_user, RLS activo). */
export async function createBilling() {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        envFilePath: ENV_FILE,
        validationSchema: envSchema,
      }),
      DatabaseModule,
    ],
  }).compile();
  await moduleRef.init();
  const invoices = new InvoicesService(new PlanService());
  return {
    db: moduleRef.get(TenantDb),
    catalog: new CatalogService(),
    customers: new CustomersService(),
    invoices,
    payments: new PaymentsService(invoices),
    reports: new ReportsService(),
    close: () => moduleRef.close(),
  };
}
export type Billing = Awaited<ReturnType<typeof createBilling>>;

export interface TestTenant {
  tenantId: string;
  userId: string;
}

/** Crea un tenant con su usuario owner mediante la función de registro de la plataforma. */
export async function createTenant(
  label: string,
  taxRate = '0.15',
): Promise<TestTenant> {
  const client = await connect('app_user');
  try {
    const { rows } = await client.query<{ tenant_id: string; user_id: string }>(
      'select * from auth_register($1, $2, $3, $4, $5, $6, $7)',
      [
        `Tenant ${label}`,
        `${RUN}-${label}`,
        'USD',
        taxRate,
        `${RUN}-${label}@example.test`,
        'hash',
        label,
      ],
    );
    return { tenantId: rows[0].tenant_id, userId: rows[0].user_id };
  } finally {
    await client.end();
  }
}

/**
 * Ejecuta `fn` como `migrator` con el tenant fijado. Las sesiones del dueño de las
 * tablas no pasan por los candados de inmutabilidad (sí por RLS), lo que permite
 * preparar datos imposibles desde la API, como un comprobante emitido el mes pasado.
 */
export async function asOwner<T>(
  tenantId: string,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = await connect('migrator');
  try {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id', $1, true)", [
      tenantId,
    ]);
    const result = await fn(client);
    await client.query('commit');
    return result;
  } finally {
    await client.end();
  }
}

/**
 * Borra los datos de facturación de los tenants cuyo slug empieza por `prefix` y,
 * salvo que se pida lo contrario, también los tenants y sus usuarios.
 */
export async function cleanupBilling(
  prefix = RUN,
  opts = { tenants: true },
): Promise<void> {
  const admin = await connect('migrator');
  try {
    const { rows } = await admin.query<{ id: string }>(
      'select id from tenants where slug like $1',
      [`${prefix}-%`],
    );
    for (const { id } of rows) {
      await admin.query('begin');
      await admin.query("select set_config('app.tenant_id', $1, true)", [id]);
      for (const table of [
        'payments',
        'invoices',
        'products',
        'categories',
        'customers',
        'invoice_counters',
      ]) {
        await admin.query(`delete from ${table}`);
      }
      await admin.query('commit');
    }
    if (opts.tenants) {
      await admin.query('delete from tenants where slug like $1', [
        `${prefix}-%`,
      ]);
      await admin.query('delete from users where email like $1', [
        `${prefix}-%`,
      ]);
    }
  } finally {
    await admin.end();
  }
}
