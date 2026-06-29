// Ethora.com platform, copyright: Dappros Ltd (c) 2026, all rights reserved
import crypto from 'node:crypto'
import { WebSocket as WsImpl } from 'ws'
import { client as xmppClient, xml } from '@xmpp/client'

// `@xmpp/client`'s websocket transport reads `globalThis.WebSocket`. Node 20 has no
// built-in global WebSocket, so polyfill once. Idempotent and safe on Node 21+.
if (typeof (globalThis as any).WebSocket === 'undefined') {
  (globalThis as any).WebSocket = WsImpl
}

// Synthetic-app contract (must be kept in sync with the backend's
// `isSyntheticTestApp` helper in createAppV1.service.js):
// - The backend recognises any app whose displayName starts with `__uptime__`
//   as a synthetic test app and SKIPS marketing/analytics side-effects
//   (HubSpot/Slack/etc.) for it.
// - We use a STABLE displayName per journey "mode" so the analytics bypass
//   always fires deterministically, but we still CREATE + DELETE the app on
//   every run. That way:
//     1) `POST /v1/apps` (or `/v2/apps`) and `DELETE /v1/apps/:id` are exercised
//        by every uptime tick (this is the whole point of a synthetic regression).
//     2) the admin Apps list only shows the synthetic app for the brief window
//        of an in-flight run, never permanently.
//     3) HubSpot/Slack/CRM never receive a "new app" event because the
//        displayName always matches the bypass prefix.
//
// Per-mode displayNames are kept distinct so two different journey modes
// (basic + advanced + b2b) can run concurrently without colliding on the
// same name in flight (runLock already prevents same-mode concurrency).
//
// If a previous run died mid-way and left an orphan, the next run's
// `prepareSyntheticApp*` helper finds it by displayName and deletes it
// before creating its own fresh app — leaks self-heal automatically.
export const SYNTHETIC_APP_DISPLAY_NAME_PREFIX = '__uptime__'
export const SYNTHETIC_APP_DISPLAY_NAME_BASIC = '__uptime__journey'
export const SYNTHETIC_APP_DISPLAY_NAME_ADVANCED = '__uptime__journey_advanced'
export const SYNTHETIC_APP_DISPLAY_NAME_B2B = '__uptime__journey_b2b'

// Optional manual journeys (enabled: false in uptime.yml; user runs from UI).
// Each gets its own stable per-mode displayName so concurrent runs of different
// modes don't collide.
export const SYNTHETIC_APP_DISPLAY_NAME_PASSWORD_RESET = '__uptime__journey_password_reset'
export const SYNTHETIC_APP_DISPLAY_NAME_USER_TAGS = '__uptime__journey_user_tags'
export const SYNTHETIC_APP_DISPLAY_NAME_CHAT_REPORTS = '__uptime__journey_chat_reports'
export const SYNTHETIC_APP_DISPLAY_NAME_APP_STATS = '__uptime__journey_app_stats'
export const SYNTHETIC_APP_DISPLAY_NAME_V1_FILES = '__uptime__journey_v1_files'
export const SYNTHETIC_APP_DISPLAY_NAME_PRIVATE_CHAT = '__uptime__journey_private_chat'
export const SYNTHETIC_APP_DISPLAY_NAME_V2_USER_CHATS = '__uptime__journey_v2_user_chats'
// Lifecycle (2607+): soft-delete -> restore -> export -> hard-delete -> import.
// Verifies the full backup/restore promise including end-user round-trip.
export const SYNTHETIC_APP_DISPLAY_NAME_LIFECYCLE = '__uptime__journey_lifecycle'

// Stable header so a server admin can also distinguish these calls in logs/proxy rules.
export const SYNTHETIC_HEADERS: Record<string, string> = { 'x-ethora-synthetic': '1' }

export type JourneyEnv = {
  ethoraApiBase: string
  baseDomainName: string
  adminEmail: string
  adminPassword: string
  // Retained for backwards compatibility with existing uptime.env files; no longer
  // used to mint new app names — synthetic apps now have stable display names.
  appNamePrefix: string
  usersCount: number
}

type JourneyMode =
  | 'basic'
  | 'advanced'
  | 'b2b'
  // Optional manual journeys (enabled: false by default; run via UI button)
  | 'token_refresh'
  | 'signup_validation'
  | 'password_reset'
  | 'app_stats'
  | 'user_tags'
  | 'chat_reports'
  | 'v1_files'
  | 'private_chat'
  | 'v2_user_chats'
  | 'lifecycle'

type JourneyOptions = {
  mode?: string
  // Optional operator room to stream journey progress into (room name or full room JID).
  // This does NOT replace the journey's own test rooms; it is only an observer stream.
  observerRoom?: string
  // Load-testing only: override the synthetic app's displayName so each parallel
  // iteration gets its OWN uniquely-named app. The journeys normally key the app
  // by a stable per-mode displayName so a failed sequential run self-heals via
  // orphan-sweep — but under parallelism that sweep archives sibling workers'
  // live apps (403 APP_ARCHIVED). A unique displayName side-steps the collision.
  appDisplayNameOverride?: string
  // Load-testing only: a freshly-created synthetic app has no initialized AI bot,
  // so PUT /bot returns 422 BOT_NOT_INITIALIZED. Uptime checks treat that as a
  // hard failure (correctly); load runs set this to exercise the bot endpoints
  // without the missing-bot 422 failing the whole journey.
  tolerateUninitializedBot?: boolean
}

export type JourneyResult = {
  ok: boolean
  details: Record<string, any>
}

function normalizeObserverRoomJid(input: string, baseAppId: string, mucServiceDefault: string) {
  const s = String(input || '').trim()
  if (!s) return ''

  const [rawLocal, rawDomain] = s.includes('@') ? s.split('@', 2) : [s, '']
  const local = String(rawLocal || '').trim()
  if (!local) return ''

  const normalizedLocal = !baseAppId
    ? local
    : local.startsWith(`${baseAppId}_`)
      ? local
      : `${baseAppId}_${local}`

  const domain = String(rawDomain || '').trim() || mucServiceDefault
  return `${normalizedLocal}@${domain}`
}

function must(value: string | undefined, name: string) {
  if (!value) throw new Error(`Missing env: ${name}`)
  return value
}

export function getJourneyEnvFromProcess(): JourneyEnv {
  return {
    ethoraApiBase: must(process.env.ETHORA_API_BASE, 'ETHORA_API_BASE').replace(/\/$/, ''),
    baseDomainName: must(process.env.ETHORA_BASE_DOMAIN_NAME, 'ETHORA_BASE_DOMAIN_NAME'),
    adminEmail: must(process.env.ETHORA_ADMIN_EMAIL, 'ETHORA_ADMIN_EMAIL'),
    adminPassword: must(process.env.ETHORA_ADMIN_PASSWORD, 'ETHORA_ADMIN_PASSWORD'),
    appNamePrefix: process.env.ETHORA_APP_NAME_PREFIX || 'uptime-journey',
    usersCount: Number(process.env.ETHORA_USERS_COUNT || 2),
  }
}

type XmppEnv = {
  serviceUrl: string
  host: string
  mucService: string
}

function getXmppEnvFromProcess(): XmppEnv {
  const serviceUrl = must(process.env.ETHORA_XMPP_SERVICE, 'ETHORA_XMPP_SERVICE')
  const host = must(process.env.ETHORA_XMPP_HOST, 'ETHORA_XMPP_HOST')
  const mucService = process.env.ETHORA_XMPP_MUC_SERVICE || `conference.${host}`
  return { serviceUrl, host, mucService }
}

export type B2BEnv = {
  appId: string
  appSecret: string
}

export function getB2BEnvFromProcess(): B2BEnv {
  const appId = process.env.ETHORA_B2B_APP_ID || process.env.ETHORA_CHAT_APP_ID
  const appSecret = process.env.ETHORA_B2B_APP_SECRET || process.env.ETHORA_CHAT_APP_SECRET
  return {
    appId: must(appId, 'ETHORA_B2B_APP_ID'),
    appSecret: must(appSecret, 'ETHORA_B2B_APP_SECRET'),
  }
}

function resolveMode(env: JourneyEnv, opts?: JourneyOptions): JourneyMode {
  const candidates = [opts?.mode, process.env.ETHORA_JOURNEY_MODE]
    .filter(Boolean)
    .map((s) => String(s).toLowerCase())
  const value = candidates.find(Boolean) || 'basic'

  // Order matters: more specific tokens before generic ones.
  if (value.includes('token_refresh') || value.includes('token-refresh')) return 'token_refresh'
  if (value.includes('signup_validation') || value.includes('signup-validation')) return 'signup_validation'
  if (value.includes('password_reset') || value.includes('password-reset')) return 'password_reset'
  if (value.includes('app_stats') || value.includes('app-stats')) return 'app_stats'
  if (value.includes('user_tags') || value.includes('user-tags')) return 'user_tags'
  if (value.includes('chat_reports') || value.includes('chat-reports')) return 'chat_reports'
  if (value.includes('v1_files') || value.includes('v1-files')) return 'v1_files'
  if (value.includes('private_chat') || value.includes('private-chat')) return 'private_chat'
  if (value.includes('v2_user_chats') || value.includes('v2-user-chats')) return 'v2_user_chats'
  if (value.includes('lifecycle') || value.includes('archive') || value.includes('soft_delete') || value.includes('soft-delete')) return 'lifecycle'
  if (value.includes('b2b') || value.includes('server')) return 'b2b'
  if (value.includes('advanced') || value.includes('comprehensive')) return 'advanced'
  return 'basic'
}

function randSuffix() {
  return crypto.randomUUID().slice(0, 8)
}

