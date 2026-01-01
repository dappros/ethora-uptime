// Ethora.com platform, copyright: Dappros Ltd (c) 2026, all rights reserved
import pg from 'pg'

export type Db = {
  pool: pg.Pool
}

export function createDb(): Db {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is required')
  const pool = new pg.Pool({
    connectionString: url,
    max: Number(process.env.DB_POOL_MAX || 5),
  })
  return { pool }
}

export async function ensureSchema(db: Db) {
  await db.pool.query(`
    create table if not exists instances (
      id text primary key,
      name text not null,
      enabled boolean not null default true,
      tags jsonb not null default '[]'::jsonb
    );
  `)

  await db.pool.query(`
    create table if not exists checks (
      id text primary key,
      instance_id text not null references instances(id) on delete cascade,
      name text not null,
      type text not null,
      url text not null,
      interval_seconds int not null,
      timeout_ms int not null,
      meta jsonb not null default '{}'::jsonb
    );
  `)

  await db.pool.query(`
    create table if not exists check_runs (
      id bigserial primary key,
      check_id text not null references checks(id) on delete cascade,
      ts timestamptz not null default now(),
      ok boolean not null,
      status_code int,
      duration_ms int not null,
      error_text text,
      details jsonb not null default '{}'::jsonb
    );
  `)

  await db.pool.query(`create index if not exists idx_check_runs_check_id_ts on check_runs(check_id, ts desc);`)
}

export async function upsertConfig(db: Db, config: any) {
  // Persist instances/check definitions (idempotent)
  for (const inst of config.instances) {
    await db.pool.query(
      `insert into instances(id,name,enabled,tags)
       values($1,$2,$3,$4)
       on conflict (id) do update set name=excluded.name, enabled=excluded.enabled, tags=excluded.tags`,
      [inst.id, inst.name, Boolean(inst.enabled), JSON.stringify(inst.tags || [])]
    )

    for (const chk of inst.checks) {
      const checkId = `${inst.id}:${chk.id}`
      await db.pool.query(
        `insert into checks(id,instance_id,name,type,url,interval_seconds,timeout_ms,meta)
         values($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict (id) do update set
           name=excluded.name,
           type=excluded.type,
           url=excluded.url,
           interval_seconds=excluded.interval_seconds,
           timeout_ms=excluded.timeout_ms,
           meta=excluded.meta`,
        [
          checkId,
          inst.id,
          chk.name,
          chk.type,
          chk.url,
          Number(chk.intervalSeconds || 60),
          Number(chk.timeoutMs || 5000),
          JSON.stringify({
            method: chk.method || 'GET',
            headers: chk.headers || {},
            body: chk.body || undefined,
            expect: chk.expect || [],
          }),
        ]
      )
    }
  }
}


