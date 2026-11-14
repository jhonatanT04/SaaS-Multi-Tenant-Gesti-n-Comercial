import { ConflictException, type HttpException } from '@nestjs/common';

/** ERRCODE de los triggers de inmutabilidad (migración 0101). */
const BILLING_GUARD = 'BL001';
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';

interface PgError {
  code?: string;
  constraint?: string;
  message: string;
}

function isPgError(err: unknown): err is PgError {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as PgError).code === 'string'
  );
}

/**
 * Traduce errores de restricción de Postgres a 409 con un mensaje útil; cualquier
 * otro error se relanza tal cual. `messages` asocia nombre de constraint → mensaje.
 */
export function rethrowPgError(
  err: unknown,
  messages: Record<string, string | HttpException> = {},
): never {
  if (isPgError(err)) {
    const known = err.constraint ? messages[err.constraint] : undefined;
    if (known)
      throw typeof known === 'string' ? new ConflictException(known) : known;
    if (err.code === BILLING_GUARD) throw new ConflictException(err.message);
    if (err.code === UNIQUE_VIOLATION)
      throw new ConflictException('Ya existe un registro con esos datos');
    if (err.code === FOREIGN_KEY_VIOLATION) {
      throw new ConflictException(
        'El registro está en uso o referencia datos inexistentes',
      );
    }
  }
  throw err;
}
