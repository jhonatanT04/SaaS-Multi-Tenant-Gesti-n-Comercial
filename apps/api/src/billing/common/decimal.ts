/**
 * Aritmética decimal exacta sobre bigint (punto fijo). El dinero nunca pasa por
 * `number`: entra como string decimal, se opera como entero escalado y sale como string.
 * Todos los valores del dominio son no negativos, salvo diferencias (saldo).
 */

const DECIMAL = /^\d+(\.\d+)?$/;

/** '12.5' con escala 2 → 1250n. Lanza si no es decimal no negativo o si sobran decimales. */
export function parseDecimal(value: string, scale: number): bigint {
  if (!DECIMAL.test(value))
    throw new RangeError(`Decimal inválido: "${value}"`);
  const [int, frac = ''] = value.split('.');
  if (frac.length > scale && /[1-9]/.test(frac.slice(scale))) {
    throw new RangeError(`"${value}" tiene más de ${scale} decimales`);
  }
  return BigInt(int + frac.slice(0, scale).padEnd(scale, '0'));
}

/** 1250n con escala 2 → '12.50'. */
export function formatDecimal(value: bigint, scale: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value)
    .toString()
    .padStart(scale + 1, '0');
  const int = digits.slice(0, digits.length - scale);
  const frac = scale > 0 ? '.' + digits.slice(digits.length - scale) : '';
  return (negative ? '-' : '') + int + frac;
}

/** Reduce `value` de `fromScale` a `toScale` decimales redondeando la mitad hacia arriba. */
export function roundHalfUp(
  value: bigint,
  fromScale: number,
  toScale: number,
): bigint {
  if (value < 0n)
    throw new RangeError('roundHalfUp solo admite valores no negativos');
  if (fromScale <= toScale) return value * 10n ** BigInt(toScale - fromScale);
  const divisor = 10n ** BigInt(fromScale - toScale);
  return (value + divisor / 2n) / divisor;
}
