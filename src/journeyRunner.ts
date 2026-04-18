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

// Stable header so a server admin can also distinguish these calls in logs/proxy rules.
const SYNTHETIC_HEADERS: Record<string, string> = { 'x-ethora-synthetic': '1' }

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

type JourneyMode = 'basic' | 'advanced' | 'b2b'

type JourneyOptions = {
  mode?: string
  // Optional operator room to stream journey progress into (room name or full room JID).
  // This does NOT replace the journey's own test rooms; it is only an observer stream.
  observerRoom?: string
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

type B2BEnv = {
  appId: string
  appSecret: string
}

function getB2BEnvFromProcess(): B2BEnv {
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
  if (value.includes('b2b') || value.includes('server')) return 'b2b'
  if (value.includes('advanced') || value.includes('comprehensive')) return 'advanced'
  return 'basic'
}

function randSuffix() {
  return crypto.randomUUID().slice(0, 8)
}

async function httpJson(method: string, url: string, headers: Record<string, string>, body?: any) {
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

function createServerToken(appId: string, appSecret: string, tenantId?: string) {
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

type SyntheticAppRef = {
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
async function prepareSyntheticAppV1(
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
async function prepareSyntheticAppV2(
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

async function pollUserBatchJob(apiBase: string, appId: string, authToken: string, jobId: string, timeoutMs = 120000) {
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

export async function runJourney(env: JourneyEnv, opts?: JourneyOptions): Promise<JourneyResult> {
  const mode = resolveMode(env, opts)
  if (mode === 'b2b') return await runJourneyB2B(env)
  if (mode === 'advanced') return await runJourneyAdvanced(env, opts)

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

    step('prepare_synthetic_app', { displayName: appDisplayName })
    syntheticApp = await prepareSyntheticAppV1(env.ethoraApiBase, ownerUserToken, appDisplayName)
    details.appId = syntheticApp.appId
    details.orphansCleaned = syntheticApp.orphansCleaned
    if (syntheticApp.orphansCleaned > 0) {
      step('cleaned_orphans', { count: syntheticApp.orphansCleaned })
    }
    step('create_app', { appId: syntheticApp.appId })

    const newAppToken = syntheticApp.appToken

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

async function runJourneyB2B(env: JourneyEnv): Promise<JourneyResult> {
  // Per-run uniqueness happens at user/chat level (UUIDs include the suffix).
  // The synthetic child app is reused across runs (Option A+C).
  const suffix = randSuffix()
  const appDisplayName = SYNTHETIC_APP_DISPLAY_NAME_B2B
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

async function joinRoomByWs(
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


