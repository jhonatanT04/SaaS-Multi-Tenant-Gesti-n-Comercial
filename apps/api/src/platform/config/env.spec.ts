import { envSchema, ttlSeconds } from './env.js';

const base = {
  DATABASE_URL: 'postgresql://app_user:x@localhost:5433/saas',
  JWT_ACCESS_SECRET: 'access-secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
};

describe('envSchema', () => {
  it('aplica defaults y convierte PORT a número', () => {
    const env = envSchema.parse({ ...base, PORT: '4000' });
    expect(env).toMatchObject({ PORT: 4000, NODE_ENV: 'development', JWT_ACCESS_TTL: '15m', JWT_REFRESH_TTL: '7d' });
  });

  it('exige DATABASE_URL y los secretos', () => {
    const result = envSchema.safeParse({});
    expect(result.success).toBe(false);
    const paths = result.error!.issues.map((i) => i.path[0]);
    expect(paths).toEqual(expect.arrayContaining(['DATABASE_URL', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET']));
  });

  it('rechaza secretos iguales para access y refresh', () => {
    expect(envSchema.safeParse({ ...base, JWT_REFRESH_SECRET: base.JWT_ACCESS_SECRET }).success).toBe(false);
  });

  it('en producción exige secretos de al menos 32 caracteres', () => {
    expect(envSchema.safeParse({ ...base, NODE_ENV: 'production' }).success).toBe(false);
    const strong = { JWT_ACCESS_SECRET: 'a'.repeat(32), JWT_REFRESH_SECRET: 'b'.repeat(32) };
    expect(envSchema.safeParse({ ...base, ...strong, NODE_ENV: 'production' }).success).toBe(true);
  });

  it('ttlSeconds convierte sufijos', () => {
    expect([ttlSeconds('45s'), ttlSeconds('15m'), ttlSeconds('2h'), ttlSeconds('7d')]).toEqual([45, 900, 7200, 604800]);
    expect(envSchema.safeParse({ ...base, JWT_ACCESS_TTL: '15 minutos' }).success).toBe(false);
  });
});
