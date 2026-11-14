import { z } from 'zod';

const email = z.email().max(254).transform((v) => v.toLowerCase());
// El máximo acota el coste de argon2 ante entradas enormes.
const password = z.string().min(8).max(128);
const name = z.string().trim().min(1).max(120);
const slug = z
  .string()
  .min(3)
  .max(60)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'solo minúsculas, números y guiones');

export const registerSchema = z.object({
  tenantName: name,
  /** Opcional: si falta se deriva de `tenantName`. */
  tenantSlug: slug.optional(),
  currency: z.string().regex(/^[A-Z]{3}$/, 'código ISO 4217 en mayúsculas').default('USD'),
  /** Fracción: 0.15 = 15 %. */
  taxRate: z.number().min(0).max(1).default(0),
  name,
  email,
  password,
});
export type RegisterDto = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email,
  password: z.string().min(1).max(128),
  /** Necesario solo si el usuario pertenece a más de un tenant. */
  tenantSlug: slug.optional(),
});
export type LoginDto = z.infer<typeof loginSchema>;

export const refreshSchema = z.object({ refreshToken: z.string().min(1).max(2048) });
export type RefreshDto = z.infer<typeof refreshSchema>;

export const acceptInvitationSchema = z.object({
  token: z.string().min(20).max(200),
  /** Usuario nuevo: contraseña a crear. Usuario existente: su contraseña actual. */
  password,
  /** Obligatorio si el email aún no tiene cuenta. */
  name: name.optional(),
});
export type AcceptInvitationDto = z.infer<typeof acceptInvitationSchema>;
