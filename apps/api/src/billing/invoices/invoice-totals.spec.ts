import { formatDecimal, parseDecimal, roundHalfUp } from '../common/decimal.js';
import {
  computeTotals,
  paymentSummary,
  TotalsError,
  type LineInput,
} from './invoice-totals.js';

const line = (over: Partial<LineInput> = {}): LineInput => ({
  quantity: '1',
  unitPrice: '10.00',
  taxable: true,
  ...over,
});

describe('decimal', () => {
  it('convierte entre string y entero escalado sin perder precisión', () => {
    expect(parseDecimal('12.5', 2)).toBe(1250n);
    expect(parseDecimal('0.1500', 4)).toBe(1500n);
    expect(parseDecimal('7', 3)).toBe(7000n);
    expect(parseDecimal('1.2300', 2)).toBe(123n); // ceros de sobra no son pérdida
    expect(formatDecimal(1250n, 2)).toBe('12.50');
    expect(formatDecimal(5n, 2)).toBe('0.05');
    expect(formatDecimal(-5n, 2)).toBe('-0.05');
    expect(formatDecimal(0n, 2)).toBe('0.00');
  });

  it('rechaza lo que no es un decimal no negativo o tiene decimales de más', () => {
    for (const bad of ['', 'abc', '-1', '1e3', '1.', '.5', '1,5', ' 1']) {
      expect(() => parseDecimal(bad, 2), bad).toThrow(RangeError);
    }
    expect(() => parseDecimal('1.234', 2)).toThrow(/más de 2 decimales/);
  });

  it('redondea la mitad hacia arriba', () => {
    expect(roundHalfUp(1005n, 3, 2)).toBe(101n); // 1.005 → 1.01
    expect(roundHalfUp(1004n, 3, 2)).toBe(100n); // 1.004 → 1.00
    expect(roundHalfUp(1995n, 3, 2)).toBe(200n); // 1.995 → 2.00
    expect(roundHalfUp(15n, 1, 3)).toBe(1500n); // subir de escala no redondea
  });
});

