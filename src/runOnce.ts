// Ethora.com platform, copyright: Dappros Ltd (c) 2026, all rights reserved
import { createDb, ensureSchema, upsertConfig } from './db.js'
import { loadConfigFromFile } from './config.js'
import { runCheck } from './checker.js'

async function main() {
  const configPath = process.env.UPTIME_CONFIG || '/config/uptime.yml'
  const cfg = loadConfigFromFile(configPath)

  const db = createDb()
  await ensureSchema(db)
  await upsertConfig(db, cfg)

  for (const inst of cfg.instances) {
    if (!inst.enabled) continue
    for (const chk of inst.checks) {
      if (chk.enabled === false) continue
      const checkId = `${inst.id}:${chk.id}`
      const startedAt = Date.now()
      const run = await runCheck(chk)
      await db.pool.query(
        `insert into check_runs(check_id, ok, status_code, duration_ms, error_text, details)
         values($1,$2,$3,$4,$5,$6)`,
        [
          checkId,
          Boolean(run.ok),
          run.statusCode ?? null,
          run.durationMs || (Date.now() - startedAt),
          run.errorText ?? null,
          JSON.stringify(run.details || {}),
        ]
      )
      // Minimal console output for cron logs
      console.log(`[run-once] ${checkId} ok=${run.ok} ms=${run.durationMs} ${run.statusCode ?? ''} ${run.errorText ?? ''}`)
    }
  }

  await db.pool.end()
}

main().catch((e) => {
  console.error('[run-once] fatal:', e)
  process.exit(1)
})


