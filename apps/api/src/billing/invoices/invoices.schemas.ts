import { z } from 'zod';
import {
  dateSchema,
  moneySchema,
  optionalText,
  paginationSchema,
  percentSchema,
  quantitySchema,
  timeZoneSchema,
  uuidSchema,
} from '../common/schemas.js';

/**
 * Un ítem es un producto del catálogo (`productId`; nombre y si grava IVA se copian
 * del producto, y el precio también salvo que se envíe `unitPrice`), o un ítem libre
 * (`name` + `unitPrice`), útil para trabajos a medida.
 */
const itemSchema = z
  .object({
    productId: uuidSchema.optional(),
    name: z.string().trim().min(1).max(200).optional(),
    unitPrice: moneySchema.optional(),
    taxable: z.boolean().optional(),
    quantity: quantitySchema.refine((v) => Number(v) > 0, {
      message: 'cantidad: debe ser mayor que cero',
    }),
    discountAmount: moneySchema.optional(),
    discountPercent: percentSchema.optional(),
  })
  .superRefine((item, ctx) => {
    if (item.productId) {
      if (item.name !== undefined || item.taxable !== undefined) {
        ctx.addIssue({
          code: 'custom',
          message: 'con productId, name y taxable se toman del producto',
        });
      }
    } else if (item.name === undefined || item.unitPrice === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'indica productId, o name y unitPrice',
      });
    }
    if (
      item.discountAmount !== undefined &&
      item.discountPercent !== undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'usa discountAmount o discountPercent, no ambos',
      });
    }
  });
export type InvoiceItemInput = z.infer<typeof itemSchema>;

const draftFields = {
  /** null u omitido = consumidor final. */
  customerId: uuidSchema.nullable().optional(),
  notes: optionalText(1000),
  items: z.array(itemSchema).max(200),
};

export const createInvoiceSchema = z.object({
  ...draftFields,
  /** true = crear y emitir en la misma transacción (venta de mostrador). */
  issue: z.boolean().default(false),
});
export type CreateInvoiceBody = z.infer<typeof createInvoiceSchema>;

/** PUT: reemplaza cliente, notas e ítems del borrador. */
export const replaceInvoiceSchema = z.object(draftFields);
export type ReplaceInvoiceBody = z.infer<typeof replaceInvoiceSchema>;

export const voidInvoiceSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});
export type VoidInvoiceBody = z.infer<typeof voidInvoiceSchema>;

export const listInvoicesSchema = paginationSchema
  .extend({
    status: z.enum(['draft', 'issued', 'voided']).optional(),
    /** Solo aplica a emitidos: filtrar por él excluye borradores y anulados. */
    paymentStatus: z.enum(['unpaid', 'partial', 'paid']).optional(),
    customerId: uuidSchema.optional(),
    /** Busca en nombre del cliente, identificación o secuencial exacto. */
    q: z.string().trim().min(1).max(200).optional(),
    /** Rango inclusivo sobre la fecha de emisión (o de creación, en borradores). */
    from: dateSchema.optional(),
    to: dateSchema.optional(),
    tz: timeZoneSchema,
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, {
    message: 'from debe ser ≤ to',
  });
export type ListInvoicesQuery = z.infer<typeof listInvoicesSchema>;
