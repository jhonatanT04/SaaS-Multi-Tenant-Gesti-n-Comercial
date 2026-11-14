import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Selectable, Transaction } from 'kysely';
import type { DB } from '../../platform/db/schema.js';
import type { PaymentMethod, PaymentsTable } from '../billing.tables.js';
import { formatDecimal, parseDecimal } from '../common/decimal.js';
import { InvoicesService } from '../invoices/invoices.service.js';
import type { CreatePaymentBody } from './payments.schemas.js';

export interface PaymentDto {
  id: string;
  invoiceId: string;
  method: PaymentMethod;
  amount: string;
  reference: string | null;
  paidAt: Date;
  createdBy: string;
  createdAt: Date;
}

function toPayment(row: Selectable<PaymentsTable>): PaymentDto {
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    method: row.method,
    amount: row.amount,
    reference: row.reference,
    paidAt: row.paid_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

/**
 * Pagos de un comprobante emitido. El saldo y el estado de pago no se guardan:
 * se derivan de `total − suma de pagos` cada vez que se lee el comprobante.
 */
@Injectable()
export class PaymentsService {
  constructor(private readonly invoices: InvoicesService) {}

  async listForInvoice(
    trx: Transaction<DB>,
    invoiceId: string,
  ): Promise<PaymentDto[]> {
    const invoice = await trx
      .selectFrom('invoices')
      .select('id')
      .where('id', '=', invoiceId)
      .executeTakeFirst();
    if (!invoice) throw new NotFoundException('Comprobante no encontrado');
    const rows = await trx
      .selectFrom('payments')
      .selectAll()
      .where('invoice_id', '=', invoiceId)
      .orderBy('paid_at')
      .orderBy('created_at')
      .execute();
    return rows.map(toPayment);
  }

  /**
   * Registra un pago. Bloquea el comprobante antes de leer lo ya pagado, así dos
   * cobros simultáneos no pueden superar juntos el saldo.
   */
  async create(
    trx: Transaction<DB>,
    userId: string,
    invoiceId: string,
    body: CreatePaymentBody,
  ): Promise<PaymentDto> {
    const invoice = await this.invoices.lockInStatus(
      trx,
      invoiceId,
      'issued',
      'Solo se registran pagos sobre comprobantes emitidos',
    );
    const paid = await trx
      .selectFrom('payments')
      .select((eb) =>
        eb.fn.coalesce(eb.fn.sum<string>('amount'), eb.lit(0)).as('paid'),
      )
      .where('invoice_id', '=', invoiceId)
      .executeTakeFirstOrThrow();

    const balance =
      parseDecimal(invoice.total, 2) - parseDecimal(String(paid.paid), 2);
    if (parseDecimal(body.amount, 2) > balance) {
      throw new ConflictException(
        `El pago supera el saldo pendiente (${formatDecimal(balance < 0n ? 0n : balance, 2)})`,
      );
    }

    const row = await trx
      .insertInto('payments')
      .values({
        invoice_id: invoiceId,
        method: body.method,
        amount: body.amount,
        reference: body.reference ?? null,
        paid_at: body.paidAt,
        created_by: userId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toPayment(row);
  }

  /** Reverso de un pago mal registrado. */
  async delete(trx: Transaction<DB>, id: string): Promise<void> {
    const result = await trx
      .deleteFrom('payments')
      .where('id', '=', id)
      .executeTakeFirst();
    if (result.numDeletedRows === 0n)
      throw new NotFoundException('Pago no encontrado');
  }
}
