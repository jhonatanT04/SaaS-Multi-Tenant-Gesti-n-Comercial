import { join } from 'node:path';
import { z } from 'zod';

/** `apps/api/.env`, tanto desde `src/` como desde `dist/`. */
export const ENV_FILE = join(import.meta.dirname, '../../../.env');

const ttl = z.string().regex(/^\d+[smhd]$/, 'usa un número con sufijo s, m, h o d (p. ej. 15m)');

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    DATABASE_URL: z.string().startsWith('postgres'),
    JWT_ACCESS_SECRET: z.string().min(8),
    JWT_REFRESH_SECRET: z.string().min(8),
    JWT_ACCESS_TTL: ttl.default('15m'),
    JWT_REFRESH_TTL: ttl.default('7d'),
    /**
     * Peticiones por IP y ventana a cada ruta sensible de /auth (login, registro,
     * refresh, aceptar invitación). Sin valor: 10 por ventana; en NODE_ENV=test
     * queda efectivamente desactivado para no interferir con otros e2e.
     */
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).optional(),
    AUTH_RATE_LIMIT_WINDOW: ttl.default('1m'),
    /** Saltos de proxy de confianza para derivar la IP real (X-Forwarded-For). Vacío = ninguno. */
    TRUST_PROXY: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_REFRESH_SECRET'],
        message: 'debe ser distinto de JWT_ACCESS_SECRET',
      });
    }
    if (env.NODE_ENV === 'production') {
      for (const key of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'] as const) {
        if (env[key].length < 32) {
          ctx.addIssue({ code: 'custom', path: [key], message: 'mínimo 32 caracteres en producción' });
        }
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

/** Convierte '15m' / '7d' a segundos. */
export function ttlSeconds(value: string): number {
  const units = { s: 1, m: 60, h: 3600, d: 86400 } as const;
  return Number(value.slice(0, -1)) * units[value.slice(-1) as keyof typeof units];
}
