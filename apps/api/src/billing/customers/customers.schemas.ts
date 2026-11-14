import { z } from 'zod';
import { optionalText, paginationSchema } from '../common/schemas.js';

const customerFields = {
  name: z.string().trim().min(1).max(200),
  identificationType: z
    .enum(['cedula', 'ruc', 'passport', 'other'])
    .nullable()
    .optional(),
  identification: optionalText(30),
  email: z
    .union([z.literal(''), z.email().max(254)])
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional(),
  phone: optionalText(40),
  address: optionalText(500),
};

export const createCustomerSchema = z
  .object(customerFields)
  .refine(
    (v) => (v.identification == null) === (v.identificationType == null),
    {
      message: 'identification e identificationType van juntos',
      path: ['identification'],
    },
  );
export type CreateCustomerBody = z.infer<typeof createCustomerSchema>;

export const updateCustomerSchema = z
  .object(customerFields)
  .partial()
  .refine((v) => Object.keys(v).length > 0, {
    message: 'Envía al menos un campo',
  });
export type UpdateCustomerBody = z.infer<typeof updateCustomerSchema>;

export const listCustomersSchema = paginationSchema.extend({
  /** Busca en nombre e identificación. */
  q: z.string().trim().min(1).max(200).optional(),
});
export type ListCustomersQuery = z.infer<typeof listCustomersSchema>;