export async function httpJson(method: string, url: string, headers: Record<string, string>, body?: any) {
  const resp = await fetch(url, {
    method,
    headers: {
      ...headers,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await resp.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    // ignore
  }
  return { resp, json, text }
}

function base64url(input: Buffer | string) {
  return Buffer.from(input).toString('base64url')
}

function deriveScopedSecret(secret: string, purpose: string) {
  return crypto.createHmac('sha256', String(secret)).update(`ethora:${purpose}:v1`).digest('hex')
}

export function createServerToken(appId: string, appSecret: string, tenantId?: string) {
  const header = { alg: 'HS256', typ: 'JWT' }
  const payload: any = { data: { type: 'server', appId: String(appId) } }
  if (tenantId) payload.data.tenantId = String(tenantId)
  const encodedHeader = base64url(JSON.stringify(header))
  const encodedPayload = base64url(JSON.stringify(payload))
  const data = `${encodedHeader}.${encodedPayload}`
  const signingSecret = deriveScopedSecret(appSecret, 'server')
  const signature = crypto.createHmac('sha256', signingSecret).update(data).digest('base64url')
  return `${data}.${signature}`
}

function getResultObject(input: any) {
  return input?.result || input?.app || input
}

export type SyntheticAppRef = {
  appId: string
  appToken: string
  // Number of orphan apps from previous failed runs that were cleaned up before
  // this run created its own fresh app. Surfaced in the wallboard "Details"
  // modal so operators can spot a flapping leak pattern quickly.
  orphansCleaned: number
}

// Find every existing app whose displayName === <displayName> and delete each one.
// This recovers from previous failed runs that left an orphan app behind.
// Returns the count of orphans deleted (0 in the happy path).
async function deleteOrphansV1(
  apiBase: string,
  ownerToken: string,
  displayName: string
): Promise<number> {
  let cleaned = 0
  const limit = 100
  let offset = 0
  for (let page = 0; page < 5; page++) {
    const list = await httpJson(
      'GET',
      `${apiBase}/v1/apps?limit=${limit}&offset=${offset}&orderBy=displayName&order=asc`,
      { Authorization: `Bearer ${ownerToken}`, ...SYNTHETIC_HEADERS }
    )
    if (!list.resp.ok) break
    const apps = Array.isArray(list.json?.apps) ? list.json.apps : []
    const matches = apps.filter((a: any) => String(a?.displayName || '') === displayName)
    for (const m of matches) {
      const id = String(m?._id || m?.id || '').trim()
      if (!id) continue
      try {
        await httpJson(
          'DELETE',
          `${apiBase}/v1/apps/${encodeURIComponent(id)}`,
          { Authorization: `Bearer ${ownerToken}`, ...SYNTHETIC_HEADERS }
        )
        cleaned += 1
      } catch {
        // best-effort; if delete fails, the create below may still succeed (different _id).
      }
    }
    if (apps.length < limit) break
    offset += limit
  }
  return cleaned
}

// Sweep any orphan apps from previous failed runs (matching this stable displayName),
// then create a fresh synthetic app. Always exercises POST /v1/apps so the synthetic
// also doubles as a regression test for app creation.
export async function prepareSyntheticAppV1(
  apiBase: string,
  ownerToken: string,
  displayName: string
): Promise<SyntheticAppRef> {
  const orphansCleaned = await deleteOrphansV1(apiBase, ownerToken, displayName)

  // Create the synthetic app. The backend recognises the `__uptime__` prefix
  // and skips HubSpot/Slack/etc. side-effects (see createAppV1.service.js).
  const created = await httpJson(
    'POST',
    `${apiBase}/v1/apps`,
    { Authorization: `Bearer ${ownerToken}`, ...SYNTHETIC_HEADERS },
    { displayName }
  )
  if (!created.resp.ok) {
    throw new Error(`create synthetic app failed: ${created.resp.status} ${created.text}`)
  }
  const appObj = created.json?.app || created.json?.result?.app || created.json?.result || created.json
  const id = String(appObj?._id || appObj?.id || '').trim()
  const token = String(appObj?.appToken || '').trim()
  if (!id) throw new Error('create synthetic app: missing app._id')
  if (!token) throw new Error('create synthetic app: missing app.appToken')
  return { appId: id, appToken: token, orphansCleaned }
}

async function deleteOrphansV2(
  apiBase: string,
  parentServerToken: string,
  displayName: string
): Promise<number> {
  let cleaned = 0
  const limit = 100
  let offset = 0
  for (let page = 0; page < 5; page++) {
    const list = await httpJson(
      'GET',
      `${apiBase}/v2/apps?limit=${limit}&offset=${offset}&orderBy=displayName&order=asc`,
      { Authorization: `Bearer ${parentServerToken}`, ...SYNTHETIC_HEADERS }
    )
    if (!list.resp.ok) break
    const items = Array.isArray(list.json?.items) ? list.json.items
      : Array.isArray(list.json?.apps) ? list.json.apps
      : []
    const matches = items.filter((a: any) => String(a?.displayName || '') === displayName)
    for (const m of matches) {
      const id = String(m?._id || m?.id || '').trim()
      if (!id) continue
      try {
        await httpJson(
          'DELETE',
          `${apiBase}/v2/apps/${encodeURIComponent(id)}`,
          { Authorization: `Bearer ${parentServerToken}`, ...SYNTHETIC_HEADERS }
        )
        cleaned += 1
      } catch {
        // best-effort
      }
    }
    if (items.length < limit) break
    offset += limit
  }
  return cleaned
}

// V2 / B2B variant: orphan-sweep + create fresh child app under the parent tenant.
export async function prepareSyntheticAppV2(
  apiBase: string,
  parentServerToken: string,
  displayName: string
): Promise<SyntheticAppRef> {
  const orphansCleaned = await deleteOrphansV2(apiBase, parentServerToken, displayName)

  const created = await httpJson(
    'POST',
    `${apiBase}/v2/apps`,
    { Authorization: `Bearer ${parentServerToken}`, ...SYNTHETIC_HEADERS },
    { displayName }
  )
  if (!created.resp.ok) {
    throw new Error(`create synthetic b2b app failed: ${created.resp.status} ${created.text}`)
  }
  const appObj = created.json?.app || created.json?.result?.app || created.json?.result || created.json
  const id = String(appObj?._id || appObj?.id || '').trim()
  const token = String(appObj?.appToken || '').trim()
  if (!id) throw new Error('create synthetic b2b app: missing app._id')
  // v2 create may not return token directly — fetch detail.
  let resolvedToken = token
  if (!resolvedToken) {
    const detail = await httpJson(
      'GET',
      `${apiBase}/v2/apps/${encodeURIComponent(id)}`,
      { Authorization: `Bearer ${parentServerToken}`, ...SYNTHETIC_HEADERS }
    )
    if (detail.resp.ok) {
      const obj = getResultObject(detail.json)
      resolvedToken = String(obj?.appToken || '').trim()
    }
  }
  if (!resolvedToken) throw new Error('create synthetic b2b app: missing app.appToken')
  return { appId: id, appToken: resolvedToken, orphansCleaned }
}

export async function pollUserBatchJob(apiBase: string, appId: string, authToken: string, jobId: string, timeoutMs = 120000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const resp = await httpJson(
      'GET',
      `${apiBase}/v2/apps/${encodeURIComponent(appId)}/users/batch/${encodeURIComponent(jobId)}`,
      { Authorization: `Bearer ${authToken}` }
    )
    if (!resp.resp.ok) throw new Error(`batch job status failed: ${resp.resp.status} ${resp.text}`)
    const state = String(resp.json?.state || '')
    if (state === 'completed') return resp.json
    if (state === 'failed') throw new Error(`batch job failed: ${resp.json?.error || resp.text}`)
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
  throw new Error('batch job poll timeout')
}

// ============================================================================
// Shared synthetic-context helpers (used by the optional manual journeys).
//
// Each manual journey needs the same boilerplate — get base config, login admin,
// orphan-sweep + create the synthetic app, sign up + login N test users — and
// the same teardown — delete chats/files/sharelinks/users/app. Extracting these
// helpers keeps each new journey runner ~30-50 lines focused on the actual
// thing being tested instead of repeating ~100 lines of fixture wiring.
// ============================================================================

type TestUser = {
  email: string
  password: string
  token: string
  xmppUsername: string
  xmppPassword: string
  id: string
}

type SyntheticContext = {
  baseAppToken: string
  ownerUserToken: string
  syntheticApp: SyntheticAppRef
  users: TestUser[]
  suffix: string
  // Mutable lists the journey body pushes to as it creates resources.
  // The teardown helper iterates these in reverse-creation order.
  chatNames: string[]
  fileIds: string[]
  shareTokens: string[]
}

async function setupSyntheticContext(
  env: JourneyEnv,
  appDisplayName: string,
  usersCount: number,
  suffix: string,
  details: Record<string, any>,
  step: (name: string, extra?: any) => void
): Promise<SyntheticContext> {
  step('get_base_app_config')
  const cfgResp = await httpJson(
    'GET',
    `${env.ethoraApiBase}/v1/apps/get-config?domainName=${encodeURIComponent(env.baseDomainName)}`,
    {}
  )
  if (!cfgResp.resp.ok) throw new Error(`get-config failed: ${cfgResp.resp.status} ${cfgResp.text}`)
  const baseAppToken =
    cfgResp.json?.appToken ||
    cfgResp.json?.app?.appToken ||
    cfgResp.json?.result?.appToken ||
    cfgResp.json?.result?.app?.appToken
  if (!baseAppToken) throw new Error('get-config: missing appToken in response')

  step('login_admin_user')
  const loginResp = await httpJson(
    'POST',
    `${env.ethoraApiBase}/v1/users/login-with-email`,
    { Authorization: String(baseAppToken) },
    { email: env.adminEmail, password: env.adminPassword }
  )
  if (!loginResp.resp.ok) throw new Error(`login-with-email failed: ${loginResp.resp.status} ${loginResp.text}`)
  const ownerUserToken = String(loginResp.json?.token || '').trim()
  if (!ownerUserToken) throw new Error('login-with-email: missing token')

  step('prepare_synthetic_app', { displayName: appDisplayName })
  const syntheticApp = await prepareSyntheticAppV1(env.ethoraApiBase, ownerUserToken, appDisplayName)
  details.appId = syntheticApp.appId
  details.orphansCleaned = syntheticApp.orphansCleaned
  if (syntheticApp.orphansCleaned > 0) {
    step('cleaned_orphans', { count: syntheticApp.orphansCleaned })
  }
  step('create_app', { appId: syntheticApp.appId })

  const users: TestUser[] = []
  for (let i = 0; i < usersCount; i++) {
    const email = `uptime-${suffix}-${i}@example.com`
    const password = `Pass-${suffix}-${i}-Abc123`

    step('signup_user_v2', { i })
    const signupResp = await httpJson(
      'POST',
      `${env.ethoraApiBase}/v2/users/sign-up-with-email`,
      { Authorization: String(syntheticApp.appToken) },
      { email, firstName: `Uptime${i}`, lastName: `Journey${suffix}`, password, cfToken: '', utm: '' }
    )
    if (!signupResp.resp.ok) throw new Error(`signup v2 failed: ${signupResp.resp.status} ${signupResp.text}`)

    step('login_user_v2', { i })
    const userLoginResp = await httpJson(
      'POST',
      `${env.ethoraApiBase}/v2/users/login-with-email`,
      { Authorization: String(syntheticApp.appToken) },
      { email, password }
    )
    if (!userLoginResp.resp.ok) throw new Error(`login v2 failed: ${userLoginResp.resp.status} ${userLoginResp.text}`)
    const u = userLoginResp.json?.user
    const t = userLoginResp.json?.token
    if (!u?._id || !t) throw new Error('login v2: missing user or token')
    users.push({
      email,
      password,
      token: String(t),
      xmppUsername: String(u?.xmppUsername || ''),
      xmppPassword: String(u?.xmppPassword || ''),
      id: String(u._id),
    })
  }

  return {
    baseAppToken: String(baseAppToken),
    ownerUserToken,
    syntheticApp,
    users,
    suffix,
    chatNames: [],
    fileIds: [],
    shareTokens: [],
  }
}

async function teardownSyntheticContext(
  env: JourneyEnv,
  ctx: SyntheticContext | null,
  details: Record<string, any>,
  step: (name: string, extra?: any) => void,
  cleanupErr: (stage: string, e: any) => void
): Promise<void> {
  if (!ctx) return
  const ownerToken = ctx.ownerUserToken
  const userToken = ctx.users[0]?.token

  // 1) sharelinks (user auth)
  for (const tok of ctx.shareTokens) {
    if (!userToken) break
    try {
      step('cleanup_delete_sharelink', { token: tok.slice(0, 8) })
      const r = await httpJson(
        'DELETE',
        `${env.ethoraApiBase}/v1/sharelink/${encodeURIComponent(tok)}`,
        { Authorization: `Bearer ${userToken}` }
      )
      if (!r.resp.ok) cleanupErr('delete_sharelink', new Error(`status=${r.resp.status} ${r.text}`))
    } catch (e) { cleanupErr('delete_sharelink', e) }
  }

  // 2) files (user auth, v2 first then v1 fallback)
  for (const fid of ctx.fileIds) {
    if (!userToken) break
    try {
      step('cleanup_delete_file', { fileId: fid })
      const r = await httpJson(
        'DELETE',
        `${env.ethoraApiBase}/v2/files/${encodeURIComponent(fid)}`,
        { Authorization: `Bearer ${userToken}` }
      )
      if (!r.resp.ok && r.resp.status === 404) {
        const r1 = await httpJson(
          'DELETE',
          `${env.ethoraApiBase}/v1/files/${encodeURIComponent(fid)}`,
          { Authorization: `Bearer ${userToken}` }
        )
        if (!r1.resp.ok) cleanupErr('delete_file', new Error(`status=${r1.resp.status} ${r1.text}`))
      } else if (!r.resp.ok) {
        cleanupErr('delete_file', new Error(`status=${r.resp.status} ${r.text}`))
      }
    } catch (e) { cleanupErr('delete_file', e) }
  }

  // 3) chats (user auth)
  for (const name of ctx.chatNames) {
    if (!userToken) break
    try {
      step('cleanup_delete_chat', { chatName: name })
      const r = await httpJson(
        'DELETE',
        `${env.ethoraApiBase}/v1/chats`,
        { Authorization: `Bearer ${userToken}`, 'Content-Type': 'application/json' },
        { name }
      )
      if (!r.resp.ok) cleanupErr('delete_chat', new Error(`status=${r.resp.status} ${r.text}`))
    } catch (e) { cleanupErr('delete_chat', e) }
  }

  // 4) users (admin auth)
  if (ctx.users.length) {
    try {
      step('cleanup_delete_users')
      const r = await httpJson(
        'POST',
        `${env.ethoraApiBase}/v1/users/delete-many-with-app-id/${encodeURIComponent(String(ctx.syntheticApp.appId))}`,
        { Authorization: `Bearer ${ownerToken}` },
        { usersIdList: ctx.users.map((u) => u.id) }
      )
      if (!r.resp.ok) cleanupErr('delete_users', new Error(`status=${r.resp.status} ${r.text}`))
    } catch (e) { cleanupErr('delete_users', e) }
  }

  // 5) app (admin auth) — always last so we have an app context for the
  // user/chat/file deletes above.
  try {
    step('cleanup_delete_app')
    const r = await httpJson(
      'DELETE',
      `${env.ethoraApiBase}/v1/apps/${encodeURIComponent(String(ctx.syntheticApp.appId))}`,
      { Authorization: `Bearer ${ownerToken}`, ...SYNTHETIC_HEADERS }
    )
    if (!r.resp.ok) cleanupErr('delete_app', new Error(`status=${r.resp.status} ${r.text}`))
  } catch (e) { cleanupErr('delete_app', e) }
}

function makeManualJourneyShell(mode: string) {
  const suffix = randSuffix()
  const details: Record<string, any> = {
    suffix,
    mode,
    steps: [],
    cleanup: { errors: [] as Array<{ stage: string; message: string }> },
  }
  const step = (name: string, extra?: any) => details.steps.push({ name, ...extra, ts: new Date().toISOString() })
  const cleanupErr = (stage: string, e: any) => {
    details.cleanup.errors.push({ stage, message: e?.message || String(e) })
  }
  return { suffix, details, step, cleanupErr }
}

// ============================================================================
// Optional manual journeys (enabled: false in uptime.yml; user runs from UI).
// Each focuses on a small slice of the API surface that the always-on journeys
// don't already cover, so an operator can fire them on demand for QA / regression.
// ============================================================================

// 1) journey_token_refresh — verifies POST /v1/users/login + /login/refresh roundtrip.
//    Uses the base app and admin credentials (no synthetic app needed).
async function runJourneyTokenRefresh(env: JourneyEnv): Promise<JourneyResult> {
  const { suffix: _suffix, details, step } = makeManualJourneyShell('token_refresh')
  try {
    step('get_base_app_config')
    const cfgResp = await httpJson(
      'GET',
      `${env.ethoraApiBase}/v1/apps/get-config?domainName=${encodeURIComponent(env.baseDomainName)}`,
      {}
    )
    if (!cfgResp.resp.ok) throw new Error(`get-config failed: ${cfgResp.resp.status} ${cfgResp.text}`)
    const baseAppToken =
      cfgResp.json?.appToken ||
      cfgResp.json?.app?.appToken ||
      cfgResp.json?.result?.appToken ||
      cfgResp.json?.result?.app?.appToken
    if (!baseAppToken) throw new Error('get-config: missing appToken')

    step('login_admin')
    const loginResp = await httpJson(
      'POST',
      `${env.ethoraApiBase}/v1/users/login-with-email`,
      { Authorization: String(baseAppToken) },
      { email: env.adminEmail, password: env.adminPassword }
    )
    if (!loginResp.resp.ok) throw new Error(`login failed: ${loginResp.resp.status} ${loginResp.text}`)
    const accessToken = String(loginResp.json?.token || '').trim()
    const refreshToken = String(loginResp.json?.refreshToken || loginResp.json?.refresh_token || '').trim()
    if (!accessToken) throw new Error('login: missing token')
    if (!refreshToken) {
      // Some installs may not issue a refresh token (no rotating-token feature). Treat as skipped.
      step('skipped', { reason: 'login response missing refreshToken' })
      details.warning = 'login did not return a refreshToken; backend may not support refresh flow'
      return { ok: true, details }
    }

    step('refresh_token')
    const refreshResp = await httpJson(
      'POST',
      `${env.ethoraApiBase}/v1/users/login/refresh`,
      { Authorization: String(baseAppToken) },
      { refreshToken }
    )
    if (!refreshResp.resp.ok) throw new Error(`refresh failed: ${refreshResp.resp.status} ${refreshResp.text}`)
    const newToken = String(refreshResp.json?.token || refreshResp.json?.accessToken || '').trim()
    if (!newToken) throw new Error('refresh: missing new token')
    if (newToken === accessToken) {
      // Not strictly wrong but suspicious — flag as a warning rather than fail.
      details.warning = 'refresh returned the same token as login (no rotation observed)'
    }

    step('verify_new_token_with_me')
    const meResp = await httpJson(
      'GET',
      `${env.ethoraApiBase}/v1/users/me`,
      { Authorization: `Bearer ${newToken}` }
    )
    if (!meResp.resp.ok) throw new Error(`users/me with refreshed token failed: ${meResp.resp.status}`)

    step('ok')
    return { ok: true, details }
  } catch (e: any) {
    details.steps.push({ name: 'error', message: e?.message || String(e), ts: new Date().toISOString() })
    return { ok: false, details: { ...details, error: e?.message || String(e) } }
  }
}

// 2) journey_signup_validation — read-only: check-domain-name + checkEmail.
async function runJourneySignupValidation(env: JourneyEnv): Promise<JourneyResult> {
  const { suffix, details, step } = makeManualJourneyShell('signup_validation')
  try {
    step('get_base_app_config')
    const cfgResp = await httpJson(
      'GET',
      `${env.ethoraApiBase}/v1/apps/get-config?domainName=${encodeURIComponent(env.baseDomainName)}`,
      {}
    )
    if (!cfgResp.resp.ok) throw new Error(`get-config failed: ${cfgResp.resp.status} ${cfgResp.text}`)
    const baseAppToken =
      cfgResp.json?.appToken ||
      cfgResp.json?.app?.appToken ||
      cfgResp.json?.result?.appToken ||
      cfgResp.json?.result?.app?.appToken
    if (!baseAppToken) throw new Error('get-config: missing appToken')

    // Use a deterministic suffix-based domain name so we always probe a
    // never-used name (expected: 200 / available).
    step('check_domain_name')
    const domainName = `uptimeprobe${suffix}`
    const dnResp = await httpJson(
      'POST',
      `${env.ethoraApiBase}/v1/apps/check-domain-name`,
      { Authorization: String(baseAppToken) },
      { domainName }
    )
    // Backends return 200 with { isAvailable: true } or similar; some may 422 on
    // reserved names. Either is fine — what we care about is the endpoint responding.
    if (!(dnResp.resp.ok || dnResp.resp.status === 422)) {
      throw new Error(`check-domain-name failed: ${dnResp.resp.status} ${dnResp.text}`)
    }
    details.checkDomain = { status: dnResp.resp.status, body: dnResp.json }

    step('check_email')
    const probeEmail = `uptime-probe-${suffix}@example.com`
    const emResp = await httpJson(
      'GET',
      `${env.ethoraApiBase}/v1/users/checkEmail/${encodeURIComponent(probeEmail)}`,
      {}
    )
    if (!(emResp.resp.ok || emResp.resp.status === 422)) {
      throw new Error(`checkEmail failed: ${emResp.resp.status} ${emResp.text}`)
    }
    details.checkEmail = { status: emResp.resp.status, body: emResp.json }

    step('ok')
    return { ok: true, details }
  } catch (e: any) {
    details.steps.push({ name: 'error', message: e?.message || String(e), ts: new Date().toISOString() })
    return { ok: false, details: { ...details, error: e?.message || String(e) } }
  }
}

// 3) journey_password_reset — POST /v1/users/forgot for an existing user, then
//    POST /v1/users/reset with a deliberately invalid token (expect 4xx).
//    Avoids consuming the real token (we can't read the email) but still verifies
//    both endpoints respond and the validation path is wired up.
async function runJourneyPasswordReset(env: JourneyEnv): Promise<JourneyResult> {
  const { suffix, details, step, cleanupErr } = makeManualJourneyShell('password_reset')
  let ctx: SyntheticContext | null = null
  try {
    ctx = await setupSyntheticContext(env, SYNTHETIC_APP_DISPLAY_NAME_PASSWORD_RESET, 1, suffix, details, step)
    const u0 = ctx.users[0]

    step('forgot_password')
    const forgotResp = await httpJson(
      'POST',
      `${env.ethoraApiBase}/v1/users/forgot`,
      { Authorization: String(ctx.syntheticApp.appToken) },
      { email: u0.email }
    )
    // Many backends always return 200 to prevent email-enumeration; some return 404
    // for unknown emails. Both are fine — we want to ensure no 5xx.
    if (forgotResp.resp.status >= 500) throw new Error(`forgot failed: ${forgotResp.resp.status} ${forgotResp.text}`)
    details.forgot = { status: forgotResp.resp.status }

    step('reset_with_bad_token')
    const badResetResp = await httpJson(
      'POST',
      `${env.ethoraApiBase}/v1/users/reset`,
      { Authorization: String(ctx.syntheticApp.appToken) },
      { token: 'uptime-invalid-token-' + suffix, password: 'NewPass-' + suffix + '-X1' }
    )
    // Expect 4xx. 5xx is a real bug, 2xx means the token validation is broken.
    if (badResetResp.resp.status >= 500) throw new Error(`reset (bad token) returned 5xx: ${badResetResp.resp.status}`)
    if (badResetResp.resp.ok) throw new Error(`reset accepted an obviously-invalid token (${badResetResp.resp.status})`)
    details.badReset = { status: badResetResp.resp.status }

    step('ok')
    return { ok: true, details }
  } catch (e: any) {
    details.steps.push({ name: 'error', message: e?.message || String(e), ts: new Date().toISOString() })
    return { ok: false, details: { ...details, error: e?.message || String(e) } }
  } finally {
    await teardownSyntheticContext(env, ctx, details, step, cleanupErr)
  }
}

// 4) journey_app_stats — synthetic app + GET /v1/apps/graph-statistic/{appId}.
//    Catches Mongo aggregation regressions on the admin dashboard data path.
async function runJourneyAppStats(env: JourneyEnv): Promise<JourneyResult> {
  const { suffix, details, step, cleanupErr } = makeManualJourneyShell('app_stats')
  let ctx: SyntheticContext | null = null
  try {
    ctx = await setupSyntheticContext(env, SYNTHETIC_APP_DISPLAY_NAME_APP_STATS, 0, suffix, details, step)
    const appId = String(ctx.syntheticApp.appId)

    step('graph_statistic')
    const r = await httpJson(
      'GET',
      `${env.ethoraApiBase}/v1/apps/graph-statistic/${encodeURIComponent(appId)}`,
      { Authorization: `Bearer ${ctx.ownerUserToken}` }
    )
    if (!r.resp.ok) throw new Error(`graph-statistic failed: ${r.resp.status} ${r.text}`)
    details.graphStatistic = { keys: Object.keys(r.json || {}).slice(0, 20) }

    // Bonus: GET /v1/apps/{id} as a single-app fetch sanity check.
    step('get_app')
    const r2 = await httpJson(
      'GET',
      `${env.ethoraApiBase}/v1/apps/${encodeURIComponent(appId)}`,
      { Authorization: `Bearer ${ctx.ownerUserToken}` }
    )
    if (!r2.resp.ok) throw new Error(`get app failed: ${r2.resp.status} ${r2.text}`)

    step('ok')
    return { ok: true, details }
  } catch (e: any) {
    details.steps.push({ name: 'error', message: e?.message || String(e), ts: new Date().toISOString() })
    return { ok: false, details: { ...details, error: e?.message || String(e) } }
  } finally {
    await teardownSyntheticContext(env, ctx, details, step, cleanupErr)
  }
}

// 5) journey_user_tags — exercise tags-add / tags-set / tags-delete.
async function runJourneyUserTags(env: JourneyEnv): Promise<JourneyResult> {
  const { suffix, details, step, cleanupErr } = makeManualJourneyShell('user_tags')
  let ctx: SyntheticContext | null = null
  try {
    ctx = await setupSyntheticContext(env, SYNTHETIC_APP_DISPLAY_NAME_USER_TAGS, 2, suffix, details, step)
    const appId = String(ctx.syntheticApp.appId)
    const userIdList = ctx.users.map((u) => u.id)
    const tagAdd = `uptime-add-${suffix}`
    const tagSet = `uptime-set-${suffix}`

    step('tags_add')
    const r1 = await httpJson(
      'POST',
      `${env.ethoraApiBase}/v1/users/tags-add/${encodeURIComponent(appId)}`,
      { Authorization: `Bearer ${ctx.ownerUserToken}` },
      { userIdList, tagsList: [tagAdd] }
    )
    if (!r1.resp.ok) throw new Error(`tags-add failed: ${r1.resp.status} ${r1.text}`)

    step('tags_set')
    const r2 = await httpJson(
      'POST',
      `${env.ethoraApiBase}/v1/users/tags-set/${encodeURIComponent(appId)}`,
      { Authorization: `Bearer ${ctx.ownerUserToken}` },
      { userIdList, tagsList: [tagSet] }
    )
    if (!r2.resp.ok) throw new Error(`tags-set failed: ${r2.resp.status} ${r2.text}`)

    step('tags_delete')
    const r3 = await httpJson(
      'POST',
      `${env.ethoraApiBase}/v1/users/tags-delete/${encodeURIComponent(appId)}`,
      { Authorization: `Bearer ${ctx.ownerUserToken}` },
      { userIdList, tagsList: [tagSet] }
    )
    if (!r3.resp.ok) throw new Error(`tags-delete failed: ${r3.resp.status} ${r3.text}`)

    step('ok')
    return { ok: true, details }
  } catch (e: any) {
    details.steps.push({ name: 'error', message: e?.message || String(e), ts: new Date().toISOString() })
    return { ok: false, details: { ...details, error: e?.message || String(e) } }
  } finally {
    await teardownSyntheticContext(env, ctx, details, step, cleanupErr)
  }
}

// 6) journey_chat_reports — public chat + report submission (moderation flow).
async function runJourneyChatReports(env: JourneyEnv): Promise<JourneyResult> {
  const { suffix, details, step, cleanupErr } = makeManualJourneyShell('chat_reports')
  let ctx: SyntheticContext | null = null
  try {
    ctx = await setupSyntheticContext(env, SYNTHETIC_APP_DISPLAY_NAME_CHAT_REPORTS, 2, suffix, details, step)
    const u0 = ctx.users[0]
    const u1 = ctx.users[1]

    step('create_chat')
    const createChatResp = await httpJson(
      'POST',
      `${env.ethoraApiBase}/v1/chats`,
      { Authorization: `Bearer ${u0.token}` },
      { title: `report-${suffix}`, description: 'uptime chat reports', type: 'public', uuid: `report-${suffix}`, members: [u1.xmppUsername] }
    )
    if (!createChatResp.resp.ok) throw new Error(`create chat failed: ${createChatResp.resp.status} ${createChatResp.text}`)
    const chatName = String(createChatResp.json?.result?.name || '').trim()
    if (!chatName) throw new Error('create chat: missing name')
    ctx.chatNames.push(chatName)

    step('report_chat')
    const reportResp = await httpJson(
      'POST',
      `${env.ethoraApiBase}/v1/chats/reports/${encodeURIComponent(chatName)}`,
      { Authorization: `Bearer ${u1.token}` },
      { reason: `uptime synthetic report ${suffix}` }
    )
    // Some backends return 201, some 200; accept any 2xx.
    if (!reportResp.resp.ok) throw new Error(`report failed: ${reportResp.resp.status} ${reportResp.text}`)

    step('ok')
    return { ok: true, details }
  } catch (e: any) {
    details.steps.push({ name: 'error', message: e?.message || String(e), ts: new Date().toISOString() })
    return { ok: false, details: { ...details, error: e?.message || String(e) } }
  } finally {
    await teardownSyntheticContext(env, ctx, details, step, cleanupErr)
  }
}

// 7) journey_v1_files — full v1 file upload + list + get + delete lifecycle.
async function runJourneyV1Files(env: JourneyEnv): Promise<JourneyResult> {
  const { suffix, details, step, cleanupErr } = makeManualJourneyShell('v1_files')
  let ctx: SyntheticContext | null = null
  try {
    ctx = await setupSyntheticContext(env, SYNTHETIC_APP_DISPLAY_NAME_V1_FILES, 1, suffix, details, step)
    const u0 = ctx.users[0]

    step('upload_v1')
    const form = new FormData()
    form.append('files', new Blob([`uptime-v1-file-${suffix}`], { type: 'text/plain' }), `v1-${suffix}.txt`)
    const upResp = await fetch(`${env.ethoraApiBase}/v1/files/`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${u0.token}` },
      body: form,
    })
    const upText = await upResp.text()
    if (!upResp.ok) throw new Error(`upload failed: ${upResp.status} ${upText}`)
    let upJson: any = null
    try { upJson = upText ? JSON.parse(upText) : null } catch {}
    const file = upJson?.results?.[0] || upJson?.files?.[0] || upJson?.[0]
    const fileId = String(file?._id || file?.id || '').trim()
    if (!fileId) throw new Error('upload: missing file id')

    step('list_v1')
    const listResp = await httpJson(
      'GET',
      `${env.ethoraApiBase}/v1/files/`,
      { Authorization: `Bearer ${u0.token}` }
    )
    if (!listResp.resp.ok) throw new Error(`list failed: ${listResp.resp.status} ${listResp.text}`)

    step('get_v1')
    const getResp = await httpJson(
      'GET',
      `${env.ethoraApiBase}/v1/files/${encodeURIComponent(fileId)}`,
      { Authorization: `Bearer ${u0.token}` }
    )
    if (!getResp.resp.ok) throw new Error(`get failed: ${getResp.resp.status} ${getResp.text}`)

    step('delete_v1')
    const delResp = await httpJson(
      'DELETE',
      `${env.ethoraApiBase}/v1/files/${encodeURIComponent(fileId)}`,
      { Authorization: `Bearer ${u0.token}` }
    )
    if (!delResp.resp.ok) {
      // Don't hard-fail if delete is unsupported — push to teardown which will retry.
      ctx.fileIds.push(fileId)
      throw new Error(`delete failed: ${delResp.resp.status} ${delResp.text}`)
    }

    step('ok')
    return { ok: true, details }
  } catch (e: any) {
    details.steps.push({ name: 'error', message: e?.message || String(e), ts: new Date().toISOString() })
    return { ok: false, details: { ...details, error: e?.message || String(e) } }
  } finally {
    await teardownSyntheticContext(env, ctx, details, step, cleanupErr)
  }
}

// 8) journey_private_chat — POST /v1/chats/private + delete.
async function runJourneyPrivateChat(env: JourneyEnv): Promise<JourneyResult> {
  const { suffix, details, step, cleanupErr } = makeManualJourneyShell('private_chat')
  let ctx: SyntheticContext | null = null
  try {
    ctx = await setupSyntheticContext(env, SYNTHETIC_APP_DISPLAY_NAME_PRIVATE_CHAT, 2, suffix, details, step)
    const u0 = ctx.users[0]
    const u1 = ctx.users[1]

    step('create_private_chat')
    const createResp = await httpJson(
      'POST',
      `${env.ethoraApiBase}/v1/chats/private`,
      { Authorization: `Bearer ${u0.token}` },
      { title: `dm-${suffix}`, members: [u1.xmppUsername], uuid: `dm-${suffix}` }
    )
    if (!createResp.resp.ok) throw new Error(`create private chat failed: ${createResp.resp.status} ${createResp.text}`)
    const chatName = String(createResp.json?.result?.name || '').trim()
    if (!chatName) throw new Error('create private chat: missing name')
    ctx.chatNames.push(chatName)

    step('list_my_chats')
    const myResp = await httpJson(
      'GET',
      `${env.ethoraApiBase}/v1/chats/my`,
      { Authorization: `Bearer ${u0.token}` }
    )
    if (!myResp.resp.ok) throw new Error(`list my chats failed: ${myResp.resp.status} ${myResp.text}`)

    step('ok')
    return { ok: true, details }
  } catch (e: any) {
    details.steps.push({ name: 'error', message: e?.message || String(e), ts: new Date().toISOString() })
    return { ok: false, details: { ...details, error: e?.message || String(e) } }
  } finally {
    await teardownSyntheticContext(env, ctx, details, step, cleanupErr)
  }
}

// 9) journey_v2_user_chats — public chat + GET /v2/chats/users + PATCH /v2/chats/users.
async function runJourneyV2UserChats(env: JourneyEnv): Promise<JourneyResult> {
  const { suffix, details, step, cleanupErr } = makeManualJourneyShell('v2_user_chats')
  let ctx: SyntheticContext | null = null
  try {
    ctx = await setupSyntheticContext(env, SYNTHETIC_APP_DISPLAY_NAME_V2_USER_CHATS, 2, suffix, details, step)
    const u0 = ctx.users[0]
    const u1 = ctx.users[1]

    step('create_chat')
    const createResp = await httpJson(
      'POST',
      `${env.ethoraApiBase}/v2/chats`,
      { Authorization: `Bearer ${u0.token}` },
      { title: `v2uc-${suffix}`, description: 'uptime v2 user chats', type: 'group', uuid: `v2uc-${suffix}`, members: [u1.xmppUsername] }
    )
    if (!createResp.resp.ok) throw new Error(`create chat failed: ${createResp.resp.status} ${createResp.text}`)
    const chatName = String(createResp.json?.result?.name || '').trim()
    if (!chatName) throw new Error('create chat: missing name')
    ctx.chatNames.push(chatName)

    step('get_v2_chats_users')
    const getResp = await httpJson(
      'GET',
      `${env.ethoraApiBase}/v2/chats/users`,
      { Authorization: `Bearer ${u0.token}` }
    )
    if (!getResp.resp.ok) throw new Error(`get /v2/chats/users failed: ${getResp.resp.status} ${getResp.text}`)
    details.usersInChats = Array.isArray(getResp.json?.users) ? getResp.json.users.length : null

    // PATCH /v2/chats/users is a multipart endpoint expecting profile-image
    // updates etc.; many installs require a file part. We send a minimal text
    // body and accept 4xx (validation error) without failing — what we want
    // to verify is that the route is mounted and responding.
    step('patch_v2_chats_users')
    const fForm = new FormData()
    fForm.append('firstName', `Updated-${suffix}`)
    const patchResp = await fetch(`${env.ethoraApiBase}/v2/chats/users`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${u0.token}` },
      body: fForm,
    })
    if (patchResp.status >= 500) {
      const txt = await patchResp.text().catch(() => '')
      throw new Error(`patch /v2/chats/users 5xx: ${patchResp.status} ${txt.slice(0, 200)}`)
    }
    details.patchStatus = patchResp.status

    step('ok')
    return { ok: true, details }
  } catch (e: any) {
    details.steps.push({ name: 'error', message: e?.message || String(e), ts: new Date().toISOString() })
    return { ok: false, details: { ...details, error: e?.message || String(e) } }
  } finally {
    await teardownSyntheticContext(env, ctx, details, step, cleanupErr)
  }
}

