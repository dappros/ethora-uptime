// Ethora.com platform, copyright: Dappros Ltd (c) 2026, all rights reserved
import { WebSocket } from 'ws'
import type { CheckConfig } from './config.js'
import { getJourneyEnvFromProcess, runJourney } from './journeyRunner.js'
import crypto from 'node:crypto'
import { client as xmppClient, xml } from '@xmpp/client'
import http from 'node:http'
import https from 'node:https'

export type CheckRunResult = {
  ok: boolean
  statusCode?: number
  durationMs: number
  errorText?: string
  details?: Record<string, any>
}

function nowMs() {
  return Date.now()
}

export async function runCheck(check: CheckConfig): Promise<CheckRunResult> {
  return await runCheckWithOpts(check)
}

export type RunCheckOpts = {
  // Optional operator observer room for journey checks (room name or room JID).
  journeyObserverRoom?: string
}

export async function runCheckWithOpts(check: CheckConfig, opts: RunCheckOpts = {}): Promise<CheckRunResult> {
  if (check.type === 'http') {
    return await runHttpCheck(check)
  }
  if (check.type === 'wss') {
    return await runWssCheck(check)
  }
  if (check.type === 'journey') {
    return await runJourneyCheck(check, opts)
  }
  if (check.type === 'push_validate') {
    return await runPushValidateCheck(check)
  }
  if (check.type === 'xmpp_muc_echo') {
    return await runXmppMucEchoCheck(check)
  }
  return { ok: false, durationMs: 0, errorText: `Unknown check type: ${(check as any).type}` }
}

function mustEnv(name: string) {
  const v = process.env[name]
  const s = typeof v === 'string' ? v.trim() : ''
  if (!s) throw new Error(`Missing env: ${name}`)
  return s
}

async function httpJson(method: 'GET' | 'POST', url: string, headers: Record<string, string>, body?: any, timeoutMs = 10000) {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resp = await fetch(url, {
      method,
      headers: { ...(headers || {}), ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
      body: method === 'POST' ? JSON.stringify(body || {}) : undefined,
      signal: controller.signal,
    })
    const text = await resp.text()
    let json: any = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    return { resp, text, json }
  } finally {
    clearTimeout(t)
  }
}

async function runPushValidateCheck(_check: CheckConfig): Promise<CheckRunResult> {
  const start = nowMs()
  try {
    const apiBase = mustEnv('ETHORA_API_BASE').replace(/\/$/, '')
    const baseDomainName = mustEnv('ETHORA_BASE_DOMAIN_NAME')
    const adminEmail = mustEnv('ETHORA_ADMIN_EMAIL')
    const adminPassword = mustEnv('ETHORA_ADMIN_PASSWORD')

    // 1) get-config (for base app token + app id)
    const cfg = await httpJson(
      'GET',
      `${apiBase}/v1/apps/get-config?domainName=${encodeURIComponent(baseDomainName)}`,
      {},
      undefined,
      10000
    )
    if (!cfg.resp.ok) {
      return { ok: false, statusCode: cfg.resp.status, durationMs: nowMs() - start, errorText: `get-config failed: ${cfg.resp.status}` }
    }
    const baseAppObj = cfg.json?.app || cfg.json?.result?.app || cfg.json?.result || cfg.json
    const appId = String(baseAppObj?._id || baseAppObj?.id || '').trim()
    const appToken =
      cfg.json?.appToken ||
      cfg.json?.app?.appToken ||
      cfg.json?.result?.appToken ||
      cfg.json?.result?.app?.appToken
    if (!appId || !appToken) {
      return { ok: false, durationMs: nowMs() - start, errorText: 'get-config missing appId/appToken' }
    }

    // 2) login as admin to get a user bearer token
    const login = await httpJson(
      'POST',
      `${apiBase}/v1/users/login-with-email`,
      { Authorization: String(appToken) },
      { email: adminEmail, password: adminPassword },
      15000
    )
    if (!login.resp.ok) {
      return { ok: false, statusCode: login.resp.status, durationMs: nowMs() - start, errorText: `login failed: ${login.resp.status}` }
    }
    const userToken = String(login.json?.token || '').trim()
    if (!userToken) {
      return { ok: false, durationMs: nowMs() - start, errorText: 'login missing token' }
    }

    // 3) validate push (dry-run)
    const val = await httpJson(
      'POST',
      `${apiBase}/v1/push/validate/${encodeURIComponent(appId)}`,
      { Authorization: `Bearer ${userToken}` },
      {},
      30000
    )
    const ok = Boolean(val.resp.ok && (val.json?.ok === true || val.json?.pong === true || val.json?.success === true || val.json?.dryRun === true))
    return {
      ok,
      statusCode: val.resp.status,
      durationMs: nowMs() - start,
      errorText: ok ? undefined : (val.json?.error || `push validate failed: ${val.resp.status}`),
      details: { response: val.json ?? val.text ?? null },
    }
  } catch (e: any) {
    if (String(e?.message || '').startsWith('Missing env:')) {
      return { ok: false, durationMs: nowMs() - start, errorText: `skipped: ${e.message}` }
    }
    return { ok: false, durationMs: nowMs() - start, errorText: e?.message || String(e) }
  }
}

