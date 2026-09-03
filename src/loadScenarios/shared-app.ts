// Ethora.com platform, copyright: Dappros Ltd (c) 2026, all rights reserved
//
// Shared-app load scenario.
//
// The journey-based scenarios (basic/b2b/…) each create AND tear down their own
// synthetic app per iteration, keyed by a *stable* displayName so a failed run
// self-heals via orphan-sweep. That is correct for sequential uptime checks but
// breaks under parallelism: every worker shares the same displayName, so one
// worker's orphan-sweep archives the app another worker is mid-login against →
// `403 APP_ARCHIVED`. It also conflates app-creation cost with the thing we
// actually want to measure.
//
// This scenario instead provisions ONE synthetic app up front (unique
// displayName, so no cross-run/cross-worker collision), then every worker
// iteration does the real high-frequency auth work — sign up a unique user and
// log them in — against that shared app. Teardown deletes the one app at the
// end. This measures signup/login capacity (exactly the path the auth rate
// limiter protects) without per-iteration app churn.

import { getJourneyEnvFromProcess, type JourneyEnv } from '../journeyRunner.js'
import { runLoad, type LoadRunResult, type LoadProgressSnapshot } from '../loadRunner.js'

export interface SharedAppOptions {
   parallelism: number
   durationSeconds: number
   rampUpSeconds?: number
   sleepBetweenIterationsMs?: number
   reportEverySeconds?: number
   label?: string
   onProgress?: (snapshot: LoadProgressSnapshot) => void
   /** Unique-ish suffix for the synthetic app + user emails. Defaults to a timestamp. */
   suffix?: string
}

// Synthetic marker header: the backend recognises `__uptime__`-prefixed apps +
// this header and skips HubSpot/Slack/etc. side-effects on creation.
const SYNTHETIC_HEADERS: Record<string, string> = { 'x-ethora-synthetic': '1' }

async function httpJson(method: string, url: string, headers: Record<string, string>, body?: any) {
   const resp = await fetch(url, {
      method,
      // Marker on every call — see the note in journeyRunner.ts's httpJson.
      headers: { ...SYNTHETIC_HEADERS, ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
   })
   const text = await resp.text()
   let json: any = null
   try {
      json = text ? JSON.parse(text) : null
   } catch {
      // non-JSON body; leave json null
   }
   return { resp, json, text }
}

interface SharedAppContext {
   ownerToken: string
   appId: string
   appToken: string
}

// Provision the single shared app: base config → admin login → create app.
async function setupSharedApp(env: JourneyEnv, displayName: string): Promise<SharedAppContext> {
   const cfg = await httpJson(
      'GET',
      `${env.ethoraApiBase}/v1/apps/get-config?domainName=${encodeURIComponent(env.baseDomainName)}`,
      {},
   )
   if (!cfg.resp.ok) throw new Error(`get-config failed: ${cfg.resp.status} ${cfg.text}`)
   const baseAppToken =
      cfg.json?.appToken || cfg.json?.app?.appToken || cfg.json?.result?.appToken || cfg.json?.result?.app?.appToken
   if (!baseAppToken) throw new Error('get-config: missing appToken')

   const login = await httpJson(
      'POST',
      `${env.ethoraApiBase}/v1/users/login-with-email`,
      { Authorization: String(baseAppToken) },
      { email: env.adminEmail, password: env.adminPassword },
   )
   if (!login.resp.ok) throw new Error(`admin login failed: ${login.resp.status} ${login.text}`)
   const ownerToken = String(login.json?.token || '').trim()
   if (!ownerToken) throw new Error('admin login: missing token')

   const created = await httpJson(
      'POST',
      `${env.ethoraApiBase}/v1/apps`,
      { Authorization: `Bearer ${ownerToken}`, ...SYNTHETIC_HEADERS },
      { displayName },
   )
   if (!created.resp.ok) throw new Error(`create shared app failed: ${created.resp.status} ${created.text}`)
   const appObj = created.json?.app || created.json?.result?.app || created.json?.result || created.json
   const appId = String(appObj?._id || appObj?.id || '').trim()
   const appToken = String(appObj?.appToken || '').trim()
   if (!appId) throw new Error('create shared app: missing app._id')
   if (!appToken) throw new Error('create shared app: missing app.appToken')

   return { ownerToken, appId, appToken }
}

async function teardownSharedApp(env: JourneyEnv, ctx: SharedAppContext): Promise<void> {
   await httpJson(
      'DELETE',
      `${env.ethoraApiBase}/v1/apps/${encodeURIComponent(ctx.appId)}`,
      { Authorization: `Bearer ${ctx.ownerToken}`, ...SYNTHETIC_HEADERS },
   )
}

// One iteration: sign up a brand-new user into the shared app, then log in.
// Unique email per (worker, iteration) so signups never collide.
async function signupAndLogin(
   env: JourneyEnv,
   ctx: SharedAppContext,
   suffix: string,
   workerId: number,
   iteration: number,
): Promise<{ ok: boolean; details?: Record<string, any> }> {
   const email = `loadtest-${suffix}-w${workerId}-i${iteration}@example.com`
   const password = `Pass-${suffix}-${workerId}-${iteration}-Abc123`

   const signup = await httpJson(
      'POST',
      `${env.ethoraApiBase}/v2/users/sign-up-with-email`,
      { Authorization: String(ctx.appToken) },
      { email, firstName: 'Load', lastName: `User${workerId}`, password, cfToken: '', utm: '' },
   )
   if (!signup.resp.ok) {
      return { ok: false, details: { error: `signup failed: ${signup.resp.status} ${signup.text}` } }
   }

   const login = await httpJson(
      'POST',
      `${env.ethoraApiBase}/v2/users/login-with-email`,
      { Authorization: String(ctx.appToken) },
      { email, password },
   )
   if (!login.resp.ok) {
      return { ok: false, details: { error: `login failed: ${login.resp.status} ${login.text}` } }
   }
   if (!login.json?.token) {
      return { ok: false, details: { error: 'login: missing token' } }
   }

   return { ok: true }
}

export async function runSharedApp(opts: SharedAppOptions): Promise<LoadRunResult> {
   const env = getJourneyEnvFromProcess()
   // Date.now() is fine here (normal Node runtime, not a workflow script); we
   // only need a per-run-unique token for the app displayName + emails.
   const suffix = opts.suffix || `${Date.now().toString(36)}`
   const displayName = `__uptime__load_${suffix}`

   const ctx = await setupSharedApp(env, displayName)
   try {
      return await runLoad({
         parallelism: opts.parallelism,
         durationSeconds: opts.durationSeconds,
         rampUpSeconds: opts.rampUpSeconds,
         sleepBetweenIterationsMs: opts.sleepBetweenIterationsMs,
         reportEverySeconds: opts.reportEverySeconds,
         onProgress: opts.onProgress,
         label: opts.label || 'shared-app',
         workerFn: (workerId, iteration) => signupAndLogin(env, ctx, suffix, workerId, iteration),
      })
   } finally {
      // Always attempt to remove the shared app, even if the run threw.
      try {
         await teardownSharedApp(env, ctx)
      } catch {
         // best-effort cleanup; a leaked __uptime__load_* app is harmless and
         // can be swept manually if needed.
      }
   }
}
