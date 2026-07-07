// Ethora.com platform, copyright: Dappros Ltd (c) 2026, all rights reserved
//
// Load-test CLI entry point.
//
// Usage:
//   npm run load -- --scenario journey --mode basic --parallelism 50 --duration 300
//   npm run load -- --scenario mixed-realistic --parallelism 100 --duration 600 --ramp-up 60
//
// Required env (same as `runJourney`):
//   ETHORA_API_BASE, ETHORA_BASE_DOMAIN_NAME, ETHORA_ADMIN_EMAIL,
//   ETHORA_ADMIN_PASSWORD. Some journey modes also need
//   ETHORA_XMPP_SERVICE / ETHORA_XMPP_HOST / ETHORA_B2B_APP_ID /
//   ETHORA_B2B_APP_SECRET — see journeyRunner.ts for details.
//
// Output: a JSON summary on stdout. Non-zero exit if any iteration failed.

import { writeFileSync } from 'node:fs'
import { getJourneyEnvFromProcess } from './journeyRunner.js'
import { runLoad } from './loadRunner.js'
import { runMixedRealistic } from './loadScenarios/mixed-realistic.js'

function parseArgs(argv: string[]): Record<string, string> {
   const out: Record<string, string> = {}
   for (let i = 0; i < argv.length; i++) {
      const a = argv[i]
      if (!a.startsWith('--')) continue
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
         out[key] = next
         i++
      } else {
         out[key] = 'true'
      }
   }
   return out
}

function num(s: string | undefined, def: number): number {
   if (s === undefined) return def
   const n = Number(s)
   return Number.isFinite(n) ? n : def
}

function printHelp() {
   console.log(`Ethora load-test CLI

Usage:
  npm run load -- --scenario <name> [flags]

Scenarios:
  journey               Run a single journey mode in N parallel workers.
                        Requires: --mode <basic|advanced|b2b|token_refresh|
                                  signup_validation|password_reset|app_stats|
                                  user_tags|chat_reports|v1_files|
                                  private_chat|v2_user_chats|lifecycle>
  mixed-realistic       Weighted mix of journey modes per iteration
                        (default: basic 60%, private_chat 15%, app_stats 10%,
                        chat_reports 5%, v1_files 5%, token_refresh 5%).

Common flags:
  --parallelism N       Number of concurrent workers (default 10).
  --duration SECONDS    Total run time (default 60).
  --ramp-up SECONDS     Spread worker starts over this many seconds (default 0).
  --sleep-ms MS         Sleep this many ms between iterations per worker (default 0).
  --report-every SEC    Console progress every N seconds (default 10, 0 = silent).
  --label TEXT          Friendly label for log output.
  --out PATH            Write JSON summary to PATH in addition to stdout.

Required env vars are the same as for \`npm run journey\` — see
journeyRunner.ts > getJourneyEnvFromProcess for the full list.

Examples:
  # 60-second smoke: 10 users running the basic journey
  npm run load -- --scenario journey --mode basic --parallelism 10 --duration 60

  # 10-minute realistic mix, ramping from 0 to 100 users over the first minute
  npm run load -- --scenario mixed-realistic --parallelism 100 --duration 600 --ramp-up 60
`)
}

async function main(): Promise<void> {
   const args = parseArgs(process.argv.slice(2))
   if (args.help || args.h) {
      printHelp()
      process.exit(0)
   }

   const scenario = args.scenario || 'journey'
   const parallelism = num(args.parallelism, 10)
   const durationSeconds = num(args.duration, 60)
   const rampUpSeconds = num(args['ramp-up'], 0)
   const sleepBetweenIterationsMs = num(args['sleep-ms'], 0)
   const reportEverySeconds = num(args['report-every'], 10)
   const label = args.label
   const outPath = args.out

   if (parallelism <= 0 || durationSeconds <= 0) {
      console.error('--parallelism and --duration must be > 0')
      process.exit(2)
   }

   let result
   if (scenario === 'journey') {
      const mode = args.mode || 'basic'
      const env = getJourneyEnvFromProcess()
      result = await runLoad({
         parallelism,
         durationSeconds,
         rampUpSeconds,
         sleepBetweenIterationsMs,
         reportEverySeconds,
         journeyMode: mode,
         journeyEnv: env,
         label: label || `journey:${mode}`,
      })
   } else if (scenario === 'mixed-realistic') {
      result = await runMixedRealistic({
         parallelism,
         durationSeconds,
         rampUpSeconds,
         sleepBetweenIterationsMs,
         label,
      })
   } else {
      console.error(`Unknown --scenario: ${scenario}`)
      printHelp()
      process.exit(2)
   }

   const json = JSON.stringify(result, null, 2)
   console.log(json)
   if (outPath) {
      try {
         writeFileSync(outPath, json + '\n')
         console.log(`[load] summary written to ${outPath}`)
      } catch (e: any) {
         console.error(`[load] failed to write ${outPath}: ${e?.message || e}`)
      }
   }

   // Exit non-zero if any iteration failed, so CI / shell scripts can branch.
   process.exit(result.failed === 0 ? 0 : 2)
}

main().catch((e) => {
   console.error('[load] fatal:', e)
   process.exit(1)
})
