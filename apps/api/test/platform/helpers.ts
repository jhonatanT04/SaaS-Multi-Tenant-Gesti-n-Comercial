import { randomBytes } from 'node:crypto';
import type { INestApplication, Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../../src/app.module.js';
import { ENV_FILE } from '../../src/platform/config/env.js';
import { setupApp } from '../../src/platform/setup-app.js';

try {
  process.loadEnvFile(ENV_FILE);
} catch {
  // Sin .env (CI): las variables llegan por el entorno.
}

/** Prefijo único por ejecución, para no chocar con datos de otras corridas. */
export const RUN = `e2e${randomBytes(4).toString('hex')}`;

export async function createApp(
  opts: { authRateLimit?: number; controllers?: Type<unknown>[] } = {},
): Promise<INestApplication<App>> {
  if (opts.authRateLimit) process.env.AUTH_RATE_LIMIT_MAX = String(opts.authRateLimit);
  else delete process.env.AUTH_RATE_LIMIT_MAX;
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: opts.controllers ?? [],
  }).compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>();
  setupApp(app);
  await app.init();
  return app;
}

export const api = (app: INestApplication<App>) => request(app.getHttpServer());

export interface Session {
  accessToken: string;
  refreshToken: string;
  user: { userId: string; tenantId: string; role: string };
  email: string;
  password: string;
  slug: string;
}

export async function registerTenant(app: INestApplication<App>, label: string): Promise<Session> {
  const email = `${RUN}-${label}@example.test`;
  const password = `pw-${label}-12345678`;
  const slug = `${RUN}-${label}`;
  const res = await api(app)
    .post('/api/v1/auth/register')
    .send({ tenantName: `Tenant ${label}`, tenantSlug: slug, name: `Owner ${label}`, email, password, taxRate: 0.15 })
    .expect(201);
  return { ...res.body, email, password, slug };
}

export const bearer = (s: { accessToken: string }) => ({ Authorization: `Bearer ${s.accessToken}` });

/** Conexión directa a Postgres con el rol indicado (fuera del pool de la API). */
export async function connect(role: 'app_user' | 'migrator'): Promise<pg.Client> {
  const url = role === 'app_user' ? process.env.DATABASE_URL : process.env.MIGRATE_DATABASE_URL;
  if (!url) throw new Error(`Falta la URL de conexión para ${role}`);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}

/** Cambia el plan de un tenant como `migrator` (equivale a la operación manual de soporte). */
export async function setPlan(tenantId: string, plan: string): Promise<void> {
  const admin = await connect('migrator');
  try {
    await admin.query('UPDATE subscriptions SET plan_code = $2 WHERE tenant_id = $1', [tenantId, plan]);
  } finally {
    await admin.end();
  }
}

const CLEANUP_LOCK = 7_300_001;

/**
 * Borra los tenants y usuarios creados por esta ejecución (los de su prefijo `RUN`).
 *
 * Determinista aunque otras suites o sesiones limpien a la vez sobre la misma
 * base: (1) un advisory lock serializa todas las limpiezas, que antes se
 * cruzaban en los borrados en cascada y daban "deadlock detected"; (2) cada
 * tenant se borra por id y en orden, en su propia transacción; (3) un
 * deadlock con una transacción ajena (40P01) se reintenta.
 */
export async function cleanup(): Promise<void> {
  const admin = await connect('migrator');
  try {
    await admin.query('SELECT pg_advisory_lock($1)', [CLEANUP_LOCK]);
    for (let attempt = 1; ; attempt++) {
      try {
        await admin.query('BEGIN');
        const { rows } = await admin.query<{ id: string }>(
          'SELECT id FROM tenants WHERE slug LIKE $1 ORDER BY id',
          [`${RUN}-%`],
        );
        for (const { id } of rows) await admin.query('DELETE FROM tenants WHERE id = $1', [id]);
        await admin.query('DELETE FROM users WHERE email LIKE $1', [`${RUN}-%`]);
        await admin.query('COMMIT');
        return;
      } catch (err) {
        await admin.query('ROLLBACK');
        if ((err as { code?: string }).code !== '40P01' || attempt >= 5) throw err;
        await new Promise((r) => setTimeout(r, 50 * attempt));
      }
    }
  } finally {
    await admin.query('SELECT pg_advisory_unlock($1)', [CLEANUP_LOCK]).catch(() => undefined);
    await admin.end();
  }
}
