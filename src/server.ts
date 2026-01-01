// Ethora.com platform, copyright: Dappros Ltd (c) 2026, all rights reserved
import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDb, ensureSchema, upsertConfig } from './db.js'
import { loadConfigFromFile } from './config.js'
import { startScheduler } from './scheduler.js'
import { runCheck } from './checker.js'

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
  const checkMap = new Map<string, any>()
  for (const inst of cfg.instances) {
    for (const chk of inst.checks) {
      const id = `${inst.id}:${chk.id}`
      checkMap.set(id, { instanceId: inst.id, ...chk })
    }
  }

  const app = express()
  app.use(express.json({ limit: '1mb' }))

  app.get('/health', (_req, res) => res.json({ ok: true }))

  app.get('/api/history', async (req, res) => {
    const checkId = String(req.query.checkId || '').trim()
    const sinceMinutes = Number(req.query.sinceMinutes || 60 * 24)
    const limit = Math.min(5000, Math.max(10, Number(req.query.limit || 1000)))

    if (!checkId) return res.status(422).json({ error: 'checkId is required' })
    const rows = await db.pool.query(
      `select ts, ok, status_code, duration_ms, error_text
       from check_runs
       where check_id = $1
         and ts >= now() - ($2 || ' minutes')::interval
       order by ts asc
       limit $3`,
      [checkId, String(sinceMinutes), limit]
    )
    return res.json({ checkId, points: rows.rows })
  })

  app.post('/api/run-check', async (req, res) => {
    const checkId = String(req.body?.checkId || '').trim()
    if (!checkId) return res.status(422).json({ error: 'checkId is required' })

    const chk = checkMap.get(checkId)
    if (!chk) return res.status(404).json({ error: 'check not found' })
    // NOTE: disabled checks are not scheduled, but can still be run manually via this endpoint.

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
    return res.json({ checkId, run })
  })

  app.get('/api/summary', async (_req, res) => {
    const instances = await db.pool.query(
      `select id, name, enabled, tags from instances order by id asc`
    )
    const out = []

    for (const inst of instances.rows) {
      const checks = await db.pool.query(
        `select c.id, c.name, c.type, c.meta
         from checks c
         where c.instance_id = $1
         order by c.id asc`,
        [inst.id]
      )

      const checkOut = []
      let hasFail = false
      let hasWarn = false

      for (const chk of checks.rows) {
        const meta = typeof chk?.meta === 'string' ? (() => { try { return JSON.parse(chk.meta) } catch { return {} } })() : (chk?.meta || {})
        const severity = meta?.severity || 'critical'
        const isOptional = severity === 'optional'
        const last = await db.pool.query(
          `select ok, status_code, duration_ms, ts, error_text
           from check_runs
           where check_id = $1
           order by ts desc
           limit 1`,
          [chk.id]
        )

        const row = last.rows[0]
        if (!row) {
          // No data yet -> warn, but never hard-fail instance
          if (!isOptional) hasWarn = true
          checkOut.push({ id: chk.id, name: chk.name, severity, ok: false, statusCode: null, durationMs: null, errorText: 'no data yet' })
          continue
        }
        if (!row.ok) {
          if (isOptional) {
            // Optional checks never affect instance status.
          } else if (typeof row.error_text === 'string' && row.error_text.startsWith('skipped:')) {
            hasWarn = true
          } else {
            hasFail = true
          }
        }
        checkOut.push({
          id: chk.id,
          name: chk.name,
          type: chk.type,
          severity,
          ok: Boolean(row.ok),
          statusCode: row.status_code ?? null,
          durationMs: row.duration_ms ?? null,
          ts: row.ts,
          errorText: row.error_text ?? null,
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


