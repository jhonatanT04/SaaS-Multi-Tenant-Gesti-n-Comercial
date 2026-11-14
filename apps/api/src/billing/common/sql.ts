import { sql, type RawBuilder } from 'kysely';

/** Escapa los comodines de LIKE para buscar el texto del usuario de forma literal. */
export function likeContains(term: string): string {
  return `%${term.replace(/[\\%_]/g, '\\$&')}%`;
}

/** Inicio (00:00) de una fecha de calendario en la zona dada, como timestamptz. */
export function startOfDay(date: string, timeZone: string): RawBuilder<Date> {
  return sql<Date>`(${date}::date::timestamp AT TIME ZONE ${timeZone})`;
}

/** Inicio del día siguiente: cota superior exclusiva para un rango que incluye `date`. */
export function startOfNextDay(
  date: string,
  timeZone: string,
): RawBuilder<Date> {
  return sql<Date>`((${date}::date + 1)::timestamp AT TIME ZONE ${timeZone})`;
}
