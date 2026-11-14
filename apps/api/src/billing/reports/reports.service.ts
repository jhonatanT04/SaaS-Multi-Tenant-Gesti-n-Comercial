import { Injectable } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import type { DB } from '../../platform/db/schema.js';
import type { PaymentMethod } from '../billing.tables.js';
import type {
  PaymentMethodsQuery,
  SummaryQuery,
  TopProductsQuery,
} from './reports.schemas.js';

export interface SalesFigure {
  /** Comprobantes emitidos (los anulados no cuentan). */
  count: number;
  /** Suma de totales, con IVA. */
  total: string;
}

export interface SalesSummaryDto {
  timeZone: string;
  today: SalesFigure;
  /** Mes en curso, hasta ahora. */
  month: SalesFigure;
  /** Mes anterior completo. */
  previousMonth: SalesFigure;
  /** Mes anterior hasta el mismo día y hora que hoy: la comparación justa a mitad de mes. */
  previousMonthToDate: SalesFigure;
  /** Variación de `month` contra `previousMonthToDate`, en %; null si no hubo ventas entonces. */
  changePercent: string | null;
}

export interface TopProductDto {
  productId: string | null;
  name: string;
  quantity: string;
  /** Ingresos sin IVA, ya con descuentos. */
  revenue: string;
  invoiceCount: number;
}

export interface PaymentMethodDto {
  method: PaymentMethod;
  count: number;
  total: string;
}

export interface Ranged<T> {
  from: string;
  to: string;
  timeZone: string;
  data: T[];
}

const METHODS: PaymentMethod[] = ['cash', 'transfer', 'card'];

/**
 * CTE con el rango pedido resuelto en la zona horaria: `from_date`/`to_date` como
 * fechas de calendario y `[range_start, range_end)` como instantes. Sin fechas, el
 * mes en curso hasta hoy.
 */
function rangeCte(query: { from?: string; to?: string; tz: string }) {
  return sql`
    range_dates as (
      select
        coalesce(${query.from ?? null}::date, date_trunc('month', now() at time zone ${query.tz})::date) as from_date,
        coalesce(${query.to ?? null}::date, (now() at time zone ${query.tz})::date) as to_date
    ),
    range as (
      select from_date, to_date,
        from_date::timestamp at time zone ${query.tz} as range_start,
        (to_date + 1)::timestamp at time zone ${query.tz} as range_end
      from range_dates
    )`;
}

/** Reportes de solo lectura para el dashboard. Solo cuentan comprobantes emitidos. */
@Injectable()
export class ReportsService {
  async summary(
    trx: Transaction<DB>,
    query: SummaryQuery,
  ): Promise<SalesSummaryDto> {
    const { rows } = await sql<{
      today_count: string;
      today_total: string;
      month_count: string;
      month_total: string;
      prev_count: string;
      prev_total: string;
      prev_to_date_count: string;
      prev_to_date_total: string;
      change_percent: string | null;
    }>`
      with local as (
        select now() at time zone ${query.tz} as local_now
      ),
      bounds as (
        select
          date_trunc('day', local_now) at time zone ${query.tz} as today_start,
          date_trunc('month', local_now) at time zone ${query.tz} as month_start,
          (date_trunc('month', local_now) - interval '1 month') at time zone ${query.tz} as prev_start,
          -- Mismo punto del mes anterior (el 31 de marzo se compara con el fin de febrero).
          least(local_now - interval '1 month', date_trunc('month', local_now)) at time zone ${query.tz} as prev_cutoff
        from local
      ),
      figures as (
        select
          count(*) filter (where i.issued_at >= b.today_start) as today_count,
          coalesce(sum(i.total) filter (where i.issued_at >= b.today_start), 0) as today_total,
          count(*) filter (where i.issued_at >= b.month_start) as month_count,
          coalesce(sum(i.total) filter (where i.issued_at >= b.month_start), 0) as month_total,
          count(*) filter (where i.issued_at < b.month_start) as prev_count,
          coalesce(sum(i.total) filter (where i.issued_at < b.month_start), 0) as prev_total,
          count(*) filter (where i.issued_at < b.prev_cutoff) as prev_to_date_count,
          coalesce(sum(i.total) filter (where i.issued_at < b.prev_cutoff), 0) as prev_to_date_total
        from bounds b
        left join invoices i on i.status = 'issued' and i.issued_at >= b.prev_start
      )
      select
        today_count, today_total::numeric(14,2), month_count, month_total::numeric(14,2),
        prev_count, prev_total::numeric(14,2), prev_to_date_count, prev_to_date_total::numeric(14,2),
        case when prev_to_date_total > 0
          then round((month_total - prev_to_date_total) / prev_to_date_total * 100, 2)
        end as change_percent
      from figures
    `.execute(trx);
    const row = rows[0];
    return {
      timeZone: query.tz,
      today: { count: Number(row.today_count), total: row.today_total },
      month: { count: Number(row.month_count), total: row.month_total },
      previousMonth: { count: Number(row.prev_count), total: row.prev_total },
      previousMonthToDate: {
        count: Number(row.prev_to_date_count),
        total: row.prev_to_date_total,
      },
      changePercent: row.change_percent,
    };
  }