async function runHttpCheck(check: CheckConfig): Promise<CheckRunResult> {
  if (!check.url) {
    return { ok: false, durationMs: 0, errorText: 'missing url for http check' }
  }
  const start = nowMs()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), check.timeoutMs)

  try {
    const resp = await fetch(check.url, {
      method: check.method || 'GET',
      headers: check.headers,
      body: check.body,
      signal: controller.signal,
    })
    const durationMs = nowMs() - start
    const statusCode = resp.status

    let ok = resp.ok
    const details: Record<string, any> = {}

    const expect = check.expect || []
    const jsonRules = expect.filter((r) => r.type === 'json')
    let parsedJson: any = undefined
    let jsonParsedOk = false
    if (jsonRules.length) {
      const text = await resp.clone().text()
      try {
        parsedJson = JSON.parse(text)
        jsonParsedOk = true
      } catch {
        jsonParsedOk = false
        parsedJson = undefined
      }
    }

    for (const rule of expect) {
      if (rule.type === 'status_code') {
        ok = ok && rule.expected.includes(statusCode)
        details.statusExpected = rule.expected
      } else if (rule.type === 'json') {
        if (!jsonParsedOk) {
          // Only fail the check if the rule is asserting something.
          // If it's a capture-only rule (captureAs) we don't fail.
          if (rule.exists || rule.equals !== undefined) ok = false
          details.jsonParse = 'failed'
          continue
        }
        const value = getJsonPath(parsedJson, rule.path)
        if (rule.exists) ok = ok && value !== undefined && value !== null
        if (rule.equals !== undefined) ok = ok && String(value) === rule.equals
        if (rule.captureAs && typeof rule.captureAs === 'string') {
          details.captures = details.captures || {}
          details.captures[rule.captureAs] = value ?? null
        }
      }
    }

    return { ok, statusCode, durationMs, details }
  } catch (e: any) {
    const durationMs = nowMs() - start
    return { ok: false, durationMs, errorText: e?.name === 'AbortError' ? 'timeout' : (e?.message || String(e)) }
  } finally {
    clearTimeout(timeout)
  }
}

async function runWssCheck(check: CheckConfig): Promise<CheckRunResult> {
  if (!check.url) {
    return { ok: false, durationMs: 0, errorText: 'missing url for wss check' }
  }
  const url = check.url
  const start = nowMs()
  const timeoutMs = check.timeoutMs

  return await new Promise<CheckRunResult>((resolve) => {
    let settled = false
    const finish = (res: CheckRunResult) => {
      if (settled) return
      settled = true
      resolve(res)
    }

    const timer = setTimeout(() => {
      try {
        ws.close()
      } catch {}
      finish({ ok: false, durationMs: nowMs() - start, errorText: 'timeout' })
    }, timeoutMs)

    const ws = new WebSocket(url, {
      headers: check.headers,
    })

    ws.on('open', () => {
      clearTimeout(timer)
      try {
        ws.close()
      } catch {}
      finish({ ok: true, durationMs: nowMs() - start })
    })

    ws.on('error', (err: any) => {
      clearTimeout(timer)
      finish({ ok: false, durationMs: nowMs() - start, errorText: err?.message || String(err) })
    })
  })
}

async function runJourneyCheck(check: CheckConfig, opts: RunCheckOpts): Promise<CheckRunResult> {
  const start = nowMs()
  // Allow per-check timeout (best-effort)
  const timeoutMs = Math.max(1000, Number(check.timeoutMs || 60000))
  try {
    const res = await Promise.race([
      runJourney(getJourneyEnvFromProcess(), { mode: check.id, observerRoom: opts?.journeyObserverRoom }),
      new Promise<{ ok: boolean; details: any }>((_resolve, reject) =>
        setTimeout(() => reject(new Error('timeout')), timeoutMs)
      ),
    ])
    return { ok: Boolean(res.ok), durationMs: nowMs() - start, details: res.details }
  } catch (e: any) {
    // If journey isn't configured, treat it as "skipped" (WARN), not a hard FAIL.
    if (String(e?.message || '').startsWith('Missing env:')) {
      return { ok: false, durationMs: nowMs() - start, errorText: `skipped: ${e.message}` }
    }
    return { ok: false, durationMs: nowMs() - start, errorText: e?.message || String(e) }
  }
}

