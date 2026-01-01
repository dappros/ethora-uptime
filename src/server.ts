// Ethora.com platform, copyright: Dappros Ltd (c) 2026, all rights reserved
import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDb, ensureSchema, upsertConfig } from './db.js'
import { loadConfigFromFile } from './config.js'
import { startScheduler } from './scheduler.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

async function main() {
  const port = Number(process.env.PORT || 8099)
  const configPath = process.env.UPTIME_CONFIG || '/config/uptime.yml'

  const cfg = loadConfigFromFile(configPath)
  const db = createDb()
  await ensureSchema(db)
  await upsertConfig(db, cfg)

  const scheduler = startScheduler(db, cfg)

  const app = express()
  app.use(express.json({ limit: '1mb' }))

  app.get('/health', (_req, res) => res.json({ ok: true }))

  app.get('/api/summary', async (_req, res) => {
    const instances = await db.pool.query(
      `select id, name, enabled, tags from instances order by id asc`
    )
    const out = []

    for (const inst of instances.rows) {
      const checks = await db.pool.query(
        `select c.id, c.name
         from checks c
         where c.instance_id = $1
         order by c.id asc`,
        [inst.id]
      )

      const checkOut = []
      let hasFail = false
      let hasWarn = false

      for (const chk of checks.rows) {
        const last = await db.pool.query(
          `select ok, status_code, duration_ms, ts
           from check_runs
           where check_id = $1
           order by ts desc
           limit 1`,
          [chk.id]
        )

        const row = last.rows[0]
        if (!row) {
          hasWarn = true
          checkOut.push({ id: chk.id, name: chk.name, ok: false, statusCode: null, durationMs: null })
          continue
        }
        if (!row.ok) hasFail = true
        checkOut.push({
          id: chk.id,
          name: chk.name,
          ok: Boolean(row.ok),
          statusCode: row.status_code ?? null,
          durationMs: row.duration_ms ?? null,
          ts: row.ts,
        })
      }

      const status = hasFail ? 'red' : hasWarn ? 'amber' : 'green'
      out.push({
        id: inst.id,
        name: inst.name,
        enabled: inst.enabled,
        tags: inst.tags,
        status,
        checks: checkOut,
      })
    }

    res.json({ instances: out })
  })

  // Serve UI
  const publicDir = path.resolve(__dirname, 'public')
  app.use('/', express.static(publicDir))

  const server = app.listen(port, () => {
    console.log(`[ethora-uptime] listening on :${port}`)
    console.log(`[ethora-uptime] config: ${configPath}`)
  })

  const shutdown = async () => {
    console.log('[ethora-uptime] shutting down...')
    scheduler.stop()
    server.close(() => {})
    await db.pool.end().catch(() => {})
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch((e) => {
  console.error('[ethora-uptime] fatal:', e)
  process.exit(1)
})


