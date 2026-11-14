import { z } from 'zod';
import { moneySchema, optionalText } from '../common/schemas.js';

export const createPaymentSchema = z.object({
  method: z.enum(['cash', 'transfer', 'card']),
  /** Monto aplicado al comprobante (no lo entregado por el cliente: el vuelto no se registra). */
  amount: moneySchema.refine((v) => Number(v) > 0, {
    message: 'monto: debe ser mayor que cero',
  }),
  /** Número de transferencia, voucher, etc. */
  reference: optionalText(120),
  /** Por defecto, ahora. */
  paidAt: z.iso.datetime({ offset: true }).optional(),
});
export type CreatePaymentBody = z.infer<typeof createPaymentSchema>;
