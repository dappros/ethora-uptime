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

export interface LoadRunParams {
   scenario: 'journey' | 'mixed-realistic' | 'shared-app' | 'shared-b2b' | 'full-b2b'
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

   const scenario: LoadRunParams['scenario'] =
      raw.scenario === 'mixed-realistic'
         ? 'mixed-realistic'
         : raw.scenario === 'shared-app'
           ? 'shared-app'
           : raw.scenario === 'shared-b2b'
             ? 'shared-b2b'
             : raw.scenario === 'full-b2b'
               ? 'full-b2b'
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
