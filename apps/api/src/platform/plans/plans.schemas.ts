import { z } from 'zod';

export const setPlanSchema = z.object({ plan: z.enum(['free', 'pro']) });
export type SetPlanDto = z.infer<typeof setPlanSchema>;

export const tenantIdSchema = z.uuid();
