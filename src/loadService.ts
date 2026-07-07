// Ethora.com platform, copyright: Dappros Ltd (c) 2026, all rights reserved
//
// In-memory load-run manager for the web UI.
//
// A load run is long (tens of seconds to minutes) and heavy, so we:
//  - allow only ONE active run at a time (a second start returns 409),
//  - kick the run off in the background and return a runId immediately,
//  - expose a live progress snapshot the UI can poll,
//  - keep a small ring buffer of recent finished runs for the results table.
//
// State is process-local and non-persistent on purpose: load testing is an
// operator-driven, ad-hoc activity. If the uptime process restarts mid-run the
// run is gone — that is acceptable for this tool.

import { getJourneyEnvFromProcess } from './journeyRunner.js'
import { runLoad, type LoadRunResult, type LoadProgressSnapshot } from './loadRunner.js'
import { runMixedRealistic } from './loadScenarios/mixed-realistic.js'
import { runSharedApp } from './loadScenarios/shared-app.js'
import { runSharedB2B } from './loadScenarios/shared-b2b.js'
import { runFullB2B } from './loadScenarios/full-b2b.js'
import { runXmppMessages, runXmppConnect } from './loadScenarios/xmpp.js'

export interface LoadRunParams {
   scenario:
      | 'journey'
      | 'mixed-realistic'
      | 'shared-app'
      | 'shared-b2b'
      | 'full-b2b'
      | 'xmpp-messages'
      | 'xmpp-connect'
   mode?: string
   parallelism: number
   durationSeconds: number
   rampUpSeconds?: number
   sleepBetweenIterationsMs?: number
   label?: string
}

export type LoadRunStatus = 'running' | 'done' | 'error'

export interface LoadRunState {
   id: string
   status: LoadRunStatus
   params: LoadRunParams
   startedAt: string
   finishedAt?: string
   progress?: LoadProgressSnapshot
   result?: LoadRunResult
   error?: string
}

// Journey modes that the `journey` scenario accepts. Kept in sync with the CLI
// help in loadTest.ts; the UI renders these as a dropdown.
export const JOURNEY_MODES = [
   'basic',
   'advanced',
   'b2b',
   'token_refresh',
   'signup_validation',
   'password_reset',
   'app_stats',
   'user_tags',
   'chat_reports',
   'v1_files',
   'private_chat',
   'v2_user_chats',
   'lifecycle',
] as const

const MAX_HISTORY = 20

let activeRun: LoadRunState | null = null
const history: LoadRunState[] = []
let seq = 0

function makeRunId(): string {
   seq += 1
   return `load_${Date.now().toString(36)}_${seq}`
}

/** Report which ETHORA_* env vars the load run needs and which are present. */
export function getEnvStatus(): { present: string[]; missing: string[]; apiBase: string | null } {
   const required = ['ETHORA_API_BASE', 'ETHORA_BASE_DOMAIN_NAME', 'ETHORA_ADMIN_EMAIL', 'ETHORA_ADMIN_PASSWORD']
   const optional = [
      'ETHORA_XMPP_SERVICE',
      'ETHORA_XMPP_HOST',
      'ETHORA_B2B_APP_ID',
      'ETHORA_B2B_APP_SECRET',
   ]
   const present: string[] = []
   const missing: string[] = []
   for (const k of required) {
      if (String(process.env[k] || '').trim()) present.push(k)
      else missing.push(k)
   }
   for (const k of optional) {
      if (String(process.env[k] || '').trim()) present.push(k)
   }
   return {
      present,
      missing,
      apiBase: String(process.env.ETHORA_API_BASE || '').trim() || null,
   }
}

export function getActiveRun(): LoadRunState | null {
   return activeRun
}

export function getRun(runId: string): LoadRunState | null {
   if (activeRun && activeRun.id === runId) return activeRun
   return history.find((r) => r.id === runId) || null
}

export function listRuns(): LoadRunState[] {
   const out: LoadRunState[] = []
   if (activeRun) out.push(activeRun)
   for (const r of history) out.push(r)
   return out
}