async function getBaseAppId(timeoutMs: number): Promise<string> {
  const apiBase = envStr('ETHORA_API_BASE', '').replace(/\/$/, '')
  const baseDomainName = envStr('ETHORA_BASE_DOMAIN_NAME', '')
  if (!apiBase || !baseDomainName) return ''

  const cfg = await httpJson(
    'GET',
    `${apiBase}/v1/apps/get-config?domainName=${encodeURIComponent(baseDomainName)}`,
    {},
    undefined,
    timeoutMs
  )
  if (!cfg.resp.ok) return ''

  const baseAppObj = cfg.json?.app || cfg.json?.result?.app || cfg.json?.result || cfg.json
  return String(baseAppObj?._id || baseAppObj?.id || '').trim()
}

function envStr(name: string, def = ''): string {
  const v = process.env[name]
  if (typeof v !== 'string') return def
  const s = v.trim()
  return s ? s : def
}

function basicAuthHeader(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')
}

async function ejabberdPostJson(apiUrl: string, httpHost: string, admin: string, adminPassword: string, path: string, body: any, timeoutMs: number) {
  // NOTE:
  // Node's built-in fetch (undici) forbids setting the 'Host' header (it gets silently ignored),
  // but ejabberd routes mod_http_api by the HTTP Host header. So we must use node:http(s) here.
  return await new Promise<{ ok: boolean; status: number; data: any }>((resolve) => {
    const url = new URL(`${apiUrl}${path}`)
    const isHttps = url.protocol === 'https:'
    const lib = isHttps ? https : http

    const payload = JSON.stringify(body || {})

    const req = lib.request(
      {
        method: 'POST',
        hostname: url.hostname,
        port: url.port ? Number(url.port) : (isHttps ? 443 : 80),
        path: url.pathname + (url.search || ''),
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          // Force ejabberd vhost routing when calling via Docker DNS (xmpp:5280).
          ...(httpHost ? { Host: httpHost } : {}),
          Authorization: basicAuthHeader(admin, adminPassword),
        },
        timeout: timeoutMs,
      },
      (resp) => {
        let raw = ''
        resp.on('data', (chunk) => {
          raw += String(chunk || '')
        })
        resp.on('end', () => {
          let parsed: any = undefined
          try {
            parsed = raw ? JSON.parse(raw) : undefined
          } catch {
            parsed = raw
          }
          resolve({ ok: Boolean(resp.statusCode && resp.statusCode >= 200 && resp.statusCode < 300), status: resp.statusCode || 0, data: parsed })
        })
      }
    )

    req.on('timeout', () => {
      try { req.destroy(new Error('timeout')) } catch {}
    })
    req.on('error', (e: any) => {
      resolve({ ok: false, status: 0, data: e?.message || String(e) })
    })

    req.write(payload)
    req.end()
  })
}

function derivePassword(seed: string, tag: string): string {
  // Deterministic, so operators don't have to store extra secrets in uptime.env.
  return crypto.createHash('sha256').update(`${seed}:${tag}`).digest('hex').slice(0, 20)
}

