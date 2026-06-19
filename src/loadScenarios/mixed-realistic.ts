// Ethora.com platform, copyright: Dappros Ltd (c) 2026, all rights reserved
//
// Mixed-realistic scenario.
//
// Each worker picks a journey mode per iteration from a weighted distribution
// that approximates a "typical day in the life" of an Ethora tenant:
//   - chat send/receive (covered by the `basic` journey) dominates,
//   - some users open dashboard / read reports,
//   - occasional file uploads,
//   - rare auth refresh.
//
// This is the right baseline scenario to characterise a deployment of a given
// machine size (Vitall-like or QA-like): instead of stressing one endpoint
// in isolation it exercises the same mix of routes a real customer would
// generate, so the breakpoint we find is representative of real-world load.

import { runJourney, getJourneyEnvFromProcess } from '../journeyRunner.js'
import { runLoad, type LoadRunResult } from '../loadRunner.js'

export interface MixedRealisticOptions {
   parallelism: number
   durationSeconds: number
   rampUpSeconds?: number
   sleepBetweenIterationsMs?: number
   label?: string
}

const DEFAULT_DISTRIBUTION: Array<{ mode: string; weight: number }> = [
   { mode: 'basic', weight: 60 },          // signup + chat + cleanup — the bread and butter
   { mode: 'private_chat', weight: 15 },   // 1-1 DM exchange
   { mode: 'app_stats', weight: 10 },      // admin reads stats — heavy on Mongo aggregations
   { mode: 'chat_reports', weight: 5 },    // export CSV — disk + memory work
   { mode: 'v1_files', weight: 5 },        // file upload — multer + MinIO + image work
   { mode: 'token_refresh', weight: 5 },   // background refresh — cheap, but high RPS in real life
]

function pickMode(distribution = DEFAULT_DISTRIBUTION): string {
   const total = distribution.reduce((a, b) => a + b.weight, 0)
   const r = Math.random() * total
   let acc = 0
   for (const { mode, weight } of distribution) {
      acc += weight
      if (r <= acc) return mode
   }
   return distribution[distribution.length - 1].mode
}

export async function runMixedRealistic(
   opts: MixedRealisticOptions,
): Promise<LoadRunResult> {
   const env = getJourneyEnvFromProcess()
   return await runLoad({
      parallelism: opts.parallelism,
      durationSeconds: opts.durationSeconds,
      rampUpSeconds: opts.rampUpSeconds,
      sleepBetweenIterationsMs: opts.sleepBetweenIterationsMs,
      label: opts.label || 'mixed-realistic',
      workerFn: async () => {
         const mode = pickMode()
         const r = await runJourney(env, { mode })
         return { ok: !!r.ok, details: { mode, ...(r.details || {}) } }
      },
   })
}
