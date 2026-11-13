/**
 * Runner de migraciones SQL.
 *
 * Aplica `db/migrations/NNNN_nombre.sql` en orden numérico con MIGRATE_DATABASE_URL
 * (rol `migrator`, dueño de las tablas) y registra cada una en `schema_migrations`.
 * Cada migración corre en su propia transacción; un advisory lock evita que dos
 * procesos migren a la vez.
 *
 * Uso: `npm run db:migrate -w api` (aplica pendientes) o `-- --status` (solo lista).
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

const MIGRATIONS_DIR = join(import.meta.dirname, 'migrations');
const FILE_PATTERN = /^(\d{4})_[a-z0-9_]+\.sql$/;
const LOCK_KEY = 4_815_162_342;

interface MigrationFile {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

export async function loadMigrations(dir = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const entries = (await readdir(dir)).filter((f) => f.endsWith('.sql'));
  const migrations: MigrationFile[] = [];
  for (const name of entries) {
    const match = FILE_PATTERN.exec(name);
    if (!match) {
      throw new Error(`Nombre de migración inválido: ${name} (se espera NNNN_nombre.sql)`);
    }
    const sql = await readFile(join(dir, name), 'utf8');
    migrations.push({
      version: Number(match[1]),
      name,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    });
  }
  migrations.sort((a, b) => a.version - b.version);
  for (let i = 1; i < migrations.length; i++) {
    if (migrations[i].version === migrations[i - 1].version) {
      throw new Error(
        `Número de migración duplicado: ${migrations[i - 1].name} y ${migrations[i].name}`,
      );
    }
  }
  return migrations;
}

export async function migrate(
  connectionString: string,
  opts: { statusOnly?: boolean; log?: (msg: string) => void } = {},
): Promise<{ applied: string[]; pending: string[] }> {
  const log = opts.log ?? console.log;
  const migrations = await loadMigrations();
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    integer PRIMARY KEY,
        name       text NOT NULL,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    // Los privilegios por defecto darían DML a app_user también sobre esta tabla.
    await client.query('REVOKE ALL ON schema_migrations FROM app_user');

    const { rows } = await client.query<{ version: number; name: string; checksum: string }>(
      'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
    );
    const done = new Map(rows.map((r) => [r.version, r]));

    for (const row of rows) {
      const file = migrations.find((m) => m.version === row.version);
      if (!file) {
        throw new Error(`La migración aplicada ${row.name} ya no existe en disco`);
      }
      if (file.checksum !== row.checksum) {
        throw new Error(
          `La migración ${row.name} cambió después de aplicarse; crea una migración nueva en vez de editarla`,
        );
      }
    }

    const pending = migrations.filter((m) => !done.has(m.version));
    if (opts.statusOnly) {
      for (const m of migrations) log(`${done.has(m.version) ? 'aplicada ' : 'pendiente'}  ${m.name}`);
      return { applied: [], pending: pending.map((m) => m.name) };
    }

    const applied: string[] = [];
    for (const m of pending) {
      try {
        await client.query('BEGIN');
        await client.query(m.sql);
        await client.query(
          'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
          [m.version, m.name, m.checksum],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Falló ${m.name}: ${(err as Error).message}`, { cause: err });
      }
      applied.push(m.name);
      log(`aplicada  ${m.name}`);
    }
    if (applied.length === 0) log('Sin migraciones pendientes.');
    return { applied, pending: [] };
  } finally {
    await client.end();
  }
}

if (import.meta.main) {
  const url = process.env.MIGRATE_DATABASE_URL;
  if (!url) {
    console.error('Falta MIGRATE_DATABASE_URL');
    process.exit(1);
  }
  try {
    await migrate(url, { statusOnly: process.argv.includes('--status') });
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
