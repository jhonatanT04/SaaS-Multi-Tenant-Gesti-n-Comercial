import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql, type Selectable, type Transaction } from 'kysely';
import type { DB } from '../../platform/db/schema.js';
import { PlanService } from '../../platform/plans/plan.service.js';
import type {
  InvoiceItemsTable,
  InvoicesTable,
  InvoiceStatus,
} from '../billing.tables.js';
import { rethrowPgError } from '../common/pg-errors.js';
import { offsetOf, toPage, type Page } from '../common/schemas.js';
import { likeContains, startOfDay, startOfNextDay } from '../common/sql.js';
import {
  computeTotals,
  paymentSummary,
  TotalsError,
  type InvoiceTotals,
  type LineInput,
  type PaymentStatus,
} from './invoice-totals.js';
import type {
  CreateInvoiceBody,
  InvoiceItemInput,
  ListInvoicesQuery,
  ReplaceInvoiceBody,
} from './invoices.schemas.js';

export interface InvoiceItemDto {
  id: string;
  position: number;
  productId: string | null;
  name: string;
  unitPrice: string;
  quantity: string;
  discountAmount: string;
  taxable: boolean;
  lineSubtotal: string;
}

export interface InvoiceDto {
  id: string;
  status: InvoiceStatus;
  establishment: string;
  emissionPoint: string;
  /** Secuencial; null mientras es borrador. */
  number: number | null;
  /** '001-001-000000123'; null mientras es borrador. */
  formattedNumber: string | null;
  customerId: string | null;
  customerName: string | null;
  customerIdentification: string | null;
  taxRate: string;
  subtotalTaxable: string;
  subtotalExempt: string;
  discountTotal: string;
  taxTotal: string;
  total: string;
  paidTotal: string;
  balance: string;
  /** Solo tiene sentido en emitidos; null en borradores y anulados. */
  paymentStatus: PaymentStatus | null;
  notes: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  issuedAt: Date | null;
  issuedBy: string | null;
  voidedAt: Date | null;
  voidedBy: string | null;
  voidReason: string | null;
}

export interface InvoiceDetailDto extends InvoiceDto {
  items: InvoiceItemDto[];
}

type InvoiceRow = Selectable<InvoicesTable>;

/** Suma de pagos de la fila actual de `invoices` (subconsulta correlacionada). */
const PAID_TOTAL = sql<string>`(select coalesce(sum(pay.amount), 0)::numeric(12,2) from payments pay where pay.invoice_id = invoices.id)`;

const INVOICE_ERRORS = {
  invoices_tenant_id_customer_id_fkey: new BadRequestException(
    'El cliente indicado no existe',
  ),
};

function toItem(row: Selectable<InvoiceItemsTable>): InvoiceItemDto {
  return {
    id: row.id,
    position: row.position,
    productId: row.product_id,
    name: row.name,
    unitPrice: row.unit_price,
    quantity: row.quantity,
    discountAmount: row.discount_amount,
    taxable: row.taxable,
    lineSubtotal: row.line_subtotal,
  };
}

export function formatInvoiceNumber(
  establishment: string,
  emissionPoint: string,
  number: number,
) {
  return `${establishment}-${emissionPoint}-${String(number).padStart(9, '0')}`;
}

function toInvoice(row: InvoiceRow, paidTotal: string): InvoiceDto {
  const number = row.number === null ? null : Number(row.number);
  const payment = paymentSummary(row.total, paidTotal);
  return {
    id: row.id,
    status: row.status,
    establishment: row.establishment,
    emissionPoint: row.emission_point,
    number,
    formattedNumber:
      number === null
        ? null
        : formatInvoiceNumber(row.establishment, row.emission_point, number),
    customerId: row.customer_id,
    customerName: row.customer_name,
    customerIdentification: row.customer_identification,
    taxRate: row.tax_rate,
    subtotalTaxable: row.subtotal_taxable,
    subtotalExempt: row.subtotal_exempt,
    discountTotal: row.discount_total,
    taxTotal: row.tax_total,
    total: row.total,
    paidTotal: payment.paidTotal,
    balance: payment.balance,
    paymentStatus: row.status === 'issued' ? payment.paymentStatus : null,
    notes: row.notes,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    issuedAt: row.issued_at,
    issuedBy: row.issued_by,
    voidedAt: row.voided_at,
    voidedBy: row.voided_by,
    voidReason: row.void_reason,
  };
}

