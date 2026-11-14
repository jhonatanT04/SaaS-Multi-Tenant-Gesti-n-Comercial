import { z } from 'zod';
import { dateSchema, timeZoneSchema } from '../common/schemas.js';

export const summaryQuerySchema = z.object({ tz: timeZoneSchema });
export type SummaryQuery = z.infer<typeof summaryQuerySchema>;

/** Rango inclusivo de fechas de calendario en `tz`; por defecto, el mes en curso hasta hoy. */
const rangeFields = {
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  tz: timeZoneSchema,
};
const validRange = (v: { from?: string; to?: string }) =>
  !v.from || !v.to || v.from <= v.to;

export const topProductsQuerySchema = z
  .object({
    ...rangeFields,
    limit: z.coerce.number().int().min(1).max(50).default(10),
    /** Ordenar por ingresos (sin IVA) o por cantidad vendida. */
    sortBy: z.enum(['revenue', 'quantity']).default('revenue'),
  })
  .refine(validRange, { message: 'from debe ser ≤ to' });
export type TopProductsQuery = z.infer<typeof topProductsQuerySchema>;

export const paymentMethodsQuerySchema = z
  .object(rangeFields)
  .refine(validRange, { message: 'from debe ser ≤ to' });
export type PaymentMethodsQuery = z.infer<typeof paymentMethodsQuerySchema>;
