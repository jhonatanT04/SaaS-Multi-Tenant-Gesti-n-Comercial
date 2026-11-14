/**
 * Aislamiento entre tenants contra el Postgres real.
 *
 * Demuestra que la separación la impone la base (RLS), no los WHERE de la
 * aplicación: ninguna consulta de este archivo filtra por `tenant_id` salvo
 * cuando intenta, a propósito, apuntar al tenant ajeno.
 *
 * `rls_probe` es una tabla de negocio de prueba creada aquí con la política
 * exacta de CONTRACT.md; el bloque "todas las tablas" extiende las mismas
 * garantías estructurales a las tablas reales (plataforma y facturación).
 */
import type { INestApplication } from '@nestjs/common';
import { sql } from 'kysely';
import type pg from 'pg';
import type { App } from 'supertest/types.js';
import { TenantDb } from '../../src/platform/db/tenant-db.service.js';
import { api, bearer, cleanup, connect, createApp, registerTenant, RUN, setPlan, type Session } from './helpers.js';

const RLS_VIOLATION = '42501';
const PROBE = `rls_probe_${RUN}`;

interface ProbeRow {
  id: number;
  tenant_id: string;
  label: string;
}

describe('Aislamiento multi-tenant (RLS)', () => {
  let app: INestApplication<App>;
  let tenantDb: TenantDb;
  let admin: pg.Client;
  let a: Session;
  let b: Session;
  let A: string;
  let B: string;

  /** Estado real de la tabla, visto por el dueño (sin filtro de tenant). */
  const truth = async (): Promise<ProbeRow[]> =>
    (await admin.query<ProbeRow>(`SELECT id, tenant_id, label FROM ${PROBE} ORDER BY id`)).rows;
  const labelsOf = async (tenant: string) =>
    (await truth()).filter((r) => r.tenant_id === tenant).map((r) => r.label).sort();
  const probe = sql.table(PROBE);

  beforeAll(async () => {
    app = await createApp();
    tenantDb = app.get(TenantDb);
    admin = await connect('migrator');
    await admin.query(`
      CREATE TABLE ${PROBE} (
        id        integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        label     text NOT NULL
      );
      ALTER TABLE ${PROBE} ENABLE ROW LEVEL SECURITY;
      ALTER TABLE ${PROBE} FORCE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON ${PROBE}
        USING (tenant_id = app_tenant_id())
        WITH CHECK (tenant_id = app_tenant_id());
      -- Solo para que este test pueda verificar el estado real desde fuera.
      CREATE POLICY test_owner_sees_all ON ${PROBE} TO migrator USING (true) WITH CHECK (true);
    `);
    a = await registerTenant(app, 'iso-a');
    b = await registerTenant(app, 'iso-b');
    A = a.user.tenantId;
    B = b.user.tenantId;
    await setPlan(B, 'pro'); // el test de invitaciones necesita más de 1 usuario
  });

  beforeEach(async () => {
    await admin.query(`TRUNCATE ${PROBE} RESTART IDENTITY`);
    await admin.query(
      `INSERT INTO ${PROBE} (tenant_id, label) VALUES ($1,'a1'),($1,'a2'),($2,'b1'),($2,'b2'),($2,'b3')`,
      [A, B],
    );
  });

  afterAll(async () => {
    await admin.query(`DROP TABLE IF EXISTS ${PROBE}`);
    await admin.end();
    await app.close();
    await cleanup();
  });

  describe('tabla de negocio: A no puede tocar las filas de B', () => {
    it('LEER: un SELECT sin WHERE devuelve solo las filas del tenant', async () => {
      const seenByA = await tenantDb.runAs(A, (trx) => sql<ProbeRow>`select * from ${probe}`.execute(trx));
      expect(seenByA.rows.map((r) => r.label).sort()).toEqual(['a1', 'a2']);
      expect(seenByA.rows.every((r) => r.tenant_id === A)).toBe(true);

      const seenByB = await tenantDb.runAs(B, (trx) => sql<ProbeRow>`select * from ${probe}`.execute(trx));
      expect(seenByB.rows.map((r) => r.label).sort()).toEqual(['b1', 'b2', 'b3']);
    });

    it('LEER: ni pidiendo explícitamente el tenant ajeno, ni por id, ni con agregados', async () => {
      const bRowId = (await truth()).find((r) => r.tenant_id === B)!.id;
      await tenantDb.runAs(A, async (trx) => {
        const byTenant = await sql`select * from ${probe} where tenant_id = ${B}`.execute(trx);
        const byId = await sql`select * from ${probe} where id = ${bRowId}`.execute(trx);
        const count = await sql<{ n: string }>`select count(*) as n from ${probe}`.execute(trx);
        const tautology = await sql`select * from ${probe} where true or tenant_id = ${B}`.execute(trx);
        expect(byTenant.rows).toHaveLength(0);
        expect(byId.rows).toHaveLength(0);
        expect(count.rows[0].n).toBe('2');
        expect(tautology.rows).toHaveLength(2);
      });
    });

    it('INSERTAR: una fila con el tenant_id de B se rechaza', async () => {
      await expect(
        tenantDb.runAs(A, (trx) => sql`insert into ${probe} (tenant_id, label) values (${B}, 'intruso')`.execute(trx)),
      ).rejects.toMatchObject({ code: RLS_VIOLATION });
      expect(await labelsOf(B)).toEqual(['b1', 'b2', 'b3']);

      await tenantDb.runAs(A, (trx) => sql`insert into ${probe} (tenant_id, label) values (${A}, 'a3')`.execute(trx));
      expect(await labelsOf(A)).toEqual(['a1', 'a2', 'a3']);
    });

    it('ACTUALIZAR: un UPDATE sin WHERE solo afecta al tenant; por id ajeno afecta 0 filas', async () => {
      const bRowId = (await truth()).find((r) => r.tenant_id === B)!.id;
      const { all, targeted } = await tenantDb.runAs(A, async (trx) => ({
        all: await sql`update ${probe} set label = label || '!'`.execute(trx),
        targeted: await sql`update ${probe} set label = 'hackeado' where id = ${bRowId}`.execute(trx),
      }));
      expect(all.numAffectedRows).toBe(2n);
      expect(targeted.numAffectedRows).toBe(0n);
      expect(await labelsOf(A)).toEqual(['a1!', 'a2!']);
      expect(await labelsOf(B)).toEqual(['b1', 'b2', 'b3']);
    });

    it('ACTUALIZAR: no se puede "regalar" una fila propia al otro tenant', async () => {
      await expect(
        tenantDb.runAs(A, (trx) => sql`update ${probe} set tenant_id = ${B}`.execute(trx)),
      ).rejects.toMatchObject({ code: RLS_VIOLATION });
      expect(await labelsOf(A)).toEqual(['a1', 'a2']);
      expect(await labelsOf(B)).toEqual(['b1', 'b2', 'b3']);
    });

    it('BORRAR: un DELETE sin WHERE solo borra las filas del tenant', async () => {
      const bRowId = (await truth()).find((r) => r.tenant_id === B)!.id;
      const { targeted, all } = await tenantDb.runAs(A, async (trx) => ({
        targeted: await sql`delete from ${probe} where id = ${bRowId}`.execute(trx),
        all: await sql`delete from ${probe}`.execute(trx),
      }));
      expect(targeted.numAffectedRows).toBe(0n);
      expect(all.numAffectedRows).toBe(2n);
      expect(await labelsOf(A)).toEqual([]);
      expect(await labelsOf(B)).toEqual(['b1', 'b2', 'b3']);
    });

    it('transacciones concurrentes de A y B no se mezclan', async () => {
      const results = await Promise.all(
        Array.from({ length: 40 }, (_, i) => {
          const tenant = i % 2 === 0 ? A : B;
          return tenantDb.runAs(tenant, async (trx) => {
            const { rows } = await sql<ProbeRow>`select * from ${probe}, pg_sleep(0.005)`.execute(trx);
            return rows.every((r) => r.tenant_id === tenant) && rows.length === (tenant === A ? 2 : 3);
          });
        }),
      );
      expect(results.every(Boolean)).toBe(true);
    });
  });

  describe('sin app.tenant_id fijado no se ve nada', () => {
    let raw: pg.Client;

    beforeEach(async () => {
      raw = await connect('app_user');
    });
    afterEach(() => raw.end());

    it('conexión nueva (variable nunca fijada): 0 filas y escritura rechazada', async () => {
      const setting = await raw.query(`select current_setting('app.tenant_id', true) as v, current_user as u`);
      expect(setting.rows[0]).toEqual({ v: null, u: 'app_user' });

      expect((await raw.query(`SELECT * FROM ${PROBE}`)).rows).toHaveLength(0);
      expect((await raw.query(`UPDATE ${PROBE} SET label = 'x'`)).rowCount).toBe(0);
      expect((await raw.query(`DELETE FROM ${PROBE}`)).rowCount).toBe(0);
      await expect(
        raw.query(`INSERT INTO ${PROBE} (tenant_id, label) VALUES ($1, 'x')`, [A]),
      ).rejects.toMatchObject({ code: RLS_VIOLATION });
      expect(await truth()).toHaveLength(5);
    });

    it("conexión reutilizada del pool (la variable quedó en ''): 0 filas, sin error y sin fuga del tenant anterior", async () => {
      await raw.query('BEGIN');
      await raw.query(`SELECT set_config('app.tenant_id', $1, true)`, [B]);
      expect((await raw.query(`SELECT * FROM ${PROBE}`)).rows).toHaveLength(3);
      await raw.query('COMMIT');

      // Tras el COMMIT el valor local desaparece, pero la variable ya existe en la sesión como ''.
      const setting = await raw.query(`select current_setting('app.tenant_id', true) as v`);
      expect(setting.rows[0].v).toBe('');

      expect((await raw.query(`SELECT * FROM ${PROBE}`)).rows).toHaveLength(0);
      expect((await raw.query(`UPDATE ${PROBE} SET label = 'x'`)).rowCount).toBe(0);
      expect((await raw.query(`DELETE FROM ${PROBE}`)).rowCount).toBe(0);
      await expect(
        raw.query(`INSERT INTO ${PROBE} (tenant_id, label) VALUES ($1, 'x')`, [B]),
      ).rejects.toMatchObject({ code: RLS_VIOLATION });
      expect(await truth()).toHaveLength(5);
    });

    it('lo mismo tras un ROLLBACK', async () => {
      await raw.query('BEGIN');
      await raw.query(`SELECT set_config('app.tenant_id', $1, true)`, [B]);
      await raw.query('ROLLBACK');
      expect((await raw.query(`SELECT * FROM ${PROBE}`)).rows).toHaveLength(0);
    });

    it('las tablas de plataforma tampoco muestran nada sin tenant', async () => {
      for (const table of ['tenants', 'memberships', 'refresh_tokens', 'invitations']) {
        expect((await raw.query(`SELECT * FROM ${table}`)).rows, table).toHaveLength(0);
      }
      expect((await raw.query('SELECT id, email FROM users')).rows).toHaveLength(0);
    });

    it('un valor que no es UUID falla cerrado (error, nunca filas)', async () => {
      await raw.query('BEGIN');
      await raw.query(`SELECT set_config('app.tenant_id', 'no-es-uuid', true)`);
      await expect(raw.query(`SELECT * FROM ${PROBE}`)).rejects.toMatchObject({ code: '22P02' });
      await raw.query('ROLLBACK');
    });
  });

  describe('tablas de plataforma', () => {
    it('A solo ve su tenant, sus miembros, sus tokens y sus invitaciones', async () => {
      await api(app).post('/api/v1/users/invitations').set(bearer(b)).send({ email: `${RUN}-iso-inv@example.test` }).expect(201);
      await tenantDb.runAs(A, async (trx) => {
        const tenants = await trx.selectFrom('tenants').select('id').execute();
        const members = await trx.selectFrom('memberships').select(['tenant_id', 'user_id']).execute();
        const users = await trx.selectFrom('users').select(['id', 'email']).execute();
        const tokens = await trx.selectFrom('refresh_tokens').select('tenant_id').execute();
        const invitations = await trx.selectFrom('invitations').select('id').execute();
        expect(tenants).toEqual([{ id: A }]);
        expect(members).toEqual([{ tenant_id: A, user_id: a.user.userId }]);
        expect(users).toEqual([{ id: a.user.userId, email: a.email }]);
        expect(tokens.length).toBeGreaterThan(0);
        expect(tokens.every((t) => t.tenant_id === A)).toBe(true);
        expect(invitations).toHaveLength(0);
      });
    });

    it('A no puede auto-añadirse a B, ni cambiar roles o borrar miembros de B', async () => {
      await expect(
        tenantDb.runAs(A, (trx) =>
          trx.insertInto('memberships').values({ tenant_id: B, user_id: a.user.userId, role: 'owner' }).execute(),
        ),
      ).rejects.toMatchObject({ code: RLS_VIOLATION });
      const { updated, deleted } = await tenantDb.runAs(A, async (trx) => ({
        updated: await trx.updateTable('memberships').set({ role: 'cashier' }).where('user_id', '=', b.user.userId).executeTakeFirst(),
        deleted: await trx.deleteFrom('memberships').where('tenant_id', '=', B).executeTakeFirst(),
      }));
      expect(updated.numUpdatedRows).toBe(0n);
      expect(deleted.numDeletedRows).toBe(0n);
      const { rows } = await admin.query('SELECT role FROM memberships WHERE tenant_id = $1', [B]);
      expect(rows).toEqual([{ role: 'owner' }]);
    });

    it('app_user no puede leer password_hash ni escribir en users/tenants, ni con tenant fijado', async () => {
      const attempts = [
        sql`select password_hash from users`,
        sql`select * from users`,
        sql`update users set email = 'x@example.test'`,
        sql`delete from users`,
        sql`insert into users (email, password_hash, name) values ('x@example.test', 'h', 'x')`,
        sql`insert into tenants (name, slug) values ('x', 'xxx-xxx')`,
        sql`update tenants set name = 'hackeado'`,
        sql`delete from tenants`,
        sql`select * from schema_migrations`,
      ];
      for (const attempt of attempts) {
        await expect(tenantDb.runAs(A, (trx) => attempt.execute(trx))).rejects.toMatchObject({ code: RLS_VIOLATION });
      }
    });

    it('por HTTP: el token de A no alcanza a los usuarios de B', async () => {
      const list = await api(app).get('/api/v1/users').set(bearer(a)).expect(200);
      expect(list.body.total).toBe(1);
      expect(list.body.data.map((u: { id: string }) => u.id)).toEqual([a.user.userId]);

      await api(app).patch(`/api/v1/users/${b.user.userId}/role`).set(bearer(a)).send({ role: 'cashier' }).expect(404);
      await api(app).delete(`/api/v1/users/${b.user.userId}`).set(bearer(a)).expect(404);
      const bStill = await api(app).get('/api/v1/auth/me').set(bearer(b)).expect(200);
      expect(bStill.body.user.role).toBe('owner');
      // El refresh token de B no sirve para obtener sesión en A ni al revés.
      const refreshed = await api(app).post('/api/v1/auth/refresh').send({ refreshToken: b.refreshToken }).expect(200);
      expect(refreshed.body.user.tenantId).toBe(B);
    });
  });

  describe('todas las tablas (plataforma y facturación)', () => {
    it('el rol de la API no es superusuario, no tiene BYPASSRLS y no es dueño de ninguna tabla', async () => {
      const role = await tenantDb.runAs(A, (trx) =>
        sql<{ rolsuper: boolean; rolbypassrls: boolean; owned: string }>`
          select r.rolsuper, r.rolbypassrls,
                 (select count(*) from pg_class c where c.relowner = r.oid and c.relkind in ('r','p','v','m')) as owned
          from pg_roles r where r.rolname = current_user`.execute(trx),
      );
      expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false, owned: '0' });
    });

    it('toda tabla con tenant_id tiene RLS ENABLE + FORCE y al menos una política', async () => {
      const { rows } = await admin.query<{ table: string; enabled: boolean; forced: boolean; policies: string }>(`
        SELECT c.relname AS table, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
               (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute att ON att.attrelid = c.oid AND att.attname = 'tenant_id' AND NOT att.attisdropped
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
        ORDER BY c.relname`);
      expect(rows.length).toBeGreaterThanOrEqual(4);
      const unprotected = rows.filter((r) => !r.enabled || !r.forced || Number(r.policies) === 0);
      expect(unprotected).toEqual([]);
    });

    it('ninguna política de aislamiento usa current_setting(...)::uuid directo (lanza con \'\')', async () => {
      const { rows } = await admin.query<{ tablename: string; policyname: string }>(`
        SELECT tablename, policyname FROM pg_policies
        WHERE schemaname = 'public'
          AND (coalesce(qual, '') ~ 'current_setting' OR coalesce(with_check, '') ~ 'current_setting')`);
      expect(rows).toEqual([]);
    });

    it('un tenant recién creado no ve ninguna fila en ninguna tabla con tenant_id', async () => {
      const fresh = await registerTenant(app, 'iso-vacio');
      // Se excluyen las tablas `rls_probe_*` de otras corridas simultáneas (pueden borrarse a mitad del test).
      const tables = await admin.query<{ relname: string }>(
        `SELECT c.relname FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute att ON att.attrelid = c.oid AND att.attname = 'tenant_id' AND NOT att.attisdropped
         WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
           AND (c.relname NOT LIKE 'rls_probe\\_%' OR c.relname = $1)`,
        [PROBE],
      );
      await tenantDb.runAs(fresh.user.tenantId, async (trx) => {
        for (const { relname } of tables.rows) {
          const { rows } = await sql<{ foreign: string }>`
            select count(*) as foreign from ${sql.table(relname)} where tenant_id <> ${fresh.user.tenantId}`.execute(trx);
          expect(rows[0].foreign, relname).toBe('0');
        }
      });
    });
  });
});