// Prometheus exposition for the current (or last finished) load run, so a
// Grafana dashboard can overlay load (RPS / latency / errors / inflight) on the
// same timeline as cAdvisor/node_exporter resource metrics. Live counts come
// from the active run's progress; latency percentiles are only known once a run
// finishes, so they reflect the most recent completed run.
export function getMetricsText(): string {
   const run = activeRun || history[0] || null
   const running = activeRun ? 1 : 0
   const p = run?.progress
   const elapsed = p?.elapsedSeconds || 0
   const ok = p?.ok || 0
   const total = p?.totalIterations || 0
   const failed = p?.failed || 0
   const inflight = p?.inFlight || 0
   const throughput = elapsed > 0 ? total / elapsed : (run?.result?.throughputPerSec || 0)
   const lat = run?.result?.latency
   const lines: string[] = []
   const g = (name: string, help: string, value: number, labels = '') => {
      lines.push(`# HELP ${name} ${help}`)
      lines.push(`# TYPE ${name} gauge`)
      lines.push(`${name}${labels} ${Number.isFinite(value) ? value : 0}`)
   }
   g('ethora_load_running', 'Whether a load run is currently active (1) or not (0).', running)
   g('ethora_load_parallelism', 'Configured parallelism of the current/last run.', run?.params?.parallelism || 0)
   g('ethora_load_inflight', 'Iterations currently in flight.', inflight)
   g('ethora_load_iterations', 'Total iterations so far (current/last run).', total)
   g('ethora_load_ok', 'Successful iterations.', ok)
   g('ethora_load_failed', 'Failed iterations.', failed)
   g('ethora_load_throughput_per_sec', 'Iterations per second.', Math.round(throughput * 100) / 100)
   if (lat) {
      lines.push('# HELP ethora_load_latency_ms Iteration latency percentiles (last finished run).')
      lines.push('# TYPE ethora_load_latency_ms gauge')
      lines.push(`ethora_load_latency_ms{quantile="0.5"} ${lat.p50Ms}`)
      lines.push(`ethora_load_latency_ms{quantile="0.95"} ${lat.p95Ms}`)
      lines.push(`ethora_load_latency_ms{quantile="0.99"} ${lat.p99Ms}`)
      lines.push(`ethora_load_latency_ms{quantile="1.0"} ${lat.maxMs}`)
   }
   return lines.join('\n') + '\n'
}

function clampPositive(n: number, def: number, max: number): number {
   if (!Number.isFinite(n) || n <= 0) return def
   return Math.min(n, max)
}

/**
 * Start a load run in the background. Throws if another run is active or if
 * required env is missing. Returns the runId immediately; poll getRun(runId)
 * for progress and the final result.
 */
