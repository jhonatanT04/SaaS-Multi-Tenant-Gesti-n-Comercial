/**
 * Planes free/pro: límites de comprobantes y usuarios, @RequiresPlan, cambio de
 * plan por super-admin y atomicidad bajo concurrencia, contra el Postgres real.
 */
import { Controller, Get, type INestApplication } from '@nestjs/common';
import { sql } from 'kysely';
import type { App } from 'supertest/types.js';
import { RequiresPlan } from '../../src/platform/plans/requires-plan.decorator.js';
import { PlanService } from '../../src/platform/plans/plan.service.js';
import { TenantDb } from '../../src/platform/db/tenant-db.service.js';
import { api, bearer, cleanup, connect, createApp, registerTenant, RUN, setPlan, type Session } from './helpers.js';
import { cleanupBilling } from '../billing/helpers.js';

@Controller('test-pro')
class ProOnlyProbe {
  @Get()
  @RequiresPlan('pro')
  proOnly() {
    return { ok: true };
  }

  @Get('either')
  @RequiresPlan('free', 'pro')
  either() {
    return { ok: true };
  }
}

describe('Planes y límites de uso', () => {
  let app: INestApplication<App>;
  let tenantDb: TenantDb;
  let plans: PlanService;

  beforeAll(async () => {
    app = await createApp({ controllers: [ProOnlyProbe] });
    tenantDb = app.get(TenantDb);
    plans = app.get(PlanService);
  });

  afterAll(async () => {
    await app.close();
    const admin = await connect('migrator');
    await admin.query(`DELETE FROM usage_counters WHERE tenant_id IN (SELECT id FROM tenants WHERE slug LIKE $1)`, [`${RUN}-%`]);
    await admin.end();
    await cleanupBilling(RUN, { tenants: false });
    await cleanup();
  });

  const issueOne = (s: Session) =>
    api(app)
      .post('/api/v1/invoices')
      .set(bearer(s))
      .send({ items: [{ name: 'Servicio', unitPrice: '1.00', quantity: 1 }], issue: true });

  describe('alta y catálogo', () => {
    it('todo tenant nuevo nace en free, con los límites de la semilla', async () => {
      const t = await registerTenant(app, 'plan-alta');
      const res = await api(app).get('/api/v1/plan').set(bearer(t)).expect(200);
      expect(res.body.plan).toEqual({
        code: 'free',
        name: 'Free',
        limits: { invoicesPerMonth: 50, users: 1, aiAssistant: false },
      });
      expect(res.body.usage).toEqual({
        period: new Date().toISOString().slice(0, 7),
        invoicesIssued: 0,
        users: 1,
        pendingInvitations: 0,
      });
      expect(res.body.availablePlans.map((p: { code: string }) => p.code)).toEqual(['free', 'pro']);
      expect(res.body.availablePlans[1].limits).toEqual({ invoicesPerMonth: null, users: null, aiAssistant: true });
      await api(app).get('/api/v1/plan').expect(401);
    });

    it('un tenant creado por cualquier vía (INSERT directo) también queda en free', async () => {
      const admin = await connect('migrator');
      try {
        const { rows } = await admin.query<{ id: string }>(
          `INSERT INTO tenants (name, slug) VALUES ('Directo', $1) RETURNING id`,
          [`${RUN}-directo`],
        );
        const sub = await admin.query('SELECT plan_code FROM subscriptions WHERE tenant_id = $1', [rows[0].id]);
        expect(sub.rows).toEqual([{ plan_code: 'free' }]);
      } finally {
        await admin.end();
      }
    });

    it('un tenant solo ve su propia suscripción y su uso', async () => {
      const a = await registerTenant(app, 'plan-iso-a');
      const b = await registerTenant(app, 'plan-iso-b');
      await setPlan(b.user.tenantId, 'pro');
      const seen = await tenantDb.runAs(a.user.tenantId, async (trx) => ({
        subs: await trx.selectFrom('subscriptions').selectAll().execute(),
        counters: await sql`select * from usage_counters`.execute(trx),
      }));
      expect(seen.subs.map((s) => [s.tenant_id, s.plan_code])).toEqual([[a.user.tenantId, 'free']]);
      expect(seen.counters.rows).toEqual([]);
    });

    it('app_user no puede cambiarse de plan ni tocar el catálogo, los admins ni el historial', async () => {
      const t = await registerTenant(app, 'plan-hack');
      const attempts = [
        sql`update subscriptions set plan_code = 'pro'`,
        sql`insert into subscriptions (tenant_id, plan_code) values (app_tenant_id(), 'pro') on conflict do nothing`,
        sql`delete from subscriptions`,
        sql`update plans set max_invoices_per_month = null`,
        sql`delete from plans`,
        sql`insert into platform_admins (user_id) values (${t.user.userId})`,
        sql`select * from platform_admins`,
        sql`delete from plan_changes`,
      ];
      for (const attempt of attempts) {
        await expect(tenantDb.runAs(t.user.tenantId, (trx) => attempt.execute(trx))).rejects.toMatchObject({
          code: '42501',
        });
      }
      const { plan } = (await api(app).get('/api/v1/plan').set(bearer(t)).expect(200)).body;
      expect(plan.code).toBe('free');
    });
  });

  describe('límite de comprobantes', () => {
    it('free: el comprobante 51 se bloquea con 402 PLAN_LIMIT_INVOICES y se desbloquea al pasar a pro', async () => {
      const t = await registerTenant(app, 'plan-inv');
      const numbers: string[] = [];
      for (let i = 1; i <= 50; i++) {
        const res = await issueOne(t);
        expect(res.status, `comprobante ${i}`).toBe(201);
        numbers.push(res.body.number);
      }
      expect(new Set(numbers).size).toBe(50);

      const blocked = await issueOne(t).expect(402);
      expect(blocked.body).toMatchObject({
        statusCode: 402,
        code: 'PLAN_LIMIT_INVOICES',
        plan: 'free',
        limit: 50,
        used: 50,
      });
      expect(blocked.body.message).toMatch(/Mejora tu plan/);

      // El bloqueo no consumió secuencial ni cupo: el uso sigue en 50 y no quedó un emitido de más.
      const usage = (await api(app).get('/api/v1/plan').set(bearer(t)).expect(200)).body.usage;
      expect(usage.invoicesIssued).toBe(50);
      const issued = await tenantDb.runAs(t.user.tenantId, (trx) =>
        trx.selectFrom('invoices').select((eb) => eb.fn.countAll<string>().as('n')).where('status', '=', 'issued').executeTakeFirstOrThrow(),
      );
      expect(issued.n).toBe('50');

      await setPlan(t.user.tenantId, 'pro');
      const unlocked = await issueOne(t).expect(201);
      expect(unlocked.body.number).not.toBe(numbers.at(-1));
      expect((await api(app).get('/api/v1/plan').set(bearer(t))).body.usage.invoicesIssued).toBe(51);
    }, 30_000);

    it('bajar a free con el mes ya pasado del límite bloquea nuevas emisiones, sin tocar lo emitido', async () => {
      const t = await registerTenant(app, 'plan-bajada');
      await setPlan(t.user.tenantId, 'pro');
      const admin = await connect('migrator');
      await admin.query(
        `INSERT INTO usage_counters (tenant_id, period, invoices_issued)
         VALUES ($1, date_trunc('month', now() at time zone 'utc')::date, 80)`,
        [t.user.tenantId],
      );
      await admin.end();
      await setPlan(t.user.tenantId, 'free');
      const res = await issueOne(t).expect(402);
      expect(res.body).toMatchObject({ code: 'PLAN_LIMIT_INVOICES', limit: 50 });
    });

    it('el cupo es por mes: un contador de un mes anterior no cuenta', async () => {
      const t = await registerTenant(app, 'plan-mes');
      const admin = await connect('migrator');
      await admin.query(
        `INSERT INTO usage_counters (tenant_id, period, invoices_issued)
         VALUES ($1, (date_trunc('month', now() at time zone 'utc') - interval '1 month')::date, 50)`,
        [t.user.tenantId],
      );
      await admin.end();
      await issueOne(t).expect(201);
      expect((await api(app).get('/api/v1/plan').set(bearer(t))).body.usage.invoicesIssued).toBe(1);
    });

    it('carrera en el límite: con 10 solicitudes simultáneas y 5 cupos pasan exactamente 5', async () => {
      const t = await registerTenant(app, 'plan-carrera');
      const admin = await connect('migrator');
      await admin.query(
        `INSERT INTO usage_counters (tenant_id, period, invoices_issued)
         VALUES ($1, date_trunc('month', now() at time zone 'utc')::date, 45)`,
        [t.user.tenantId],
      );
      await admin.end();

      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () =>
          tenantDb.runAs(t.user.tenantId, async (trx) => {
            await plans.consumeInvoiceQuota(trx);
            await sql`select pg_sleep(0.05)`.execute(trx); // ensancha la ventana de la carrera
          }),
        ),
      );
      const ok = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(ok).toHaveLength(5);
      expect(rejected).toHaveLength(5);
      for (const r of rejected) expect(r.reason).toMatchObject({ code: 'PLAN_LIMIT_INVOICES' });
      const used = await tenantDb.runAs(t.user.tenantId, (trx) => plans.getUsage(trx));
      expect(used.invoicesIssued).toBe(50);
    });

    it('carrera por HTTP: 8 emisiones simultáneas con 3 cupos → 3 emitidas, 5 con 402, secuenciales 1..N sin huecos', async () => {
      const t = await registerTenant(app, 'plan-carrera-http');
      const admin = await connect('migrator');
      await admin.query(
        `INSERT INTO usage_counters (tenant_id, period, invoices_issued)
         VALUES ($1, date_trunc('month', now() at time zone 'utc')::date, 47)`,
        [t.user.tenantId],
      );
      await admin.end();
      const res = await Promise.all(Array.from({ length: 8 }, () => issueOne(t)));
      expect(res.filter((r) => r.status === 201)).toHaveLength(3);
      const blocked = res.filter((r) => r.status === 402);
      expect(blocked).toHaveLength(5);
      expect(blocked.every((r) => r.body.code === 'PLAN_LIMIT_INVOICES')).toBe(true);
    });

    it('si la transacción del llamador se revierte, el cupo se devuelve', async () => {
      const t = await registerTenant(app, 'plan-rollback');
      await expect(
        tenantDb.runAs(t.user.tenantId, async (trx) => {
          await plans.consumeInvoiceQuota(trx);
          throw new Error('falla después de reservar');
        }),
      ).rejects.toThrow('falla después');
      const usage = await tenantDb.runAs(t.user.tenantId, (trx) => plans.getUsage(trx));
      expect(usage.invoicesIssued).toBe(0);
    });
  });

  describe('límite de usuarios', () => {
    it('free (1 usuario): invitar da 402 PLAN_LIMIT_USERS; con pro se permite', async () => {
      const t = await registerTenant(app, 'plan-users');
      const invite = (email: string) =>
        api(app).post('/api/v1/users/invitations').set(bearer(t)).send({ email, role: 'cashier' });
      const blocked = await invite(`${RUN}-u1@example.test`).expect(402);
      expect(blocked.body).toMatchObject({ code: 'PLAN_LIMIT_USERS', plan: 'free', limit: 1, used: 1 });
      await setPlan(t.user.tenantId, 'pro');
      await invite(`${RUN}-u1@example.test`).expect(201);
    });

    it('cuenta miembros + invitaciones pendientes y es correcto bajo concurrencia', async () => {
      const t = await registerTenant(app, 'plan-users-n');
      const admin = await connect('migrator');
      await admin.query(
        `INSERT INTO plans (code, name, max_invoices_per_month, max_users, ai_assistant) VALUES ($1, 'Team', NULL, 3, false)`,
        [`team_${RUN}`],
      );
      await admin.query('UPDATE subscriptions SET plan_code = $2 WHERE tenant_id = $1', [t.user.tenantId, `team_${RUN}`]);
      try {
        // 1 owner + 2 invitaciones = 3: de 6 simultáneas solo pueden pasar 2.
        const res = await Promise.all(
          Array.from({ length: 6 }, (_, i) =>
            api(app).post('/api/v1/users/invitations').set(bearer(t)).send({ email: `${RUN}-n${i}@example.test`, role: 'cashier' }),
          ),
        );
        expect(res.filter((r) => r.status === 201)).toHaveLength(2);
        expect(res.filter((r) => r.status === 402)).toHaveLength(4);
        const plan = (await api(app).get('/api/v1/plan').set(bearer(t))).body;
        expect(plan.usage).toMatchObject({ users: 1, pendingInvitations: 2 });

        // Reinvitar un email que ya tiene invitación pendiente la reemplaza: no cuenta doble.
        const pending = (await api(app).get('/api/v1/users/invitations').set(bearer(t))).body.data[0].email;
        await api(app).post('/api/v1/users/invitations').set(bearer(t)).send({ email: pending, role: 'admin' }).expect(201);
      } finally {
        await admin.query('UPDATE subscriptions SET plan_code = $2 WHERE tenant_id = $1', [t.user.tenantId, 'free']);
        await admin.query('DELETE FROM plans WHERE code = $1', [`team_${RUN}`]);
        await admin.end();
      }
    });
  });

  describe('@RequiresPlan', () => {
    it('free → 402 PLAN_UPGRADE_REQUIRED; pro → 200; sin token → 401; ruta con varios planes', async () => {
      const t = await registerTenant(app, 'plan-req');
      await api(app).get('/api/v1/test-pro').expect(401);
      const res = await api(app).get('/api/v1/test-pro').set(bearer(t)).expect(402);
      expect(res.body).toMatchObject({ code: 'PLAN_UPGRADE_REQUIRED', plan: 'free', requiredPlans: ['pro'] });
      await api(app).get('/api/v1/test-pro/either').set(bearer(t)).expect(200);
      await setPlan(t.user.tenantId, 'pro');
      await api(app).get('/api/v1/test-pro').set(bearer(t)).expect(200);
    });
  });

  describe('cambio de plan por super-admin', () => {
    let superAdmin: Session;
    let target: Session;
    const put = (as: Session, tenantId: string, body: object) =>
      api(app).put(`/api/v1/platform/tenants/${tenantId}/plan`).set(bearer(as)).send(body);

    beforeAll(async () => {
      superAdmin = await registerTenant(app, 'plan-sa');
      target = await registerTenant(app, 'plan-target');
    });

    it('un owner normal no puede (403) y su plan no cambia', async () => {
      await put(target, target.user.tenantId, { plan: 'pro' }).expect(403);
      await put(superAdmin, target.user.tenantId, { plan: 'pro' }).expect(403);
      expect((await api(app).get('/api/v1/plan').set(bearer(target))).body.plan.code).toBe('free');
    });

    it('la función de base también se niega a quien no es super-admin (no depende solo del guard)', async () => {
      const raw = await connect('app_user');
      try {
        await expect(
          raw.query('select * from platform_set_tenant_plan($1, $2, $3)', [target.user.userId, target.user.tenantId, 'pro']),
        ).rejects.toMatchObject({ code: '42501' });
      } finally {
        await raw.end();
      }
    });

    it('un super-admin cambia el plan de otro tenant, queda registrado y puede revertirlo', async () => {
      const admin = await connect('migrator');
      await admin.query('INSERT INTO platform_admins (user_id) VALUES ($1)', [superAdmin.user.userId]);
      try {
        const res = await put(superAdmin, target.user.tenantId, { plan: 'pro' }).expect(200);
        expect(res.body).toEqual({ tenantId: target.user.tenantId, plan: 'pro', previousPlan: 'free' });
        expect((await api(app).get('/api/v1/plan').set(bearer(target))).body.plan.code).toBe('pro');

        const log = await admin.query('SELECT from_plan, to_plan, changed_by FROM plan_changes WHERE tenant_id = $1', [target.user.tenantId]);
        expect(log.rows).toEqual([{ from_plan: 'free', to_plan: 'pro', changed_by: superAdmin.user.userId }]);

        await put(superAdmin, target.user.tenantId, { plan: 'free' }).expect(200);
        expect((await api(app).get('/api/v1/plan').set(bearer(target))).body.plan.code).toBe('free');

        await put(superAdmin, target.user.tenantId, { plan: 'enterprise' }).expect(400);
        await put(superAdmin, '00000000-0000-4000-8000-000000000000', { plan: 'pro' }).expect(404);
        await put(superAdmin, 'no-uuid', { plan: 'pro' }).expect(400);

        // Ser super-admin no rompe el aislamiento: sigue viendo solo su propio tenant.
        const users = (await api(app).get('/api/v1/users').set(bearer(superAdmin)).expect(200)).body;
        expect(users.data.map((u: { id: string }) => u.id)).toEqual([superAdmin.user.userId]);
        await api(app).delete(`/api/v1/users/${target.user.userId}`).set(bearer(superAdmin)).expect(404);

        // Quitarlo de la tabla revoca el privilegio de inmediato, con el mismo token.
        await admin.query('DELETE FROM platform_admins WHERE user_id = $1', [superAdmin.user.userId]);
        await put(superAdmin, target.user.tenantId, { plan: 'pro' }).expect(403);
      } finally {
        await admin.query('DELETE FROM platform_admins WHERE user_id = $1', [superAdmin.user.userId]);
        await admin.end();
      }
    });

    it('al bajar a un plan con menos usuarios se descartan las invitaciones pendientes que lo excedan', async () => {
      const t = await registerTenant(app, 'plan-baja-inv');
      await setPlan(t.user.tenantId, 'pro');
      await api(app).post('/api/v1/users/invitations').set(bearer(t)).send({ email: `${RUN}-baja@example.test`, role: 'cashier' }).expect(201);
      const sa = await registerTenant(app, 'plan-sa2');
      const admin = await connect('migrator');
      await admin.query('INSERT INTO platform_admins (user_id) VALUES ($1)', [sa.user.userId]);
      try {
        await put(sa, t.user.tenantId, { plan: 'free' }).expect(200);
        const pending = await api(app).get('/api/v1/users/invitations').set(bearer(t)).expect(200);
        expect(pending.body.total).toBe(0);
      } finally {
        await admin.query('DELETE FROM platform_admins WHERE user_id = $1', [sa.user.userId]);
        await admin.end();
      }
    });
  });
});
