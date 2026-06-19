# Load testing

This package ships a small load-test driver that reuses the same journey
infrastructure as the uptime checks (`src/journeyRunner.ts`). Instead of
running a single end-to-end journey once, the load driver runs **N parallel
copies** of one or more journeys for a chosen duration and reports
throughput / latency / error breakdown.

Why this instead of k6 / JMeter:

- The journeys already drive real Ethora flows (signup, login, chat send,
  XMPP MUC, file upload, B2B admin actions, etc.) end-to-end through the
  same SDK clients a real product uses.
- No new tool / language / install — same TypeScript stack you already run
  for uptime checks. CI integration is `npm run load`.
- Result schema is plain JSON; you can pipe it into Grafana, Prometheus,
  or whatever you already use for uptime data.

For situations the journey runner does not cover (e.g. raw XMPP message
storms at 10 000 msg/min in a single MUC room), you can plug a custom
`workerFn` into `runLoad(...)` and bypass the journey machinery entirely.

## Required env

The same env vars that `npm run journey` needs:

```
ETHORA_API_BASE=https://api.<your-stage>.com
ETHORA_BASE_DOMAIN_NAME=<base app domain, e.g. "app">
ETHORA_ADMIN_EMAIL=<admin@…>
ETHORA_ADMIN_PASSWORD=<…>

# Plus, for journeys that hit XMPP:
ETHORA_XMPP_SERVICE=wss://xmpp.<your-stage>.com/ws
ETHORA_XMPP_HOST=xmpp.<your-stage>.com

# Plus, for the b2b journey:
ETHORA_B2B_APP_ID=<…>
ETHORA_B2B_APP_SECRET=<…>
```

`journeyRunner.ts` is the source of truth for which env each mode needs.

## Quick smoke

```bash
# 10 concurrent users running the basic journey for 60 s.
npm run load -- --scenario journey --mode basic --parallelism 10 --duration 60
```

Sample output (abbreviated):

```json
{
  "label": "journey:basic",
  "parallelism": 10,
  "durationSeconds": 60,
  "totalIterations": 87,
  "ok": 86,
  "failed": 1,
  "successRate": 0.9885,
  "throughputPerSec": 1.45,
  "latency": { "count": 87, "meanMs": 6754, "p50Ms": 6500, "p95Ms": 9200, "p99Ms": 10500, "maxMs": 11320 },
  "errorBreakdown": [ { "error": "ETIMEDOUT api.…/v1/users/login-with-email", "count": 1 } ]
}
```

Exit code is `0` only if every iteration succeeded; `2` otherwise. CI can
use this as the pass/fail gate.

## Scenarios

### 1. `journey` — single-mode parallel

```bash
npm run load -- \
  --scenario journey \
  --mode <basic|advanced|b2b|token_refresh|signup_validation|password_reset|
          app_stats|user_tags|chat_reports|v1_files|private_chat|v2_user_chats|lifecycle> \
  --parallelism N \
  --duration SECONDS
```

Use this when you want to stress a specific flow (e.g. push the `v1_files`
journey to find the file-upload bottleneck, or `app_stats` to find the
Mongo aggregation breakpoint).

### 2. `mixed-realistic` — weighted day-in-the-life

Each worker picks a journey mode per iteration from a weighted distribution
that approximates real customer traffic:

| Mode            | Weight | What it stresses                        |
|-----------------|-------:|-----------------------------------------|
| `basic`         |    60% | signup + chat send/receive + cleanup    |
| `private_chat`  |    15% | 1-1 DM exchange                          |
| `app_stats`     |    10% | Mongo aggregations / dashboard reads    |
| `chat_reports`  |     5% | CSV export — disk + memory             |
| `v1_files`      |     5% | multer + MinIO + image processing       |
| `token_refresh` |     5% | refresh-token verification              |

```bash
npm run load -- --scenario mixed-realistic --parallelism 100 --duration 600 --ramp-up 60
```

