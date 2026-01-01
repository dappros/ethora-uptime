// Ethora.com platform, copyright: Dappros Ltd (c) 2026, all rights reserved
import { WebSocket } from 'ws'
import type { CheckConfig } from './config.js'

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
  if (check.type === 'http') {
    return await runHttpCheck(check)
  }
  if (check.type === 'wss') {
    return await runWssCheck(check)
  }
  return { ok: false, durationMs: 0, errorText: `Unknown check type: ${(check as any).type}` }
}

async function runHttpCheck(check: CheckConfig): Promise<CheckRunResult> {
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
    for (const rule of expect) {
      if (rule.type === 'status_code') {
        ok = ok && rule.expected.includes(statusCode)
        details.statusExpected = rule.expected
      } else if (rule.type === 'json') {
        const text = await resp.clone().text()
        try {
          const json = JSON.parse(text)
          const value = getJsonPath(json, rule.path)
          if (rule.exists) ok = ok && value !== undefined && value !== null
          if (rule.equals !== undefined) ok = ok && String(value) === rule.equals
          details.jsonPath = rule.path
        } catch {
          ok = false
          details.jsonParse = 'failed'
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

    const ws = new WebSocket(check.url, {
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


