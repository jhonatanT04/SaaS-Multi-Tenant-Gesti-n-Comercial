import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Env } from '../config/env.js';
import { KYSELY } from './database.constants.js';
import type { DB } from './schema.js';
import { TenantDb } from './tenant-db.service.js';

/**
 * Conexión de la API (rol `app_user`, sujeto a RLS). Global: cualquier módulo
 * puede inyectar `TenantDb` sin importar nada.
 */
@Global()
@Module({
  providers: [
    {
      provide: KYSELY,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        new Kysely<DB>({
          dialect: new PostgresDialect({
            pool: new pg.Pool({
              connectionString: config.get('DATABASE_URL', { infer: true }),
              max: 10,
            }),
          }),
        }),
    },
    TenantDb,
  ],
  exports: [KYSELY, TenantDb],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(KYSELY) private readonly db: Kysely<DB>) {}

  async onApplicationShutdown(): Promise<void> {
    await this.db.destroy();
  }
}
