import { Inject, Injectable } from '@nestjs/common';
import { Kysely, sql, type Transaction } from 'kysely';
import { KYSELY } from './database.constants.js';
import type { DB } from './schema.js';
import { tenantContext } from './tenant-context.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Único punto de acceso a la base para código de negocio. Cada llamada abre una
 * transacción y fija `app.tenant_id` con alcance de transacción, de modo que las
 * políticas RLS filtran por tenant aunque la consulta no tenga `WHERE tenant_id`.
 */
@Injectable()
export class TenantDb {
  constructor(@Inject(KYSELY) private readonly db: Kysely<DB>) {}

  /** Transacción con set_config('app.tenant_id', <tenant del request>, true). */
  run<T>(fn: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
    const tenantId = tenantContext.getTenantId();
    if (!tenantId) {
      return Promise.reject(
        new Error('TenantDb.run fuera de un request autenticado; usa runAs(tenantId, fn)'),
      );
    }
    return this.runAs(tenantId, fn);
  }

  /** Igual, con tenant explícito (tests, jobs). */
  runAs<T>(tenantId: string, fn: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
    if (!UUID.test(tenantId)) {
      return Promise.reject(new Error('tenantId inválido: se espera un UUID'));
    }
    return this.db.transaction().execute(async (trx) => {
      await sql`select set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);
      return fn(trx);
    });
  }
}
