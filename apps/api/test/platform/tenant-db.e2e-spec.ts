import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { sql } from 'kysely';
import { ENV_FILE, envSchema } from '../../src/platform/config/env.js';
import { DatabaseModule } from '../../src/platform/db/database.module.js';
import { tenantContext } from '../../src/platform/db/tenant-context.js';
import { TenantDb } from '../../src/platform/db/tenant-db.service.js';

describe('TenantDb', () => {
  let tenantDb: TenantDb;
  let close: () => Promise<void>;
  const tenant = '11111111-1111-4111-8111-111111111111';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, envFilePath: ENV_FILE, validationSchema: envSchema }),
        DatabaseModule,
      ],
    }).compile();
    await moduleRef.init();
    tenantDb = moduleRef.get(TenantDb);
    close = () => moduleRef.close();
  });

  afterAll(() => close());

  const currentTenant = (db: TenantDb, run: 'run' | 'runAs') => {
    const fn = async (trx: Parameters<Parameters<TenantDb['run']>[0]>[0]) => {
      const { rows } = await sql<{ t: string; u: string }>`
        select current_setting('app.tenant_id', true) as t, current_user as u`.execute(trx);
      return rows[0];
    };
    return run === 'run' ? db.run(fn) : db.runAs(tenant, fn);
  };

  it('runAs fija app.tenant_id y se conecta como app_user', async () => {
    await expect(currentTenant(tenantDb, 'runAs')).resolves.toEqual({ t: tenant, u: 'app_user' });
  });

  it('run toma el tenant del contexto del request', async () => {
    const row = await tenantContext.run({}, () => {
      tenantContext.setTenantId(tenant);
      return currentTenant(tenantDb, 'run');
    });
    expect(row.t).toBe(tenant);
  });

  it('run sin tenant en el contexto falla en vez de consultar sin aislamiento', async () => {
    await expect(currentTenant(tenantDb, 'run')).rejects.toThrow(/runAs/);
    await expect(tenantContext.run({}, () => currentTenant(tenantDb, 'run'))).rejects.toThrow(/runAs/);
  });

  it('runAs rechaza un tenantId que no es UUID', async () => {
    await expect(tenantDb.runAs("x'; drop table tenants; --", async () => 1)).rejects.toThrow(/UUID/);
  });

  it('el tenant no se filtra a la siguiente transacción de la misma conexión', async () => {
    await tenantDb.runAs(tenant, async () => undefined);
    const other = '22222222-2222-4222-8222-222222222222';
    const seen = await tenantDb.runAs(other, async (trx) => {
      const { rows } = await sql<{ t: string }>`select current_setting('app.tenant_id', true) as t`.execute(trx);
      return rows[0].t;
    });
    expect(seen).toBe(other);
  });

  it('revierte la transacción si el callback lanza', async () => {
    await expect(
      tenantDb.runAs(tenant, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });
});
