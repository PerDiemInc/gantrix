// `npm run db:rebaseline`: for a database that was migrated with the old, many-file migration
// history. The history was squashed into one baseline file (apps/server/drizzle/0000_init.sql),
// which creates exactly the same tables. This tells such a database that the baseline is already
// applied, so `npm run db:migrate` doesn't try to create the tables again. No data is touched.
// It changes only drizzle's bookkeeping table, and only with --yes (otherwise it just reports).
//
// A database that doesn't have the current tables should be recreated instead:
//   docker compose down -v && npm run infra:up && npm run db:migrate
import { existsSync } from 'node:fs';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import pg from 'pg';

const root = new URL('../', import.meta.url).pathname;
if (existsSync(`${root}.env`)) process.loadEnvFile(`${root}.env`);
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set (put it in .env).');
  process.exit(1);
}
const apply = process.argv.includes('--yes');

const migrations = readMigrationFiles({ migrationsFolder: `${root}apps/server/drizzle` });
if (migrations.length !== 1 || !migrations[0]) {
  console.error(`Expected one baseline migration, found ${migrations.length}. Nothing to do.`);
  process.exit(1);
}
const baseline = migrations[0];
// The tables the baseline creates, from its own SQL.
const wanted = [...baseline.sql.join('\n').matchAll(/CREATE TABLE "([^"]+)"/g)].map((m) => m[1]);

const db = new pg.Client({ connectionString: url });
await db.connect();
try {
  const have = new Set(
    (await db.query("select tablename from pg_tables where schemaname = 'public'")).rows.map(
      (r: { tablename: string }) => r.tablename,
    ),
  );
  const missing = wanted.filter((t) => !have.has(t));
  if (missing.length) {
    console.error(
      `This database is missing ${missing.length} of the ${wanted.length} tables (${missing.slice(0, 4).join(', ')}${missing.length > 4 ? ', …' : ''}).\n` +
        'It was not fully migrated, so it can not be rebaselined. Recreate it instead:\n' +
        '  docker compose down -v && npm run infra:up && npm run db:migrate',
    );
    process.exit(1);
  }
  const table = await db.query("select to_regclass('drizzle.__drizzle_migrations') as t");
  const recorded = table.rows[0]?.t
    ? (await db.query('select hash, created_at from drizzle.__drizzle_migrations order by id')).rows
    : [];
  if (recorded.length === 1 && recorded[0].hash === baseline.hash) {
    console.log('Already on the baseline migration. Nothing to do.');
    process.exit(0);
  }
  console.log(
    `All ${wanted.length} tables exist. The database records ${recorded.length} applied migration${recorded.length === 1 ? '' : 's'}; ` +
      'the baseline replaces them.',
  );
  if (!apply) {
    console.log('Run again with --yes to record the baseline as applied (no data is changed).');
    process.exit(0);
  }
  await db.query('begin');
  await db.query('create schema if not exists drizzle');
  await db.query(
    'create table if not exists drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)',
  );
  await db.query('delete from drizzle.__drizzle_migrations');
  await db.query('insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)', [
    baseline.hash,
    baseline.folderMillis,
  ]);
  await db.query('commit');
  console.log('Done. `npm run db:migrate` now sees the baseline as applied.');
} catch (error) {
  await db.query('rollback').catch(() => {});
  throw error;
} finally {
  await db.end();
}
