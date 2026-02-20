// Ethora.com platform, copyright: Dappros Ltd (c) 2026, all rights reserved
import crypto from 'node:crypto'
import { client as xmppClient, xml } from '@xmpp/client'

export type JourneyEnv = {
  ethoraApiBase: string
  baseDomainName: string
  adminEmail: string
  adminPassword: string
  appNamePrefix: string
  usersCount: number
}

type JourneyMode = 'basic' | 'advanced'

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

function resolveMode(env: JourneyEnv, opts?: JourneyOptions): JourneyMode {
  const candidates = [opts?.mode, process.env.ETHORA_JOURNEY_MODE]
    .filter(Boolean)
    .map((s) => String(s).toLowerCase())
  const value = candidates.find(Boolean) || 'basic'
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

export async function runJourney(env: JourneyEnv, opts?: JourneyOptions): Promise<JourneyResult> {
  const mode = resolveMode(env, opts)
  if (mode === 'advanced') return await runJourneyAdvanced(env, opts)

  const suffix = randSuffix()
  const appDisplayName = `${env.appNamePrefix}-${suffix}`

  const details: Record<string, any> = {
    suffix,
    appDisplayName,
    mode: 'basic',
    steps: [],
  }

  let ownerUserToken: string | null = null
  let newAppId: string | null = null
  let newAppToken: string | null = null
  const createdUserIds: string[] = []
  const createdUserXmpp: string[] = []
  let chatName: string | null = null
  let chatOwnerToken: string | null = null
  let chatOwnerXmpp: string | null = null
  let chatOwnerXmppPassword: string | null = null

  const step = (name: string, extra?: any) => details.steps.push({ name, ...extra, ts: new Date().toISOString() })

  try {
    // 0) Get base app config -> appToken
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

    // 0.1) Login admin user (app auth)
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

    // 1) Create app (user auth)
    step('create_app')
    const createAppResp = await httpJson(
      'POST',
      `${env.ethoraApiBase}/v1/apps`,
      { Authorization: `Bearer ${ownerUserToken}` },
      { displayName: appDisplayName }
    )
    if (!createAppResp.resp.ok) throw new Error(`create app failed: ${createAppResp.resp.status} ${createAppResp.text}`)

    const appObj = createAppResp.json?.app
    newAppId = appObj?._id || appObj?.id
    newAppToken = appObj?.appToken
    if (!newAppId) throw new Error('create app: missing app._id')
    if (!newAppToken) throw new Error('create app: missing app.appToken')

    // 2) Create end users via v2 signup (app auth), then login via v2 to get user JWTs
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
      const loginResp = await httpJson(
        'POST',
        `${env.ethoraApiBase}/v2/users/login-with-email`,
        { Authorization: String(newAppToken) },
        { email, password }
      )
      if (!loginResp.resp.ok) throw new Error(`login v2 failed: ${loginResp.resp.status} ${loginResp.text}`)
      const user = loginResp.json?.user
      const token = loginResp.json?.token
      if (!user?._id) throw new Error('login v2: missing user._id')
      if (!token) throw new Error('login v2: missing token')
      createdUserIds.push(String(user._id))
      if (user?.xmppUsername) createdUserXmpp.push(String(user.xmppUsername))
      if (i === 0) {
        chatOwnerToken = String(token)
        chatOwnerXmpp = String(user?.xmppUsername || '')
        chatOwnerXmppPassword = String(user?.xmppPassword || '')
      }
    }
    if (!chatOwnerToken) throw new Error('login v2: missing token for first user')

    // 3) Create chat (user auth, within new app)
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

    // 4) Add second user to chat (if present)
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
    // Cleanup (best-effort)
    if (chatName && chatOwnerToken) {
      try {
        step('cleanup_delete_chat')
        await httpJson(
          'DELETE',
          `${env.ethoraApiBase}/v1/chats`,
          { Authorization: `Bearer ${chatOwnerToken}`, 'Content-Type': 'application/json' },
          { name: chatName }
        )
      } catch {}
    }

    if (newAppId && ownerUserToken && createdUserIds.length) {
      try {
        step('cleanup_delete_users')
        await httpJson(
          'POST',
          `${env.ethoraApiBase}/v1/users/delete-many-with-app-id/${encodeURIComponent(String(newAppId))}`,
          { Authorization: `Bearer ${ownerUserToken}` },
          { usersIdList: createdUserIds }
        )
      } catch {}
    }

    if (newAppId && ownerUserToken) {
      try {
        step('cleanup_delete_app')
        await httpJson('DELETE', `${env.ethoraApiBase}/v1/apps/${encodeURIComponent(String(newAppId))}`, { Authorization: `Bearer ${ownerUserToken}` })
      } catch {}
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
  const appDisplayName = `${env.appNamePrefix}-${suffix}`
  const details: Record<string, any> = {
    suffix,
    appDisplayName,
    mode: 'advanced',
    steps: [],
  }

  const step = (name: string, extra?: any) => details.steps.push({ name, ...extra, ts: new Date().toISOString() })

  let ownerUserToken: string | null = null
  let newAppId: string | null = null
  let newAppToken: string | null = null

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

    step('create_app')
    const createAppResp = await httpJson(
      'POST',
      `${env.ethoraApiBase}/v1/apps`,
      { Authorization: `Bearer ${ownerUserToken}` },
      { displayName: appDisplayName }
    )
    if (!createAppResp.resp.ok) throw new Error(`create app failed: ${createAppResp.resp.status} ${createAppResp.text}`)

    const appObj = createAppResp.json?.app
    newAppId = appObj?._id || appObj?.id
    newAppToken = appObj?.appToken
    if (!newAppId) throw new Error('create app: missing app._id')
    if (!newAppToken) throw new Error('create app: missing app.appToken')
    notify(`create_app ok appId=${newAppId}`)

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
        await httpJson('DELETE', `${env.ethoraApiBase}/v1/chats`, { Authorization: `Bearer ${users[0].token}`, 'Content-Type': 'application/json' }, { name: testChatName })
      } catch {}
    }
    if (validationChatName && users[0]?.token) {
      try {
        step('cleanup_delete_validation_chat')
        await httpJson('DELETE', `${env.ethoraApiBase}/v1/chats`, { Authorization: `Bearer ${users[0].token}`, 'Content-Type': 'application/json' }, { name: validationChatName })
      } catch {}
    }
    if (newAppId && ownerUserToken && users.length) {
      try {
        step('cleanup_delete_users')
        await httpJson(
          'POST',
          `${env.ethoraApiBase}/v1/users/delete-many-with-app-id/${encodeURIComponent(String(newAppId))}`,
          { Authorization: `Bearer ${ownerUserToken}` },
          { usersIdList: users.map((u) => u.id) }
        )
      } catch {}
    }
    if (newAppId && ownerUserToken) {
      try {
        step('cleanup_delete_app')
        await httpJson('DELETE', `${env.ethoraApiBase}/v1/apps/${encodeURIComponent(String(newAppId))}`, { Authorization: `Bearer ${ownerUserToken}` })
      } catch {}
    }
  }
}