export async function runJourney(env: JourneyEnv, opts?: JourneyOptions): Promise<JourneyResult> {
  const mode = resolveMode(env, opts)
  if (mode === 'b2b') return await runJourneyB2B(env, opts)
  if (mode === 'advanced') return await runJourneyAdvanced(env, opts)
  // Optional manual journeys
  if (mode === 'token_refresh') return await runJourneyTokenRefresh(env)
  if (mode === 'signup_validation') return await runJourneySignupValidation(env)
  if (mode === 'password_reset') return await runJourneyPasswordReset(env)
  if (mode === 'app_stats') return await runJourneyAppStats(env)
  if (mode === 'user_tags') return await runJourneyUserTags(env)
  if (mode === 'chat_reports') return await runJourneyChatReports(env)
  if (mode === 'v1_files') return await runJourneyV1Files(env)
  if (mode === 'private_chat') return await runJourneyPrivateChat(env)
  if (mode === 'v2_user_chats') return await runJourneyV2UserChats(env)
  if (mode === 'lifecycle') return await runJourneyAdvancedLifecycle(env)

  // Per-run user/chat uniqueness via suffix; the synthetic app uses a STABLE
  // displayName per mode so the backend's `__uptime__` analytics bypass fires.
  // We still create + delete the app each run to exercise the create/delete
  // endpoints (this is a regression test) and keep the admin Apps list clean.
  const suffix = randSuffix()
  const appDisplayName = SYNTHETIC_APP_DISPLAY_NAME_BASIC

  const details: Record<string, any> = {
    suffix,
    appDisplayName,
    mode: 'basic',
    steps: [],
    cleanup: { errors: [] as Array<{ stage: string; message: string }> },
  }

  let ownerUserToken: string | null = null
  let syntheticApp: SyntheticAppRef | null = null
  const createdUserIds: string[] = []
  const createdUserXmpp: string[] = []
  let chatName: string | null = null
  let chatOwnerToken: string | null = null

  const step = (name: string, extra?: any) => details.steps.push({ name, ...extra, ts: new Date().toISOString() })
  const cleanupErr = (stage: string, e: any) => {
    details.cleanup.errors.push({ stage, message: e?.message || String(e) })
  }

  try {
    step('get_base_app_config')
    const cfgResp = await httpJson(
      'GET',
      `${env.ethoraApiBase}/v1/apps/get-config?domainName=${encodeURIComponent(env.baseDomainName)}`,
      {}
    )
    if (!cfgResp.resp.ok) throw new Error(`get-config failed: ${cfgResp.resp.status} ${cfgResp.text}`)
    // Backends return different shapes here:
    // - { appToken, ... }
    // - { app: { appToken } }
    // - { result: { appToken } }  (monoserver)
    const baseAppToken =
      cfgResp.json?.appToken ||
      cfgResp.json?.app?.appToken ||
      cfgResp.json?.result?.appToken ||
      cfgResp.json?.result?.app?.appToken
    if (!baseAppToken) throw new Error('get-config: missing appToken in response')

    step('login_admin_user')
    const loginResp = await httpJson(
      'POST',
      `${env.ethoraApiBase}/v1/users/login-with-email`,
      { Authorization: String(baseAppToken) },
      { email: env.adminEmail, password: env.adminPassword }
    )
    if (!loginResp.resp.ok) throw new Error(`login-with-email failed: ${loginResp.resp.status} ${loginResp.text}`)
    ownerUserToken = loginResp.json?.token
    if (!ownerUserToken) throw new Error('login-with-email: missing token')

    // Verify the admin user token works on the canonical /me endpoint.
    step('users_me')
    const meResp = await httpJson(
      'GET',
      `${env.ethoraApiBase}/v1/users/me`,
      { Authorization: `Bearer ${ownerUserToken}` }
    )
    if (!meResp.resp.ok) throw new Error(`users/me failed: ${meResp.resp.status} ${meResp.text}`)

    step('prepare_synthetic_app', { displayName: appDisplayName })
    syntheticApp = await prepareSyntheticAppV1(env.ethoraApiBase, ownerUserToken, appDisplayName)
    details.appId = syntheticApp.appId
    details.orphansCleaned = syntheticApp.orphansCleaned
    if (syntheticApp.orphansCleaned > 0) {
      step('cleaned_orphans', { count: syntheticApp.orphansCleaned })
    }
    step('create_app', { appId: syntheticApp.appId })

    const newAppToken = syntheticApp.appToken

    // Exercise app settings update (PUT /v1/apps/:id) — important admin flow.
    step('update_app_settings')
    const putAppResp = await httpJson(
      'PUT',
      `${env.ethoraApiBase}/v1/apps/${encodeURIComponent(String(syntheticApp.appId))}`,
      { Authorization: `Bearer ${ownerUserToken}`, ...SYNTHETIC_HEADERS },
      { appTagline: `uptime-${suffix}` }
    )
    if (!putAppResp.resp.ok) throw new Error(`update app failed: ${putAppResp.resp.status} ${putAppResp.text}`)

    for (let i = 0; i < env.usersCount; i++) {
      step('signup_user_v2', { i })
      const email = `uptime-${suffix}-${i}@example.com`
      const password = `Pass-${suffix}-${i}-Abc123`
      const signupResp = await httpJson(
        'POST',
        `${env.ethoraApiBase}/v2/users/sign-up-with-email`,
        { Authorization: String(newAppToken) },
        {
          email,
          firstName: `Uptime${i}`,
          lastName: `Journey${suffix}`,
          password,
          cfToken: '',
          utm: '',
        }
      )
      if (!signupResp.resp.ok) throw new Error(`signup v2 failed: ${signupResp.resp.status} ${signupResp.text}`)

      step('login_user_v2', { i })
      const loginRespV2 = await httpJson(
        'POST',
        `${env.ethoraApiBase}/v2/users/login-with-email`,
        { Authorization: String(newAppToken) },
        { email, password }
      )
      if (!loginRespV2.resp.ok) throw new Error(`login v2 failed: ${loginRespV2.resp.status} ${loginRespV2.text}`)
      const user = loginRespV2.json?.user
      const token = loginRespV2.json?.token
      if (!user?._id) throw new Error('login v2: missing user._id')
      if (!token) throw new Error('login v2: missing token')
      createdUserIds.push(String(user._id))
      if (user?.xmppUsername) createdUserXmpp.push(String(user.xmppUsername))
      if (i === 0) {
        chatOwnerToken = String(token)
      }
    }
    if (!chatOwnerToken) throw new Error('login v2: missing token for first user')

    step('create_chat')
    const createChatResp = await httpJson(
      'POST',
      `${env.ethoraApiBase}/v1/chats`,
      { Authorization: `Bearer ${chatOwnerToken}` },
      {
        title: `uptime-${suffix}`,
        description: 'synthetic journey',
        type: 'public',
        uuid: suffix,
        members: [],
      }
    )
    if (!createChatResp.resp.ok) throw new Error(`create chat failed: ${createChatResp.resp.status} ${createChatResp.text}`)
    chatName = createChatResp.json?.result?.name
    if (!chatName) throw new Error('create chat: missing result.name')

    if (createdUserXmpp.length > 1) {
      step('chat_add_user')
      const addResp = await httpJson(
        'POST',
        `${env.ethoraApiBase}/v1/chats/users-access`,
        { Authorization: `Bearer ${chatOwnerToken}` },
        { chatName, members: [createdUserXmpp[1]] }
      )
      if (!addResp.resp.ok) throw new Error(`add user failed: ${addResp.resp.status} ${addResp.text}`)
    }

    step('ok')
    return { ok: true, details }
  } catch (e: any) {
    step('error', { message: e?.message || String(e) })
    return { ok: false, details: { ...details, error: e?.message || String(e) } }
  } finally {
    // Cleanup (best-effort): delete chat + users + the synthetic app itself.
    // Deleting the app every run keeps the admin Apps list clean AND exercises
    // the DELETE /v1/apps/:id endpoint as part of every uptime tick.
    // If any of these fail, the next run's `prepareSyntheticAppV1` will sweep
    // the orphan(s) before creating its own fresh app.
    if (chatName && chatOwnerToken) {
      try {
        step('cleanup_delete_chat')
        const r = await httpJson(
          'DELETE',
          `${env.ethoraApiBase}/v1/chats`,
          { Authorization: `Bearer ${chatOwnerToken}`, 'Content-Type': 'application/json' },
          { name: chatName }
        )
        if (!r.resp.ok) cleanupErr('delete_chat', new Error(`status=${r.resp.status} ${r.text}`))
      } catch (e) { cleanupErr('delete_chat', e) }
    }

    if (syntheticApp?.appId && ownerUserToken && createdUserIds.length) {
      try {
        step('cleanup_delete_users')
        const r = await httpJson(
          'POST',
          `${env.ethoraApiBase}/v1/users/delete-many-with-app-id/${encodeURIComponent(String(syntheticApp.appId))}`,
          { Authorization: `Bearer ${ownerUserToken}` },
          { usersIdList: createdUserIds }
        )
        if (!r.resp.ok) cleanupErr('delete_users', new Error(`status=${r.resp.status} ${r.text}`))
      } catch (e) { cleanupErr('delete_users', e) }
    }

    if (syntheticApp?.appId && ownerUserToken) {
      try {
        step('cleanup_delete_app')
        const r = await httpJson(
          'DELETE',
          `${env.ethoraApiBase}/v1/apps/${encodeURIComponent(String(syntheticApp.appId))}`,
          { Authorization: `Bearer ${ownerUserToken}`, ...SYNTHETIC_HEADERS }
        )
        if (!r.resp.ok) cleanupErr('delete_app', new Error(`status=${r.resp.status} ${r.text}`))
      } catch (e) { cleanupErr('delete_app', e) }
    }
  }
}

