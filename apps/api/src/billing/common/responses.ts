import { z } from 'zod';

/**
 * Forma de las respuestas JSON, para Swagger (`@ApiOkResponse({ standardSchema })`).
 * No validan nada en tiempo de ejecución: los e2e comprueban que las respuestas
 * reales las cumplen, así la documentación no se desvía del código.
 * Dinero y cantidades viajan como string decimal; fechas como ISO 8601.
 */
const money = z.string().describe('Decimal con 2 decimales, p. ej. "12.50"');
const quantity = z.string().describe('Decimal con 3 decimales, p. ej. "1.500"');
const timestamp = z.iso.datetime();
const id = z.uuid();

export function pageOf<T extends z.ZodType>(item: T) {
  return z.strictObject({
    data: z.array(item),
    page: z.number().int(),
    pageSize: z.number().int(),
    total: z.number().int(),
  });
}

export const categoryResponse = z.strictObject({
  id,
  name: z.string(),
  createdAt: timestamp,
});

export const productResponse = z.strictObject({
  id,
  categoryId: id.nullable(),
  kind: z.enum(['product', 'service']),
  code: z.string().nullable(),
  name: z.string(),
  description: z.string().nullable(),
  price: money.describe('Precio unitario sin impuesto'),
  taxable: z.boolean().describe('Grava IVA'),
  active: z.boolean(),
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const customerResponse = z.strictObject({
  id,
  name: z.string(),
  identificationType: z.enum(['cedula', 'ruc', 'passport', 'other']).nullable(),
  identification: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  address: z.string().nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
});

const invoiceFields = {
  id,
  status: z.enum(['draft', 'issued', 'voided']),
  establishment: z.string(),
  emissionPoint: z.string(),
  number: z
    .number()
    .int()
    .nullable()
    .describe('Secuencial; null mientras es borrador'),
  formattedNumber: z
    .string()
    .nullable()
    .describe('"001-001-000000123"; null en borrador'),
  customerId: id.nullable().describe('null = consumidor final'),
  customerName: z.string().nullable(),
  customerIdentification: z.string().nullable(),
  taxRate: z.string().describe('Fracción: "0.1500" = 15 %'),
  subtotalTaxable: money,
  subtotalExempt: money,
  discountTotal: money,
  taxTotal: money,
  total: money,
  paidTotal: money,
  balance: money,
  paymentStatus: z
    .enum(['unpaid', 'partial', 'paid'])
    .nullable()
    .describe('Derivado de los pagos; null en borradores y anulados'),
  notes: z.string().nullable(),
  createdBy: id,
  createdAt: timestamp,
  updatedAt: timestamp,
  issuedAt: timestamp.nullable(),
  issuedBy: id.nullable(),
  voidedAt: timestamp.nullable(),
  voidedBy: id.nullable(),
  voidReason: z.string().nullable(),
};

export const invoiceResponse = z.strictObject(invoiceFields);

export const invoiceDetailResponse = z.strictObject({
  ...invoiceFields,
  items: z.array(
    z.strictObject({
      id,
      position: z.number().int(),
      productId: id.nullable().describe('null = ítem libre'),
      name: z.string().describe('Copia del nombre al momento de la venta'),
      unitPrice: money.describe(
        'Copia del precio al momento de la venta, sin impuesto',
      ),
      quantity,
      discountAmount: money,
      taxable: z.boolean(),
      lineSubtotal: money.describe(
        'cantidad × precio − descuento, sin impuesto',
      ),
    }),
  ),
});

export const paymentResponse = z.strictObject({
  id,
  invoiceId: id,
  method: z.enum(['cash', 'transfer', 'card']),
  amount: money,
  reference: z.string().nullable(),
  paidAt: timestamp,
  createdBy: id,
  createdAt: timestamp,
});

const salesFigure = z.strictObject({
  count: z
    .number()
    .int()
    .describe('Comprobantes emitidos (los anulados no cuentan)'),
  total: money.describe('Suma de totales, con IVA'),
});

export const salesSummaryResponse = z.strictObject({
  timeZone: z.string(),
  today: salesFigure,
  month: salesFigure.describe('Mes en curso, hasta ahora'),
  previousMonth: salesFigure.describe('Mes anterior completo'),
  previousMonthToDate: salesFigure.describe(
    'Mes anterior hasta el mismo día y hora que hoy',
  ),
  changePercent: z
    .string()
    .nullable()
    .describe(
      'Variación de month contra previousMonthToDate, en %; null si no hubo ventas',
    ),
});

function rangeOf<T extends z.ZodType>(item: T) {
  return z.strictObject({
    from: z.iso.date(),
    to: z.iso.date(),
    timeZone: z.string(),
    data: z.array(item),
  });
}

export const topProductsResponse = rangeOf(
  z.strictObject({
    productId: id.nullable(),
    name: z.string(),
    quantity,
    revenue: money.describe('Ingresos sin IVA, ya con descuentos'),
    invoiceCount: z.number().int(),
  }),
);

export const paymentMethodsResponse = rangeOf(
  z.strictObject({
    method: z.enum(['cash', 'transfer', 'card']),
    count: z.number().int(),
    total: money,
  }),
);
