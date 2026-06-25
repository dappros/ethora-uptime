// Ethora.com platform, copyright: Dappros Ltd (c) 2026, all rights reserved
//
// Shared-b2b load scenario.
//
// The `b2b` journey runs the full tenant lifecycle (create app, tokens, bot,
// batch users, chats, …) against a stable-displayName synthetic app — great as
// a sequential smoke test, but under parallelism workers archive each other's
// app via orphan-sweep (403 APP_ARCHIVED) and the optional AI-bot step can hard-
// fail with 422 BOT_NOT_INITIALIZED on a fresh app.
//
// For load we want the realistic high-frequency B2B operation: a tenant backend
// provisioning users via the server-to-server batch endpoint. So this scenario
// provisions ONE child app up front (unique displayName, parent server token),
// then every worker iteration creates a small batch of unique users and polls
// the job to completion against that shared app. Teardown deletes the one app.
// No per-iteration app churn, no bot dependency, no cross-worker collision.

import {
   getJourneyEnvFromProcess,
   getB2BEnvFromProcess,
   createServerToken,
   prepareSyntheticAppV2,
   pollUserBatchJob,
   httpJson,
   SYNTHETIC_HEADERS,
   type JourneyEnv,
   type SyntheticAppRef,
} from '../journeyRunner.js'
import { runLoad, type LoadRunResult, type LoadProgressSnapshot } from '../loadRunner.js'

export interface SharedB2BOptions {
   parallelism: number
   durationSeconds: number
   rampUpSeconds?: number
   sleepBetweenIterationsMs?: number
   reportEverySeconds?: number
   label?: string
   onProgress?: (snapshot: LoadProgressSnapshot) => void
   /** How many users to create per iteration (default 2). */
   usersPerIteration?: number
   /** Unique-ish suffix for the synthetic app + user uuids. Defaults to a timestamp. */
   suffix?: string
}

interface SharedB2BContext {
   parentServerToken: string
   app: SyntheticAppRef
}

// One iteration: create a small batch of brand-new users via the B2B server
// endpoint and poll the async job to completion. uuids are unique per
// (worker, iteration) so batches never collide.
async function createUsersBatch(
   env: JourneyEnv,
   ctx: SharedB2BContext,
   suffix: string,
   usersPerIteration: number,
   workerId: number,
   iteration: number,
): Promise<{ ok: boolean; details?: Record<string, any> }> {
   const usersList = Array.from({ length: usersPerIteration }, (_, n) => {
      const uuid = `b2bload-${suffix}-w${workerId}-i${iteration}-u${n}`
      return {
         uuid,
         email: `${uuid}@example.com`,
         firstName: 'Load',
         lastName: `B2B${workerId}`,
         password: `Pass-${suffix}-${workerId}-${iteration}-${n}-Abc`,
      }
   })

   const create = await httpJson(
      'POST',
      `${env.ethoraApiBase}/v2/apps/${encodeURIComponent(ctx.app.appId)}/users/batch`,
      { Authorization: `Bearer ${ctx.parentServerToken}` },
      { bypassEmailConfirmation: true, usersList },
   )
   if (create.resp.status !== 202) {
      return { ok: false, details: { error: `create users batch failed: ${create.resp.status} ${create.text}` } }
   }
   const jobId = String(create.json?.jobId || '').trim()
   if (!jobId) {
      return { ok: false, details: { error: 'create users batch: missing jobId' } }
   }

   try {
      const job = await pollUserBatchJob(env.ethoraApiBase, ctx.app.appId, ctx.parentServerToken, jobId)
      const results = Array.isArray(job?.result?.results) ? job.result.results : []
      const anyOk = results.some((r: any) => ['created', 'exists', 'uuid_exists'].includes(String(r?.status || '')))
      if (!anyOk) {
         return { ok: false, details: { error: 'user batch created no users' } }
      }
      return { ok: true }
   } catch (e: any) {
      return { ok: false, details: { error: e?.message || String(e) } }
   }
}

export async function runSharedB2B(opts: SharedB2BOptions): Promise<LoadRunResult> {
   const env = getJourneyEnvFromProcess()
   const b2b = getB2BEnvFromProcess()
   const parentServerToken = createServerToken(b2b.appId, b2b.appSecret)
   // Date.now() is fine here (normal Node runtime, not a workflow script).
   const suffix = opts.suffix || `${Date.now().toString(36)}`
   const displayName = `__uptime__load_b2b_${suffix}`
   const usersPerIteration = Math.max(1, Math.min(50, opts.usersPerIteration || 2))

   const app = await prepareSyntheticAppV2(env.ethoraApiBase, parentServerToken, displayName)
   const ctx: SharedB2BContext = { parentServerToken, app }

   try {
      return await runLoad({
         parallelism: opts.parallelism,
         durationSeconds: opts.durationSeconds,
         rampUpSeconds: opts.rampUpSeconds,
         sleepBetweenIterationsMs: opts.sleepBetweenIterationsMs,
         reportEverySeconds: opts.reportEverySeconds,
         onProgress: opts.onProgress,
         label: opts.label || 'shared-b2b',
         workerFn: (workerId, iteration) =>
            createUsersBatch(env, ctx, suffix, usersPerIteration, workerId, iteration),
      })
   } finally {
      try {
         await httpJson(
            'DELETE',
            `${env.ethoraApiBase}/v2/apps/${encodeURIComponent(app.appId)}`,
            { Authorization: `Bearer ${parentServerToken}`, ...SYNTHETIC_HEADERS },
         )
      } catch {
         // best-effort; a leaked __uptime__load_b2b_* app is harmless.
      }
   }
}
