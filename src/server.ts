// Ethora.com platform, copyright: Dappros Ltd (c) 2026, all rights reserved
import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDb, ensureSchema, upsertConfig } from './db.js'
import { loadConfigFromFile } from './config.js'
import { startScheduler } from './scheduler.js'
import { runCheckWithOpts } from './checker.js'
import { isCheckLocked, withCheckLock } from './runLock.js'

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

    if (isCheckLocked(checkId)) {
      return res.status(409).json({ error: 'check already running', code: 'CHECK_ALREADY_RUNNING', checkId })
    }

    const startedAt = Date.now()
    const journeyObserverRoom = String(req.body?.journeyObserverRoom || '').trim()
    const run = await withCheckLock(checkId, async () => {
      return await runCheckWithOpts(chk, {
        journeyObserverRoom: journeyObserverRoom || undefined,
      })
    })
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

  // Manual action: run push validation once (no uptime.yml / DB check definition needed).
  // Useful for operators validating push credentials after installing/upgrading.
  app.post('/api/actions/push-validate', async (req, res) => {
    const actionId = 'action:push_validate'
    if (isCheckLocked(actionId)) {
      return res.status(409).json({ error: 'push validate already running', code: 'CHECK_ALREADY_RUNNING' })
    }

    const timeoutMs = Math.max(5000, Math.min(180000, Number(req.body?.timeoutMs || 60000)))
    const startedAt = Date.now()

    const chk: any = {
      id: actionId,
      name: 'Push_validate',
      type: 'push_validate',
      severity: 'optional',
      intervalSeconds: 0,
      timeoutMs,
    }

    const run = await withCheckLock(actionId, async () => {
      return await runCheckWithOpts(chk, {})
    })

    return res.json({
      actionId,
      run: {
        ...run,
        durationMs: run.durationMs || (Date.now() - startedAt),
        ts: new Date().toISOString(),
      },
    })
  })

  // Fetch last run with full details payload (useful for journeys)
  app.get('/api/last-run', async (req, res) => {
    const checkId = String(req.query.checkId || '').trim()
    if (!checkId) return res.status(422).json({ error: 'checkId is required' })

    const rows = await db.pool.query(
      `select ok, status_code, duration_ms, ts, error_text, details
       from check_runs
       where check_id = $1
       order by ts desc
       limit 1`,
      [checkId]
    )
    const row = rows.rows[0]
    if (!row) return res.status(404).json({ error: 'no runs yet', checkId })

    return res.json({
      checkId,
      run: {
        ok: Boolean(row.ok),
        statusCode: row.status_code ?? null,
        durationMs: row.duration_ms ?? null,
        ts: row.ts,
        errorText: row.error_text ?? null,
        details: row.details || {},
      }
    })
  })

  // Heuristic to distinguish a "checker-side error" (e.g. uptime container missing
  // `WebSocket` polyfill, missing env, network glitch on the probe itself) from a
  // genuine "monitored service is failing". Checker errors should bubble up as AMBER
  // (warning) on the wallboard rather than RED, otherwise the dashboard is misleading.
  function classifyErrorText(errText: string | null | undefined): 'service_fail' | 'checker_error' | 'skipped' {
    const s = String(errText || '')
    if (!s) return 'service_fail'
    if (s.startsWith('skipped:')) return 'skipped'
    const checkerSignals = [
      'WebSocket is not defined',
      'Missing env:',
      'fetch failed',
      'getaddrinfo',
      'ECONNREFUSED',
      'ENOTFOUND',
      'EAI_AGAIN',
      'EHOSTUNREACH',
      'ETIMEDOUT',
      'request to ',
    ]
    if (checkerSignals.some((sig) => s.includes(sig))) return 'checker_error'
    return 'service_fail'
  }

  // Resolve the current configuration from the in-memory map. Treat checks that exist in
  // the DB but not in the current config as "obsolete" so we can hide them from rollups.
  function resolveCheckConfig(checkId: string) {
    const cfg = checkMap.get(checkId)
    if (!cfg) return { enabled: false, intervalSeconds: null as number | null, isManual: false, obsolete: true }
    return {
      enabled: cfg.enabled !== false,
      intervalSeconds: Number(cfg.intervalSeconds || 0) || null,
      isManual: cfg.intervalSeconds === 0 || cfg.enabled === false,
      obsolete: false,
    }
  }

  app.get('/api/summary', async (_req, res) => {
    const instances = await db.pool.query(
      `select id, name, enabled, tags from instances order by id asc`
    )
    const now = Date.now()
    const out: any[] = []
    const totals = { instances: 0, enabledInstances: 0, byStatus: { green: 0, amber: 0, red: 0 }, criticalChecks: 0, criticalFailing: 0, optionalChecks: 0, optionalFailing: 0 }

    for (const inst of instances.rows) {
      const checks = await db.pool.query(
        `select c.id, c.name, c.type, c.meta
         from checks c
         where c.instance_id = $1
         order by c.id asc`,
        [inst.id]
      )

      const checkOut: any[] = []
      let hasFail = false
      let hasWarn = false
      let buildInfo: any = null

      for (const chk of checks.rows) {
        const meta = typeof chk?.meta === 'string' ? (() => { try { return JSON.parse(chk.meta) } catch { return {} } })() : (chk?.meta || {})
        const severity = meta?.severity || 'critical'
        const isOptional = severity === 'optional'
        const cfg = resolveCheckConfig(chk.id)
        const last = await db.pool.query(
          `select ok, status_code, duration_ms, ts, error_text, details
           from check_runs
           where check_id = $1
           order by ts desc
           limit 1`,
          [chk.id]
        )

        const row = last.rows[0]
        const baseOut: any = {
          id: chk.id,
          name: chk.name,
          type: chk.type,
          severity,
          enabled: cfg.enabled,
          obsolete: cfg.obsolete,
          intervalSeconds: cfg.intervalSeconds,
        }
        if (!isOptional) totals.criticalChecks += 1
        else totals.optionalChecks += 1

        if (!row) {
          // Distinguish "manual / disabled" (never scheduled) from "scheduled but no run yet" (warm-up).
          const noRunReason = !cfg.enabled ? 'manual_or_disabled' : 'no_data_yet'
          // Disabled/manual checks should never amber the instance.
          if (!isOptional && cfg.enabled) hasWarn = true
          checkOut.push({
            ...baseOut,
            ok: false,
            statusCode: null,
            durationMs: null,
            errorText: noRunReason === 'manual_or_disabled' ? null : 'no data yet',
            errorClass: null,
            noRunReason,
            ts: null,
            lastRunIso: null,
            lastRunAgoSeconds: null,
          })
          continue
        }

        const errClass = classifyErrorText(row.error_text)
        if (!row.ok) {
          if (isOptional) {
            totals.optionalFailing += 1
          } else {
            totals.criticalFailing += 1
            if (errClass === 'skipped' || errClass === 'checker_error') {
              hasWarn = true
            } else {
              hasFail = true
            }
          }
        }

        const ts = row.ts
        const lastRunIso = ts ? new Date(ts).toISOString() : null
        const lastRunAgoSeconds = ts ? Math.max(0, Math.floor((now - new Date(ts).getTime()) / 1000)) : null

        checkOut.push({
          ...baseOut,
          ok: Boolean(row.ok),
          statusCode: row.status_code ?? null,
          durationMs: row.duration_ms ?? null,
          ts,
          lastRunIso,
          lastRunAgoSeconds,
          errorText: row.error_text ?? null,
          errorClass: row.ok ? null : errClass,
          captures: row.details?.captures || undefined,
        })

        // Prefer build info from API_ping check (if configured with capture rules),
        // but allow other checks (e.g. Swagger_JSON) to fill missing fields.
        if (row.details?.captures) {
          if (!buildInfo) {
            buildInfo = row.details.captures
          } else {
            for (const [k, v] of Object.entries(row.details.captures)) {
              if (buildInfo[k] === undefined || buildInfo[k] === null) {
                buildInfo[k] = v
              }
            }
          }
        }
      }

      const status = hasFail ? 'red' : hasWarn ? 'amber' : 'green'
      totals.instances += 1
      if (inst.enabled) {
        totals.enabledInstances += 1
        totals.byStatus[status] += 1
      }
      out.push({
        id: inst.id,
        name: inst.name,
        enabled: inst.enabled,
        tags: inst.tags,
        status,
        build: buildInfo,
        checks: checkOut,
      })
    }

    res.json({
      generatedAt: new Date().toISOString(),
      totals,
      instances: out,
    })
  })

  // Sparkline data: bucketed pass/fail counts for a check over a sliding window.
  app.get('/api/sparkline', async (req, res) => {
    const checkId = String(req.query.checkId || '').trim()
    if (!checkId) return res.status(422).json({ error: 'checkId is required' })
    const sinceMinutes = Math.max(5, Math.min(60 * 24 * 7, Number(req.query.sinceMinutes || 60 * 24)))
    const buckets = Math.max(6, Math.min(96, Number(req.query.buckets || 24)))
    const bucketMinutes = Math.max(1, Math.round(sinceMinutes / buckets))

    // Use date_trunc + width_bucket would be more elegant, but we want fixed-width buckets
    // that always end at "now" so the rightmost bucket is the most-recent slice.
    const rows = await db.pool.query(
      `with bounds as (
         select now() as ts_max,
                now() - ($1 || ' minutes')::interval as ts_min
       ),
       runs as (
         select ts, ok, duration_ms,
                floor(extract(epoch from (now() - ts)) / ($2::int * 60)) as bucket_index_from_now
         from check_runs, bounds
         where check_id = $3 and ts >= bounds.ts_min
       )
       select bucket_index_from_now::int as idx,
              count(*) as total,
              count(*) filter (where ok) as ok_count,
              avg(duration_ms)::int as avg_duration_ms,
              max(duration_ms) as max_duration_ms,
              min(ts) as first_ts,
              max(ts) as last_ts
       from runs
       group by bucket_index_from_now
       order by bucket_index_from_now asc`,
      [String(sinceMinutes), bucketMinutes, checkId]
    )

    // Build a dense buckets array from oldest → newest so the UI can render a left→right strip.
    const dense: Array<any> = []
    const byIdx = new Map<number, any>()
    for (const r of rows.rows) byIdx.set(Number(r.idx), r)
    for (let i = buckets - 1; i >= 0; i--) {
      const r = byIdx.get(i)
      dense.push({
        index: buckets - 1 - i,
        total: r ? Number(r.total) : 0,
        okCount: r ? Number(r.ok_count) : 0,
        failCount: r ? Number(r.total) - Number(r.ok_count) : 0,
        avgDurationMs: r?.avg_duration_ms ? Number(r.avg_duration_ms) : null,
        maxDurationMs: r?.max_duration_ms ? Number(r.max_duration_ms) : null,
      })
    }

    res.json({
      checkId,
      sinceMinutes,
      bucketMinutes,
      buckets: dense,
    })
  })

  // Serve UI
  const publicDir = path.resolve(__dirname, 'public')
  // Backward compat: older builds produced dist/public/public/*.html (double-nested).
  // Prefer the direct path first, but also serve nested content so `/history.html` keeps working.
  const publicNestedDir = path.resolve(publicDir, 'public')

  app.use('/', express.static(publicDir))
  app.use('/', express.static(publicNestedDir))

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


