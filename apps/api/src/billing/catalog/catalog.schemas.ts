import { z } from 'zod';
import {
  moneySchema,
  optionalText,
  paginationSchema,
  queryBoolean,
  uuidSchema,
} from '../common/schemas.js';

export const categoryBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
});
export type CategoryBody = z.infer<typeof categoryBodySchema>;

export const listCategoriesSchema = paginationSchema.extend({
  q: z.string().trim().min(1).max(120).optional(),
});
export type ListCategoriesQuery = z.infer<typeof listCategoriesSchema>;

const productFields = {
  name: z.string().trim().min(1).max(200),
  kind: z.enum(['product', 'service']),
  code: optionalText(60),
  description: optionalText(2000),
  categoryId: uuidSchema.nullable().optional(),
  /** Precio unitario sin impuesto. */
  price: moneySchema,
  /** Grava IVA. */
  taxable: z.boolean(),
  active: z.boolean(),
};

export const createProductSchema = z.object({
  ...productFields,
  kind: productFields.kind.default('product'),
  taxable: productFields.taxable.default(true),
  active: productFields.active.default(true),
});
export type CreateProductBody = z.infer<typeof createProductSchema>;

export const updateProductSchema = z
  .object(productFields)
  .partial()
  .refine((v) => Object.keys(v).length > 0, {
    message: 'Envía al menos un campo',
  });
export type UpdateProductBody = z.infer<typeof updateProductSchema>;

export const listProductsSchema = paginationSchema.extend({
  q: z.string().trim().min(1).max(200).optional(),
  categoryId: uuidSchema.optional(),
  kind: z.enum(['product', 'service']).optional(),
  active: queryBoolean.optional(),
});
export type ListProductsQuery = z.infer<typeof listProductsSchema>;
