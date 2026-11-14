import type { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types.js';
import {
  api,
  bearer,
  cleanup,
  createApp,
  registerTenant,
  RUN,
  type Session,
} from '../platform/helpers.js';
import {
  categoryResponse,
  customerResponse,
  invoiceDetailResponse,
  invoiceResponse,
  pageOf,
  paymentMethodsResponse,
  paymentResponse,
  productResponse,
  salesSummaryResponse,
  topProductsResponse,
} from '../../src/billing/common/responses.js';
import { asOwner, cleanupBilling } from './helpers.js';

/** La API de facturación por HTTP: rutas, roles, validación y forma de las respuestas. */
describe('facturación por HTTP', () => {
  let app: INestApplication<App>;
  let owner: Session;
  let cashier: Session;
  let stranger: Session; // owner de otro negocio

  const as = (s: Session) => ({
    get: (url: string) => api(app).get(`/api/v1${url}`).set(bearer(s)),
    post: (url: string, body?: object) =>
      api(app).post(`/api/v1${url}`).set(bearer(s)).send(body),
    put: (url: string, body: object) =>
      api(app).put(`/api/v1${url}`).set(bearer(s)).send(body),
    patch: (url: string, body: object) =>
      api(app).patch(`/api/v1${url}`).set(bearer(s)).send(body),
    delete: (url: string) => api(app).delete(`/api/v1${url}`).set(bearer(s)),
  });

  beforeAll(async () => {
    app = await createApp();
    owner = await registerTenant(app, 'fact');
    stranger = await registerTenant(app, 'fact-ajeno');
    // El plan inicial solo admite un usuario; para tener cajero el negocio pasa a pro.
    await asOwner(owner.user.tenantId, (c) =>
      c.query(
        "update subscriptions set plan_code = 'pro' where tenant_id = $1",
        [owner.user.tenantId],
      ),
    );
    const email = `${RUN}-fact-cajero@example.test`;
    const password = 'pw-cajero-12345678';
    const invitation = (
      await as(owner)
        .post('/users/invitations', { email, role: 'cashier' })
        .expect(201)
    ).body;
    const accepted = await api(app)
      .post('/api/v1/auth/invitations/accept')
      .send({ token: invitation.token, password, name: 'Cajero' })
      .expect(200);
    cashier = { ...accepted.body, email, password, slug: owner.slug };
  });

  afterAll(async () => {
    await app.close();
    await cleanupBilling(RUN, { tenants: false });
    await cleanup();
  });

  it('todas las rutas exigen token', async () => {
    for (const url of [
      '/categories',
      '/products',
      '/customers',
      '/invoices',
      '/reports/sales-summary',
    ]) {
      await api(app).get(`/api/v1${url}`).expect(401);
    }
  });

  it('flujo de venta completo con el cajero, y lo que solo puede hacer owner/admin', async () => {
    // Catálogo: lo edita el owner, el cajero solo lo consulta.
    await as(cashier).post('/categories', { name: 'Comida' }).expect(403);
    const category = (
      await as(owner).post('/categories', { name: 'Comida' }).expect(201)
    ).body;
    await as(owner).post('/categories', { name: 'comida' }).expect(409);
    await as(cashier)
      .post('/products', { name: 'Quesadilla', price: '3.50' })
      .expect(403);
    const product = (
      await as(owner)
        .post('/products', {
          name: 'Quesadilla',
          price: 3.5,
          categoryId: category.id,
        })
        .expect(201)
    ).body;
    expect(product).toMatchObject({
      name: 'Quesadilla',
      price: '3.50',
      taxable: true,
      active: true,
      kind: 'product',
    });
    await as(cashier)
      .patch(`/products/${product.id}`, { price: '0.01' })
      .expect(403);
    await as(cashier).delete(`/products/${product.id}`).expect(403);
    await as(cashier).delete(`/categories/${category.id}`).expect(403);

    const products = (
      await as(cashier)
        .get('/products?q=quesa&active=true&pageSize=5')
        .expect(200)
    ).body;
    expect(products).toEqual({
      data: [product],
      page: 1,
      pageSize: 5,
      total: 1,
    });

    // Clientes: el cajero los registra; no los elimina.
    const customer = (
      await as(cashier)
        .post('/customers', {
          name: 'Ana Pérez',
          identificationType: 'cedula',
          identification: '0102030405',
          email: 'ana@example.test',
        })
        .expect(201)
    ).body;
    await as(cashier)
      .post('/customers', {
        name: 'Otra',
        identificationType: 'cedula',
        identification: '0102030405',
      })
      .expect(409);
    await as(cashier).delete(`/customers/${customer.id}`).expect(403);

    // Venta: borrador → edición → emisión → cobro.
    const draft = (
      await as(cashier)
        .post('/invoices', {
          customerId: customer.id,
          items: [{ productId: product.id, quantity: 1 }],
        })
        .expect(201)
    ).body;
    expect(draft).toMatchObject({
      status: 'draft',
      number: null,
      total: '4.03',
      createdBy: cashier.user.userId,
    });
    const edited = (
      await as(cashier)
        .put(`/invoices/${draft.id}`, {
          customerId: customer.id,
          items: [
            { productId: product.id, quantity: 2 },
            {
              name: 'Salsa extra',
              unitPrice: '0.50',
              quantity: 1,
              taxable: false,
            },
          ],
        })
        .expect(200)
    ).body;
    expect(edited).toMatchObject({
      subtotalTaxable: '7.00',
      subtotalExempt: '0.50',
      taxTotal: '1.05',
      total: '8.55',
    });

    const issued = (
      await as(cashier).post(`/invoices/${draft.id}/issue`).expect(200)
    ).body;
    expect(issued).toMatchObject({
      status: 'issued',
      number: 1,
      formattedNumber: '001-001-000000001',
      customerName: 'Ana Pérez',
      issuedBy: cashier.user.userId,
      paymentStatus: 'unpaid',
      balance: '8.55',
    });
    expect(issued.items).toHaveLength(2);
    await as(cashier).put(`/invoices/${draft.id}`, { items: [] }).expect(409);
    await as(cashier).delete(`/invoices/${draft.id}`).expect(409);

    await as(cashier)
      .post(`/invoices/${draft.id}/payments`, { method: 'cash', amount: 5 })
      .expect(201);
    await as(cashier)
      .post(`/invoices/${draft.id}/payments`, {
        method: 'card',
        amount: '3.56',
      })
      .expect(409);
    const payment = (
      await as(cashier)
        .post(`/invoices/${draft.id}/payments`, {
          method: 'card',
          amount: '3.55',
          reference: 'V-123',
        })
        .expect(201)
    ).body;
    expect(payment).toMatchObject({
      method: 'card',
      amount: '3.55',
      reference: 'V-123',
      createdBy: cashier.user.userId,
    });
    expect(
      (await as(cashier).get(`/invoices/${draft.id}/payments`).expect(200))
        .body,
    ).toHaveLength(2);
    expect(
      (await as(cashier).get(`/invoices/${draft.id}`).expect(200)).body,
    ).toMatchObject({ paymentStatus: 'paid', balance: '0.00' });

    // Venta de mostrador en una sola llamada.
    const quick = (
      await as(cashier)
        .post('/invoices', {
          items: [{ productId: product.id, quantity: '1' }],
          issue: true,
        })
        .expect(201)
    ).body;
    expect(quick).toMatchObject({
      status: 'issued',
      number: 2,
      customerName: null,
    });

    const list = (
      await as(cashier).get('/invoices?status=issued&q=ana').expect(200)
    ).body;
    expect(list).toMatchObject({ page: 1, pageSize: 20, total: 1 });
    expect(list.data[0].id).toBe(draft.id);

    // Solo owner/admin: reversar pagos, anular, ver reportes.
    await as(cashier).delete(`/payments/${payment.id}`).expect(403);
    await as(cashier)
      .post(`/invoices/${quick.id}/void`, { reason: 'me equivoqué' })
      .expect(403);
    await as(cashier).get('/reports/sales-summary').expect(403);
    await as(cashier).get('/reports/top-products').expect(403);
    await as(cashier).get('/reports/payment-methods').expect(403);

    await as(owner).delete(`/payments/${payment.id}`).expect(204);
    await as(owner).post(`/invoices/${quick.id}/void`, {}).expect(400);
    const voided = (
      await as(owner)
        .post(`/invoices/${quick.id}/void`, { reason: 'pedido duplicado' })
        .expect(200)
    ).body;
    expect(voided).toMatchObject({
      status: 'voided',
      number: 2,
      voidedBy: owner.user.userId,
    });

    const summary = (await as(owner).get('/reports/sales-summary').expect(200))
      .body;
    expect(summary).toMatchObject({
      timeZone: 'America/Guayaquil',
      today: { count: 1, total: '8.55' },
      month: { count: 1, total: '8.55' },
    });
    const top = (
      await as(owner).get('/reports/top-products?limit=5').expect(200)
    ).body;
    expect(top.data).toEqual([
      {
        productId: product.id,
        name: 'Quesadilla',
        quantity: '2.000',
        revenue: '7.00',
        invoiceCount: 1,
      },
      {
        productId: null,
        name: 'Salsa extra',
        quantity: '1.000',
        revenue: '0.50',
        invoiceCount: 1,
      },
    ]);
    const methods = (
      await as(owner).get('/reports/payment-methods').expect(200)
    ).body;
    expect(methods.data).toEqual([
      { method: 'cash', count: 1, total: '5.00' },
      { method: 'transfer', count: 0, total: '0.00' },
      { method: 'card', count: 0, total: '0.00' },
    ]);

    // Otro negocio no ve nada de esto.
    await as(stranger).get(`/invoices/${draft.id}`).expect(404);
    await as(stranger).get(`/products/${product.id}`).expect(404);
    await as(stranger)
      .post(`/invoices/${draft.id}/void`, { reason: 'no es mío' })
      .expect(404);
    await as(stranger)
      .post('/invoices', { items: [{ productId: product.id, quantity: 1 }] })
      .expect(400);
    expect((await as(stranger).get('/invoices').expect(200)).body).toEqual({
      data: [],
      page: 1,
      pageSize: 20,
      total: 0,
    });
    expect(
      (await as(stranger).get('/reports/sales-summary').expect(200)).body.month,
    ).toEqual({ count: 0, total: '0.00' });
  });

  it('Swagger documenta cuerpos y respuestas, y las respuestas reales cumplen lo documentado', async () => {
    const doc = (await api(app).get('/api/docs-json').expect(200)).body;
    const tags = [
      'categories',
      'products',
      'customers',
      'invoices',
      'payments',
      'reports',
    ];
    const operations = Object.entries<Record<string, any>>(doc.paths).flatMap(
      ([path, methods]) =>
        Object.entries(methods).map(([method, op]) => ({
          id: `${method.toUpperCase()} ${path}`,
          method,
          op,
        })),
    );
    const mine = operations.filter(({ op }) => tags.includes(op.tags?.[0]));
    expect(mine).toHaveLength(27);

    for (const { id, method, op } of mine) {
      const success = Object.entries<any>(op.responses).filter(([status]) =>
        status.startsWith('2'),
      );
      expect(success, id).toHaveLength(1);
      const [status, response] = success[0];
      if (status === '204') continue;
      // Toda respuesta con cuerpo declara su esquema, y es un objeto o arreglo con contenido.
      const schema = response.content?.['application/json']?.schema;
      expect(schema, `${id}: falta el esquema de respuesta`).toBeDefined();
      expect(JSON.stringify(schema), id).toMatch(/"properties"/);
      // Toda escritura con cuerpo declara el esquema de entrada.
      if (['post', 'put', 'patch'].includes(method) && !id.endsWith('/issue')) {
        expect(
          op.requestBody?.content?.['application/json']?.schema?.properties,
          id,
        ).toBeDefined();
      }
    }
    const issue = doc.paths['/api/v1/invoices/{id}/issue'].post;
    expect(Object.keys(issue.responses).sort()).toEqual(['200', '402']);
    expect(
      Object.keys(
        issue.responses['200'].content['application/json'].schema.properties,
      ),
    ).toEqual(
      expect.arrayContaining([
        'number',
        'total',
        'balance',
        'paymentStatus',
        'items',
      ]),
    );

    // Las respuestas reales pasan los mismos esquemas (estrictos: sin campos de más ni de menos).
    const category = (
      await as(owner).post('/categories', { name: 'Docs' }).expect(201)
    ).body;
    categoryResponse.parse(category);
    const product = (
      await as(owner)
        .post('/products', { name: 'Docs', price: '1.00' })
        .expect(201)
    ).body;
    productResponse.parse(product);
    productResponse.parse(
      (
        await as(owner)
          .patch(`/products/${product.id}`, { price: '2.00' })
          .expect(200)
      ).body,
    );
    const customer = (
      await as(owner).post('/customers', { name: 'Docs' }).expect(201)
    ).body;
    customerResponse.parse(customer);
    const invoice = (
      await as(owner)
        .post('/invoices', {
          customerId: customer.id,
          items: [{ productId: product.id, quantity: 2 }],
          issue: true,
        })
        .expect(201)
    ).body;
    invoiceDetailResponse.parse(invoice);
    paymentResponse.parse(
      (
        await as(owner)
          .post(`/invoices/${invoice.id}/payments`, {
            method: 'cash',
            amount: '1.00',
          })
          .expect(201)
      ).body,
    );
    invoiceDetailResponse.parse(
      (await as(owner).get(`/invoices/${invoice.id}`).expect(200)).body,
    );
    paymentResponse
      .array()
      .parse(
        (await as(owner).get(`/invoices/${invoice.id}/payments`).expect(200))
          .body,
      );
    invoiceDetailResponse.parse(
      (
        await as(owner)
          .post(`/invoices/${invoice.id}/void`, { reason: 'prueba de docs' })
          .expect(200)
      ).body,
    );
    const lists = [
      ['/categories', pageOf(categoryResponse)],
      ['/products', pageOf(productResponse)],
      ['/customers', pageOf(customerResponse)],
      ['/invoices', pageOf(invoiceResponse)],
      ['/reports/sales-summary', salesSummaryResponse],
      ['/reports/top-products', topProductsResponse],
      ['/reports/payment-methods', paymentMethodsResponse],
    ] as const;
    for (const [url, schema] of lists) {
      const body = (await as(owner).get(url).expect(200)).body;
      expect(() => schema.parse(body), url).not.toThrow();
      if ('data' in body) expect(body.data.length, url).toBeGreaterThan(0);
    }
  });

  it('valida la entrada con 400', async () => {
    const bad: [string, object][] = [
      ['/products', { name: 'X', price: -1 }],
      ['/products', { name: 'X', price: '1.999' }],
      ['/products', { name: 'X', price: 1e21 }],
      ['/products', { name: '', price: 1 }],
      ['/customers', { name: 'X', identification: '123' }], // falta identificationType
      ['/customers', { name: 'X', email: 'no-es-correo' }],
      ['/invoices', {}],
      ['/invoices', { items: [{ quantity: 1 }] }],
      ['/invoices', { items: [{ name: 'X', unitPrice: 1, quantity: 0 }] }],
      [
        '/invoices',
        {
          items: [
            {
              name: 'X',
              unitPrice: 1,
              quantity: 1,
              discountAmount: 1,
              discountPercent: 10,
            },
          ],
        },
      ],
      [
        '/invoices',
        {
          items: [{ name: 'X', unitPrice: 1, quantity: 1, discountAmount: 2 }],
        },
      ], // descuento > línea
      [
        '/invoices',
        {
          items: [
            { name: 'X', unitPrice: 1, quantity: 1, discountPercent: 101 },
          ],
        },
      ],
      ['/invoices', { customerId: 'no-es-uuid', items: [] }],
    ];
    for (const [url, body] of bad) {
      const res = await as(owner).post(url, body);
      expect(
        res.status,
        `${url} ${JSON.stringify(body)} → ${JSON.stringify(res.body)}`,
      ).toBe(400);
    }
    await as(owner).get('/invoices/no-es-uuid').expect(400);
    await as(owner).get('/invoices?page=0').expect(400);
    await as(owner).get('/invoices?pageSize=101').expect(400);
    await as(owner).get('/invoices?status=pagado').expect(400);
    await as(owner).get('/invoices?from=2026-02-30').expect(400);
    await as(owner).get('/reports/sales-summary?tz=Marte/Olimpo').expect(400);
    await as(owner)
      .get('/reports/top-products?from=2026-03-01&to=2026-02-01')
      .expect(400);
    await as(owner)
      .patch('/products/00000000-0000-4000-8000-000000000000', {})
      .expect(400);
    await as(owner)
      .patch('/products/00000000-0000-4000-8000-000000000000', { price: 1 })
      .expect(404);
  });
});
