// Ethora.com platform, copyright: Dappros Ltd (c) 2026, all rights reserved
//
// XMPP load scenarios.
//
// These drive the SAME WebSocket transport (ws://…/ws) that real Ethora
// clients use — not the classic TCP 5222 c2s path a tool like Tsung would hit —
// so the numbers reflect the production chat path. Two profiles:
//
//   xmpp-messages  Persistent connections, sustained MUC message throughput.
//                  Each worker holds one WS connection joined to a shared room
//                  and, per iteration, sends a groupchat message and waits for
//                  the server to broadcast it back (round-trip). Measures
//                  "X messages/min in a room" + broadcast latency.
//
//   xmpp-connect   Connection storm. Each iteration does a full
//                  connect → auth → join MUC → send → disconnect. Measures how
//                  many fresh sessions the server can stand up per second.
//
// Both reuse the journey's @xmpp/client WS helper (joinRoomByWs) and its Node
// WebSocket polyfill (loaded as a side-effect of importing journeyRunner).

import { xml } from '@xmpp/client'
import {
   getJourneyEnvFromProcess,
   prepareSyntheticAppV1,
   joinRoomByWs,
   httpJson,
   type JourneyEnv,
} from '../journeyRunner.js'
import { runLoad, type LoadRunResult, type LoadProgressSnapshot } from '../loadRunner.js'

export interface XmppOptions {
   parallelism: number
   durationSeconds: number
   rampUpSeconds?: number
   sleepBetweenIterationsMs?: number
   reportEverySeconds?: number
   label?: string
   onProgress?: (snapshot: LoadProgressSnapshot) => void
   suffix?: string
}

interface XmppPoolUser {
   xmppUsername: string
   xmppPassword: string
}

interface XmppContext {
   ownerToken: string
   appId: string
   roomJid: string
   pool: XmppPoolUser[]
   serviceUrl: string
   host: string
}

const JOIN_TIMEOUT_MS = 15000
const ECHO_TIMEOUT_MS = 15000

function xmppEnv() {
   const serviceUrl = String(process.env.ETHORA_XMPP_SERVICE || '').trim()
   const host = String(process.env.ETHORA_XMPP_HOST || '').trim()
   const mucService = String(process.env.ETHORA_XMPP_MUC_SERVICE || '').trim() || `conference.${host}`
   if (!serviceUrl) throw new Error('Missing env: ETHORA_XMPP_SERVICE')
   if (!host) throw new Error('Missing env: ETHORA_XMPP_HOST')
   return { serviceUrl, host, mucService }
}

// Provision: app → pool of users → one public room they are all members of.
async function setupXmpp(env: JourneyEnv, suffix: string, poolSize: number): Promise<XmppContext> {
   const { serviceUrl, host, mucService } = xmppEnv()

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

   const app = await prepareSyntheticAppV1(env.ethoraApiBase, ownerToken, `__uptime__load_xmpp_${suffix}`)

   // Create a pool of users; capture their xmpp creds + a user token to create the room.
   const pool: XmppPoolUser[] = []
   let creatorToken = ''
   for (let i = 0; i < poolSize; i++) {
      const email = `xmppload-${suffix}-u${i}@example.com`
      const password = `Pass-${suffix}-${i}-Abc123`
      const signup = await httpJson(
         'POST',
         `${env.ethoraApiBase}/v2/users/sign-up-with-email`,
         { Authorization: String(app.appToken) },
         { email, firstName: 'Xmpp', lastName: `User${i}`, password, cfToken: '', utm: '' },
      )
      if (!signup.resp.ok) throw new Error(`signup u${i} failed: ${signup.resp.status} ${signup.text}`)
      const userLogin = await httpJson(
         'POST',
         `${env.ethoraApiBase}/v2/users/login-with-email`,
         { Authorization: String(app.appToken) },
         { email, password },
      )
      if (!userLogin.resp.ok) throw new Error(`login u${i} failed: ${userLogin.resp.status} ${userLogin.text}`)
      const u = userLogin.json?.user
      const t = String(userLogin.json?.token || '').trim()
      if (!u?.xmppUsername || !u?.xmppPassword || !t) throw new Error(`login u${i}: missing xmpp creds/token`)
      if (i === 0) creatorToken = t
      pool.push({ xmppUsername: String(u.xmppUsername), xmppPassword: String(u.xmppPassword) })
   }

   // One public room, with every pool user as a member so they can all join.
   const createChat = await httpJson(
      'POST',
      `${env.ethoraApiBase}/v1/chats`,
      { Authorization: `Bearer ${creatorToken}` },
      {
         title: `xmppload-${suffix}`,
         description: 'uptime xmpp load',
         type: 'public',
         uuid: `xmppload-${suffix}`,
         members: pool.map((u) => u.xmppUsername),
      },
   )
   if (!createChat.resp.ok) throw new Error(`create chat failed: ${createChat.resp.status} ${createChat.text}`)
   const chatName = String(createChat.json?.result?.name || '').trim()
   if (!chatName) throw new Error('create chat: missing name')

   return { ownerToken, appId: app.appId, roomJid: `${chatName}@${mucService}`, pool, serviceUrl, host }
}