describe('computeTotals', () => {
  it('comprobante vacío: todo en cero', () => {
    expect(computeTotals([], '0.15')).toEqual({
      lines: [],
      subtotalTaxable: '0.00',
      subtotalExempt: '0.00',
      discountTotal: '0.00',
      taxTotal: '0.00',
      total: '0.00',
    });
  });

  it('separa base gravada y no gravada, y solo la gravada lleva IVA', () => {
    const totals = computeTotals(
      [
        line({ quantity: '2', unitPrice: '3.50' }), // quesadillas: 7.00 gravado
        line({ quantity: '1', unitPrice: '1.25', taxable: false }), // 1.25 no gravado
      ],
      '0.1500',
    );
    expect(totals.lines.map((l) => l.lineSubtotal)).toEqual(['7.00', '1.25']);
    expect(totals.subtotalTaxable).toBe('7.00');
    expect(totals.subtotalExempt).toBe('1.25');
    expect(totals.taxTotal).toBe('1.05');
    expect(totals.total).toBe('9.30');
  });

  it('no arrastra errores de coma flotante (0.1 + 0.2, 1.15 × 3, 0.07 × 100)', () => {
    const totals = computeTotals(
      [
        line({ unitPrice: '0.10', taxable: false }),
        line({ unitPrice: '0.20', taxable: false }),
        line({ quantity: '3', unitPrice: '1.15', taxable: false }),
        line({ quantity: '100', unitPrice: '0.07', taxable: false }),
      ],
      '0',
    );
    expect(totals.lines.map((l) => l.lineSubtotal)).toEqual([
      '0.10',
      '0.20',
      '3.45',
      '7.00',
    ]);
    expect(totals.total).toBe('10.75');
  });

  it('cantidades fraccionarias: redondea el bruto de la línea a centavos, mitad hacia arriba', () => {
    // 0.333 × 9.99 = 3.32667 → 3.33 ; 1.5 × 0.03 = 0.045 → 0.05 ; 0.001 × 4.00 = 0.004 → 0.00
    const totals = computeTotals(
      [
        line({ quantity: '0.333', unitPrice: '9.99' }),
        line({ quantity: '1.5', unitPrice: '0.03' }),
        line({ quantity: '0.001', unitPrice: '4.00' }),
      ],
      '0',
    );
    expect(totals.lines.map((l) => l.lineSubtotal)).toEqual([
      '3.33',
      '0.05',
      '0.00',
    ]);
  });

  it('descuento en monto y en porcentaje por línea', () => {
    const totals = computeTotals(
      [
        line({ quantity: '2', unitPrice: '10.00', discountAmount: '2.50' }), // 20.00 − 2.50
        line({ quantity: '1', unitPrice: '9.99', discountPercent: '15' }), // 9.99 − 1.50 (1.4985 → 1.50)
        line({
          quantity: '1',
          unitPrice: '5.00',
          taxable: false,
          discountPercent: '100',
        }), // gratis
      ],
      '0.15',
    );
    expect(totals.lines).toEqual([
      { discountAmount: '2.50', lineSubtotal: '17.50' },
      { discountAmount: '1.50', lineSubtotal: '8.49' },
      { discountAmount: '5.00', lineSubtotal: '0.00' },
    ]);
    expect(totals.discountTotal).toBe('9.00');
    expect(totals.subtotalTaxable).toBe('25.99');
    expect(totals.subtotalExempt).toBe('0.00');
    expect(totals.taxTotal).toBe('3.90'); // 25.99 × 0.15 = 3.8985
    expect(totals.total).toBe('29.89');
  });

  it('el IVA se calcula sobre la base total, no sumando redondeos por línea', () => {
    // Tres líneas de 0.03: por línea sería 0.0045 → 0.00 cada una (0.00 en total);
    // sobre la base de 0.09 es 0.0135 → 0.01.
    const totals = computeTotals(
      [
        line({ unitPrice: '0.03' }),
        line({ unitPrice: '0.03' }),
        line({ unitPrice: '0.03' }),
      ],
      '0.15',
    );
    expect(totals.taxTotal).toBe('0.01');
    expect(totals.total).toBe('0.10');
  });

  it('redondea el IVA la mitad hacia arriba', () => {
    expect(computeTotals([line({ unitPrice: '0.10' })], '0.15').taxTotal).toBe(
      '0.02',
    ); // 0.015
    expect(computeTotals([line({ unitPrice: '0.30' })], '0.15').taxTotal).toBe(
      '0.05',
    ); // 0.045
    expect(computeTotals([line({ unitPrice: '0.29' })], '0.15').taxTotal).toBe(
      '0.04',
    ); // 0.0435
  });

  it('tasa 0 y tasa con cuatro decimales', () => {
    expect(computeTotals([line({ unitPrice: '100.00' })], '0.0000').total).toBe(
      '100.00',
    );
    expect(
      computeTotals([line({ unitPrice: '100.00' })], '0.0825').taxTotal,
    ).toBe('8.25');
    expect(computeTotals([line({ unitPrice: '100.00' })], '1').total).toBe(
      '200.00',
    );
  });

  it('siempre cumple total = gravado + no gravado + IVA y descuento = suma de líneas', () => {
    const cents = (v: string) => parseDecimal(v, 2);
    const lines = Array.from({ length: 60 }, (_, i) =>
      line({
        quantity: `${(i % 7) + 1}.${String((i * 37) % 1000).padStart(3, '0')}`,
        unitPrice: `${(i * 13) % 50}.${String((i * 71) % 100).padStart(2, '0')}`,
        taxable: i % 3 !== 0,
        discountPercent: i % 4 === 0 ? `${(i * 3) % 101}` : undefined,
      }),
    );
    const totals = computeTotals(lines, '0.15');
    expect(cents(totals.total)).toBe(
      cents(totals.subtotalTaxable) +
        cents(totals.subtotalExempt) +
        cents(totals.taxTotal),
    );
    expect(cents(totals.discountTotal)).toBe(
      totals.lines.reduce((sum, l) => sum + cents(l.discountAmount), 0n),
    );
    expect(cents(totals.subtotalTaxable) + cents(totals.subtotalExempt)).toBe(
      totals.lines.reduce((sum, l) => sum + cents(l.lineSubtotal), 0n),
    );
  });

  it('montos grandes siguen siendo exactos', () => {
    const totals = computeTotals(
      [line({ quantity: '99999.999', unitPrice: '9999.99' })],
      '0.15',
    );
    expect(totals.subtotalTaxable).toBe('999998990.00'); // 999998990.00001 → redondeado
    expect(totals.taxTotal).toBe('149999848.50');
    expect(totals.total).toBe('1149998838.50');
  });

  it('rechaza entradas inválidas con TotalsError', () => {
    const bad: [LineInput[], string, RegExp][] = [
      [[line({ quantity: '0' })], '0.15', /mayor que cero/],
      [[line({ quantity: '-1' })], '0.15', /cantidad/],
      [[line({ quantity: '1.0001' })], '0.15', /más de 3 decimales/],
      [[line({ unitPrice: '1.005' })], '0.15', /más de 2 decimales/],
      [[line({ unitPrice: 'NaN' })], '0.15', /precio/],
      [
        [line({ discountAmount: '10.01' })],
        '0.15',
        /supera el valor de la línea/,
      ],
      [[line({ discountPercent: '100.01' })], '0.15', /100 %/],
      [
        [line({ discountAmount: '1', discountPercent: '1' })],
        '0.15',
        /no ambos/,
      ],
      [[line()], '1.5', /entre 0 y 1/],
      [[line()], '15%', /tasa de impuesto/],
      [
        [line({ quantity: '9999999999', unitPrice: '9999999999.99' })],
        '0',
        /demasiado grande/,
      ],
    ];
    for (const [lines, rate, message] of bad) {
      expect(() => computeTotals(lines, rate), String(message)).toThrow(
        TotalsError,
      );
      expect(() => computeTotals(lines, rate)).toThrow(message);
    }
  });

  it('el mensaje de error dice qué ítem falla', () => {
    expect(() =>
      computeTotals([line(), line({ quantity: '0' })], '0.15'),
    ).toThrow(/ítem 2/);
  });
});

describe('paymentSummary', () => {
  it('deriva saldo y estado de pago', () => {
    expect(paymentSummary('10.00', '0.00')).toEqual({
      paidTotal: '0.00',
      balance: '10.00',
      paymentStatus: 'unpaid',
    });
    expect(paymentSummary('10.00', '0.01')).toMatchObject({
      balance: '9.99',
      paymentStatus: 'partial',
    });
    expect(paymentSummary('10.00', '10.00')).toMatchObject({
      balance: '0.00',
      paymentStatus: 'paid',
    });
    // Un comprobante de total cero no tiene nada pendiente.
    expect(paymentSummary('0.00', '0')).toMatchObject({
      balance: '0.00',
      paymentStatus: 'paid',
    });
  });
});
