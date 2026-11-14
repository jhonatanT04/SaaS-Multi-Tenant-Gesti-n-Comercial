import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';
import type { PlanCode } from '../db/schema.js';
import { PlanGuard } from './plan.guard.js';

export const REQUIRED_PLANS_KEY = 'platform:required-plans';

/**
 * Restringe la ruta (o el controlador entero) a tenants cuyo plan esté entre
 * los indicados; el resto recibe 402 `PLAN_UPGRADE_REQUIRED`.
 * Ejemplo: `@RequiresPlan('pro')` en el controlador del asistente de IA.
 */
export const RequiresPlan = (...plans: PlanCode[]): MethodDecorator & ClassDecorator =>
  applyDecorators(SetMetadata(REQUIRED_PLANS_KEY, plans), UseGuards(PlanGuard));