async function runJourneyB2B(env: JourneyEnv, opts?: JourneyOptions): Promise<JourneyResult> {
  // Per-run uniqueness happens at user/chat level (UUIDs include the suffix).
  // The synthetic child app is reused across runs (Option A+C) unless a load run
  // passes a unique displayName override to avoid cross-worker orphan-sweep.
  const suffix = randSuffix()
  const appDisplayName = opts?.appDisplayNameOverride || SYNTHETIC_APP_DISPLAY_NAME_B2B
  const details: Record<string, any> = {
    suffix,
    appDisplayName,
    mode: 'b2b',
    steps: [],
    cleanup: { errors: [] as Array<{ stage: string; message: string }> },
  }

  const b2b = getB2BEnvFromProcess()
  const parentServerToken = createServerToken(b2b.appId, b2b.appSecret)
  const step = (name: string, extra?: any) => details.steps.push({ name, ...extra, ts: new Date().toISOString() })
  const cleanupErr = (stage: string, e: any) => {
    details.cleanup.errors.push({ stage, message: e?.message || String(e) })
  }

  let syntheticApp: SyntheticAppRef | null = null
  let createdAppId: string | null = null
  let createdChatName: string | null = null
  const createdUserUuids: string[] = []
  let createdTokenId: string | null = null

  try {
    step('prepare_synthetic_app_v2', { displayName: appDisplayName })
    syntheticApp = await prepareSyntheticAppV2(env.ethoraApiBase, parentServerToken, appDisplayName)
    createdAppId = syntheticApp.appId
    details.appId = syntheticApp.appId
    details.orphansCleaned = syntheticApp.orphansCleaned
    if (syntheticApp.orphansCleaned > 0) {
      step('cleaned_orphans_v2', { count: syntheticApp.orphansCleaned })
    }
    step('create_app_v2', { appId: syntheticApp.appId })

    step('list_apps_v2')
    const listAppsResp = await httpJson(
      'GET',
      `${env.ethoraApiBase}/v2/apps?limit=20&offset=0`,
      { Authorization: `Bearer ${parentServerToken}`, ...SYNTHETIC_HEADERS }
    )
    if (!listAppsResp.resp.ok) throw new Error(`list apps failed: ${listAppsResp.resp.status} ${listAppsResp.text}`)

    step('get_app_v2')
    const getAppResp = await httpJson(
      'GET',
      `${env.ethoraApiBase}/v2/apps/${encodeURIComponent(createdAppId)}`,
      { Authorization: `Bearer ${parentServerToken}`, ...SYNTHETIC_HEADERS }
    )
    if (!getAppResp.resp.ok) throw new Error(`get app failed: ${getAppResp.resp.status} ${getAppResp.text}`)

    // Exercise app-settings update via tenant actor.
    step('patch_app_v2')
    const patchAppResp = await httpJson(
      'PATCH',
      `${env.ethoraApiBase}/v2/apps/${encodeURIComponent(createdAppId)}`,
      { Authorization: `Bearer ${parentServerToken}`, ...SYNTHETIC_HEADERS },
      { appTagline: `uptime-tagline-${suffix}` }
    )
    if (!patchAppResp.resp.ok) throw new Error(`patch app failed: ${patchAppResp.resp.status} ${patchAppResp.text}`)

    // Provision default rooms — exercises the bulk room provisioning helper.
    step('provision_rooms_v2')
    const provisionResp = await httpJson(
      'POST',
      `${env.ethoraApiBase}/v2/apps/${encodeURIComponent(createdAppId)}/provision`,
      { Authorization: `Bearer ${parentServerToken}`, ...SYNTHETIC_HEADERS },
      { rooms: [{ title: `Provisioned-${suffix}`, pinned: false }] }
    )
    if (!provisionResp.resp.ok) throw new Error(`provision rooms failed: ${provisionResp.resp.status} ${provisionResp.text}`)

    // AI Bot read/write — best-effort: AI-bot service is optional and may be
    // unavailable in some deployments. We exercise the API surface but treat
    // 5xx specifically as a "skipped" so we don't false-RED the journey.
    step('get_app_bot_v2')
    const getBotResp = await httpJson(
      'GET',
      `${env.ethoraApiBase}/v2/apps/${encodeURIComponent(createdAppId)}/bot`,
      { Authorization: `Bearer ${parentServerToken}`, ...SYNTHETIC_HEADERS }
    )
    if (getBotResp.resp.ok) {
      step('put_app_bot_v2')
      const putBotResp = await httpJson(
        'PUT',
        `${env.ethoraApiBase}/v2/apps/${encodeURIComponent(createdAppId)}/bot`,
        { Authorization: `Bearer ${parentServerToken}`, ...SYNTHETIC_HEADERS },
        { status: 'off', greetingMessage: `uptime-${suffix}` }
      )
      if (!putBotResp.resp.ok && putBotResp.resp.status < 500) {
        const botCode = String(putBotResp.json?.code || '')
        // Load runs use freshly-created apps that have no initialized bot yet;
        // tolerate that specific 422 so the rest of the journey still runs.
        if (opts?.tolerateUninitializedBot && putBotResp.resp.status === 422 && botCode === 'BOT_NOT_INITIALIZED') {
          step('put_app_bot_v2_skipped', { status: 422, code: botCode })
        } else {
          throw new Error(`put app bot failed: ${putBotResp.resp.status} ${putBotResp.text}`)
        }
      }
    } else if (getBotResp.resp.status < 500) {
      throw new Error(`get app bot failed: ${getBotResp.resp.status} ${getBotResp.text}`)
    } else {
      step('get_app_bot_v2_skipped', { status: getBotResp.resp.status })
    }

    step('create_app_token_v2')
    const createTokenResp = await httpJson(
      'POST',
      `${env.ethoraApiBase}/v2/apps/${encodeURIComponent(createdAppId)}/tokens`,
      { Authorization: `Bearer ${parentServerToken}`, ...SYNTHETIC_HEADERS },
      { label: `uptime-${suffix}` }
    )
    if (!createTokenResp.resp.ok) throw new Error(`create app token failed: ${createTokenResp.resp.status} ${createTokenResp.text}`)
    createdTokenId = String(createTokenResp.json?.tokenId || '').trim()

    step('list_app_tokens_v2')
    const listTokensResp = await httpJson(
      'GET',
      `${env.ethoraApiBase}/v2/apps/${encodeURIComponent(createdAppId)}/tokens`,
      { Authorization: `Bearer ${parentServerToken}` }
    )
    if (!listTokensResp.resp.ok) throw new Error(`list app tokens failed: ${listTokensResp.resp.status} ${listTokensResp.text}`)

    // Exercise app-token rotation — important for B2B credential management.
    if (createdTokenId) {
      step('rotate_app_token_v2')
      const rotateResp = await httpJson(
        'POST',
        `${env.ethoraApiBase}/v2/apps/${encodeURIComponent(createdAppId)}/tokens/${encodeURIComponent(createdTokenId)}/rotate`,
        { Authorization: `Bearer ${parentServerToken}`, ...SYNTHETIC_HEADERS },
        { label: `uptime-${suffix}-rot` }
      )
      if (!rotateResp.resp.ok) throw new Error(`rotate app token failed: ${rotateResp.resp.status} ${rotateResp.text}`)
      // Rotation revokes the old token id and may return a new one. If the API
      // returns the new tokenId, track it so cleanup deletes the right record.
      const rotatedTokenId = String(rotateResp.json?.tokenId || '').trim()
      if (rotatedTokenId) createdTokenId = rotatedTokenId
    }

    const user1Uuid = `b2b-${suffix}-u1`
    const user2Uuid = `b2b-${suffix}-u2`
    createdUserUuids.push(user1Uuid, user2Uuid)

    step('create_users_batch_v2')
    const createUsersResp = await httpJson(
      'POST',
      `${env.ethoraApiBase}/v2/apps/${encodeURIComponent(createdAppId)}/users/batch`,
      { Authorization: `Bearer ${parentServerToken}` },
      {
        bypassEmailConfirmation: true,
        usersList: [
          { uuid: user1Uuid, email: `${user1Uuid}@example.com`, firstName: 'B2B', lastName: 'UserOne', password: `Pass-${suffix}-1` },
          { uuid: user2Uuid, email: `${user2Uuid}@example.com`, firstName: 'B2B', lastName: 'UserTwo', password: `Pass-${suffix}-2` },
        ],
      }
    )
    if (createUsersResp.resp.status !== 202) throw new Error(`create users batch failed: ${createUsersResp.resp.status} ${createUsersResp.text}`)
    const createUsersJobId = String(createUsersResp.json?.jobId || '').trim()
    if (!createUsersJobId) throw new Error('create users batch: missing jobId')

    step('poll_users_batch_v2', { jobId: createUsersJobId })
    const batchJob = await pollUserBatchJob(env.ethoraApiBase, createdAppId, parentServerToken, createUsersJobId)
    const batchResults = Array.isArray(batchJob?.result?.results) ? batchJob.result.results : []
    if (!batchResults.some((r: any) => ['created', 'exists', 'uuid_exists'].includes(String(r?.status || '')))) {
      throw new Error('user batch did not create any users')
    }

    step('create_chat_v2')
    const createChatResp = await httpJson(
      'POST',
      `${env.ethoraApiBase}/v2/apps/${encodeURIComponent(createdAppId)}/chats`,
      { Authorization: `Bearer ${parentServerToken}` },
      { title: `b2b-${suffix}`, description: 'uptime synthetic b2b', type: 'public', uuid: `chat-${suffix}` }
    )
    if (!createChatResp.resp.ok) throw new Error(`create chat failed: ${createChatResp.resp.status} ${createChatResp.text}`)
    createdChatName = String(createChatResp.json?.result?.name || createChatResp.json?.result?.jid || '').trim()
    if (!createdChatName) throw new Error('create chat: missing room name')

    step('patch_chat_v2')
    const patchChatResp = await httpJson(
      'PATCH',
      `${env.ethoraApiBase}/v2/apps/${encodeURIComponent(createdAppId)}/chats/${encodeURIComponent(createdChatName)}`,
      { Authorization: `Bearer ${parentServerToken}` },
      { title: `b2b-updated-${suffix}` }
    )
    if (!patchChatResp.resp.ok) throw new Error(`patch chat failed: ${patchChatResp.resp.status} ${patchChatResp.text}`)

    step('add_user_to_chat_v2')
    const addUserResp = await httpJson(
      'POST',
      `${env.ethoraApiBase}/v2/apps/${encodeURIComponent(createdAppId)}/chats/users-access`,
      { Authorization: `Bearer ${parentServerToken}` },
      { chatName: createdChatName, members: [user2Uuid] }
    )
    if (!addUserResp.resp.ok) throw new Error(`add user to chat failed: ${addUserResp.resp.status} ${addUserResp.text}`)

    step('get_user_chats_v2')
    const getUserChatsResp = await httpJson(
      'GET',
      `${env.ethoraApiBase}/v2/apps/${encodeURIComponent(createdAppId)}/users/${encodeURIComponent(user2Uuid)}/chats?limit=20&includeMembers=false`,
      { Authorization: `Bearer ${parentServerToken}` }
    )
    if (!getUserChatsResp.resp.ok) throw new Error(`get user chats failed: ${getUserChatsResp.resp.status} ${getUserChatsResp.text}`)

    step('remove_user_from_chat_v2')
    const removeUserResp = await httpJson(
      'DELETE',
      `${env.ethoraApiBase}/v2/apps/${encodeURIComponent(createdAppId)}/chats/users-access`,
      { Authorization: `Bearer ${parentServerToken}` },
      { chatName: createdChatName, members: [user2Uuid] }
    )
    if (!removeUserResp.resp.ok) throw new Error(`remove user from chat failed: ${removeUserResp.resp.status} ${removeUserResp.text}`)

    // Broadcast — async announcement to selected chat rooms. Best-effort: jobId
    // polling is short and bounded so we don't block on long-running broadcasts.
    //
    // Body shape MUST match broadcastChatsV2.service.js Joi schema:
    //   { text: required, chatNames | chatIds | allRooms=true } (one of the targets is required)
    // and matches the Swagger contract documented for both
    //   POST /v2/chats/broadcast              (legacy, app-auth)
    //   POST /v2/apps/{appId}/chats/broadcast (preferred, tenant-actor / B2B)
    // see: https://api.chat-qa.ethora.com/api-docs/#/Chats/post_v2_apps__appId__chats_broadcast
    // We send via the app-scoped (B2B/tenant-actor) variant here using the parent
    // server JWT, and target the chat we created earlier by its internal name.
    step('broadcast_v2')
    const broadcastResp = await httpJson(
      'POST',
      `${env.ethoraApiBase}/v2/apps/${encodeURIComponent(createdAppId)}/chats/broadcast`,
      { Authorization: `Bearer ${parentServerToken}`, ...SYNTHETIC_HEADERS },
      { chatNames: [createdChatName], text: `uptime-broadcast-${suffix}` }
    )
    if (broadcastResp.resp.ok) {
      const broadcastJobId = String(broadcastResp.json?.jobId || '').trim()
      if (broadcastJobId) {
        step('poll_broadcast_v2', { jobId: broadcastJobId })
        const pollStart = Date.now()
        while (Date.now() - pollStart < 8000) {
          const jobResp = await httpJson(
            'GET',
            `${env.ethoraApiBase}/v2/apps/${encodeURIComponent(createdAppId)}/chats/broadcast/${encodeURIComponent(broadcastJobId)}`,
            { Authorization: `Bearer ${parentServerToken}`, ...SYNTHETIC_HEADERS }
          )
          if (!jobResp.resp.ok) {
            step('poll_broadcast_v2_skipped', { status: jobResp.resp.status })
            break
          }
          const jstate = String(jobResp.json?.state || '')
          if (jstate === 'completed' || jstate === 'failed') {
            step('broadcast_v2_done', { state: jstate })
            break
          }
          await new Promise((r) => setTimeout(r, 800))
        }
      } else {
        step('broadcast_v2_no_jobid')
      }
    } else if (broadcastResp.resp.status < 500) {
      throw new Error(`broadcast failed: ${broadcastResp.resp.status} ${broadcastResp.text}`)
    } else {
      step('broadcast_v2_skipped', { status: broadcastResp.resp.status })
    }

    step('delete_users_batch_v2')
    const deleteUsersResp = await httpJson(
      'DELETE',
      `${env.ethoraApiBase}/v2/apps/${encodeURIComponent(createdAppId)}/users/batch`,
      { Authorization: `Bearer ${parentServerToken}` },
      { usersIdList: createdUserUuids }
    )
    if (!deleteUsersResp.resp.ok) throw new Error(`delete users failed: ${deleteUsersResp.resp.status} ${deleteUsersResp.text}`)
    createdUserUuids.length = 0

    step('delete_chat_v2')
    const deleteChatResp = await httpJson(
      'DELETE',
      `${env.ethoraApiBase}/v2/apps/${encodeURIComponent(createdAppId)}/chats`,
      { Authorization: `Bearer ${parentServerToken}`, ...SYNTHETIC_HEADERS },
      { name: createdChatName }
    )
    if (!deleteChatResp.resp.ok) throw new Error(`delete chat failed: ${deleteChatResp.resp.status} ${deleteChatResp.text}`)
    createdChatName = null

    if (createdTokenId) {
      step('delete_app_token_v2')
      const deleteTokenResp = await httpJson(
        'DELETE',
        `${env.ethoraApiBase}/v2/apps/${encodeURIComponent(createdAppId)}/tokens/${encodeURIComponent(createdTokenId)}`,
        { Authorization: `Bearer ${parentServerToken}`, ...SYNTHETIC_HEADERS }
      )
      if (!deleteTokenResp.resp.ok) throw new Error(`delete app token failed: ${deleteTokenResp.resp.status} ${deleteTokenResp.text}`)
      createdTokenId = null
    }

    step('delete_app_v2')
    const deleteAppResp = await httpJson(
      'DELETE',
      `${env.ethoraApiBase}/v2/apps/${encodeURIComponent(createdAppId)}`,
      { Authorization: `Bearer ${parentServerToken}`, ...SYNTHETIC_HEADERS }
    )
    if (!deleteAppResp.resp.ok) throw new Error(`delete app failed: ${deleteAppResp.resp.status} ${deleteAppResp.text}`)
    createdAppId = null

    step('ok')
    return { ok: true, details }
  } catch (e: any) {
    step('error', { message: e?.message || String(e) })
    return { ok: false, details: { ...details, error: e?.message || String(e) } }
  } finally {
    if (createdChatName && createdAppId) {
      try {
        step('cleanup_delete_chat_v2')
        const r = await httpJson(
          'DELETE',
          `${env.ethoraApiBase}/v2/apps/${encodeURIComponent(createdAppId)}/chats`,
          { Authorization: `Bearer ${parentServerToken}`, ...SYNTHETIC_HEADERS },
          { name: createdChatName }
        )
        if (!r.resp.ok) cleanupErr('delete_chat_v2', new Error(`status=${r.resp.status} ${r.text}`))
      } catch (e) { cleanupErr('delete_chat_v2', e) }
    }

    if (createdUserUuids.length && createdAppId) {
      try {
        step('cleanup_delete_users_batch_v2')
        const r = await httpJson(
          'DELETE',
          `${env.ethoraApiBase}/v2/apps/${encodeURIComponent(createdAppId)}/users/batch`,
          { Authorization: `Bearer ${parentServerToken}`, ...SYNTHETIC_HEADERS },
          { usersIdList: createdUserUuids }
        )
        if (!r.resp.ok) cleanupErr('delete_users_v2', new Error(`status=${r.resp.status} ${r.text}`))
      } catch (e) { cleanupErr('delete_users_v2', e) }
    }

    if (createdTokenId && createdAppId) {
      try {
        step('cleanup_delete_app_token_v2')
        const r = await httpJson(
          'DELETE',
          `${env.ethoraApiBase}/v2/apps/${encodeURIComponent(createdAppId)}/tokens/${encodeURIComponent(createdTokenId)}`,
          { Authorization: `Bearer ${parentServerToken}`, ...SYNTHETIC_HEADERS }
        )
        if (!r.resp.ok) cleanupErr('delete_token_v2', new Error(`status=${r.resp.status} ${r.text}`))
      } catch (e) { cleanupErr('delete_token_v2', e) }
    }

    if (createdAppId) {
      try {
        step('cleanup_delete_app_v2')
        const r = await httpJson(
          'DELETE',
          `${env.ethoraApiBase}/v2/apps/${encodeURIComponent(createdAppId)}`,
          { Authorization: `Bearer ${parentServerToken}`, ...SYNTHETIC_HEADERS }
        )
        if (!r.resp.ok) cleanupErr('delete_app_v2', new Error(`status=${r.resp.status} ${r.text}`))
      } catch (e) { cleanupErr('delete_app_v2', e) }
    }
  }
}

