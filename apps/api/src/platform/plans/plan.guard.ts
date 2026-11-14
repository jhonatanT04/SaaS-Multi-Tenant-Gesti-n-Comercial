import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PlanCode } from '../db/schema.js';
import { TenantDb } from '../db/tenant-db.service.js';
import { PlanLimitException } from './plan-limit.exception.js';
import { PlanService } from './plan.service.js';
import { REQUIRED_PLANS_KEY } from './requires-plan.decorator.js';

/** Guard de `@RequiresPlan()`. Corre después del guard JWT global, que ya fijó el tenant. */
@Injectable()
export class PlanGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tenantDb: TenantDb,
    private readonly plans: PlanService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<PlanCode[] | undefined>(REQUIRED_PLANS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required?.length) return true;
    const plan = await this.tenantDb.run((trx) => this.plans.getPlan(trx));
    if (!required.includes(plan.code)) {
      throw new PlanLimitException(
        'PLAN_UPGRADE_REQUIRED',
        `Esta función no está incluida en tu plan ${plan.name}.`,
        { plan: plan.code, requiredPlans: required },
      );
    }
    return true;
  }
}