export function startLoadRun(raw: LoadRunParams): LoadRunState {
   if (activeRun && activeRun.status === 'running') {
      const err: any = new Error('a load run is already in progress')
      err.code = 'LOAD_RUN_IN_PROGRESS'
      throw err
   }

   const env = getEnvStatus()
   if (env.missing.length) {
      const err: any = new Error(`missing required env: ${env.missing.join(', ')}`)
      err.code = 'MISSING_ENV'
      throw err
   }

   const KNOWN_SCENARIOS = ['mixed-realistic', 'shared-app', 'shared-b2b', 'full-b2b', 'xmpp-messages', 'xmpp-connect']
   const scenario: LoadRunParams['scenario'] = KNOWN_SCENARIOS.includes(String(raw.scenario))
      ? (raw.scenario as LoadRunParams['scenario'])
      : 'journey'
   // Guardrails: cap parallelism/duration so a fat-fingered UI value can't take
   // the box (or the target deployment) down by accident.
   const params: LoadRunParams = {
      scenario,
      mode: scenario === 'journey' ? (raw.mode || 'basic') : undefined,
      parallelism: clampPositive(Number(raw.parallelism), 10, 500),
      durationSeconds: clampPositive(Number(raw.durationSeconds), 60, 3600),
      rampUpSeconds: Math.max(0, Number(raw.rampUpSeconds) || 0),
      sleepBetweenIterationsMs: Math.max(0, Number(raw.sleepBetweenIterationsMs) || 0),
      label: raw.label?.trim() || undefined,
   }

   const state: LoadRunState = {
      id: makeRunId(),
      status: 'running',
      params,
      startedAt: new Date().toISOString(),
      progress: { elapsedSeconds: 0, totalIterations: 0, ok: 0, failed: 0, inFlight: 0 },
   }
   activeRun = state

   const onProgress = (snapshot: LoadProgressSnapshot) => {
      state.progress = snapshot
   }

   const finish = (patch: Partial<LoadRunState>) => {
      Object.assign(state, patch, { finishedAt: new Date().toISOString() })
      history.unshift(state)
      while (history.length > MAX_HISTORY) history.pop()
      activeRun = null
   }

   // Fire-and-forget; we deliberately do not await.
   ;(async () => {
      try {
         let result: LoadRunResult
         if (params.scenario === 'mixed-realistic') {
            result = await runMixedRealistic({
               parallelism: params.parallelism,
               durationSeconds: params.durationSeconds,
               rampUpSeconds: params.rampUpSeconds,
               sleepBetweenIterationsMs: params.sleepBetweenIterationsMs,
               reportEverySeconds: 2,
               label: params.label,
               onProgress,
            })
         } else if (params.scenario === 'shared-app') {
            result = await runSharedApp({
               parallelism: params.parallelism,
               durationSeconds: params.durationSeconds,
               rampUpSeconds: params.rampUpSeconds,
               sleepBetweenIterationsMs: params.sleepBetweenIterationsMs,
               reportEverySeconds: 2,
               label: params.label,
               onProgress,
            })
         } else if (params.scenario === 'shared-b2b') {
            result = await runSharedB2B({
               parallelism: params.parallelism,
               durationSeconds: params.durationSeconds,
               rampUpSeconds: params.rampUpSeconds,
               sleepBetweenIterationsMs: params.sleepBetweenIterationsMs,
               reportEverySeconds: 2,
               label: params.label,
               onProgress,
            })
         } else if (params.scenario === 'full-b2b') {
            result = await runFullB2B({
               parallelism: params.parallelism,
               durationSeconds: params.durationSeconds,
               rampUpSeconds: params.rampUpSeconds,
               sleepBetweenIterationsMs: params.sleepBetweenIterationsMs,
               reportEverySeconds: 2,
               label: params.label,
               onProgress,
            })
         } else if (params.scenario === 'xmpp-messages') {
            result = await runXmppMessages({
               parallelism: params.parallelism,
               durationSeconds: params.durationSeconds,
               rampUpSeconds: params.rampUpSeconds,
               sleepBetweenIterationsMs: params.sleepBetweenIterationsMs,
               reportEverySeconds: 2,
               label: params.label,
               onProgress,
            })
         } else if (params.scenario === 'xmpp-connect') {
            result = await runXmppConnect({
               parallelism: params.parallelism,
               durationSeconds: params.durationSeconds,
               rampUpSeconds: params.rampUpSeconds,
               sleepBetweenIterationsMs: params.sleepBetweenIterationsMs,
               reportEverySeconds: 2,
               label: params.label,
               onProgress,
            })
         } else {
            const journeyEnv = getJourneyEnvFromProcess()
            result = await runLoad({
               parallelism: params.parallelism,
               durationSeconds: params.durationSeconds,
               rampUpSeconds: params.rampUpSeconds,
               sleepBetweenIterationsMs: params.sleepBetweenIterationsMs,
               reportEverySeconds: 2,
               journeyMode: params.mode,
               journeyEnv,
               label: params.label || `journey:${params.mode}`,
               onProgress,
            })
         }
         finish({ status: 'done', result })
      } catch (e: any) {
         finish({ status: 'error', error: e?.message || String(e) })
      }
   })()

   return state
}