async function ensureXmppUser(apiUrl: string, xmppHost: string, admin: string, adminPassword: string, user: string, password: string, timeoutMs: number) {
  // Try to register. If the account already exists, set/overwrite its password.
  const reg = await ejabberdPostJson(apiUrl, xmppHost, admin, adminPassword, '/register', { host: xmppHost, user, password }, timeoutMs)
  if (reg.ok) return { ok: true, via: 'register' as const }

  const regText = typeof reg.data === 'string' ? reg.data : JSON.stringify(reg.data || {})
  const looksLikeAlreadyExists =
    reg.status === 409 ||
    regText.toLowerCase().includes('conflict') ||
    regText.toLowerCase().includes('already') ||
    regText.toLowerCase().includes('exists')

  if (!looksLikeAlreadyExists) {
    throw new Error(`XMPP_REGISTER_FAILED(${user}): status=${reg.status} data=${regText}`)
  }

  const ch = await ejabberdPostJson(apiUrl, xmppHost, admin, adminPassword, '/change_password', { host: xmppHost, user, newpass: password }, timeoutMs)
  if (!ch.ok) {
    const chText = typeof ch.data === 'string' ? ch.data : JSON.stringify(ch.data || {})
    throw new Error(`XMPP_CHANGE_PASSWORD_FAILED(${user}): status=${ch.status} data=${chText}`)
  }
  return { ok: true, via: 'change_password' as const }
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
    let lastPresenceError: string | undefined

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
        // If ejabberd rejects the join, it may send a presence error with a `from` that is not the room JID.
        // Surface it immediately so operators see the real reason (AccessRules/mod_ethora/muc policy), not a timeout.
        if (stanza.attrs?.type === 'error') {
          lastPresenceError = stanza.toString()
          cleanup().then(() => reject(new Error(`XMPP_JOIN_ERROR(${stage}):${lastPresenceError}`)))
          return
        }
        if ((stanza.attrs?.from || '').split('/')[0] !== roomJid) return
        cleanup().then(() => resolve(xmpp))
      }

      xmpp.on('stanza', stanzaHandler)
      timeoutId = setTimeout(() => {
        cleanup().then(async () => {
          try { await xmpp.stop() } catch {}
          reject(new Error(lastPresenceError ? `XMPP_JOIN_ROOM_TIMEOUT(${stage}):${lastPresenceError}` : `XMPP_JOIN_ROOM_TIMEOUT(${stage})`))
        })
      }, timeoutMs)

      const presence = xml('presence', { to: `${roomJid}/${myNick}` }, xml('x', 'http://jabber.org/protocol/muc'))
      xmpp.send(presence)
    })

    xmpp.start().catch(reject)
  })
}