async function teardownXmpp(env: JourneyEnv, ctx: XmppContext): Promise<void> {
   await httpJson('DELETE', `${env.ethoraApiBase}/v1/apps/${encodeURIComponent(ctx.appId)}`, {
      Authorization: `Bearer ${ctx.ownerToken}`,
      'x-ethora-synthetic': '1',
   })
}

function sendGroupchat(xmpp: any, roomJid: string, id: string, body: string) {
   return xmpp.send(xml('message', { to: roomJid, type: 'groupchat', id }, xml('body', {}, body)))
}

// Resolve when the server broadcasts our own message (matched by stanza id) back
// into the room — i.e. a full client→server→client round-trip.
function awaitEcho(xmpp: any, roomJid: string, id: string, timeoutMs: number): Promise<void> {
   return new Promise((resolve, reject) => {
      let timer: any
      const onStanza = (stanza: any) => {
         if (!stanza?.is?.('message')) return
         if (stanza.attrs?.type !== 'groupchat') return
         if ((stanza.attrs?.from || '').split('/')[0] !== roomJid) return
         if (String(stanza.attrs?.id || '') === id) {
            cleanup()
            resolve()
         }
      }
      const cleanup = () => {
         try { clearTimeout(timer) } catch {}
         try { xmpp.off('stanza', onStanza) } catch {}
      }
      timer = setTimeout(() => {
         cleanup()
         reject(new Error('XMPP_ECHO_TIMEOUT'))
      }, timeoutMs)
      xmpp.on('stanza', onStanza)
   })
}

function poolSizeFor(parallelism: number): number {
   // Cap pool creation cost; workers share JIDs (distinct XMPP resources) when
   // parallelism exceeds the pool. 1 user per worker up to 20.
   return Math.max(1, Math.min(parallelism, 20))
}

// ── xmpp-messages: persistent connections, message round-trip throughput ──────
export async function runXmppMessages(opts: XmppOptions): Promise<LoadRunResult> {
   const env = getJourneyEnvFromProcess()
   const suffix = opts.suffix || `${Date.now().toString(36)}`
   const ctx = await setupXmpp(env, suffix, poolSizeFor(opts.parallelism))

   // One persistent joined connection per worker, created lazily on first use.
   const clients = new Map<number, any>()
   const getClient = async (workerId: number) => {
      let c = clients.get(workerId)
      if (!c) {
         const u = ctx.pool[workerId % ctx.pool.length]
         c = await joinRoomByWs(ctx.serviceUrl, ctx.host, u.xmppUsername, u.xmppPassword, ctx.roomJid, JOIN_TIMEOUT_MS, `w${workerId}`)
         clients.set(workerId, c)
      }
      return c
   }

   try {
      return await runLoad({
         parallelism: opts.parallelism,
         durationSeconds: opts.durationSeconds,
         rampUpSeconds: opts.rampUpSeconds,
         sleepBetweenIterationsMs: opts.sleepBetweenIterationsMs,
         reportEverySeconds: opts.reportEverySeconds,
         onProgress: opts.onProgress,
         label: opts.label || 'xmpp-messages',
         workerFn: async (workerId, iteration) => {
            try {
               const xmpp = await getClient(workerId)
               const id = `m-${workerId}-${iteration}-${suffix}`
               const echo = awaitEcho(xmpp, ctx.roomJid, id, ECHO_TIMEOUT_MS)
               await sendGroupchat(xmpp, ctx.roomJid, id, `load ${id}`)
               await echo
               return { ok: true }
            } catch (e: any) {
               return { ok: false, details: { error: e?.message || String(e) } }
            }
         },
      })
   } finally {
      for (const c of clients.values()) {
         try { await c.stop() } catch {}
      }
      try { await teardownXmpp(env, ctx) } catch {}
   }
}

// ── xmpp-connect: connection storm (connect → join → send → disconnect) ───────
export async function runXmppConnect(opts: XmppOptions): Promise<LoadRunResult> {
   const env = getJourneyEnvFromProcess()
   const suffix = opts.suffix || `${Date.now().toString(36)}`
   const ctx = await setupXmpp(env, suffix, poolSizeFor(opts.parallelism))

   try {
      return await runLoad({
         parallelism: opts.parallelism,
         durationSeconds: opts.durationSeconds,
         rampUpSeconds: opts.rampUpSeconds,
         sleepBetweenIterationsMs: opts.sleepBetweenIterationsMs,
         reportEverySeconds: opts.reportEverySeconds,
         onProgress: opts.onProgress,
         label: opts.label || 'xmpp-connect',
         workerFn: async (workerId, iteration) => {
            const u = ctx.pool[workerId % ctx.pool.length]
            let xmpp: any = null
            try {
               xmpp = await joinRoomByWs(
                  ctx.serviceUrl, ctx.host, u.xmppUsername, u.xmppPassword, ctx.roomJid, JOIN_TIMEOUT_MS, `w${workerId}i${iteration}`,
               )
               await sendGroupchat(xmpp, ctx.roomJid, `c-${workerId}-${iteration}-${suffix}`, 'load connect')
               return { ok: true }
            } catch (e: any) {
               return { ok: false, details: { error: e?.message || String(e) } }
            } finally {
               if (xmpp) { try { await xmpp.stop() } catch {} }
            }
         },
      })
   } finally {
      try { await teardownXmpp(env, ctx) } catch {}
   }
}