This is the right baseline scenario for "characterise a deployment of a
given machine size" — what breaks first when the system is exercised the
way real users exercise it.

## Common flags

| Flag                 | Default | Meaning                                                     |
|----------------------|--------:|-------------------------------------------------------------|
| `--parallelism N`    |      10 | Concurrent workers (each runs the work fn in a loop)        |
| `--duration SEC`     |      60 | Total run time. Workers stop looping after this elapses.    |
| `--ramp-up SEC`      |       0 | Spread worker starts over this many seconds.                |
| `--sleep-ms MS`      |       0 | Per-iteration sleep per worker (models "think time").       |
| `--report-every SEC` |      10 | Console progress every N seconds. `0` disables.             |
| `--label TEXT`       | scenario| Friendly label in logs / output.                            |
| `--out PATH`         |    none | Write JSON summary to PATH in addition to stdout.            |
| `--help`             |       — | Print scenario + flag list.                                 |

## Reading the output

The summary returned at the end (and written to `--out` if given) is a
single JSON object. Key fields:

- **`successRate`** — fraction of iterations that returned `ok:true`.
  Anything below ~0.95 in a healthy system means we hit a breakpoint.
- **`throughputPerSec`** — completed iterations per wall-clock second.
  Multiply by the number of API/XMPP calls a journey makes to compare
  against raw RPS figures.
- **`latency.p99Ms`** — 99th percentile of single-iteration duration.
  Compare to your SLA; values blowing past several seconds usually mean
  Mongo or the Node event loop is the bottleneck.
- **`errorBreakdown`** — top error messages with counts. First place to
  look when `failed > 0`.

## Where to run the load generator

⚠️ **Do not run from a laptop.** A consumer Wi-Fi adds 20-200 ms of
network noise and caps you at maybe a few hundred concurrent sockets.
Always run from a same-AZ EC2 instance (or equivalent) so the only thing
between the load generator and the SUT is local network.

A `t3.large` (2 vCPU / 8 GiB) is enough for ~500 concurrent journey
workers. Beyond that you'll start to see the generator itself
event-loop-stall before the SUT does.

## Collecting server-side metrics during a run

The load driver only measures the **client side** (what each worker
observes). To pair that with what the SUT is doing internally, run a
parallel snapshot collector on the SUT during the test. Suggested set:

- `pm2 monit` (or `pm2 logs --raw --nostream --lines 5000 > /tmp/pm2.log`)
- `mongostat 5 > /tmp/mongostat.csv` and `mongotop 5 > /tmp/mongotop.csv`
- `vmstat 5 > /tmp/vmstat.csv`
- `iotop -boP -d 5 -n 60 > /tmp/iotop.csv` (root)
- `ejabberdctl status` snapshots once per 30 s

Concrete `collect-metrics.sh` helper is on the roadmap; for now the
above commands manually invoked alongside the load run are enough to
identify the first bottleneck.

## Adding a new scenario

A scenario is just a function that returns `LoadRunResult`. Put it in
`src/loadScenarios/<name>.ts`, expose it as `runXxx(opts)`, then wire a
new branch into `loadTest.ts > main()`.

The simplest scenarios just call `runLoad(...)` with a `journeyMode`.
For anything more custom — for example "raw XMPP chat burst, 100
concurrent connections sending 10 msg/sec each in the same MUC room" —
pass a `workerFn` and skip the journey machinery entirely:

```ts
import { client, xml } from '@xmpp/client'
import { runLoad } from '../loadRunner.js'

export async function runChatBurst(opts: { ... }) {
   return runLoad({
      parallelism: opts.parallelism,
      durationSeconds: opts.durationSeconds,
      label: 'chat-burst',
      workerFn: async (workerId) => {
         // connect, join MUC, send N stanzas, measure round-trip,
         // disconnect, return { ok, details: { sent, received, p99Latency } }
      },
   })
}
```