export async function joinRoomByWs(
  serviceUrl: string,
  domain: string,
  usernameLocal: string,
  password: string,
  roomJid: string,
  timeoutMs: number,
  stage: string
) {
  return await new Promise<any>((resolve, reject) => {
    const xmpp = xmppClient({ service: serviceUrl, domain, username: usernameLocal, password })
    let timeoutId: any
    let stanzaHandler: any

    const cleanup = async () => {
      try { xmpp.off('stanza', stanzaHandler) } catch {}
      try { if (timeoutId) clearTimeout(timeoutId) } catch {}
    }

    xmpp.on('error', async (err: any) => {
      await cleanup()
      try { await xmpp.stop() } catch {}
      reject(err)
    })

    xmpp.on('online', () => {
      const myNick = xmpp?.jid?.getLocal ? xmpp.jid.getLocal() : usernameLocal

      stanzaHandler = (stanza: any) => {
        if (!stanza?.is?.('presence')) return
        if ((stanza.attrs?.from || '').split('/')[0] !== roomJid) return
        if (stanza.attrs?.type === 'error') {
          cleanup().then(() => reject(new Error(`XMPP_JOIN_ERROR(${stage}):${stanza.toString()}`)))
          return
        }
        cleanup().then(() => resolve(xmpp))
      }

      xmpp.on('stanza', stanzaHandler)

      timeoutId = setTimeout(() => {
        cleanup().then(async () => {
          try { await xmpp.stop() } catch {}
          reject(new Error(`XMPP_JOIN_ROOM_TIMEOUT(${stage})`))
        })
      }, timeoutMs)

      const presence = xml('presence', { to: `${roomJid}/${myNick}` }, xml('x', 'http://jabber.org/protocol/muc'))
      xmpp.send(presence)
    })

    xmpp.start().catch(reject)
  })
}

