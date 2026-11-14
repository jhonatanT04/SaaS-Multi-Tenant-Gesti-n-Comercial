import { formatDecimal, parseDecimal, roundHalfUp } from '../common/decimal.js';

/**
 * Cálculo de totales de un comprobante. Función pura y exacta (bigint, sin float).
 *
 * Reglas:
 * - Los precios son SIN impuesto.
 * - Bruto de línea = cantidad × precio unitario, redondeado a 2 decimales (mitad hacia arriba).
 * - El descuento es por línea: un monto, o un porcentaje del bruto (redondeado a 2 decimales).
 * - Subtotal de línea = bruto − descuento.
 * - El IVA se calcula una sola vez sobre la suma de los subtotales gravados (no línea
 *   por línea), con la tasa del tenant como fracción (0.15 = 15 %).
 * - Total = subtotal gravado + subtotal no gravado + IVA.
 */

export interface LineInput {
  /** Hasta 3 decimales. */
  quantity: string;
  /** Hasta 2 decimales, sin impuesto. */
  unitPrice: string;
  taxable: boolean;
  /** Descuento en dinero. Excluyente con `discountPercent`. */
  discountAmount?: string | null;
  /** Descuento en porcentaje (0–100) del bruto de la línea. */
  discountPercent?: string | null;
}

export interface ComputedLine {
  discountAmount: string;
  lineSubtotal: string;
}

export interface InvoiceTotals {
  lines: ComputedLine[];
  subtotalTaxable: string;
  subtotalExempt: string;
  discountTotal: string;
  taxTotal: string;
  total: string;
}

/** Entrada inválida para el cálculo; la API la devuelve como 400. */
export class TotalsError extends Error {}

const MONEY = 2;
const QUANTITY = 3;
const RATE = 4;
/** Máximo que cabe en numeric(12,2). */
const MAX_MONEY = 999_999_999_999n;

function parse(value: string, scale: number, label: string): bigint {
  try {
    return parseDecimal(value, scale);
  } catch (err) {
    throw new TotalsError(`${label}: ${(err as Error).message}`);
  }
}

export function computeTotals(
  lines: LineInput[],
  taxRate: string,
): InvoiceTotals {
  const rate = parse(taxRate, RATE, 'tasa de impuesto');
  if (rate > 10n ** BigInt(RATE))
    throw new TotalsError('tasa de impuesto: debe estar entre 0 y 1');

  let subtotalTaxable = 0n;
  let subtotalExempt = 0n;
  let discountTotal = 0n;

  const computed = lines.map((line, index): ComputedLine => {
    const label = `ítem ${index + 1}`;
    const quantity = parse(line.quantity, QUANTITY, `${label}, cantidad`);
    if (quantity <= 0n)
      throw new TotalsError(`${label}: la cantidad debe ser mayor que cero`);
    const unitPrice = parse(line.unitPrice, MONEY, `${label}, precio`);
    const gross = roundHalfUp(quantity * unitPrice, QUANTITY + MONEY, MONEY);

    if (line.discountAmount != null && line.discountPercent != null) {
      throw new TotalsError(
        `${label}: usa descuento en monto o en porcentaje, no ambos`,
      );
    }
    let discount = 0n;
    if (line.discountPercent != null) {
      const percent = parse(line.discountPercent, 2, `${label}, descuento`);
      if (percent > 100_00n)
        throw new TotalsError(
          `${label}: el descuento no puede superar el 100 %`,
        );
      // bruto (2 dec.) × porcentaje (2 dec.) / 100 → escala 6.
      discount = roundHalfUp(gross * percent, MONEY + 2 + 2, MONEY);
    } else if (line.discountAmount != null) {
      discount = parse(line.discountAmount, MONEY, `${label}, descuento`);
    }
    if (discount > gross) {
      throw new TotalsError(
        `${label}: el descuento supera el valor de la línea`,
      );
    }

    const lineSubtotal = gross - discount;
    if (lineSubtotal > MAX_MONEY)
      throw new TotalsError(`${label}: el monto es demasiado grande`);
    if (line.taxable) subtotalTaxable += lineSubtotal;
    else subtotalExempt += lineSubtotal;
    discountTotal += discount;

    return {
      discountAmount: formatDecimal(discount, MONEY),
      lineSubtotal: formatDecimal(lineSubtotal, MONEY),
    };
  });

  const taxTotal = roundHalfUp(subtotalTaxable * rate, MONEY + RATE, MONEY);
  const total = subtotalTaxable + subtotalExempt + taxTotal;
  if (total > MAX_MONEY || discountTotal > MAX_MONEY) {
    throw new TotalsError('El total del comprobante es demasiado grande');
  }

  return {
    lines: computed,
    subtotalTaxable: formatDecimal(subtotalTaxable, MONEY),
    subtotalExempt: formatDecimal(subtotalExempt, MONEY),
    discountTotal: formatDecimal(discountTotal, MONEY),
    taxTotal: formatDecimal(taxTotal, MONEY),
    total: formatDecimal(total, MONEY),
  };
}

export type PaymentStatus = 'unpaid' | 'partial' | 'paid';

/** Saldo y estado de pago derivados de total y suma de pagos (nunca se guardan). */
export function paymentSummary(
  total: string,
  paidTotal: string,
): { paidTotal: string; balance: string; paymentStatus: PaymentStatus } {
  const totalCents = parseDecimal(total, MONEY);
  const paidCents = parseDecimal(paidTotal, MONEY);
  const balance = totalCents - paidCents;
  const paymentStatus: PaymentStatus =
    balance <= 0n ? 'paid' : paidCents > 0n ? 'partial' : 'unpaid';
  return {
    paidTotal: formatDecimal(paidCents, MONEY),
    balance: formatDecimal(balance, MONEY),
    paymentStatus,
  };
}
