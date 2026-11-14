import { Body, Controller, Get, Inject, NotFoundException, Param, Put, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Kysely, sql } from 'kysely';
import { type AuthUser, CurrentUser } from '../auth/current-user.decorator.js';
import { KYSELY } from '../db/database.constants.js';
import type { DB, PlanCode } from '../db/schema.js';
import { TenantDb } from '../db/tenant-db.service.js';
import { PlanService } from './plan.service.js';
import { type SetPlanDto, setPlanSchema, tenantIdSchema } from './plans.schemas.js';
import { PlatformAdminGuard } from './platform-admin.guard.js';

@ApiTags('plans')
@Controller()
export class PlansController {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly plans: PlanService,
    @Inject(KYSELY) private readonly db: Kysely<DB>,
  ) {}

  /** Plan del tenant, su uso del mes y el catálogo, para la pantalla "mejorar plan". */
  @Get('plan')
  current() {
    return this.tenantDb.run(async (trx) => ({
      plan: await this.plans.getPlan(trx),
      usage: await this.plans.getUsage(trx),
      availablePlans: (
        await trx
          .selectFrom('plans')
          .select(['code', 'name', 'max_invoices_per_month', 'max_users', 'ai_assistant'])
          .orderBy('max_invoices_per_month', (ob) => ob.asc().nullsLast())
          .execute()
      ).map((p) => ({
        code: p.code,
        name: p.name,
        limits: { invoicesPerMonth: p.max_invoices_per_month, users: p.max_users, aiAssistant: p.ai_assistant },
      })),
    }));
  }

  /**
   * Cambio manual de plan de cualquier tenant; solo super-admin de plataforma.
   * La función de base vuelve a verificar al super-admin y registra el cambio.
   */
  @Put('platform/tenants/:tenantId/plan')
  @UseGuards(PlatformAdminGuard)
  async setPlan(
    @CurrentUser() admin: AuthUser,
    @Param('tenantId', { schema: tenantIdSchema }) tenantId: string,
    @Body({ schema: setPlanSchema }) dto: SetPlanDto,
  ) {
    const { rows } = await sql<{ tenant_id: string; plan_code: PlanCode; previous_plan: PlanCode }>`
      select tenant_id, plan_code, previous_plan
      from platform_set_tenant_plan(${admin.userId}, ${tenantId}, ${dto.plan})`.execute(this.db);
    if (!rows[0]) throw new NotFoundException('Organización no encontrada');
    return { tenantId: rows[0].tenant_id, plan: rows[0].plan_code, previousPlan: rows[0].previous_plan };
  }
}
