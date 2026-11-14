import { z } from 'zod';

/**
 * Montos y cantidades: se aceptan como string o número JSON, pero se normalizan a
 * string decimal sin operar nunca en coma flotante (un número en notación
 * exponencial o con decimales de más se rechaza).
 */
function decimalString(maxDecimals: number, label: string) {
  const pattern = new RegExp(`^\\d{1,10}(\\.\\d{1,${maxDecimals}})?$`);
  return z
    .union([z.string(), z.number()])
    .transform((v) => (typeof v === 'number' ? String(v) : v.trim()))
    .refine((v) => pattern.test(v), {
      message: `${label}: decimal no negativo con hasta ${maxDecimals} decimales`,
    });
}

/** Dinero: hasta 2 decimales, cabe en numeric(12,2). */
export const moneySchema = decimalString(2, 'monto');
/** Cantidad: hasta 3 decimales (1.5 kg, 0.25 m de tela). */
export const quantitySchema = decimalString(3, 'cantidad');
/** Porcentaje de descuento, 0–100 con hasta 2 decimales. */
export const percentSchema = decimalString(2, 'porcentaje').refine(
  (v) => Number(v) <= 100,
  {
    message: 'porcentaje: máximo 100',
  },
);

export const uuidSchema = z.uuid();
export const idParamSchema = z.object({ id: uuidSchema });

/** Texto opcional: recorta y convierte '' en null. */
export function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();
}

/** Booleano de query string: solo 'true' o 'false'. */
export const queryBoolean = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true');

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type Pagination = z.infer<typeof paginationSchema>;

export interface Page<T> {
  data: T[];
  page: number;
  pageSize: number;
  total: number;
}

export function toPage<T>(
  data: T[],
  total: number | string | bigint,
  p: Pagination,
): Page<T> {
  return { data, page: p.page, pageSize: p.pageSize, total: Number(total) };
}

export function offsetOf(p: Pagination): number {
  return (p.page - 1) * p.pageSize;
}

/** Fecha de calendario YYYY-MM-DD válida. */
export const dateSchema = z.iso.date();

const TIME_ZONES = new Set(Intl.supportedValuesOf('timeZone'));
/** Zona IANA con la que se cortan "hoy" y "este mes". Los tenants aún no guardan la suya. */
export const DEFAULT_TIME_ZONE = 'America/Guayaquil';
export const timeZoneSchema = z
  .string()
  .refine((v) => v === 'UTC' || TIME_ZONES.has(v), {
    message: 'zona horaria IANA desconocida',
  })
  .default(DEFAULT_TIME_ZONE);
