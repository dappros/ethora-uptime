// Ethora.com platform, copyright: Dappros Ltd (c) 2026, all rights reserved
//
// Full-b2b load scenario.
//
// Unlike `shared-b2b` (which provisions one app and only hammers batch user
// creation), this runs the COMPLETE b2b journey per iteration — create app →
// list/get/patch → provision rooms → get/put bot → create/list/rotate token →
// batch users → create/patch chat → add/remove members → teardown — so every
// B2B endpoint is exercised under parallel load, not just the hot path.
//
// The only reason the stock `journey/b2b` mode can't be parallelised is that
// every iteration shares the same stable app displayName, so one worker's
// orphan-sweep archives another's live app (403 APP_ARCHIVED). We side-step that
// by handing each iteration a UNIQUE displayName via appDisplayNameOverride, so
// the sweep matches only that iteration's own app. tolerateUninitializedBot lets
// the bot step run against the fresh app without the expected 422 failing the
// whole journey (a brand-new synthetic app has no initialized AI bot yet).

import { runJourney, getJourneyEnvFromProcess, type JourneyEnv } from '../journeyRunner.js'
import { runLoad, type LoadRunResult, type LoadProgressSnapshot } from '../loadRunner.js'

export interface FullB2BOptions {
   parallelism: number
   durationSeconds: number
   rampUpSeconds?: number
   sleepBetweenIterationsMs?: number
   reportEverySeconds?: number
   label?: string
   onProgress?: (snapshot: LoadProgressSnapshot) => void
   /** Unique-ish run token used to namespace each iteration's app. Defaults to a timestamp. */
   suffix?: string
}

export async function runFullB2B(opts: FullB2BOptions): Promise<LoadRunResult> {
   const env: JourneyEnv = getJourneyEnvFromProcess()
   // Date.now() is fine here (normal Node runtime, not a workflow script).
   const suffix = opts.suffix || `${Date.now().toString(36)}`

   return await runLoad({
      parallelism: opts.parallelism,
      durationSeconds: opts.durationSeconds,
      rampUpSeconds: opts.rampUpSeconds,
      sleepBetweenIterationsMs: opts.sleepBetweenIterationsMs,
      reportEverySeconds: opts.reportEverySeconds,
      onProgress: opts.onProgress,
      label: opts.label || 'full-b2b',
      workerFn: async (workerId, iteration) => {
         // Unique app displayName per iteration → no cross-worker orphan-sweep
         // collision. Keep the `__uptime__` prefix so the backend still applies
         // the synthetic-app side-effect bypass.
         const appDisplayNameOverride = `__uptime__journey_b2b_load_${suffix}_w${workerId}_i${iteration}`
         const r = await runJourney(env, {
            mode: 'b2b',
            appDisplayNameOverride,
            tolerateUninitializedBot: true,
         })
         return { ok: !!r.ok, details: r.details }
      },
   })
}
