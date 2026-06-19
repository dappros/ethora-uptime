// Ethora.com platform, copyright: Dappros Ltd (c) 2026, all rights reserved
//
// Load-test runner — parallelism wrapper around existing journeys.
//
// The uptime tool already knows how to drive end-to-end Ethora user flows
// (signup, login, chat, file upload, reports, …) via `runJourney(...)` in
// `journeyRunner.ts`. For load testing we don't need to re-implement any of
// that; we just need to spin up N parallel copies of those flows and measure
// what falls over first.
//
// This file is intentionally small and self-contained: it does NOT introduce
// any new dependencies (no worker_threads, no clustering) — Node.js' default
// single-threaded event loop handles the IO concurrency for us, since every
// journey is HTTP / XMPP IO-bound. If we ever need true multi-core, we wrap
// the existing API by spawning N child processes of `npm run load` from a
// supervisor — easier than retro-fitting worker_threads.

import { runJourney, type JourneyEnv, type JourneyResult } from './journeyRunner.js'

export type WorkerFn = (
   workerId: number,
   iteration: number,
) => Promise<{ ok: boolean; details?: Record<string, any> }>

export interface LoadRunOptions {
   /** How many concurrent workers (each one runs the work fn in a loop). */
   parallelism: number
   /** Spread worker starts over this many seconds (0 = all at once). */
   rampUpSeconds?: number
   /** How long each worker keeps looping (in seconds). */
   durationSeconds: number
   /** Per-iteration cooldown — useful to model "real users" who don't hammer. */
   sleepBetweenIterationsMs?: number

   /**
    * Either: pick an existing journey mode and call `runJourney(env, { mode })`
    * each iteration; OR: provide a `workerFn` for fully custom behaviour
    * (e.g. an XMPP-only chat-burst scenario that doesn't go through the
    * journey machinery at all).
    *
    * If both are given, `workerFn` wins.
    */
   journeyMode?: string
   journeyEnv?: JourneyEnv
   workerFn?: WorkerFn

   /** Console progress every N seconds (default 10). 0 disables. */
   reportEverySeconds?: number
   /** Friendly label for log lines. */
   label?: string
}

export interface IterationResult {
   workerId: number
   iteration: number
   ok: boolean
   durationMs: number
   error?: string
   details?: Record<string, any>
}

export interface LatencySnapshot {
   count: number
   meanMs: number
   p50Ms: number
   p95Ms: number
   p99Ms: number
   maxMs: number
}

export interface LoadRunResult {
   label: string
   parallelism: number
   durationSeconds: number
   startedAt: string
   finishedAt: string
   wallClockMs: number
   totalIterations: number
   ok: number
   failed: number
   successRate: number
   throughputPerSec: number
   latency: LatencySnapshot
   errorBreakdown: Array<{ error: string; count: number }>
}

function percentile(sortedAsc: number[], q: number): number {
   if (!sortedAsc.length) return 0
   const idx = Math.min(sortedAsc.length - 1, Math.floor(sortedAsc.length * q))
   return sortedAsc[idx]
}

function summarize(label: string, parallelism: number, durationSeconds: number, startedAt: number, results: IterationResult[]): LoadRunResult {
   const finishedAt = Date.now()
   const ok = results.filter((r) => r.ok)
   const failed = results.filter((r) => !r.ok)
   const latencies = results.map((r) => r.durationMs).sort((a, b) => a - b)
   const errorCounts = new Map<string, number>()
   for (const f of failed) {
      const key = (f.error || 'unknown').slice(0, 200)
      errorCounts.set(key, (errorCounts.get(key) || 0) + 1)
   }
   const wallClockMs = finishedAt - startedAt
   const mean = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0
   return {
      label,
      parallelism,
      durationSeconds,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
      wallClockMs,
      totalIterations: results.length,
      ok: ok.length,
      failed: failed.length,
      successRate: results.length ? ok.length / results.length : 0,
      throughputPerSec: results.length ? (results.length * 1000) / wallClockMs : 0,
      latency: {
         count: latencies.length,
         meanMs: Math.round(mean),
         p50Ms: percentile(latencies, 0.5),
         p95Ms: percentile(latencies, 0.95),
         p99Ms: percentile(latencies, 0.99),
         maxMs: latencies[latencies.length - 1] || 0,
      },
      errorBreakdown: Array.from(errorCounts.entries())
         .map(([error, count]) => ({ error, count }))
         .sort((a, b) => b.count - a.count),
   }
}

