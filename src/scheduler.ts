// Ethora.com platform, copyright: Dappros Ltd (c) 2026, all rights reserved
import type { Db } from './db.js'
import type { UptimeConfig } from './config.js'
import { runCheck } from './checker.js'
import { isCheckLocked, withCheckLock } from './runLock.js'

export type Scheduler = {
  stop: () => void
}

export function startScheduler(db: Db, cfg: UptimeConfig): Scheduler {
  const timers: NodeJS.Timeout[] = []

  for (const inst of cfg.instances) {
    if (!inst.enabled) continue
    for (const chk of inst.checks) {
      if (chk.enabled === false) continue
      const checkId = `${inst.id}:${chk.id}`
      const intervalMs = Math.max(5, Number(chk.intervalSeconds || 60)) * 1000

      const tick = async () => {
        if (isCheckLocked(checkId)) return
        const startedAt = Date.now()
        const res = await withCheckLock(checkId, async () => await runCheck(chk))
        const durationMs = res.durationMs || (Date.now() - startedAt)

        await db.pool.query(
          `insert into check_runs(check_id, ok, status_code, duration_ms, error_text, details)
           values($1,$2,$3,$4,$5,$6)`,
          [
            checkId,
            Boolean(res.ok),
            res.statusCode ?? null,
            durationMs,
            res.errorText ?? null,
            JSON.stringify(res.details || {}),
          ]
        )
      }

      // jittered initial run to avoid thundering herd
      const initialDelay = Math.floor(Math.random() * Math.min(intervalMs, 10_000))
      timers.push(setTimeout(() => void tick().catch(() => {}), initialDelay))

      timers.push(setInterval(() => void tick().catch(() => {}), intervalMs))
    }
  }

  return {
    stop: () => {
      for (const t of timers) clearTimeout(t)
    },
  }
}


