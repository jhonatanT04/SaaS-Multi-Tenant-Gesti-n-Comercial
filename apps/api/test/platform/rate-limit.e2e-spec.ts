import type { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types.js';
import { api, bearer, cleanup, createApp, registerTenant, RUN } from './helpers.js';

const LIMIT = 3;

describe('Rate limiting en /auth', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await createApp({ authRateLimit: LIMIT });
  });
  afterAll(async () => {
    await app.close();
    await cleanup();
  });

  /** Dispara LIMIT peticiones inválidas (pasan el guard) y comprueba que la siguiente recibe 429. */
  async function expectThrottled(path: string, body: object, expectedBeforeLimit: number) {
    for (let i = 0; i < LIMIT; i++) {
      const res = await api(app).post(path).send(body);
      expect(res.status, `${path} #${i + 1}`).toBe(expectedBeforeLimit);
    }
    const limited = await api(app).post(path).send(body).expect(429);
    expect(limited.headers['retry-after']).toBeDefined();
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    return limited;
  }

  it('login: 401 hasta el límite y 429 después (aunque la contraseña sea la correcta)', async () => {
    const email = `${RUN}-rl-login@example.test`;
    const limited = await expectThrottled('/api/v1/auth/login', { email, password: 'incorrecta-123' }, 401);
    expect(limited.body.message).toMatch(/Too Many Requests/i);
  });

  it('registro, refresh y aceptación de invitaciones también están limitados, cada ruta con su contador', async () => {
    await expectThrottled('/api/v1/auth/register', { tenantName: 'x' }, 400);
    await expectThrottled('/api/v1/auth/refresh', { refreshToken: 'no-es-un-jwt' }, 401);
    await expectThrottled('/api/v1/auth/invitations/accept', { token: 'x'.repeat(43), password: 'password-123', name: 'N' }, 404);
  });

  it('logout también cuenta, pero health y auth/me no se limitan', async () => {
    for (let i = 0; i < LIMIT + 3; i++) {
      await api(app).get('/api/v1/health').expect(200);
    }
    // Registro válido agotado arriba para esta IP; por eso la sesión se obtiene fuera del límite.
    await api(app).post('/api/v1/auth/logout').send({ refreshToken: 'x' }).expect(204);
  });

  it('no afecta a las rutas autenticadas del resto de la API', async () => {
    // El registro está agotado en esta app; el límite no se hereda a otras rutas.
    const fresh = await createApp({ authRateLimit: 50 });
    try {
      const t = await registerTenant(fresh, 'rl-me');
      for (let i = 0; i < LIMIT + 5; i++) {
        await api(fresh).get('/api/v1/auth/me').set(bearer(t)).expect(200);
        await api(fresh).get('/api/v1/plan').set(bearer(t)).expect(200);
      }
    } finally {
      await fresh.close();
    }
  });
});
