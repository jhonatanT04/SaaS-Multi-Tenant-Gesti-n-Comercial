import { Injectable } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import type { DB, PlanCode } from '../db/schema.js';
import { PlanLimitException } from './plan-limit.exception.js';

export interface TenantPlan {
  code: PlanCode;
  name: string;
  limits: {
    /** null = sin límite. */
    invoicesPerMonth: number | null;
    /** null = sin límite. Cuenta miembros + invitaciones pendientes. */
    users: number | null;
    aiAssistant: boolean;
  };
}

export interface TenantUsage {
  /** Mes en curso (UTC), 'YYYY-MM'. */
  period: string;
  invoicesIssued: number;
  users: number;
  pendingInvitations: number;
}

/** Primer día del mes en curso en UTC; es la clave de `usage_counters`. */
const CURRENT_PERIOD = sql<Date>`date_trunc('month', now() at time zone 'utc')::date`;

/**
 * Plan y límites del tenant. Todos los métodos reciben la transacción de
 * `TenantDb.run/runAs` del llamador: operan sobre el tenant de esa transacción
 * y sus efectos se confirman o revierten junto con ella.
 */
@Injectable()
export class PlanService {
  async getPlan(trx: Transaction<DB>): Promise<TenantPlan> {
    const row = await trx
      .selectFrom('subscriptions as s')
      .innerJoin('plans as p', 'p.code', 's.plan_code')
      .select(['p.code', 'p.name', 'p.max_invoices_per_month', 'p.max_users', 'p.ai_assistant'])
      .executeTakeFirst();
    // El trigger de la migración 0002 garantiza una suscripción por tenant.
    if (!row) throw new Error('El tenant de la transacción no tiene suscripción');
    return {
      code: row.code,
      name: row.name,
      limits: { invoicesPerMonth: row.max_invoices_per_month, users: row.max_users, aiAssistant: row.ai_assistant },
    };
  }

  /**
   * Reserva un cupo de emisión del mes. Llamar exactamente una vez por
   * comprobante que pasa a emitido, dentro de la misma transacción.
   *
   * Lanza `PlanLimitException` (402, `PLAN_LIMIT_INVOICES`) si el plan ya no
   * admite más emisiones este mes; en ese caso no consume nada.
   *
   * Concurrencia: el upsert bloquea la fila del contador hasta el fin de la
   * transacción. Una segunda emisión simultánea espera y reevalúa la condición
   * contra el valor ya confirmado, así que en el límite solo pasa una. Si la
   * transacción del llamador se revierte, el cupo se devuelve.
   */
  async consumeInvoiceQuota(trx: Transaction<DB>): Promise<void> {
    const plan = await this.getPlan(trx);
    const limit = plan.limits.invoicesPerMonth;
    const { rows } = await sql`
      insert into usage_counters (tenant_id, period, invoices_issued)
      values (app_tenant_id(), ${CURRENT_PERIOD}, 1)
      on conflict (tenant_id, period) do update
        set invoices_issued = usage_counters.invoices_issued + 1
        where ${limit}::integer is null or usage_counters.invoices_issued < ${limit}::integer
      returning invoices_issued`.execute(trx);
    if (rows.length === 0 && limit !== null) {
      throw new PlanLimitException(
        'PLAN_LIMIT_INVOICES',
        `Tu plan ${plan.name} permite ${limit} comprobantes al mes y ya los emitiste. Mejora tu plan para seguir emitiendo.`,
        { plan: plan.code, limit, used: limit },
      );
    }
  }

  /**
   * Comprueba que cabe un usuario más (miembros + invitaciones pendientes).
   * Bloquea las memberships del tenant para que dos invitaciones simultáneas
   * no superen el límite. Lanza 402 `PLAN_LIMIT_USERS`.
   */
  async assertCanAddUser(trx: Transaction<DB>): Promise<void> {
    const plan = await this.getPlan(trx);
    const limit = plan.limits.users;
    if (limit === null) return;
    await trx.selectFrom('memberships').select('user_id').forUpdate().execute();
    const usage = await this.countUsers(trx);
    const used = usage.users + usage.pendingInvitations;
    if (used >= limit) {
      throw new PlanLimitException(
        'PLAN_LIMIT_USERS',
        `Tu plan ${plan.name} permite ${limit} ${limit === 1 ? 'usuario' : 'usuarios'}. Mejora tu plan para invitar a más personas.`,
        { plan: plan.code, limit, used },
      );
    }
  }

  async getUsage(trx: Transaction<DB>): Promise<TenantUsage> {
    const counter = await sql<{ period: string; invoices_issued: number | null }>`
      select to_char(p.period, 'YYYY-MM') as period, c.invoices_issued
      from (select ${CURRENT_PERIOD} as period) p
      left join usage_counters c on c.period = p.period`.execute(trx);
    return {
      period: counter.rows[0].period,
      invoicesIssued: counter.rows[0].invoices_issued ?? 0,
      ...(await this.countUsers(trx)),
    };
  }

  private async countUsers(trx: Transaction<DB>): Promise<{ users: number; pendingInvitations: number }> {
    const { users } = await trx
      .selectFrom('memberships')
      .select((eb) => eb.fn.countAll<string>().as('users'))
      .executeTakeFirstOrThrow();
    const { pending } = await trx
      .selectFrom('invitations')
      .select((eb) => eb.fn.countAll<string>().as('pending'))
      .where('accepted_at', 'is', null)
      .where('expires_at', '>', new Date())
      .executeTakeFirstOrThrow();
    return { users: Number(users), pendingInvitations: Number(pending) };
  }
}
