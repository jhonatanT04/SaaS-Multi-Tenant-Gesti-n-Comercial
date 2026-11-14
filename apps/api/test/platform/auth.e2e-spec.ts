import type { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types.js';
import { api, bearer, cleanup, createApp, registerTenant, RUN, setPlan, type Session } from './helpers.js';

describe('Auth y gestión de usuarios (HTTP)', () => {
  let app: INestApplication<App>;
  let owner: Session;

  beforeAll(async () => {
    app = await createApp();
    owner = await registerTenant(app, 'auth');
    await setPlan(owner.user.tenantId, 'pro'); // free admite 1 usuario; estos tests invitan a varios
  });

  afterAll(async () => {
    await app.close();
    await cleanup();
  });

  const login = (body: object) => api(app).post('/api/v1/auth/login').send(body);

  describe('registro y login', () => {
    it('el registro crea tenant + owner y devuelve tokens', () => {
      expect(owner.user.role).toBe('owner');
      expect(owner.user.tenantId).toMatch(/^[0-9a-f-]{36}$/);
      expect(owner.accessToken).toBeTruthy();
      expect(owner.refreshToken).toBeTruthy();
    });

    it('rechaza email duplicado (409) y no deja un tenant huérfano', async () => {
      const slug = `${RUN}-huerfano`;
      await api(app)
        .post('/api/v1/auth/register')
        .send({ tenantName: 'Otro', tenantSlug: slug, name: 'X', email: owner.email, password: 'whatever-123' })
        .expect(409);
      // El slug sigue libre: la transacción entera se revirtió.
      const again = await api(app)
        .post('/api/v1/auth/register')
        .send({ tenantName: 'Otro', tenantSlug: slug, name: 'X', email: `${RUN}-huerfano@example.test`, password: 'whatever-123' })
        .expect(201);
      expect(again.body.user.role).toBe('owner');
    });

    it('rechaza slug duplicado explícito (409) y deriva uno libre si no se envía', async () => {
      await api(app)
        .post('/api/v1/auth/register')
        .send({ tenantName: 'Dup', tenantSlug: owner.slug, name: 'X', email: `${RUN}-dup1@example.test`, password: 'whatever-123' })
        .expect(409);
      for (const n of [2, 3]) {
        await api(app)
          .post('/api/v1/auth/register')
          .send({ tenantName: `${RUN} Café Ñandú`, name: 'X', email: `${RUN}-dup${n}@example.test`, password: 'whatever-123' })
          .expect(201);
      }
    });

    it('valida el cuerpo con Zod (400 con la ruta del campo)', async () => {
      const res = await api(app)
        .post('/api/v1/auth/register')
        .send({ tenantName: 'X', name: 'Y', email: 'no-es-email', password: 'corta' })
        .expect(400);
      expect(JSON.stringify(res.body.message)).toMatch(/email/);
      expect(JSON.stringify(res.body.message)).toMatch(/password/);
    });

    it('login correcto, y 401 idéntico para contraseña errónea y email inexistente', async () => {
      const ok = await login({ email: owner.email.toUpperCase(), password: owner.password }).expect(200);
      expect(ok.body.user).toEqual(owner.user);
      const bad = await login({ email: owner.email, password: 'incorrecta-123' }).expect(401);
      const unknown = await login({ email: `${RUN}-nadie@example.test`, password: 'incorrecta-123' }).expect(401);
      expect(bad.body).toEqual(unknown.body);
    });

    it('la contraseña se guarda con argon2id', async () => {
      const { connect } = await import('./helpers.js');
      const admin = await connect('migrator');
      const { rows } = await admin.query('SELECT password_hash FROM users WHERE email = $1', [owner.email]);
      await admin.end();
      expect(rows[0].password_hash).toMatch(/^\$argon2id\$/);
    });
  });

  describe('guard global', () => {
    it('sin token → 401; con token → 200', async () => {
      await api(app).get('/api/v1/auth/me').expect(401);
      await api(app).get('/api/v1/users').expect(401);
      const me = await api(app).get('/api/v1/auth/me').set(bearer(owner)).expect(200);
      expect(me.body.user.email).toBe(owner.email);
      expect(me.body.tenant).toMatchObject({ slug: owner.slug, currency: 'USD', taxRate: '0.1500' });
    });

    it('rechaza token manipulado y refresh token usado como access', async () => {
      const [h, p, s] = owner.accessToken.split('.');
      const forged = Buffer.from(
        JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), role: 'owner', tid: '00000000-0000-4000-8000-000000000000' }),
      ).toString('base64url');
      await api(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${h}.${forged}.${s}`).expect(401);
      await api(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${owner.refreshToken}`).expect(401);
      const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      await api(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${none}.${p}.`).expect(401);
    });

    it('rutas públicas: health y swagger', async () => {
      const health = await api(app).get('/api/v1/health').expect(200);
      expect(health.body.status).toBe('ok');
      const docs = await api(app).get('/api/docs-json').expect(200);
      expect(Object.keys(docs.body.paths)).toEqual(
        expect.arrayContaining(['/api/v1/auth/register', '/api/v1/auth/login', '/api/v1/users']),
      );
    });
  });

  describe('refresh con rotación', () => {
    const refresh = (refreshToken: string) => api(app).post('/api/v1/auth/refresh').send({ refreshToken });

    it('rota el token; reutilizar el viejo revoca toda la familia', async () => {
      const s = (await login({ email: owner.email, password: owner.password }).expect(200)).body;
      const r1 = (await refresh(s.refreshToken).expect(200)).body;
      expect(r1.refreshToken).not.toBe(s.refreshToken);
      await api(app).get('/api/v1/auth/me').set(bearer(r1)).expect(200);

      await refresh(s.refreshToken).expect(401); // reutilización
      await refresh(r1.refreshToken).expect(401); // el sucesor también cae
    });

    it('un access token no sirve como refresh; logout invalida el refresh', async () => {
      const s = (await login({ email: owner.email, password: owner.password }).expect(200)).body;
      await refresh(s.accessToken).expect(401);
      await api(app).post('/api/v1/auth/logout').send({ refreshToken: s.refreshToken }).expect(204);
      await refresh(s.refreshToken).expect(401);
    });

    it('dos refresh simultáneos con el mismo token: como mucho uno gana', async () => {
      const s = (await login({ email: owner.email, password: owner.password }).expect(200)).body;
      const results = await Promise.all([refresh(s.refreshToken), refresh(s.refreshToken)]);
      expect(results.filter((r) => r.status === 200).length).toBeLessThanOrEqual(1);
      expect(results.filter((r) => r.status === 401).length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('miembros e invitaciones', () => {
    let cashier: Session;
    let admin: Session;
    const invite = (as: Session, body: object) => api(app).post('/api/v1/users/invitations').set(bearer(as)).send(body);
    const accept = (body: object) => api(app).post('/api/v1/auth/invitations/accept').send(body);

    async function join(label: string, role: string): Promise<Session> {
      const email = `${RUN}-${label}@example.test`;
      const password = `pw-${label}-12345678`;
      const inv = (await invite(owner, { email, role }).expect(201)).body;
      const res = await accept({ token: inv.token, password, name: label }).expect(200);
      return { ...res.body, email, password, slug: owner.slug };
    }

    beforeAll(async () => {
      cashier = await join('cajero', 'cashier');
      admin = await join('admin', 'admin');
    });

    it('la invitación aceptada crea al miembro con su rol y queda consumida', async () => {
      expect(cashier.user).toMatchObject({ role: 'cashier', tenantId: owner.user.tenantId });
      const inv = (await invite(owner, { email: `${RUN}-una-vez@example.test`, role: 'cashier' }).expect(201)).body;
      await accept({ token: inv.token, password: 'password-123', name: 'Una Vez' }).expect(200);
      await accept({ token: inv.token, password: 'password-123', name: 'Una Vez' }).expect(404);
      await accept({ token: 'x'.repeat(43), password: 'password-123', name: 'N' }).expect(404);
    });

    it('lista paginada de miembros con el formato del contrato', async () => {
      const res = await api(app).get('/api/v1/users?page=1&pageSize=2').set(bearer(owner)).expect(200);
      expect(res.body).toMatchObject({ page: 1, pageSize: 2, total: 4 });
      expect(res.body.data).toHaveLength(2);
      expect(res.body.data[0]).toEqual({
        id: owner.user.userId, email: owner.email, name: 'Owner auth', role: 'owner', joinedAt: expect.any(String),
      });
      expect(JSON.stringify(res.body)).not.toMatch(/password|argon2/);
      await api(app).get('/api/v1/users?pageSize=1000').set(bearer(owner)).expect(400);
    });

    it('@Roles: un cashier no puede gestionar usuarios (403)', async () => {
      await api(app).get('/api/v1/users').set(bearer(cashier)).expect(403);
      await invite(cashier, { email: `${RUN}-z@example.test`, role: 'cashier' }).expect(403);
      await api(app).delete(`/api/v1/users/${admin.user.userId}`).set(bearer(cashier)).expect(403);
    });

    it('un admin no puede crear ni tocar owners', async () => {
      await invite(admin, { email: `${RUN}-o@example.test`, role: 'owner' }).expect(403);
      const role = (id: string, r: string) =>
        api(app).patch(`/api/v1/users/${id}/role`).set(bearer(admin)).send({ role: r });
      await role(cashier.user.userId, 'owner').expect(403);
      await role(owner.user.userId, 'cashier').expect(403);
      await api(app).delete(`/api/v1/users/${owner.user.userId}`).set(bearer(admin)).expect(403);
      await role(cashier.user.userId, 'admin').expect(200);
      await role(cashier.user.userId, 'cashier').expect(200);
    });

    it('la organización no puede quedarse sin owner', async () => {
      await api(app).patch(`/api/v1/users/${owner.user.userId}/role`).set(bearer(owner)).send({ role: 'admin' }).expect(409);
      await api(app).delete(`/api/v1/users/${owner.user.userId}`).set(bearer(owner)).expect(409);
    });

    it('no se puede invitar a quien ya es miembro (409); reinvitar reemplaza la pendiente', async () => {
      await invite(owner, { email: cashier.email, role: 'admin' }).expect(409);
      const email = `${RUN}-pendiente@example.test`;
      const first = (await invite(owner, { email, role: 'cashier' }).expect(201)).body;
      const second = (await invite(owner, { email, role: 'admin' }).expect(201)).body;
      await accept({ token: first.token, password: 'password-123', name: 'P' }).expect(404);
      const pending = await api(app).get('/api/v1/users/invitations').set(bearer(owner)).expect(200);
      expect(pending.body.data.filter((i: { email: string }) => i.email === email)).toHaveLength(1);
      expect(JSON.stringify(pending.body)).not.toMatch(/token/i);
      await api(app).delete(`/api/v1/users/invitations/${second.id}`).set(bearer(owner)).expect(204);
      await accept({ token: second.token, password: 'password-123', name: 'P' }).expect(404);
    });

    it('usuario existente invitado a otro tenant: exige su contraseña y luego elige tenant al entrar', async () => {
      const other = await registerTenant(app, 'auth-otro');
      await setPlan(other.user.tenantId, 'pro');
      const inv = (await invite(other, { email: cashier.email, role: 'admin' }).expect(201)).body;
      await accept({ token: inv.token, password: 'no-es-la-suya-1' }).expect(401);
      const joined = (await accept({ token: inv.token, password: cashier.password }).expect(200)).body;
      expect(joined.user).toEqual({ userId: cashier.user.userId, tenantId: other.user.tenantId, role: 'admin' });

      const ambiguous = await login({ email: cashier.email, password: cashier.password }).expect(400);
      expect(ambiguous.body.tenants.map((t: { slug: string }) => t.slug).sort()).toEqual([owner.slug, other.slug].sort());
      const chosen = await login({ email: cashier.email, password: cashier.password, tenantSlug: other.slug }).expect(200);
      expect(chosen.body.user.tenantId).toBe(other.user.tenantId);
      await login({ email: cashier.email, password: cashier.password, tenantSlug: `${RUN}-ajeno` }).expect(401);
    });

    it('quitar a un miembro invalida su refresh token y su login en ese tenant', async () => {
      const victim = await join('saliente', 'cashier');
      await api(app).delete(`/api/v1/users/${victim.user.userId}`).set(bearer(admin)).expect(204);
      await api(app).post('/api/v1/auth/refresh').send({ refreshToken: victim.refreshToken }).expect(401);
      await login({ email: victim.email, password: victim.password }).expect(403);
      await api(app).get('/api/v1/auth/me').set(bearer(victim)).expect(401);
      await api(app).delete(`/api/v1/users/${victim.user.userId}`).set(bearer(admin)).expect(404);
    });
  });
});