async function runXmppMucEchoCheck(check: CheckConfig): Promise<CheckRunResult> {
  const start = nowMs()
  const timeoutMs = Math.max(4000, Number(check.timeoutMs || 15000))

  // Prefer Docker-internal DNS (uptime joins the same network as ejabberd).
  // Operators can override via env if uptime is deployed differently.
  const apiUrl = envStr('ETHORA_XMPP_API_URL', 'http://xmpp:5280/api')
  const serviceUrl = envStr('ETHORA_XMPP_SERVICE', 'ws://xmpp:5280/ws')
  const xmppHost = envStr('ETHORA_XMPP_HOST', 'localhost')
  const mucService = envStr('ETHORA_XMPP_MUC_SERVICE', `conference.${xmppHost}`)
  // Ejabberd HTTP API basic auth typically expects a full JID (e.g. admin@localhost), not just localpart.
  const adminDefault = `admin@${xmppHost}`
  const admin = envStr('ETHORA_XMPP_ADMIN', adminDefault)
  const adminPassword = envStr('ETHORA_XMPP_ADMIN_PASSWORD', '')

  if (!adminPassword) {
    return { ok: false, durationMs: nowMs() - start, errorText: 'skipped: Missing env: ETHORA_XMPP_ADMIN_PASSWORD' }
  }

  const baseAppId = await getBaseAppId(Math.min(10000, timeoutMs))
  const legacyUser1 = 'uptime_health_u1'
  const legacyUser2 = 'uptime_health_u2'
  const legacyRoom = 'uptime_health_room'
  const appScopedUser1 = baseAppId ? `${baseAppId}_000000000000000000000001` : legacyUser1
  const appScopedUser2 = baseAppId ? `${baseAppId}_000000000000000000000002` : legacyUser2
  const appScopedRoom = baseAppId ? `${baseAppId}_00000000000000000000000a` : legacyRoom

  const explicitUser1 = envStr('ETHORA_XMPP_HEALTH_USER1', '')
  const explicitUser2 = envStr('ETHORA_XMPP_HEALTH_USER2', '')
  const explicitRoom = envStr('ETHORA_XMPP_HEALTH_ROOM', '')
  const hasExplicitHealthOverrides = Boolean(explicitUser1 || explicitUser2 || explicitRoom)

  const primaryUser1 = explicitUser1 || appScopedUser1
  const primaryUser2 = explicitUser2 || appScopedUser2
  const primaryRoom = explicitRoom || appScopedRoom
  const pass1 = envStr('ETHORA_XMPP_HEALTH_PASS1', derivePassword(adminPassword, 'u1'))
  const pass2 = envStr('ETHORA_XMPP_HEALTH_PASS2', derivePassword(adminPassword, 'u2'))
  const candidates = [
    { strategy: baseAppId ? 'app_scoped' : 'legacy', user1: primaryUser1, user2: primaryUser2, roomName: primaryRoom },
  ]
  if (!hasExplicitHealthOverrides && baseAppId) {
    candidates.push({ strategy: 'legacy_fallback', user1: legacyUser1, user2: legacyUser2, roomName: legacyRoom })
  }

  const details: Record<string, any> = {
    baseAppId,
    serviceUrl,
    apiUrl,
    attempts: [],
  }

  let lastError = ''
  for (const candidate of candidates) {
    const roomJid = `${candidate.roomName}@${mucService}`
    const marker = `uptime:${Date.now()}:${crypto.randomBytes(6).toString('hex')}`
    const attempt: Record<string, any> = {
      strategy: candidate.strategy,
      roomJid,
      user1: candidate.user1,
      user2: candidate.user2,
    }
    details.attempts.push(attempt)
    details.roomJid = roomJid
    details.user1 = candidate.user1
    details.user2 = candidate.user2
    details.strategy = candidate.strategy

    let adminXmpp: any = undefined
    let xmpp1: any = undefined
    let xmpp2: any = undefined
    let messageHandler: any = undefined

    try {
      const userOpTimeout = Math.min(6000, timeoutMs)
      attempt.user1Ensure = await ensureXmppUser(apiUrl, xmppHost, admin, adminPassword, candidate.user1, pass1, userOpTimeout)
      attempt.user2Ensure = await ensureXmppUser(apiUrl, xmppHost, admin, adminPassword, candidate.user2, pass2, userOpTimeout)

      await ejabberdPostJson(apiUrl, xmppHost, admin, adminPassword, '/destroy_room', { name: candidate.roomName, service: mucService }, Math.min(8000, timeoutMs))

      const adminLocal = String(admin || adminDefault).split('@')[0] || 'admin'
      const adminJoinTimeout = Math.min(10000, timeoutMs)
      adminXmpp = await joinRoomByWs(serviceUrl, xmppHost, adminLocal, adminPassword, roomJid, adminJoinTimeout, 'admin_join_create_room')
      attempt.roomCreate = { ok: true, via: 'xmpp_join_as_admin', adminLocal }

      const joinTimeout = Math.min(10000, timeoutMs)
      xmpp2 = await joinRoomByWs(serviceUrl, xmppHost, candidate.user2, pass2, roomJid, joinTimeout, 'user2_join')

      let received = false
      const receivedPromise = new Promise<void>((resolve, reject) => {
        messageHandler = (stanza: any) => {
          try {
            if (!stanza?.is?.('message')) return
            if (stanza.attrs?.type !== 'groupchat') return
            if ((stanza.attrs?.from || '').split('/')[0] !== roomJid) return
            const body = stanza.getChildText?.('body') || ''
            if (body === marker) {
              received = true
              resolve()
            }
          } catch (e) {
            reject(e)
          }
        }
        xmpp2.on('stanza', messageHandler)
      })

      xmpp1 = await joinRoomByWs(serviceUrl, xmppHost, candidate.user1, pass1, roomJid, joinTimeout, 'user1_join')
      const msg = xml('message', { to: roomJid, type: 'groupchat', id: `uptime-${Date.now()}` }, xml('body', {}, marker))
      xmpp1.send(msg)

      await Promise.race([
        receivedPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('XMPP_ECHO_TIMEOUT')), Math.min(7000, timeoutMs))),
      ])

      details.received = received
      attempt.received = received
      return { ok: true, durationMs: nowMs() - start, details }
    } catch (e: any) {
      lastError = e?.message || String(e)
      attempt.error = lastError
      details.received = false
      if (!(candidate.strategy === 'app_scoped' && lastError.includes('XMPP_REGISTER_FAILED') && !hasExplicitHealthOverrides)) {
        details.error = lastError
        return { ok: false, durationMs: nowMs() - start, errorText: details.error, details }
      }
    } finally {
      try { if (xmpp2 && messageHandler) xmpp2.off('stanza', messageHandler) } catch {}
      try { if (adminXmpp) await adminXmpp.stop() } catch {}
      try { if (xmpp1) await xmpp1.stop() } catch {}
      try { if (xmpp2) await xmpp2.stop() } catch {}
    }
  }

  details.error = lastError || 'XMPP_ECHO_FAILED'
  return { ok: false, durationMs: nowMs() - start, errorText: details.error, details }
}

function getJsonPath(obj: any, path: string): any {
  // Simple dot path, e.g. "info.title"
  const parts = path.split('.').filter(Boolean)
  let cur = obj
  for (const p of parts) {
    if (cur == null) return undefined
    cur = cur[p]
  }
  return cur
}


