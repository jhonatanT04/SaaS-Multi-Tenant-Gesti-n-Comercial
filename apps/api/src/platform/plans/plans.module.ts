import { Global, Module } from '@nestjs/common';
import { PlanGuard } from './plan.guard.js';
import { PlanService } from './plan.service.js';
import { PlansController } from './plans.controller.js';
import { PlatformAdminGuard } from './platform-admin.guard.js';

/** Global: cualquier módulo puede inyectar `PlanService` y usar `@RequiresPlan()`. */
@Global()
@Module({
  controllers: [PlansController],
  providers: [PlanService, PlanGuard, PlatformAdminGuard],
  exports: [PlanService, PlanGuard],
})
export class PlansModule {}
