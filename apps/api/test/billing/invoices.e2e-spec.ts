import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { sql } from 'kysely';
import { PlanLimitException } from '../../src/platform/plans/plan-limit.exception.js';
import { PlanService } from '../../src/platform/plans/plan.service.js';
import {
  asOwner,
  cleanupBilling,
  connect,
  createBilling,
  createTenant,
  type Billing,
  type TestTenant,
} from './helpers.js';

/**
 * Integración contra el Postgres real, como `app_user` y a través de `TenantDb.runAs`:
 * lo que se prueba aquí (RLS, bloqueos, triggers) no existe en un mock.
 */
describe('facturación (integración con Postgres)', () => {
  let b: Billing;
  let a: TestTenant; // tenant principal, IVA 15 %
  let other: TestTenant; // otro negocio, IVA 12 %

  beforeAll(async () => {
    b = await createBilling();
    a = await createTenant('a', '0.15');
    other = await createTenant('b', '0.12');
  });

  afterAll(async () => {
    await b.close();
    await cleanupBilling();
  });

  const item = (unitPrice = '10.00', quantity = '1') => ({
    name: 'Ítem libre',
    unitPrice,
    quantity,
  });
  const draft = (t: TestTenant, items = [item()]) =>
    b.db.runAs(t.tenantId, (trx) =>
      b.invoices.create(trx, t.userId, { items, issue: false }),
    );
  const issue = (t: TestTenant, id: string) =>
    b.db.runAs(t.tenantId, (trx) => b.invoices.issue(trx, t.userId, id));
  const sale = (t: TestTenant, items = [item()]) =>
    b.db.runAs(t.tenantId, (trx) =>
      b.invoices.create(trx, t.userId, { items, issue: true }),
    );
  const pay = (
    t: TestTenant,
    id: string,
    amount: string,
    method: 'cash' | 'transfer' | 'card' = 'cash',
  ) =>
    b.db.runAs(t.tenantId, (trx) =>
      b.payments.create(trx, t.userId, id, { method, amount }),
    );

  describe('secuencial', () => {
    // Tenant propio: el resto de la suite también emite y movería el contador.
    let t: TestTenant;
    beforeAll(async () => {
      t = await createTenant('seq');
    });

    it('30 emisiones concurrentes reciben 1..30, sin huecos ni duplicados', async () => {
      const drafts = await Promise.all(
        Array.from({ length: 30 }, () => draft(t)),
      );
      expect(
        drafts.every((d) => d.number === null && d.status === 'draft'),
      ).toBe(true);

      const issued = await Promise.all(drafts.map((d) => issue(t, d.id)));

      const numbers = issued.map((i) => i.number).sort((x, y) => x! - y!);
      expect(numbers).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
      expect(issued[0].formattedNumber).toMatch(/^001-001-\d{9}$/);
    });

    it('una emisión que falla después de tomar el número no deja hueco', async () => {
      const failed = await draft(t);
      await expect(
        b.db.runAs(t.tenantId, async (trx) => {
          const done = await b.invoices.issue(trx, t.userId, failed.id);
          expect(done.number).toBe(31);
          throw new Error('fallo posterior a la emisión');
        }),
      ).rejects.toThrow('fallo posterior');

      const next = await sale(t);
      expect(next.number).toBe(31);
      // El borrador que falló sigue siendo borrador y se puede emitir después.
      expect((await issue(t, failed.id)).number).toBe(32);
    });

    it('emitir el mismo borrador en paralelo solo funciona una vez y consume un número', async () => {
      const d = await draft(t);
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () => issue(t, d.id)),
      );
      const ok = results.filter((r) => r.status === 'fulfilled');
      const failed = results.filter((r) => r.status === 'rejected');
      expect(ok).toHaveLength(1);
      expect(failed).toHaveLength(7);
      expect(failed.every((r) => r.reason instanceof ConflictException)).toBe(
        true,
      );
      expect((await sale(t)).number).toBe(34); // 33 fue el anterior: no se quemó ninguno
    });

    it('borradores, eliminados y anulados no generan huecos; el anulado conserva su número', async () => {
      const d = await draft(t);
      await b.db.runAs(t.tenantId, (trx) => b.invoices.deleteDraft(trx, d.id));
      const s = await sale(t);
      expect(s.number).toBe(35);
      const voided = await b.db.runAs(t.tenantId, (trx) =>
        b.invoices.void(trx, t.userId, s.id, 'error de digitación'),
      );
      expect(voided).toMatchObject({
        status: 'voided',
        number: 35,
        voidReason: 'error de digitación',
      });
      expect((await sale(t)).number).toBe(36);

      const { rows } = await b.db.runAs(t.tenantId, (trx) =>
        sql<{ n: string; distinct_n: string; max: string }>`
          select count(number) as n, count(distinct number) as distinct_n, max(number) as max from invoices`.execute(
          trx,
        ),
      );
      expect(rows[0]).toEqual({ n: '36', distinct_n: '36', max: '36' });
    });

    it('cada tenant lleva su propio secuencial', async () => {
      const fresh = await createTenant('seq2');
      expect((await sale(fresh)).number).toBe(1);
      expect((await sale(fresh)).number).toBe(2);
    });
  });

  describe('cupo del plan', () => {
    it('al llegar al límite del plan, el rechazo (402) no consume secuencial ni deja hueco', async () => {
      const t = await createTenant('cupo');
      const plan = await b.db.runAs(t.tenantId, (trx) =>
        new PlanService().getPlan(trx),
      );
      const limit = plan.limits.invoicesPerMonth!;
      expect(limit).toBeGreaterThan(0); // el plan inicial (free) tiene tope mensual

      // Cinco emisiones más que el cupo, todas a la vez.
      const drafts = await Promise.all(
        Array.from({ length: limit + 5 }, () => draft(t)),
      );
      const results = await Promise.allSettled(
        drafts.map((d) => issue(t, d.id)),
      );
      const issued = results.flatMap((r) =>
        r.status === 'fulfilled' ? [r.value] : [],
      );
      const rejected = results.flatMap((r) =>
        r.status === 'rejected' ? [r.reason] : [],
      );

      expect(issued).toHaveLength(limit);
      expect(rejected).toHaveLength(5);
      for (const err of rejected) {
        expect(err).toBeInstanceOf(PlanLimitException);
        expect(err.getStatus()).toBe(402);
        expect(err.getResponse()).toMatchObject({
          code: 'PLAN_LIMIT_INVOICES',
          limit,
        });
      }
      // Los emitidos son exactamente 1..límite: los rechazos no quemaron números.
      expect(issued.map((i) => i.number).sort((x, y) => x! - y!)).toEqual(
        Array.from({ length: limit }, (_, i) => i + 1),
      );

      // Los rechazados siguen como borrador, sin número, y el contador quedó en el límite.
      const pending = drafts.filter((d) => !issued.some((i) => i.id === d.id));
      for (const d of pending) {
        expect(
          await b.db.runAs(t.tenantId, (trx) => b.invoices.get(trx, d.id)),
        ).toMatchObject({
          status: 'draft',
          number: null,
        });
      }
      await expect(sale(t)).rejects.toBeInstanceOf(PlanLimitException); // crear y emitir tampoco pasa
      const counter = await b.db.runAs(t.tenantId, (trx) =>
        trx
          .selectFrom('invoice_counters')
          .select('last_number')
          .executeTakeFirstOrThrow(),
      );
      expect(Number(counter.last_number)).toBe(limit);

      // Con un plan sin tope, el siguiente número es límite + 1.
      await asOwner(t.tenantId, (c) =>
        c.query(
          "update subscriptions set plan_code = 'pro' where tenant_id = $1",
          [t.tenantId],
        ),
      );
      expect((await issue(t, pending[0].id)).number).toBe(limit + 1);
    });
  });

  describe('aislamiento entre tenants', () => {
    let invoiceId: string;
    let productId: string;
    let customerId: string;

    beforeAll(async () => {
      const product = await b.db.runAs(a.tenantId, (trx) =>
        b.catalog.createProduct(trx, {
          name: 'Quesadilla',
          kind: 'product',
          price: '3.50',
          taxable: true,
          active: true,
        }),
      );
      const customer = await b.db.runAs(a.tenantId, (trx) =>
        b.customers.create(trx, {
          name: 'Ana Pérez',
          identificationType: 'cedula',
          identification: '0102030405',
        }),
      );
      productId = product.id;
      customerId = customer.id;
      const invoice = await b.db.runAs(a.tenantId, (trx) =>
        b.invoices.create(trx, a.userId, {
          customerId,
          items: [{ productId, quantity: '2' }],
          issue: true,
        }),
      );
      invoiceId = invoice.id;
      await pay(a, invoiceId, '5.00');
    });

    it('el dueño ve su comprobante', async () => {
      const mine = await b.db.runAs(a.tenantId, (trx) =>
        b.invoices.get(trx, invoiceId),
      );
      expect(mine).toMatchObject({
        status: 'issued',
        customerName: 'Ana Pérez',
        total: '8.05',
      });
    });

    it('otro tenant no lo ve en listados ni por id, ni puede operarlo', async () => {
      const asOther = <T>(fn: Parameters<typeof b.db.runAs<T>>[1]) =>
        b.db.runAs(other.tenantId, fn);
      const page = { page: 1, pageSize: 100, tz: 'America/Guayaquil' };

      expect((await asOther((trx) => b.invoices.list(trx, page))).total).toBe(
        0,
      );
      expect(
        (await asOther((trx) => b.catalog.listProducts(trx, page))).total,
      ).toBe(0);
      expect((await asOther((trx) => b.customers.list(trx, page))).total).toBe(
        0,
      );

      await expect(
        asOther((trx) => b.invoices.get(trx, invoiceId)),
      ).rejects.toThrow(NotFoundException);
      await expect(
        asOther((trx) =>
          b.invoices.void(trx, other.userId, invoiceId, 'no es mío'),
        ),
      ).rejects.toThrow(NotFoundException);
      await expect(
        asOther((trx) => b.payments.listForInvoice(trx, invoiceId)),
      ).rejects.toThrow(NotFoundException);
      await expect(
        asOther((trx) =>
          b.payments.create(trx, other.userId, invoiceId, {
            method: 'cash',
            amount: '1.00',
          }),
        ),
      ).rejects.toThrow(NotFoundException);
      await expect(
        asOther((trx) => b.catalog.getProduct(trx, productId)),
      ).rejects.toThrow(NotFoundException);
      await expect(
        asOther((trx) => b.customers.get(trx, customerId)),
      ).rejects.toThrow(NotFoundException);

      // Tampoco puede vender productos ni facturar a clientes ajenos.
      await expect(
        asOther((trx) =>
          b.invoices.create(trx, other.userId, {
            items: [{ productId, quantity: '1' }],
            issue: false,
          }),
        ),
      ).rejects.toThrow(/el producto no existe/);
      await expect(
        asOther((trx) =>
          b.invoices.create(trx, other.userId, {
            customerId,
            items: [],
            issue: false,
          }),
        ),
      ).rejects.toThrow(/El cliente indicado no existe/);

      // Y no sigue ahí después de intentarlo.
      expect(
        (await b.db.runAs(a.tenantId, (trx) => b.invoices.get(trx, invoiceId)))
          .status,
      ).toBe('issued');
    });

    it('con SQL directo, RLS devuelve cero filas de todas las tablas y vistas', async () => {
      const tables = [
        'invoices',
        'invoice_items',
        'payments',
        'products',
        'customers',
        'invoice_counters',
        'v_ventas',
        'v_productos_vendidos',
      ];
      for (const [tenant, expectRows] of [
        [a, true],
        [other, false],
      ] as const) {
        for (const table of tables) {
          const { rows } = await b.db.runAs(tenant.tenantId, (trx) =>
            sql<{
              n: string;
            }>`select count(*) as n from ${sql.table(table)}`.execute(trx),
          );
          expect(
            Number(rows[0].n) > 0,
            `${table} visto por ${expectRows ? 'su dueño' : 'otro tenant'}`,
          ).toBe(expectRows);
        }
      }
    });

    it('con SQL directo no se puede escribir en otro tenant ni referenciar sus filas', async () => {
      const client = await connect('app_user');
      const asOtherSql = async (text: string, params: unknown[]) => {
        await client.query('begin');
        await client.query("select set_config('app.tenant_id', $1, true)", [
          other.tenantId,
        ]);
        try {
          return await client.query(text, params);
        } finally {
          await client.query('rollback');
        }
      };
      try {
        // Insertar declarando el tenant ajeno: lo bloquea WITH CHECK.
        await expect(
          asOtherSql(
            `insert into products (tenant_id, name, price) values ($1, 'intruso', 1)`,
            [a.tenantId],
          ),
        ).rejects.toThrow(/row-level security/);
        // Colgar un ítem o un pago del comprobante ajeno: FK compuesta (tenant_id, id).
        await expect(
          asOtherSql(
            `insert into invoice_items (invoice_id, position, name, unit_price, quantity, taxable, line_subtotal)
             values ($1, 99, 'intruso', 1, 1, false, 1)`,
            [invoiceId],
          ),
        ).rejects.toThrow(/foreign key/);
        await expect(
          asOtherSql(
            `insert into payments (invoice_id, method, amount, created_by) values ($1, 'cash', 1, $2)`,
            [invoiceId, other.userId],
          ),
        ).rejects.toThrow(/foreign key/);
        // UPDATE y DELETE no encuentran la fila.
        expect(
          (
            await asOtherSql(`update invoices set notes = 'x' where id = $1`, [
              invoiceId,
            ])
          ).rowCount,
        ).toBe(0);
        expect(
          (
            await asOtherSql(`delete from payments where invoice_id = $1`, [
              invoiceId,
            ])
          ).rowCount,
        ).toBe(0);

        // Sin tenant fijado (conexión nueva o reutilizada): cero filas, no un error.
        expect(
          (await client.query('select count(*)::int as n from invoices'))
            .rows[0].n,
        ).toBe(0);
      } finally {
        await client.end();
      }
    });
  });

  describe('totales y copia de datos', () => {
    it('calcula con la tasa del tenant y congela nombre y precio del producto', async () => {
      const product = await b.db.runAs(a.tenantId, (trx) =>
        b.catalog.createProduct(trx, {
          name: 'Basta de pantalón',
          kind: 'service',
          price: '4.00',
          taxable: true,
          active: true,
        }),
      );
      const exempt = await b.db.runAs(a.tenantId, (trx) =>
        b.catalog.createProduct(trx, {
          name: 'Agua',
          kind: 'product',
          price: '0.75',
          taxable: false,
          active: true,
        }),
      );
      const invoice = await b.db.runAs(a.tenantId, (trx) =>
        b.invoices.create(trx, a.userId, {
          items: [
            { productId: product.id, quantity: '3', discountPercent: '10' }, // 12.00 − 1.20
            { productId: exempt.id, quantity: '2' }, // 1.50 sin IVA
            {
              name: 'Arreglo a medida',
              unitPrice: '7.33',
              quantity: '1.5',
              discountAmount: '1.00',
            }, // 11.00 (10.995↑) − 1.00
          ],
          issue: true,
        }),
      );
      expect(invoice).toMatchObject({
        taxRate: '0.1500',
        subtotalTaxable: '20.80',
        subtotalExempt: '1.50',
        discountTotal: '2.20',
        taxTotal: '3.12',
        total: '25.42',
        paidTotal: '0.00',
        balance: '25.42',
        paymentStatus: 'unpaid',
      });
      expect(
        invoice.items.map((i) => [
          i.position,
          i.name,
          i.unitPrice,
          i.quantity,
          i.lineSubtotal,
        ]),
      ).toEqual([
        [1, 'Basta de pantalón', '4.00', '3.000', '10.80'],
        [2, 'Agua', '0.75', '2.000', '1.50'],
        [3, 'Arreglo a medida', '7.33', '1.500', '10.00'],
      ]);

      // Cambiar el catálogo después no toca lo vendido.
      await b.db.runAs(a.tenantId, (trx) =>
        b.catalog.updateProduct(trx, product.id, {
          name: 'Basta (precio nuevo)',
          price: '9.99',
        }),
      );
      const again = await b.db.runAs(a.tenantId, (trx) =>
        b.invoices.get(trx, invoice.id),
      );
      expect(again.items[0]).toMatchObject({
        name: 'Basta de pantalón',
        unitPrice: '4.00',
      });
      expect(again.total).toBe('25.42');

      // Un producto con ventas no se puede borrar, solo desactivar; inactivo no se vende.
      await expect(
        b.db.runAs(a.tenantId, (trx) =>
          b.catalog.deleteProduct(trx, product.id),
        ),
      ).rejects.toThrow(ConflictException);
      await b.db.runAs(a.tenantId, (trx) =>
        b.catalog.updateProduct(trx, product.id, { active: false }),
      );
      await expect(
        b.db.runAs(a.tenantId, (trx) =>
          b.invoices.create(trx, a.userId, {
            items: [{ productId: product.id, quantity: '1' }],
            issue: false,
          }),
        ),
      ).rejects.toThrow(/inactivo/);
    });

    it('otro tenant aplica su propia tasa', async () => {
      const invoice = await sale(other, [item('100.00')]);
      expect(invoice).toMatchObject({
        taxRate: '0.1200',
        taxTotal: '12.00',
        total: '112.00',
      });
    });

    it('al emitir se recalcula con la tasa vigente y se copia el cliente', async () => {
      const t = await createTenant('tasa', '0.12');
      const customer = await b.db.runAs(t.tenantId, (trx) =>
        b.customers.create(trx, {
          name: 'Luis',
          identificationType: 'ruc',
          identification: '1790011223001',
        }),
      );
      const d = await b.db.runAs(t.tenantId, (trx) =>
        b.invoices.create(trx, t.userId, {
          customerId: customer.id,
          items: [item('100.00')],
          issue: false,
        }),
      );
      expect(d).toMatchObject({
        taxRate: '0.1200',
        total: '112.00',
        paymentStatus: null,
      });

      // Sube el IVA y el cliente cambia de nombre antes de emitir.
      await asOwner(t.tenantId, (c) =>
        c.query('update tenants set tax_rate = 0.15 where id = $1', [
          t.tenantId,
        ]),
      );
      await b.db.runAs(t.tenantId, (trx) =>
        b.customers.update(trx, customer.id, { name: 'Luis Mora' }),
      );
      const issued = await issue(t, d.id);
      expect(issued).toMatchObject({
        taxRate: '0.1500',
        taxTotal: '15.00',
        total: '115.00',
        customerName: 'Luis Mora',
        customerIdentification: '1790011223001',
      });

      // Después de emitido, ni la tasa ni el cliente lo alteran.
      await asOwner(t.tenantId, (c) =>
        c.query('update tenants set tax_rate = 0.20 where id = $1', [
          t.tenantId,
        ]),
      );
      await b.db.runAs(t.tenantId, (trx) =>
        b.customers.update(trx, customer.id, { name: 'Otro nombre' }),
      );
      const later = await b.db.runAs(t.tenantId, (trx) =>
        b.invoices.get(trx, d.id),
      );
      expect(later).toMatchObject({
        taxRate: '0.1500',
        total: '115.00',
        customerName: 'Luis Mora',
      });
      await expect(
        b.db.runAs(t.tenantId, (trx) => b.customers.delete(trx, customer.id)),
      ).rejects.toThrow(ConflictException);
    });

    it('no se emite un comprobante sin ítems', async () => {
      const d = await draft(a, []);
      await expect(issue(a, d.id)).rejects.toThrow(BadRequestException);
    });
  });

  describe('inmutabilidad', () => {
    it('un borrador se edita y se elimina', async () => {
      const d = await draft(a);
      const edited = await b.db.runAs(a.tenantId, (trx) =>
        b.invoices.replace(trx, d.id, {
          items: [item('2.00', '4'), item('1.00')],
          notes: 'para llevar',
        }),
      );
      expect(edited).toMatchObject({
        status: 'draft',
        subtotalTaxable: '9.00',
        total: '10.35',
        notes: 'para llevar',
      });
      expect(edited.items).toHaveLength(2);
      await b.db.runAs(a.tenantId, (trx) => b.invoices.deleteDraft(trx, d.id));
      await expect(
        b.db.runAs(a.tenantId, (trx) => b.invoices.get(trx, d.id)),
      ).rejects.toThrow(NotFoundException);
    });

    it('un emitido no se edita, no se elimina y no se vuelve a emitir; solo se anula una vez', async () => {
      const s = await sale(a);
      const run = <T>(fn: Parameters<typeof b.db.runAs<T>>[1]) =>
        b.db.runAs(a.tenantId, fn);
      await expect(
        run((trx) => b.invoices.replace(trx, s.id, { items: [item('1.00')] })),
      ).rejects.toThrow(ConflictException);
      await expect(
        run((trx) => b.invoices.deleteDraft(trx, s.id)),
      ).rejects.toThrow(ConflictException);
      await expect(issue(a, s.id)).rejects.toThrow(ConflictException);

      const voided = await run((trx) =>
        b.invoices.void(trx, a.userId, s.id, 'cliente desistió'),
      );
      expect(voided).toMatchObject({
        status: 'voided',
        total: s.total,
        number: s.number,
        paymentStatus: null,
      });
      expect(voided.items).toEqual(s.items);
      await expect(
        run((trx) => b.invoices.void(trx, a.userId, s.id, 'otra vez')),
      ).rejects.toThrow(ConflictException);
      await expect(pay(a, s.id, '1.00')).rejects.toThrow(ConflictException);
    });

    it('la base lo impide aunque se salte el servicio (triggers)', async () => {
      const s = await sale(a);
      const raw = (query: ReturnType<typeof sql>) =>
        b.db.runAs(a.tenantId, (trx) => query.execute(trx));
      const blocked = { code: 'BL001' };

      await expect(
        raw(
          sql`update invoices set total = 0, subtotal_taxable = 0, tax_total = 0 where id = ${s.id}`,
        ),
      ).rejects.toMatchObject(blocked);
      await expect(
        raw(sql`update invoices set number = 999999 where id = ${s.id}`),
      ).rejects.toMatchObject(blocked);
      await expect(
        raw(sql`update invoices set customer_name = 'otro' where id = ${s.id}`),
      ).rejects.toMatchObject(blocked);
      await expect(
        raw(
          sql`update invoices set status = 'draft', number = null, issued_at = null where id = ${s.id}`,
        ),
      ).rejects.toMatchObject(blocked);
      await expect(
        raw(sql`delete from invoices where id = ${s.id}`),
      ).rejects.toMatchObject(blocked);
      await expect(
        raw(
          sql`update invoice_items set unit_price = 0.01 where invoice_id = ${s.id}`,
        ),
      ).rejects.toMatchObject(blocked);
      await expect(
        raw(sql`delete from invoice_items where invoice_id = ${s.id}`),
      ).rejects.toMatchObject(blocked);
      await expect(
        raw(sql`insert into invoice_items (invoice_id, position, name, unit_price, quantity, taxable, line_subtotal)
                values (${s.id}, 50, 'colado', 1, 1, false, 1)`),
      ).rejects.toMatchObject(blocked);

      // Los campos reservados al SRI sí se pueden completar después.
      await raw(
        sql`update invoices set sri_status = 'AUTORIZADO', sri_access_key = '0'::text where id = ${s.id}`,
      );

      // Anulado: ya nada cambia, ni siquiera el motivo.
      await b.db.runAs(a.tenantId, (trx) =>
        b.invoices.void(trx, a.userId, s.id, 'prueba'),
      );
      await expect(
        raw(sql`update invoices set void_reason = 'otro' where id = ${s.id}`),
      ).rejects.toMatchObject(blocked);
      await expect(
        raw(
          sql`update invoices set status = 'issued', voided_at = null where id = ${s.id}`,
        ),
      ).rejects.toMatchObject(blocked);

      const after = await b.db.runAs(a.tenantId, (trx) =>
        b.invoices.get(trx, s.id),
      );
      expect(after).toMatchObject({
        total: s.total,
        number: s.number,
        voidReason: 'prueba',
      });
      expect(after.items).toEqual(s.items);
    });
  });

  describe('pagos', () => {
    it('saldo y estado derivados: pendiente → parcial → pagado', async () => {
      const s = await sale(a, [item('20.00')]); // total 23.00
      expect(s).toMatchObject({
        total: '23.00',
        balance: '23.00',
        paymentStatus: 'unpaid',
      });

      await pay(a, s.id, '10.00', 'cash');
      const partial = await b.db.runAs(a.tenantId, (trx) =>
        b.invoices.get(trx, s.id),
      );
      expect(partial).toMatchObject({
        paidTotal: '10.00',
        balance: '13.00',
        paymentStatus: 'partial',
      });

      await expect(pay(a, s.id, '13.01', 'card')).rejects.toThrow(
        /supera el saldo pendiente \(13\.00\)/,
      );
      await pay(a, s.id, '13.00', 'transfer');
      const paid = await b.db.runAs(a.tenantId, (trx) =>
        b.invoices.get(trx, s.id),
      );
      expect(paid).toMatchObject({
        paidTotal: '23.00',
        balance: '0.00',
        paymentStatus: 'paid',
      });
      await expect(pay(a, s.id, '0.01')).rejects.toThrow(ConflictException);

      const payments = await b.db.runAs(a.tenantId, (trx) =>
        b.payments.listForInvoice(trx, s.id),
      );
      expect(payments.map((p) => [p.method, p.amount])).toEqual([
        ['cash', '10.00'],
        ['transfer', '13.00'],
      ]);

      // Reversar un pago devuelve el saldo.
      await b.db.runAs(a.tenantId, (trx) =>
        b.payments.delete(trx, payments[1].id),
      );
      const reopened = await b.db.runAs(a.tenantId, (trx) =>
        b.invoices.get(trx, s.id),
      );
      expect(reopened).toMatchObject({
        balance: '13.00',
        paymentStatus: 'partial',
      });

      // El filtro por estado de pago del listado coincide con lo derivado.
      const list = (paymentStatus: 'unpaid' | 'partial' | 'paid') =>
        b.db.runAs(a.tenantId, (trx) =>
          b.invoices.list(trx, {
            page: 1,
            pageSize: 100,
            tz: 'UTC',
            paymentStatus,
          }),
        );
      expect((await list('partial')).data.map((i) => i.id)).toContain(s.id);
      expect((await list('paid')).data.map((i) => i.id)).not.toContain(s.id);
      for (const status of ['unpaid', 'partial', 'paid'] as const) {
        expect(
          (await list(status)).data.every((i) => i.paymentStatus === status),
        ).toBe(true);
      }
    });

    it('no se cobra un borrador', async () => {
      const d = await draft(a);
      await expect(pay(a, d.id, '1.00')).rejects.toThrow(ConflictException);
    });

    it('cobros simultáneos no superan el total', async () => {
      const s = await sale(a, [item('10.00')]); // total 11.50
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () => pay(a, s.id, '3.00')),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
      const after = await b.db.runAs(a.tenantId, (trx) =>
        b.invoices.get(trx, s.id),
      );
      expect(after).toMatchObject({
        paidTotal: '9.00',
        balance: '2.50',
        paymentStatus: 'partial',
      });
    });
  });

  describe('reportes', () => {
    let t: TestTenant;
    const tz = 'America/Guayaquil';

    beforeAll(async () => {
      t = await createTenant('rep', '0.15');
      const create = (name: string, price: string) =>
        b.db.runAs(t.tenantId, (trx) =>
          b.catalog.createProduct(trx, {
            name,
            kind: 'product',
            price,
            taxable: true,
            active: true,
          }),
        );
      const quesadilla = await create('Quesadilla', '4.00');
      const jugo = await create('Jugo', '1.00');

      // Hoy: 2 ventas (5 quesadillas + 3 jugos; 1 quesadilla), una anulada y un borrador.
      const s1 = await b.db.runAs(t.tenantId, (trx) =>
        b.invoices.create(trx, t.userId, {
          items: [
            { productId: quesadilla.id, quantity: '5' },
            { productId: jugo.id, quantity: '3' },
          ],
          issue: true,
        }),
      ); // 23.00 + 3.45 = 26.45
      const s2 = await b.db.runAs(t.tenantId, (trx) =>
        b.invoices.create(trx, t.userId, {
          items: [{ productId: quesadilla.id, quantity: '1' }],
          issue: true,
        }),
      ); // 4.60
      const anulada = await b.db.runAs(t.tenantId, (trx) =>
        b.invoices.create(trx, t.userId, {
          items: [{ productId: jugo.id, quantity: '100' }],
          issue: true,
        }),
      );
      await pay(t, anulada.id, '50.00', 'card');
      await b.db.runAs(t.tenantId, (trx) =>
        b.invoices.void(trx, t.userId, anulada.id, 'pedido cancelado'),
      );
      await b.db.runAs(t.tenantId, (trx) =>
        b.invoices.create(trx, t.userId, {
          items: [{ productId: jugo.id, quantity: '100' }],
          issue: false,
        }),
      );
      await pay(t, s1.id, '20.00', 'cash');
      await pay(t, s1.id, '6.45', 'transfer');
      await pay(t, s2.id, '4.60', 'cash');

      // Mes anterior: una venta al inicio del mes y otra al final (fechas puestas por el dueño).
      const early = await sale(t, [item('10.00')]); // 11.50
      const late = await sale(t, [item('20.00')]); // 23.00
      await asOwner(t.tenantId, async (c) => {
        const monthStart = `date_trunc('month', now() at time zone '${tz}')`;
        await c.query(
          `update invoices set issued_at = (${monthStart} - interval '1 month' + interval '1 minute') at time zone '${tz}' where id = $1`,
          [early.id],
        );
        await c.query(
          `update invoices set issued_at = (${monthStart} - interval '1 minute') at time zone '${tz}' where id = $1`,
          [late.id],
        );
      });
    });

    it('ventas de hoy, del mes y comparación con el mes anterior', async () => {
      const summary = await b.db.runAs(t.tenantId, (trx) =>
        b.reports.summary(trx, { tz }),
      );
      expect(summary.today).toEqual({ count: 2, total: '31.05' });
      expect(summary.month).toEqual({ count: 2, total: '31.05' });
      expect(summary.previousMonth).toEqual({ count: 2, total: '34.50' });
      // A la misma altura del mes anterior solo existía la primera venta
      // (salvo que este test corra en el último minuto del mes).
      expect(summary.previousMonthToDate).toEqual({ count: 1, total: '11.50' });
      expect(summary.changePercent).toBe('170.00'); // (31.05 − 11.50) / 11.50
    });

    it('sin ventas: ceros y sin porcentaje', async () => {
      const empty = await createTenant('rep-vacio');
      const summary = await b.db.runAs(empty.tenantId, (trx) =>
        b.reports.summary(trx, { tz }),
      );
      expect(summary).toMatchObject({
        today: { count: 0, total: '0.00' },
        month: { count: 0, total: '0.00' },
        previousMonth: { count: 0, total: '0.00' },
        changePercent: null,
      });
      const top = await b.db.runAs(empty.tenantId, (trx) =>
        b.reports.topProducts(trx, { tz, limit: 10, sortBy: 'revenue' }),
      );
      expect(top.data).toEqual([]);
      expect(top.from <= top.to).toBe(true);
    });

    it('top de productos del mes: solo emitidos, por ingresos o por cantidad', async () => {
      const top = await b.db.runAs(t.tenantId, (trx) =>
        b.reports.topProducts(trx, { tz, limit: 10, sortBy: 'revenue' }),
      );
      expect(
        top.data.map((p) => [p.name, p.quantity, p.revenue, p.invoiceCount]),
      ).toEqual([
        ['Quesadilla', '6.000', '24.00', 2],
        ['Jugo', '3.000', '3.00', 1],
      ]);
      const first = await b.db.runAs(t.tenantId, (trx) =>
        b.reports.topProducts(trx, { tz, limit: 1, sortBy: 'quantity' }),
      );
      expect(first.data.map((p) => p.name)).toEqual(['Quesadilla']);
    });

    it('ventas por método de pago: excluye pagos de comprobantes anulados', async () => {
      const report = await b.db.runAs(t.tenantId, (trx) =>
        b.reports.paymentMethods(trx, { tz }),
      );
      expect(report.data).toEqual([
        { method: 'cash', count: 2, total: '24.60' },
        { method: 'transfer', count: 1, total: '6.45' },
        { method: 'card', count: 0, total: '0.00' },
      ]);
    });

    it('un rango sin movimiento devuelve vacío', async () => {
      const range = { tz, from: '2001-01-01', to: '2001-01-31' };
      const top = await b.db.runAs(t.tenantId, (trx) =>
        b.reports.topProducts(trx, { ...range, limit: 10, sortBy: 'revenue' }),
      );
      expect(top).toMatchObject({
        from: '2001-01-01',
        to: '2001-01-31',
        data: [],
      });
      const methods = await b.db.runAs(t.tenantId, (trx) =>
        b.reports.paymentMethods(trx, range),
      );
      expect(
        methods.data.every((m) => m.count === 0 && m.total === '0.00'),
      ).toBe(true);
    });

    describe('vistas curadas para ai_readonly', () => {
      const asAi = async <T>(
        tenantId: string | null,
        fn: (q: (text: string) => Promise<any[]>) => Promise<T>,
      ) => {
        const client = await connect('ai_readonly');
        try {
          await client.query('begin');
          if (tenantId)
            await client.query("select set_config('app.tenant_id', $1, true)", [
              tenantId,
            ]);
          return await fn(async (text) => (await client.query(text)).rows);
        } finally {
          await client.query('rollback').catch(() => undefined);
          await client.end();
        }
      };

      it('v_ventas y v_productos_vendidos muestran solo lo emitido del tenant fijado', async () => {
        await asAi(t.tenantId, async (q) => {
          const ventas = await q(
            `select numero, cliente, subtotal, iva, total, pagado, saldo, estado_pago from v_ventas where fecha_emision >= date_trunc('month', now() at time zone '${tz}') at time zone '${tz}' order by numero`,
          );
          expect(ventas).toEqual([
            {
              numero: '001-001-000000001',
              cliente: 'Consumidor final',
              subtotal: '23.00',
              iva: '3.45',
              total: '26.45',
              pagado: '26.45',
              saldo: '0.00',
              estado_pago: 'pagado',
            },
            {
              numero: '001-001-000000002',
              cliente: 'Consumidor final',
              subtotal: '4.00',
              iva: '0.60',
              total: '4.60',
              pagado: '4.60',
              saldo: '0.00',
              estado_pago: 'pagado',
            },
          ]);
          const productos = await q(
            `select producto, sum(cantidad) as cantidad, sum(subtotal) as subtotal from v_productos_vendidos where producto_id is not null group by producto order by producto`,
          );
          expect(productos).toEqual([
            { producto: 'Jugo', cantidad: '3.000', subtotal: '3.00' },
            { producto: 'Quesadilla', cantidad: '6.000', subtotal: '24.00' },
          ]);
        });
      });

      it('otro tenant, o ninguno, no ve esas filas', async () => {
        const count = (q: (text: string) => Promise<any[]>) =>
          q('select count(*)::int as n from v_ventas').then((r) => r[0].n);
        expect(await asAi(t.tenantId, count)).toBe(4);
        expect(
          await asAi((await createTenant('rep-ajeno')).tenantId, count),
        ).toBe(0);
        expect(await asAi(null, count)).toBe(0);
      });

      it('ai_readonly no puede leer tablas ni columnas fuera de las vistas, ni escribir', async () => {
        const denied = /permission denied/;
        for (const text of [
          'select * from invoices',
          'select notes from invoices',
          'select created_by from invoices',
          'select * from customers',
          'select email from customers',
          'select reference from payments',
          'select price from products',
          'select * from tenants',
          'select * from users',
          `update invoices set status = 'voided'`,
          'delete from payments',
          `insert into categories (name) values ('x')`,
        ]) {
          await expect(
            asAi(t.tenantId, (q) => q(text)),
            text,
          ).rejects.toThrow(denied);
        }
      });
    });
  });
});
