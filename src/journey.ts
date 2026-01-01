// Ethora.com platform, copyright: Dappros Ltd (c) 2026, all rights reserved
import { getJourneyEnvFromProcess, runJourney } from './journeyRunner.js'

async function main() {
  const env = getJourneyEnvFromProcess()
  const res = await runJourney(env)
  console.log(JSON.stringify(res, null, 2))
  process.exit(res.ok ? 0 : 2)
}

main().catch((e) => {
  console.error('[journey] fatal', e)
  process.exit(1)
})


