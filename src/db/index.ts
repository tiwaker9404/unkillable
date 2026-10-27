import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import postgres from 'postgres'

export type Sql = postgres.Sql

export function connect(url: string, max = 20): Sql {
  return postgres(url, {
    max,
    idle_timeout: 30,
    onnotice: () => {},
    // snake_case columns <-> camelCase JS, and `undefined` params become SQL NULL
    transform: { ...postgres.camel, undefined: null },
  })
}

const MIGRATIONS_DIR = join(import.meta.dirname, 'migrations')

/**
 * Minimal forward-only migrator. Applies each `NNN_name.sql` in order inside a
 * transaction, guarded by an advisory lock so N replicas booting at once is safe.
 */
export async function migrate(sql: Sql, log: (msg: string) => void = () => {}): Promise<string[]> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort()
  const applied: string[] = []

  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(727411)`
    await tx`
      create table if not exists schema_migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      )`
    const done = new Set(
      (await tx<{ name: string }[]>`select name from schema_migrations`).map((r) => r.name),
    )
    for (const file of files) {
      if (done.has(file)) continue
      const text = await readFile(join(MIGRATIONS_DIR, file), 'utf8')
      await tx.unsafe(text)
      await tx`insert into schema_migrations (name) values (${file})`
      applied.push(file)
      log(`applied migration ${file}`)
    }
  })
  return applied
}