function totalsOrBadRequest(
  lines: LineInput[],
  taxRate: string,
): InvoiceTotals {
  try {
    return computeTotals(lines, taxRate);
  } catch (err) {
    if (err instanceof TotalsError) throw new BadRequestException(err.message);
    throw err;
  }
}

function totalsColumns(totals: InvoiceTotals, taxRate: string) {
  return {
    tax_rate: taxRate,
    subtotal_taxable: totals.subtotalTaxable,
    subtotal_exempt: totals.subtotalExempt,
    discount_total: totals.discountTotal,
    tax_total: totals.taxTotal,
    total: totals.total,
  };
}

/**
 * Comprobantes: borrador → emitido → anulado.
 *
 * Todos los métodos reciben la transacción de `TenantDb` (RLS ya aplicado). Las
 * mutaciones bloquean primero la fila del comprobante (FOR UPDATE), de modo que
 * editar, emitir, anular y cobrar el mismo comprobante se serializan.
 */
@Injectable()
export class InvoicesService {
  constructor(private readonly plans: PlanService) {}

  async list(
    trx: Transaction<DB>,
    query: ListInvoicesQuery,
  ): Promise<Page<InvoiceDto>> {
    let base = trx.selectFrom('invoices');
    if (query.status) base = base.where('status', '=', query.status);
    if (query.customerId)
      base = base.where('customer_id', '=', query.customerId);
    if (query.q) {
      const term = likeContains(query.q);
      const exactNumber = /^\d{1,15}$/.test(query.q) ? query.q : null;
      base = base.where((eb) =>
        eb.or([
          eb('customer_name', 'ilike', term),
          eb('customer_identification', 'ilike', term),
          ...(exactNumber ? [eb('number', '=', exactNumber)] : []),
        ]),
      );
    }
    if (query.paymentStatus) {
      base = base.where('status', '=', 'issued');
      if (query.paymentStatus === 'paid')
        base = base.where(sql<boolean>`${PAID_TOTAL} >= invoices.total`);
      if (query.paymentStatus === 'partial') {
        base = base.where(
          sql<boolean>`${PAID_TOTAL} > 0 and ${PAID_TOTAL} < invoices.total`,
        );
      }
      if (query.paymentStatus === 'unpaid') {
        base = base.where(
          sql<boolean>`${PAID_TOTAL} = 0 and invoices.total > 0`,
        );
      }
    }
    const when = sql<Date>`coalesce(invoices.issued_at, invoices.created_at)`;
    if (query.from)
      base = base.where(
        sql<boolean>`${when} >= ${startOfDay(query.from, query.tz)}`,
      );
    if (query.to)
      base = base.where(
        sql<boolean>`${when} < ${startOfNextDay(query.to, query.tz)}`,
      );

    const [rows, count] = await Promise.all([
      base
        .selectAll('invoices')
        .select(PAID_TOTAL.as('paid_total'))
        .orderBy(when, 'desc')
        .orderBy('invoices.id')
        .limit(query.pageSize)
        .offset(offsetOf(query))
        .execute(),
      base
        .select((eb) => eb.fn.countAll<string>().as('total'))
        .executeTakeFirstOrThrow(),
    ]);
    return toPage(
      rows.map(({ paid_total, ...row }) => toInvoice(row, paid_total)),
      count.total,
      query,
    );
  }

  async get(trx: Transaction<DB>, id: string): Promise<InvoiceDetailDto> {
    const row = await trx
      .selectFrom('invoices')
      .selectAll('invoices')
      .select(PAID_TOTAL.as('paid_total'))
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Comprobante no encontrado');
    const items = await trx
      .selectFrom('invoice_items')
      .selectAll()
      .where('invoice_id', '=', id)
      .orderBy('position')
      .execute();
    const { paid_total, ...invoice } = row;
    return { ...toInvoice(invoice, paid_total), items: items.map(toItem) };
  }