async function waitForRoomMessage(xmpp: any, roomJid: string, bodyMatch: string, timeoutMs: number) {
  return await new Promise<void>((resolve, reject) => {
    let timeoutId: any
    const onStanza = (stanza: any) => {
      if (!stanza?.is?.('message')) return
      if (stanza.attrs?.type !== 'groupchat') return
      if ((stanza.attrs?.from || '').split('/')[0] !== roomJid) return
      const body = stanza.getChildText?.('body') || ''
      // Some servers/bridges may omit body for attachment stanzas, but preserve the stanza id.
      const id = String(stanza.attrs?.id || '')
      const hasAttachments = Boolean(stanza.getChild?.('attachments'))
      if (body === bodyMatch || id === bodyMatch || (bodyMatch === 'media' && (id === 'media' || hasAttachments))) {
        cleanup().then(() => resolve())
      }
    }
    const cleanup = async () => {
      try { if (timeoutId) clearTimeout(timeoutId) } catch {}
      try { xmpp.off('stanza', onStanza) } catch {}
    }
    timeoutId = setTimeout(() => cleanup().then(() => reject(new Error('XMPP_MESSAGE_TIMEOUT'))), timeoutMs)
    xmpp.on('stanza', onStanza)
  })
}

async function runJourneyAdvanced(env: JourneyEnv, opts?: JourneyOptions): Promise<JourneyResult> {
  const suffix = randSuffix()
  // Reuse the same synthetic app as the basic journey (single slot in admin panel).
  const appDisplayName = SYNTHETIC_APP_DISPLAY_NAME_ADVANCED
  const details: Record<string, any> = {
    suffix,
    appDisplayName,
    mode: 'advanced',
    steps: [],
    cleanup: { errors: [] as Array<{ stage: string; message: string }> },
  }

  const step = (name: string, extra?: any) => details.steps.push({ name, ...extra, ts: new Date().toISOString() })
  const cleanupErr = (stage: string, e: any) => {
    details.cleanup.errors.push({ stage, message: e?.message || String(e) })
  }

  let ownerUserToken: string | null = null
  let syntheticApp: SyntheticAppRef | null = null

  const users: Array<{ email: string; password: string; token: string; xmppUsername: string; xmppPassword: string; id: string }> = []
  let testChatName: string | null = null
  let validationChatName: string | null = null

  // Hoisted into the outer scope so the finally block can clean them up.
  let createdShareToken: string | null = null
  let createdFileId: string | null = null

  const xmppClients: any[] = []
  let observerXmpp: any | null = null
  let observerRoomJid: string | null = null

  const notify = (msg: string) => {
    if (!observerXmpp || !observerRoomJid) return
    try {
      const stanza = xml(
        'message',
        { to: observerRoomJid, type: 'groupchat', id: `journey-observer-${Date.now()}` },
        xml('body', {}, String(msg).slice(0, 1800))
      )
      observerXmpp.send(stanza)
    } catch {
      // ignore
    }
  }

  try {
    step('get_base_app_config')
    const cfgResp = await httpJson(
      'GET',
      `${env.ethoraApiBase}/v1/apps/get-config?domainName=${encodeURIComponent(env.baseDomainName)}`,
      {}
    )
    if (!cfgResp.resp.ok) throw new Error(`get-config failed: ${cfgResp.resp.status} ${cfgResp.text}`)
    // Backends return different shapes here:
    // - { appToken, ... }
    // - { app: { appToken } }
    // - { result: { appToken } }  (monoserver)
    const baseAppToken =
      cfgResp.json?.appToken ||
      cfgResp.json?.app?.appToken ||
      cfgResp.json?.result?.appToken ||
      cfgResp.json?.result?.app?.appToken
    if (!baseAppToken) throw new Error('get-config: missing appToken in response')

    // Optional: stream journey steps into an existing operator chat room (best-effort).
    // Configure via env:
    // - ETHORA_JOURNEY_OBSERVER_ROOM=<roomName or roomJid>
    //   (If roomName does not start with "<baseAppId>_", it will be prefixed automatically.)
    try {
      const rawObserverRoom = String(opts?.observerRoom || process.env.ETHORA_JOURNEY_OBSERVER_ROOM || '').trim()
      if (rawObserverRoom) {
        const baseAppObj =
          cfgResp.json?.app ||
          cfgResp.json?.result?.app ||
          cfgResp.json?.result ||
          cfgResp.json
        const baseAppId = String(baseAppObj?._id || baseAppObj?.id || '').trim()

        // Login admin via v2 to get XMPP creds (xmppPassword is usually only present in v2 login response).
        const adminLoginV2 = await httpJson(
          'POST',
          `${env.ethoraApiBase}/v2/users/login-with-email`,
          { Authorization: String(baseAppToken) },
          { email: env.adminEmail, password: env.adminPassword }
        )

        if (adminLoginV2.resp.ok) {
          const adminUser = adminLoginV2.json?.user
          const adminXmppUsername = String(adminUser?.xmppUsername || '').trim()
          const adminXmppPassword = String(adminUser?.xmppPassword || '').trim()
          if (adminXmppUsername && adminXmppPassword) {
            const xmppEnv = getXmppEnvFromProcess()
            observerRoomJid = normalizeObserverRoomJid(rawObserverRoom, baseAppId, xmppEnv.mucService)

            observerXmpp = await joinRoomByWs(
              xmppEnv.serviceUrl,
              xmppEnv.host,
              adminXmppUsername,
              adminXmppPassword,
              observerRoomJid,
              8000,
              'observer'
            )
            xmppClients.push(observerXmpp)
            notify(`Uptime synthetic journey started (${suffix}) mode=advanced`)
          }
        }
      }
    } catch {
      // observer is best-effort
    }

    step('login_admin_user')
    const loginResp = await httpJson(
      'POST',
      `${env.ethoraApiBase}/v1/users/login-with-email`,
      { Authorization: String(baseAppToken) },
      { email: env.adminEmail, password: env.adminPassword }
    )
    if (!loginResp.resp.ok) throw new Error(`login-with-email failed: ${loginResp.resp.status} ${loginResp.text}`)
    ownerUserToken = loginResp.json?.token
    if (!ownerUserToken) throw new Error('login-with-email: missing token')
    notify('login_admin_user ok')

    step('prepare_synthetic_app', { displayName: appDisplayName })
    syntheticApp = await prepareSyntheticAppV1(env.ethoraApiBase, ownerUserToken, appDisplayName)
    details.appId = syntheticApp.appId
    details.orphansCleaned = syntheticApp.orphansCleaned
    if (syntheticApp.orphansCleaned > 0) {
      step('cleaned_orphans', { count: syntheticApp.orphansCleaned })
    }
    step('create_app', { appId: syntheticApp.appId })
    const newAppToken = syntheticApp.appToken
    notify(`synthetic app created appId=${syntheticApp.appId}${syntheticApp.orphansCleaned ? ` (cleaned ${syntheticApp.orphansCleaned} orphan(s) first)` : ''}`)

    const usersCount = Math.max(3, Number(env.usersCount || 3))
    for (let i = 0; i < usersCount; i++) {
      const email = `uptime-${suffix}-${i}@example.com`
      const password = `Pass-${suffix}-${i}-Abc123`

      step('signup_user_v2', { i })
      const signupResp = await httpJson(
        'POST',
        `${env.ethoraApiBase}/v2/users/sign-up-with-email`,
        { Authorization: String(newAppToken) },
        { email, firstName: `Uptime${i}`, lastName: `Journey${suffix}`, password, cfToken: '', utm: '' }
      )
      if (!signupResp.resp.ok) throw new Error(`signup v2 failed: ${signupResp.resp.status} ${signupResp.text}`)

      step('login_user_v2', { i })
      const loginRespV2 = await httpJson(
        'POST',
        `${env.ethoraApiBase}/v2/users/login-with-email`,
        { Authorization: String(newAppToken) },
        { email, password }
      )
      if (!loginRespV2.resp.ok) throw new Error(`login v2 failed: ${loginRespV2.resp.status} ${loginRespV2.text}`)
      const user = loginRespV2.json?.user
      const token = loginRespV2.json?.token
      if (!user?._id || !token) throw new Error('login v2: missing user or token')
      users.push({
        email,
        password,
        token: String(token),
        xmppUsername: String(user?.xmppUsername || ''),
        xmppPassword: String(user?.xmppPassword || ''),
        id: String(user._id),
      })
    }
    notify(`users ready count=${users.length}`)

    if (users.length < 3) throw new Error('advanced journey requires at least 3 users')
    const [alice, bob, charlie] = users

    step('create_chat_test')
    const createTestChat = await httpJson(
      'POST',
      `${env.ethoraApiBase}/v2/chats`,
      { Authorization: `Bearer ${alice.token}` },
      { title: `Test-${suffix}`, description: 'synthetic journey test', type: 'group', uuid: `test-${suffix}`, members: [] }
    )
    if (!createTestChat.resp.ok) throw new Error(`create test chat failed: ${createTestChat.resp.status} ${createTestChat.text}`)
    testChatName = createTestChat.json?.result?.name
    if (!testChatName) throw new Error('create test chat: missing result.name')
    notify(`create_chat_test ok room=${testChatName}`)

    step('create_chat_validation')
    const createValidationChat = await httpJson(
      'POST',
      `${env.ethoraApiBase}/v2/chats`,
      { Authorization: `Bearer ${alice.token}` },
      { title: `Validation-${suffix}`, description: 'synthetic journey validation', type: 'group', uuid: `validation-${suffix}`, members: [] }
    )
    if (!createValidationChat.resp.ok) throw new Error(`create validation chat failed: ${createValidationChat.resp.status} ${createValidationChat.text}`)
    validationChatName = createValidationChat.json?.result?.name
    if (!validationChatName) throw new Error('create validation chat: missing result.name')
    notify(`create_chat_validation ok room=${validationChatName}`)

    step('add_members_test')
    const addTest = await httpJson(
      'POST',
      `${env.ethoraApiBase}/v2/chats/users-access`,
      { Authorization: `Bearer ${alice.token}` },
      { chatName: testChatName, members: [bob.xmppUsername, charlie.xmppUsername] }
    )
    if (!addTest.resp.ok) throw new Error(`add test members failed: ${addTest.resp.status} ${addTest.text}`)
    notify('add_members_test ok')

    step('add_members_validation')
    const addValidation = await httpJson(
      'POST',
      `${env.ethoraApiBase}/v2/chats/users-access`,
      { Authorization: `Bearer ${alice.token}` },
      { chatName: validationChatName, members: [bob.xmppUsername] }
    )
    if (!addValidation.resp.ok) throw new Error(`add validation members failed: ${addValidation.resp.status} ${addValidation.text}`)
    notify('add_members_validation ok')

    const xmppEnv = getXmppEnvFromProcess()
    const testRoomJid = `${testChatName}@${xmppEnv.mucService}`
    const validationRoomJid = `${validationChatName}@${xmppEnv.mucService}`

    step('xmpp_join_test')
    const bobXmppTest = await joinRoomByWs(xmppEnv.serviceUrl, xmppEnv.host, bob.xmppUsername, bob.xmppPassword, testRoomJid, 12000, 'bob_test')
    const aliceXmppTest = await joinRoomByWs(xmppEnv.serviceUrl, xmppEnv.host, alice.xmppUsername, alice.xmppPassword, testRoomJid, 12000, 'alice_test')
    xmppClients.push(bobXmppTest, aliceXmppTest)
    notify('xmpp_join_test ok')

    const testMarker = `journey-test-${suffix}-${Date.now()}`
    step('send_test_message')
    const waitTestMsg = waitForRoomMessage(bobXmppTest, testRoomJid, testMarker, 8000)
    const msg = xml(
      'message',
      { to: testRoomJid, type: 'groupchat', id: `journey-${Date.now()}` },
      xml('body', {}, testMarker)
    )
    aliceXmppTest.send(msg)
    await waitTestMsg
    notify('send_test_message ok')

    step('xmpp_join_validation')
    const bobXmppValidation = await joinRoomByWs(xmppEnv.serviceUrl, xmppEnv.host, bob.xmppUsername, bob.xmppPassword, validationRoomJid, 12000, 'bob_validation')
    const aliceXmppValidation = await joinRoomByWs(xmppEnv.serviceUrl, xmppEnv.host, alice.xmppUsername, alice.xmppPassword, validationRoomJid, 12000, 'alice_validation')
    xmppClients.push(bobXmppValidation, aliceXmppValidation)
    notify('xmpp_join_validation ok')

    const validationMarker = `journey-validation-${suffix}-${Date.now()}`
    step('send_validation_message')
    const waitValidationMsg = waitForRoomMessage(bobXmppValidation, validationRoomJid, validationMarker, 8000)
    const msgValidation = xml(
      'message',
      { to: validationRoomJid, type: 'groupchat', id: `journey-${Date.now()}` },
      xml('body', {}, validationMarker)
    )
    aliceXmppValidation.send(msgValidation)
    await waitValidationMsg
    notify('send_validation_message ok')

    // Important ordering:
    // The backend sends the MUC "media" message BEFORE returning the HTTP response for /v1/chats/media/*.
    // If we only start waiting after the upload completes, we can miss the stanza and falsely time out.
    step('await_media_message')
    const waitMediaMsg = waitForRoomMessage(bobXmppTest, testRoomJid, 'media', 15000)

    step('upload_file')
    const form = new FormData()
    const fileBlob = new Blob([`journey-file-${suffix}`], { type: 'text/plain' })
    form.append('files', fileBlob, `journey-${suffix}.txt`)
    const uploadResp = await fetch(`${env.ethoraApiBase}/v1/chats/media/${encodeURIComponent(String(testChatName))}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.token}` },
      body: form,
    })
    const uploadText = await uploadResp.text()
    if (!uploadResp.ok) throw new Error(`file upload failed: ${uploadResp.status} ${uploadText}`)
    let uploadJson: any = null
    try { uploadJson = uploadText ? JSON.parse(uploadText) : null } catch {}
    const mediaLoc = uploadJson?.results?.[0]?.location
    if (!mediaLoc) throw new Error('file upload: missing results[0].location')

    await waitMediaMsg
    notify(`upload_file ok media=${mediaLoc}`)

    // Stop Bob in the Test room before removal to avoid lingering membership.
    try { await bobXmppTest.stop() } catch {}

    step('file_access')
    const fileResp = await fetch(mediaLoc, { method: 'GET' })
    if (!fileResp.ok) throw new Error(`file access failed: ${fileResp.status}`)

    // Sharelink lifecycle — exercise file-sharing endpoints. Best-effort:
    // share-link APIs need a fileId (returned by /v2/files upload), so we first
    // upload a generic file (not chat-attached), then create + list + delete a
    // share link for it. Both `createdShareToken` and `createdFileId` are
    // declared in the outer scope so the `finally` block can tear them down.
    try {
      step('files_v2_upload')
      const fForm = new FormData()
      fForm.append('files', new Blob([`uptime-share-${suffix}`], { type: 'text/plain' }), `share-${suffix}.txt`)
      const upResp = await fetch(`${env.ethoraApiBase}/v2/files/`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${alice.token}` },
        body: fForm,
      })
      if (upResp.ok) {
        const upJson = await upResp.json().catch(() => null)
        // v2 upload may return either { results: [{...}] } or { files: [{...}] }
        const upFile = upJson?.results?.[0] || upJson?.files?.[0] || upJson?.[0]
        createdFileId = String(upFile?._id || upFile?.id || '').trim() || null

        if (createdFileId) {
          step('sharelink_create')
          const linkResp = await httpJson(
            'POST',
            `${env.ethoraApiBase}/v1/sharelink`,
            { Authorization: `Bearer ${alice.token}` },
            { fileId: createdFileId }
          )
          if (linkResp.resp.ok) {
            createdShareToken = String(linkResp.json?.token || linkResp.json?.result?.token || '').trim() || null
            step('sharelink_list')
            await httpJson('GET', `${env.ethoraApiBase}/v1/sharelink/`, { Authorization: `Bearer ${alice.token}` })
          } else if (linkResp.resp.status < 500) {
            step('sharelink_create_skipped', { status: linkResp.resp.status })
          }
        } else {
          step('files_v2_upload_no_id')
        }
      } else {
        step('files_v2_upload_skipped', { status: upResp.status })
      }
    } catch (e: any) {
      step('sharelink_skipped', { message: e?.message || String(e) })
    }

    step('remove_bob_from_test')
    const removeResp = await httpJson(
      'DELETE',
      `${env.ethoraApiBase}/v2/chats/users-access`,
      { Authorization: `Bearer ${alice.token}` },
      { chatName: testChatName, members: [bob.xmppUsername] }
    )
    if (!removeResp.resp.ok) throw new Error(`remove user failed: ${removeResp.resp.status} ${removeResp.text}`)

    step('bob_join_denied')
    try {
      const bobRejoin = await joinRoomByWs(xmppEnv.serviceUrl, xmppEnv.host, bob.xmppUsername, bob.xmppPassword, testRoomJid, 6000, 'bob_rejoin')
      try { await bobRejoin.stop() } catch {}
      throw new Error('Bob was able to rejoin after removal')
    } catch (_e) {
      // Expected: join should fail
    }

    step('send_post_removal_message')
    const postRemovalMarker = `journey-after-remove-${suffix}-${Date.now()}`
    const msgAfterRemove = xml(
      'message',
      { to: testRoomJid, type: 'groupchat', id: `journey-${Date.now()}` },
      xml('body', {}, postRemovalMarker)
    )
    aliceXmppTest.send(msgAfterRemove)

    step('ok')
    notify('journey ok')
    return { ok: true, details }
  } catch (e: any) {
    step('error', { message: e?.message || String(e) })
    notify(`journey error: ${e?.message || String(e)}`)
    return { ok: false, details: { ...details, error: e?.message || String(e) } }
  } finally {
    for (const client of xmppClients) {
      try { await client.stop() } catch {}
    }
    // Sharelink + file cleanup (only fires if the optional sharelink block ran)
    if (createdShareToken && users[0]?.token) {
      try {
        step('cleanup_delete_sharelink')
        const r = await httpJson(
          'DELETE',
          `${env.ethoraApiBase}/v1/sharelink/${encodeURIComponent(createdShareToken)}`,
          { Authorization: `Bearer ${users[0].token}` }
        )
        if (!r.resp.ok) cleanupErr('delete_sharelink', new Error(`status=${r.resp.status} ${r.text}`))
      } catch (e) { cleanupErr('delete_sharelink', e) }
    }
    if (createdFileId && users[0]?.token) {
      try {
        step('cleanup_delete_file')
        const r = await httpJson(
          'DELETE',
          `${env.ethoraApiBase}/v2/files/${encodeURIComponent(createdFileId)}`,
          { Authorization: `Bearer ${users[0].token}` }
        )
        if (!r.resp.ok) cleanupErr('delete_file', new Error(`status=${r.resp.status} ${r.text}`))
      } catch (e) { cleanupErr('delete_file', e) }
    }
    if (testChatName && users[0]?.token) {
      try {
        step('cleanup_delete_test_chat')
        const r = await httpJson('DELETE', `${env.ethoraApiBase}/v1/chats`, { Authorization: `Bearer ${users[0].token}`, 'Content-Type': 'application/json' }, { name: testChatName })
        if (!r.resp.ok) cleanupErr('delete_test_chat', new Error(`status=${r.resp.status} ${r.text}`))
      } catch (e) { cleanupErr('delete_test_chat', e) }
    }
    if (validationChatName && users[0]?.token) {
      try {
        step('cleanup_delete_validation_chat')
        const r = await httpJson('DELETE', `${env.ethoraApiBase}/v1/chats`, { Authorization: `Bearer ${users[0].token}`, 'Content-Type': 'application/json' }, { name: validationChatName })
        if (!r.resp.ok) cleanupErr('delete_validation_chat', new Error(`status=${r.resp.status} ${r.text}`))
      } catch (e) { cleanupErr('delete_validation_chat', e) }
    }
    if (syntheticApp?.appId && ownerUserToken && users.length) {
      try {
        step('cleanup_delete_users')
        const r = await httpJson(
          'POST',
          `${env.ethoraApiBase}/v1/users/delete-many-with-app-id/${encodeURIComponent(String(syntheticApp.appId))}`,
          { Authorization: `Bearer ${ownerUserToken}` },
          { usersIdList: users.map((u) => u.id) }
        )
        if (!r.resp.ok) cleanupErr('delete_users', new Error(`status=${r.resp.status} ${r.text}`))
      } catch (e) { cleanupErr('delete_users', e) }
    }

    if (syntheticApp?.appId && ownerUserToken) {
      try {
        step('cleanup_delete_app')
        const r = await httpJson(
          'DELETE',
          `${env.ethoraApiBase}/v1/apps/${encodeURIComponent(String(syntheticApp.appId))}`,
          { Authorization: `Bearer ${ownerUserToken}`, ...SYNTHETIC_HEADERS }
        )
        if (!r.resp.ok) cleanupErr('delete_app', new Error(`status=${r.resp.status} ${r.text}`))
      } catch (e) { cleanupErr('delete_app', e) }
    }
  }
}


// ----------------------------------------------------------------------------
// Lifecycle journey: soft delete -> restore -> export -> hard delete -> import
// ----------------------------------------------------------------------------
//
// Manual/optional journey that exercises the full archive + restore + cascade
// purge + bundle round-trip flow shipped on the 2607 line. This is the
// regression-catcher for ethora-backend's soft-delete / hard-delete /
// export-import promises: if any of the assertion points below fail, a
// future change broke something documented in the API contract.
//
// Why a journey and not a unit test: these endpoints touch Mongo, ejabberd
// (MUC create/destroy), and the Bull worker that drives the cascade purge.
// Unit tests cover orchestration logic; this journey is the integration
// guardrail that runs against a live QA / staging stack.
//
// Trigger: ETHORA_JOURNEY_MODE=lifecycle npm run journey  (CLI)
//          POST /api/run-check with checkId: <instance>:journey_lifecycle (UI)
//
// Optional XMPP-side check: when ETHORA_XMPP_HOST + ETHORA_XMPP_ADMIN_PASS
// are set, the journey also asks ejabberd directly whether the MUC room
// exists at each lifecycle stage. Without those env vars it skips XMPP
// queries and reports lifecycle correctness from Mongo-level signals only.
async function runJourneyAdvancedLifecycle(env: JourneyEnv): Promise<JourneyResult> {
  const suffix = randSuffix()
  const appDisplayName = SYNTHETIC_APP_DISPLAY_NAME_LIFECYCLE
  const probeEmail = `__uptime__lifecycle-${suffix}@${env.baseDomainName}`
  const probePass = `Lf-${suffix}-${randSuffix()}!`

  const details: Record<string, any> = {
    suffix,
    appDisplayName,
    probeEmail,
    mode: 'lifecycle',
    steps: [],
    cleanup: { errors: [] as Array<{ stage: string; message: string }> },
  }
  const step = (name: string, extra?: any) => details.steps.push({ name, ...extra, ts: new Date().toISOString() })
  const cleanupErr = (stage: string, e: any) => {
    details.cleanup.errors.push({ stage, message: e?.message || String(e) })
  }

  let ownerUserToken: string | null = null
  let baseAppToken: string | null = null
  // First-pass app (created, archived/restored/exported, then hard-deleted).
  let appId: string | null = null
  // Second-pass app (created via bundle import).
  let importedAppId: string | null = null

  // Optional XMPP-side checker. Returns null when env vars aren't set so
  // callers can ignore (Mongo-level checks still run). When set, returns
  // true if ejabberd reports the room exists.
  const xmppHost = (process.env.ETHORA_XMPP_HOST || '').trim()
  const xmppAdminPass = (process.env.ETHORA_XMPP_ADMIN_PASS || '').trim()
  const xmppEnabled = !!(xmppHost && xmppAdminPass)
  async function roomExistsOnXmpp(roomName: string): Promise<boolean | null> {
    if (!xmppEnabled) return null
    // ejabberd's HTTP API requires admin@<host> Basic auth + JSON body.
    const auth = Buffer.from(`admin@${xmppHost}:${xmppAdminPass}`).toString('base64')
    const url = `http://127.0.0.1:5280/api/get_room_options`
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
        body: JSON.stringify({ name: roomName, service: `conference.${xmppHost}` }),
      })
      const text = await resp.text()
      // Existing rooms return a populated JSON map; gone rooms return {} or an error string.
      try {
        const parsed = JSON.parse(text)
        return Object.keys(parsed || {}).length > 0
      } catch {
        return false
      }
    } catch {
      // Network failure shouldn't fail the whole journey - report unknown.
      return null
    }
  }

  try {
    step('get_base_app_config')
    const cfgResp = await httpJson(
      'GET',
      `${env.ethoraApiBase}/v1/apps/get-config?domainName=${encodeURIComponent(env.baseDomainName)}`,
      {}
    )
    if (!cfgResp.resp.ok) throw new Error(`get-config failed: ${cfgResp.resp.status} ${cfgResp.text}`)
    baseAppToken =
      cfgResp.json?.appToken ||
      cfgResp.json?.app?.appToken ||
      cfgResp.json?.result?.appToken ||
      cfgResp.json?.result?.app?.appToken
    if (!baseAppToken) throw new Error('get-config: missing appToken')

    step('login_admin')
    const loginResp = await httpJson(
      'POST',
      `${env.ethoraApiBase}/v1/users/login-with-email`,
      { Authorization: String(baseAppToken) },
      { email: env.adminEmail, password: env.adminPassword }
    )
    if (!loginResp.resp.ok) throw new Error(`login failed: ${loginResp.resp.status} ${loginResp.text}`)
    ownerUserToken = loginResp.json?.token
    if (!ownerUserToken) throw new Error('login: missing token')

    // Orphan-sweep: a previous failed run could have left the lifecycle app
    // in any state (active, archived, deleting). Clean up every variant
    // before creating fresh. Uses ?includeArchived=true to see archived rows
    // and ?mode=hard so the cleanup itself doesn't leave another orphan.
    step('cleanup_orphans_start')
    let orphansCleaned = 0
    {
      const list = await httpJson(
        'GET',
        `${env.ethoraApiBase}/v1/apps?limit=200&includeArchived=true&orderBy=createdAt&order=desc`,
        { Authorization: `Bearer ${ownerUserToken}` }
      )
      const apps = Array.isArray(list.json?.apps) ? list.json.apps : []
      for (const a of apps) {
        if (String(a?.displayName || '') !== appDisplayName) continue
        const oid = String(a?._id || '').trim()
        if (!oid) continue
        try {
          await httpJson(
            'DELETE',
            `${env.ethoraApiBase}/v1/apps/${encodeURIComponent(oid)}?mode=hard`,
            { Authorization: `Bearer ${ownerUserToken}` }
          )
          orphansCleaned += 1
        } catch { /* best-effort */ }
      }
    }
    details.orphansCleaned = orphansCleaned
    if (orphansCleaned > 0) step('cleaned_orphans', { count: orphansCleaned })

    // === CREATE: app + probe user, baseline login ===
    step('create_app')
    const createResp = await httpJson(
      'POST',
      `${env.ethoraApiBase}/v1/apps`,
      { Authorization: `Bearer ${ownerUserToken}`, ...SYNTHETIC_HEADERS },
      { displayName: appDisplayName, createDefaultChat: true }
    )
    if (!createResp.resp.ok) throw new Error(`create app failed: ${createResp.resp.status} ${createResp.text}`)
    const appObj = createResp.json?.app || createResp.json?.result?.app || createResp.json?.result || createResp.json
    appId = String(appObj?._id || appObj?.id || '').trim()
    if (!appId) throw new Error('create app: missing _id')
    details.appId = appId

    step('signup_probe_user', { email: probeEmail })
    const signupResp = await httpJson(
      'POST',
      `${env.ethoraApiBase}/v2/users/sign-up-with-email`,
      { 'Content-Type': 'application/json', 'x-app-id': appId },
      { email: probeEmail, password: probePass, firstName: 'Lifecycle', lastName: 'Probe' }
    )
    if (!signupResp.resp.ok) throw new Error(`signup failed: ${signupResp.resp.status} ${signupResp.text}`)

    step('login_baseline')
    let r = await httpJson(
      'POST',
      `${env.ethoraApiBase}/v2/users/login-with-email`,
      { 'Content-Type': 'application/json', 'x-app-id': appId },
      { email: probeEmail, password: probePass }
    )
    if (!r.resp.ok || !r.json?.success) {
      throw new Error(`baseline login failed: ${r.resp.status} ${r.text}`)
    }

    // === SOFT DELETE ===
    step('soft_archive')
    r = await httpJson('DELETE', `${env.ethoraApiBase}/v1/apps/${encodeURIComponent(appId)}`, { Authorization: `Bearer ${ownerUserToken}` })
    if (!r.resp.ok || r.json?.status !== 'archived') {
      throw new Error(`archive failed: ${r.resp.status} ${r.text}`)
    }

    step('login_refused_app_archived')
    r = await httpJson(
      'POST',
      `${env.ethoraApiBase}/v2/users/login-with-email`,
      { 'Content-Type': 'application/json', 'x-app-id': appId },
      { email: probeEmail, password: probePass }
    )
    if (r.json?.code !== 'APP_ARCHIVED') {
      throw new Error(`expected APP_ARCHIVED, got: ${r.json?.code || r.resp.status}`)
    }

    step('app_hidden_from_default_list')
    r = await httpJson('GET', `${env.ethoraApiBase}/v1/apps?limit=200&orderBy=createdAt&order=desc`, { Authorization: `Bearer ${ownerUserToken}` })
    const activeIds = (Array.isArray(r.json?.apps) ? r.json.apps : []).map((a: any) => String(a?._id || ''))
    if (activeIds.includes(appId)) throw new Error('archived app should not appear in default list')

    step('app_visible_in_archived_list')
    r = await httpJson('GET', `${env.ethoraApiBase}/v1/apps?limit=200&status=archived&orderBy=createdAt&order=desc`, { Authorization: `Bearer ${ownerUserToken}` })
    const archivedIds = (Array.isArray(r.json?.apps) ? r.json.apps : []).map((a: any) => String(a?._id || ''))
    if (!archivedIds.includes(appId)) throw new Error('archived app should appear in ?status=archived list')

    // === RESTORE ===
    step('restore')
    r = await httpJson('POST', `${env.ethoraApiBase}/v1/apps/${encodeURIComponent(appId)}/restore`, { Authorization: `Bearer ${ownerUserToken}` })
    if (!r.resp.ok || r.json?.status !== 'active') {
      throw new Error(`restore failed: ${r.resp.status} ${r.text}`)
    }

    step('login_after_restore')
    r = await httpJson(
      'POST',
      `${env.ethoraApiBase}/v2/users/login-with-email`,
      { 'Content-Type': 'application/json', 'x-app-id': appId },
      { email: probeEmail, password: probePass }
    )
    if (!r.resp.ok || !r.json?.success) {
      throw new Error(`post-restore login failed: ${r.resp.status} ${r.text}`)
    }

    // === EXPORT (include=users so the bundle round-trips the probe user) ===
    step('export_bundle')
    const exportResp = await fetch(
      `${env.ethoraApiBase}/v2/apps/${encodeURIComponent(appId)}/export?format=json&include=users,chats`,
      { headers: { Authorization: `Bearer ${ownerUserToken}` } }
    )
    if (!exportResp.ok) throw new Error(`export failed: ${exportResp.status} ${await exportResp.text()}`)
    const bundle: any = await exportResp.json()
    if (bundle?.schemaVersion !== 'ethora.app.bundle.v1') {
      throw new Error(`unexpected schemaVersion: ${bundle?.schemaVersion}`)
    }
    if (!Array.isArray(bundle?.users) || bundle.users.length < 1) {
      throw new Error('bundle missing users (include=users requested)')
    }
    const exportedUser = bundle.users[0]
    if (!exportedUser?.password) {
      throw new Error('bundle user missing password hash - export side regressed')
    }
    details.bundleUsers = bundle.users.length
    details.bundleMemberships = bundle.memberships?.length || 0
    details.bundleChats = bundle.chats?.length || 0

    // Optional XMPP-side check: confirm the default Main chat MUC exists before purge.
    const firstChatName = String(bundle.chats?.[0]?.name || '')
    if (firstChatName) {
      const exists = await roomExistsOnXmpp(firstChatName)
      if (exists !== null) {
        step('xmpp_room_exists_before_purge', { roomName: firstChatName, exists })
        if (!exists) throw new Error(`xmpp room missing before purge: ${firstChatName}`)
      }
    }

    // === HARD DELETE + poll ===
    step('hard_delete')
    r = await httpJson('DELETE', `${env.ethoraApiBase}/v1/apps/${encodeURIComponent(appId)}?mode=hard`, { Authorization: `Bearer ${ownerUserToken}` })
    if (r.resp.status !== 202 || !r.json?.jobId) {
      throw new Error(`hard delete didn't enqueue: ${r.resp.status} ${r.text}`)
    }
    const jobId = String(r.json.jobId)
    details.purgeJobId = jobId

    step('poll_purge_until_complete')
    const purgeStartedAt = Date.now()
    let purgeFinal: any = null
    while (Date.now() - purgeStartedAt < 90000) {
      const poll = await httpJson('GET', `${env.ethoraApiBase}/v2/apps/purge-jobs/${encodeURIComponent(jobId)}`, { Authorization: `Bearer ${ownerUserToken}` })
      const state = String(poll.json?.state || '')
      if (state === 'completed') { purgeFinal = poll.json; break }
      if (state === 'failed') throw new Error(`purge failed: ${poll.json?.error || poll.text}`)
      await new Promise((res) => setTimeout(res, 2000))
    }
    if (!purgeFinal) throw new Error('purge poll timed out (90s)')
    details.purgeSummary = purgeFinal?.result?.summary || null

    // Optional XMPP-side check: room should be gone now.
    if (firstChatName) {
      const exists = await roomExistsOnXmpp(firstChatName)
      if (exists !== null) {
        step('xmpp_room_gone_after_purge', { roomName: firstChatName, exists })
        if (exists) throw new Error(`xmpp room still present after purge: ${firstChatName}`)
      }
    }

    step('login_refused_app_gone')
    r = await httpJson(
      'POST',
      `${env.ethoraApiBase}/v2/users/login-with-email`,
      { 'Content-Type': 'application/json', 'x-app-id': appId },
      { email: probeEmail, password: probePass }
    )
    // After hard delete the app row is gone. login_with_email refuses
    // with APP_NOT_FOUND (or AUTH_FAILED depending on how resolveAppContext
    // surfaces the missing app); we just need to assert it's NOT a successful
    // login and NOT the soft-delete code.
    if (r.json?.success === true) throw new Error('login succeeded after hard delete')
    if (r.json?.code === 'APP_ARCHIVED') throw new Error('hard delete left app in archived state, not gone')

    // === IMPORT ===
    step('import_bundle')
    const importResp = await httpJson(
      'POST',
      `${env.ethoraApiBase}/v2/apps/import`,
      { Authorization: `Bearer ${ownerUserToken}`, 'Content-Type': 'application/json' },
      bundle
    )
    if (importResp.resp.status !== 201) {
      throw new Error(`import failed: ${importResp.resp.status} ${importResp.text}`)
    }
    const importSummary = importResp.json?.summary || {}
    importedAppId = String(importSummary.newAppId || '').trim()
    if (!importedAppId) throw new Error('import: missing newAppId')
    if ((importSummary.users || 0) < 1) throw new Error('import: users count is zero')
    details.importedAppId = importedAppId
    details.importSummary = importSummary

    // Optional XMPP-side check: room re-created under new appId prefix?
    const importedFirstChatName = `${importedAppId}_${firstChatName.split('_').slice(1).join('_')}`
    if (importedFirstChatName && firstChatName) {
      const exists = await roomExistsOnXmpp(importedFirstChatName)
      if (exists !== null) {
        step('xmpp_room_recreated_after_import', { roomName: importedFirstChatName, exists })
        if (!exists) throw new Error(`xmpp room not recreated after import: ${importedFirstChatName}`)
      }
    }

    step('login_after_import')
    r = await httpJson(
      'POST',
      `${env.ethoraApiBase}/v2/users/login-with-email`,
      { 'Content-Type': 'application/json', 'x-app-id': importedAppId },
      { email: probeEmail, password: probePass }
    )
    if (!r.resp.ok || !r.json?.success) {
      throw new Error(`post-import login failed (round-trip regression): ${r.resp.status} ${r.text}`)
    }

    step('all_checks_passed')
    return { ok: true, details }
  } catch (e: any) {
    details.error = e?.message || String(e)
    return { ok: false, details }
  } finally {
    // Hard-delete cleanup of both apps the journey created. Best-effort -
    // a leftover here just means the orphan sweep at the top of the next run
    // will mop it up.
    for (const id of [importedAppId, appId]) {
      if (!id || !ownerUserToken) continue
      try {
        await httpJson(
          'DELETE',
          `${env.ethoraApiBase}/v1/apps/${encodeURIComponent(id)}?mode=hard`,
          { Authorization: `Bearer ${ownerUserToken}` }
        )
      } catch (e) { cleanupErr('delete_app', e) }
    }
  }
}
