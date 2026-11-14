import { z } from 'zod';

const role = z.enum(['owner', 'admin', 'cashier']);

export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListQuery = z.infer<typeof listQuerySchema>;

export const inviteSchema = z.object({
  email: z.email().max(254).transform((v) => v.toLowerCase()),
  role: role.default('cashier'),
});
export type InviteDto = z.infer<typeof inviteSchema>;

export const changeRoleSchema = z.object({ role });
export type ChangeRoleDto = z.infer<typeof changeRoleSchema>;

export const idSchema = z.uuid();