  /** Crea un borrador; con `issue: true` lo emite en la misma transacción. */
  async create(
    trx: Transaction<DB>,
    userId: string,
    body: CreateInvoiceBody,
  ): Promise<InvoiceDetailDto> {
    const taxRate = await this.tenantTaxRate(trx);
    const customer = await this.customerSnapshot(trx, body.customerId ?? null);
    const lines = await this.resolveItems(trx, body.items);
    const totals = totalsOrBadRequest(lines, taxRate);

    const invoice = await trx
      .insertInto('invoices')
      .values({
        ...customer,
        ...totalsColumns(totals, taxRate),
        notes: body.notes ?? null,
        created_by: userId,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
      .catch((err) => rethrowPgError(err, INVOICE_ERRORS));
    await this.insertItems(trx, invoice.id, lines, totals);

    if (body.issue) return this.issue(trx, userId, invoice.id);
    return this.get(trx, invoice.id);
  }

  /** Reemplaza cliente, notas e ítems de un borrador y recalcula sus totales. */
  async replace(
    trx: Transaction<DB>,
    id: string,
    body: ReplaceInvoiceBody,
  ): Promise<InvoiceDetailDto> {
    await this.lockInStatus(
      trx,
      id,
      'draft',
      'Solo se puede editar un comprobante en borrador',
    );
    const taxRate = await this.tenantTaxRate(trx);
    const customer = await this.customerSnapshot(trx, body.customerId ?? null);
    const lines = await this.resolveItems(trx, body.items);
    const totals = totalsOrBadRequest(lines, taxRate);

    await trx
      .deleteFrom('invoice_items')
      .where('invoice_id', '=', id)
      .execute();
    await this.insertItems(trx, id, lines, totals);
    await trx
      .updateTable('invoices')
      .set({
        ...customer,
        ...totalsColumns(totals, taxRate),
        notes: body.notes ?? null,
        updated_at: new Date(),
      })
      .where('id', '=', id)
      .execute()
      .catch((err) => rethrowPgError(err, INVOICE_ERRORS));
    return this.get(trx, id);
  }

  /** Solo borradores: no tienen secuencial, así que eliminarlos no deja huecos. */
  async deleteDraft(trx: Transaction<DB>, id: string): Promise<void> {
    await this.lockInStatus(
      trx,
      id,
      'draft',
      'Solo se puede eliminar un borrador; un emitido se anula',
    );
    await trx
      .deleteFrom('invoices')
      .where('id', '=', id)
      .execute()
      .catch((err) => rethrowPgError(err));
  }

  /**
   * Emite un borrador: congela tasa, totales y datos del cliente, y le asigna el
   * siguiente secuencial de su punto de emisión.
   *
   * El contador se incrementa con un upsert, que bloquea su fila hasta el fin de la
   * transacción: dos emisiones concurrentes del mismo tenant se ponen en fila y
   * nunca obtienen el mismo número; si esta transacción falla, el incremento se
   * revierte con ella y no queda hueco.
   *
   * Antes de tomar el número se reserva el cupo mensual del plan. Si el plan no lo
   * permite, `PlanService` lanza 402 y no se toca el contador: el rechazo no
   * consume secuencial. Orden de bloqueos fijo: comprobante → cupo → contador.
   */
  async issue(
    trx: Transaction<DB>,
    userId: string,
    id: string,
  ): Promise<InvoiceDetailDto> {
    const invoice = await this.lockInStatus(
      trx,
      id,
      'draft',
      'El comprobante ya fue emitido o anulado',
    );
    const items = await trx
      .selectFrom('invoice_items')
      .selectAll()
      .where('invoice_id', '=', id)
      .orderBy('position')
      .execute();
    if (items.length === 0) {
      throw new BadRequestException(
        'No se puede emitir un comprobante sin ítems',
      );
    }

    // Se recalcula con la tasa vigente: el borrador pudo crearse con otra.
    const taxRate = await this.tenantTaxRate(trx);
    const totals = totalsOrBadRequest(
      items.map((item) => ({
        quantity: item.quantity,
        unitPrice: item.unit_price,
        taxable: item.taxable,
        discountAmount: item.discount_amount,
      })),
      taxRate,
    );
    const customer = await this.customerSnapshot(trx, invoice.customer_id);

    await this.plans.consumeInvoiceQuota(trx);

    const counter = await trx
      .insertInto('invoice_counters')
      .values({
        establishment: invoice.establishment,
        emission_point: invoice.emission_point,
        last_number: 1,
      })
      .onConflict((oc) =>
        oc
          .columns(['tenant_id', 'establishment', 'emission_point'])
          .doUpdateSet({ last_number: sql`invoice_counters.last_number + 1` }),
      )
      .returning('last_number')
      .executeTakeFirstOrThrow();

    await trx
      .updateTable('invoices')
      .set({
        ...customer,
        ...totalsColumns(totals, taxRate),
        status: 'issued',
        number: counter.last_number,
        // clock_timestamp(): la hora real tras obtener el contador, para que el
        // orden por fecha de emisión coincida con el orden del secuencial.
        issued_at: sql`clock_timestamp()`,
        issued_by: userId,
        updated_at: new Date(),
      })
      .where('id', '=', id)
      .execute()
      .catch((err) => rethrowPgError(err, INVOICE_ERRORS));
    return this.get(trx, id);
  }

  /** Anula un emitido. Conserva su secuencial y sus pagos como historial. */
  async void(
    trx: Transaction<DB>,
    userId: string,
    id: string,
    reason: string,
  ): Promise<InvoiceDetailDto> {
    await this.lockInStatus(
      trx,
      id,
      'issued',
      'Solo se puede anular un comprobante emitido',
    );
    await trx
      .updateTable('invoices')
      .set({
        status: 'voided',
        voided_at: new Date(),
        voided_by: userId,
        void_reason: reason,
        updated_at: new Date(),
      })
      .where('id', '=', id)
      .execute()
      .catch((err) => rethrowPgError(err));
    return this.get(trx, id);
  }

  /** Bloquea el comprobante y exige un estado; 404 si no existe (o es de otro tenant). */
  async lockInStatus(
    trx: Transaction<DB>,
    id: string,
    status: InvoiceStatus,
    conflictMessage: string,
  ): Promise<InvoiceRow> {
    const invoice = await trx
      .selectFrom('invoices')
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!invoice) throw new NotFoundException('Comprobante no encontrado');
    if (invoice.status !== status) throw new ConflictException(conflictMessage);
    return invoice;
  }

  private async tenantTaxRate(trx: Transaction<DB>): Promise<string> {
    const tenant = await trx
      .selectFrom('tenants')
      .select('tax_rate')
      .where('id', '=', sql<string>`app_tenant_id()`)
      .executeTakeFirst();
    if (!tenant) throw new Error('No se encontró el tenant de la transacción');
    return tenant.tax_rate;
  }

  private async customerSnapshot(
    trx: Transaction<DB>,
    customerId: string | null,
  ) {
    if (!customerId) {
      return {
        customer_id: null,
        customer_name: null,
        customer_identification: null,
      };
    }
    const customer = await trx
      .selectFrom('customers')
      .select(['id', 'name', 'identification'])
      .where('id', '=', customerId)
      .executeTakeFirst();
    if (!customer)
      throw new BadRequestException('El cliente indicado no existe');
    return {
      customer_id: customer.id,
      customer_name: customer.name,
      customer_identification: customer.identification,
    };
  }

  /** Completa cada ítem con la copia de nombre, precio e IVA del producto. */
  private async resolveItems(trx: Transaction<DB>, items: InvoiceItemInput[]) {
    const productIds = [
      ...new Set(items.flatMap((item) => item.productId ?? [])),
    ];
    const products = productIds.length
      ? await trx
          .selectFrom('products')
          .select(['id', 'name', 'price', 'taxable', 'active'])
          .where('id', 'in', productIds)
          .execute()
      : [];
    const byId = new Map(products.map((p) => [p.id, p]));

    return items.map((item, index) => {
      const discount = {
        quantity: item.quantity,
        discountAmount: item.discountAmount ?? null,
        discountPercent: item.discountPercent ?? null,
      };
      if (!item.productId) {
        return {
          ...discount,
          productId: null,
          name: item.name!,
          unitPrice: item.unitPrice!,
          taxable: item.taxable ?? true,
        };
      }
      const product = byId.get(item.productId);
      if (!product)
        throw new BadRequestException(
          `ítem ${index + 1}: el producto no existe`,
        );
      if (!product.active) {
        throw new BadRequestException(
          `ítem ${index + 1}: "${product.name}" está inactivo`,
        );
      }
      return {
        ...discount,
        productId: product.id,
        name: product.name,
        unitPrice: item.unitPrice ?? product.price,
        taxable: product.taxable,
      };
    });
  }

  private async insertItems(
    trx: Transaction<DB>,
    invoiceId: string,
    lines: Awaited<ReturnType<InvoicesService['resolveItems']>>,
    totals: InvoiceTotals,
  ): Promise<void> {
    if (lines.length === 0) return;
    await trx
      .insertInto('invoice_items')
      .values(
        lines.map((line, index) => ({
          invoice_id: invoiceId,
          position: index + 1,
          product_id: line.productId,
          name: line.name,
          unit_price: line.unitPrice,
          quantity: line.quantity,
          discount_amount: totals.lines[index].discountAmount,
          taxable: line.taxable,
          line_subtotal: totals.lines[index].lineSubtotal,
        })),
      )
      .execute()
      .catch((err) => rethrowPgError(err));
  }
}
