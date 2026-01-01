// Ethora.com platform, copyright: Dappros Ltd (c) 2026, all rights reserved
import crypto from 'node:crypto'

export type JourneyEnv = {
  ethoraApiBase: string
  baseDomainName: string
  adminEmail: string
  adminPassword: string
  appNamePrefix: string
  usersCount: number
}

export type JourneyResult = {
  ok: boolean
  details: Record<string, any>
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

export async function runJourney(env: JourneyEnv): Promise<JourneyResult> {
  const suffix = randSuffix()
  const appDisplayName = `${env.appNamePrefix}-${suffix}`

  const details: Record<string, any> = {
    suffix,
    appDisplayName,
    steps: [],
  }

  let ownerUserToken: string | null = null
  let newAppId: string | null = null
  let newAppToken: string | null = null
  const createdUserIds: string[] = []
  const createdUserXmpp: string[] = []
  let chatName: string | null = null
  let chatOwnerToken: string | null = null

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
    const baseAppToken = cfgResp.json?.appToken || cfgResp.json?.app?.appToken
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

    // 2) Create end users via v2 signup (app auth) to get a user JWT for this new app
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
      const user = signupResp.json?.user
      const token = signupResp.json?.token
      if (!user?._id) throw new Error('signup v2: missing user._id')
      createdUserIds.push(String(user._id))
      if (user?.xmppUsername) createdUserXmpp.push(String(user.xmppUsername))
      if (i === 0 && token) chatOwnerToken = String(token)
    }
    if (!chatOwnerToken) throw new Error('signup v2: missing token for first user')

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
        await httpJson('DELETE', `${env.ethoraApiBase}/v1/chats`, { Authorization: `Bearer ${chatOwnerToken}`, 'Content-Type': 'application/json' }, { name: chatName })
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