/**
 * Spawn N parallel workers, each running the provided `workerFn` (or
 * `runJourney(env, { mode })`) in a loop for `durationSeconds` seconds.
 * Aggregates results into a single LoadRunResult.
 */
export async function runLoad(opts: LoadRunOptions): Promise<LoadRunResult> {
   if (opts.parallelism <= 0) throw new Error('parallelism must be > 0')
   if (opts.durationSeconds <= 0) throw new Error('durationSeconds must be > 0')

   const label = opts.label || opts.journeyMode || 'custom'
   const reportEverySeconds = opts.reportEverySeconds ?? 10
   const rampUpSeconds = Math.max(0, opts.rampUpSeconds ?? 0)
   const sleepBetweenMs = Math.max(0, opts.sleepBetweenIterationsMs ?? 0)

   // Build the work-per-iteration function. If `workerFn` is provided, use it.
   // Otherwise fall back to running the named journey mode with `journeyEnv`.
   const work: WorkerFn = opts.workerFn
      ? opts.workerFn
      : async () => {
           if (!opts.journeyEnv) throw new Error('journeyEnv is required when workerFn is not provided')
           if (!opts.journeyMode) throw new Error('journeyMode is required when workerFn is not provided')
           const r: JourneyResult = await runJourney(opts.journeyEnv, { mode: opts.journeyMode })
           return { ok: !!r.ok, details: r.details }
        }

   const startedAt = Date.now()
   const endsAt = startedAt + opts.durationSeconds * 1000
   const allResults: IterationResult[] = []
   let inFlight = 0

   // Periodic progress reporter (best-effort console line every N seconds).
   let reportTimer: NodeJS.Timeout | undefined
   if (reportEverySeconds > 0) {
      reportTimer = setInterval(() => {
         const now = Date.now()
         const elapsedSec = Math.round((now - startedAt) / 1000)
         const ok = allResults.filter((r) => r.ok).length
         const failed = allResults.length - ok
         console.log(
            `[load:${label}] t=${elapsedSec}s iters=${allResults.length} ok=${ok} failed=${failed} inFlight=${inFlight}`,
         )
      }, reportEverySeconds * 1000)
   }

   const spawnWorker = async (workerId: number) => {
      // Ramp-up stagger: worker N starts after N * (rampUp/parallelism) seconds.
      if (rampUpSeconds > 0 && opts.parallelism > 1) {
         const startDelayMs = (rampUpSeconds * 1000 * workerId) / opts.parallelism
         await new Promise((r) => setTimeout(r, startDelayMs))
      }

      let iteration = 0
      while (Date.now() < endsAt) {
         iteration++
         inFlight++
         const iterStart = Date.now()
         let outcome: { ok: boolean; details?: any; error?: string }
         try {
            const r = await work(workerId, iteration)
            outcome = { ok: r.ok, details: r.details }
         } catch (e: any) {
            outcome = { ok: false, error: e?.message || String(e) }
         } finally {
            inFlight--
         }
         allResults.push({
            workerId,
            iteration,
            ok: outcome.ok,
            durationMs: Date.now() - iterStart,
            error: outcome.error,
            details: outcome.details,
         })
         if (sleepBetweenMs > 0 && Date.now() < endsAt) {
            await new Promise((r) => setTimeout(r, sleepBetweenMs))
         }
      }
   }

   const workers: Promise<void>[] = []
   for (let i = 0; i < opts.parallelism; i++) {
      workers.push(spawnWorker(i))
   }
   await Promise.all(workers)
   if (reportTimer) clearInterval(reportTimer)

   return summarize(label, opts.parallelism, opts.durationSeconds, startedAt, allResults)
}