  async topProducts(
    trx: Transaction<DB>,
    query: TopProductsQuery,
  ): Promise<Ranged<TopProductDto>> {
    const order =
      query.sortBy === 'quantity'
        ? sql`quantity desc, revenue desc`
        : sql`revenue desc, quantity desc`;
    const { rows } = await sql<{
      from_date: string;
      to_date: string;
      product_id: string | null;
      name: string | null;
      quantity: string | null;
      revenue: string | null;
      invoice_count: string | null;
    }>`
      with ${rangeCte(query)},
      top as (
        -- Un producto renombrado sigue siendo una sola fila (se agrupa por id y se
        -- muestra su nombre actual); los ítems libres se agrupan por su texto.
        select
          it.product_id,
          coalesce(p.name, it.name) as name,
          sum(it.quantity) as quantity,
          sum(it.line_subtotal)::numeric(14,2) as revenue,
          count(distinct it.invoice_id) as invoice_count
        from range r
        join invoices i on i.status = 'issued' and i.issued_at >= r.range_start and i.issued_at < r.range_end
        join invoice_items it on it.invoice_id = i.id
        left join products p on p.id = it.product_id
        group by it.product_id, coalesce(p.name, it.name)
        order by ${order}, name
        limit ${query.limit}
      )
      select r.from_date::text, r.to_date::text, top.*
      from range r left join top on true
      order by ${order}, name
    `.execute(trx);
    return {
      from: rows[0].from_date,
      to: rows[0].to_date,
      timeZone: query.tz,
      data: rows
        .filter((row) => row.name !== null)
        .map((row) => ({
          productId: row.product_id,
          name: row.name!,
          quantity: row.quantity!,
          revenue: row.revenue!,
          invoiceCount: Number(row.invoice_count),
        })),
    };
  }

  /** Cobros por método según la fecha del pago. No incluye pagos de comprobantes anulados. */
  async paymentMethods(
    trx: Transaction<DB>,
    query: PaymentMethodsQuery,
  ): Promise<Ranged<PaymentMethodDto>> {
    const { rows } = await sql<{
      from_date: string;
      to_date: string;
      method: PaymentMethod | null;
      count: string | null;
      total: string | null;
    }>`
      with ${rangeCte(query)},
      by_method as (
        select pay.method, count(*) as count, sum(pay.amount)::numeric(14,2) as total
        from range r
        join payments pay on pay.paid_at >= r.range_start and pay.paid_at < r.range_end
        join invoices i on i.id = pay.invoice_id and i.status = 'issued'
        group by pay.method
      )
      select r.from_date::text, r.to_date::text, m.*
      from range r left join by_method m on true
    `.execute(trx);
    const byMethod = new Map(rows.map((row) => [row.method, row]));
    return {
      from: rows[0].from_date,
      to: rows[0].to_date,
      timeZone: query.tz,
      data: METHODS.map((method) => ({
        method,
        count: Number(byMethod.get(method)?.count ?? 0),
        total: byMethod.get(method)?.total ?? '0.00',
      })),
    };
  }
}
