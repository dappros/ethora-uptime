// Ethora.com platform, copyright: Dappros Ltd (c) 2026, all rights reserved
import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'

export type CheckType = 'http' | 'wss' | 'journey'
export type CheckSeverity = 'critical' | 'optional'

export type StatusRule =
  | { type: 'status_code'; expected: number[] }
  | { type: 'json'; path: string; equals?: string; exists?: boolean }

export type CheckConfig = {
  id: string
  name: string
  type: CheckType
  // Severity affects instance status aggregation:
  // - critical: failures can make instance red
  // - optional: failures never make instance red (still recorded & visible)
  severity?: CheckSeverity
  enabled?: boolean
  intervalSeconds: number
  timeoutMs: number
  // url is required for http/wss checks; journey checks use env config and may omit url
  url?: string
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
  expect?: StatusRule[]
}

export type InstanceConfig = {
  id: string
  name: string
  enabled: boolean
  tags?: string[]
  checks: CheckConfig[]
}

export type UptimeConfig = {
  instances: InstanceConfig[]
}

export function loadConfigFromFile(filePath: string): UptimeConfig {
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath)
  const raw = fs.readFileSync(abs, 'utf8')
  const doc = yaml.load(raw)
  if (!doc || typeof doc !== 'object') {
    throw new Error(`Invalid config YAML: ${filePath}`)
  }
  const cfg = doc as any
  if (!Array.isArray(cfg.instances)) {
    throw new Error(`Config must have 'instances: []' at root`)
  }
  for (const inst of cfg.instances) {
    if (!inst?.id || !inst?.name) throw new Error('Each instance must have id + name')
    if (!Array.isArray(inst.checks)) throw new Error(`Instance ${inst.id} must have checks[]`)
    for (const chk of inst.checks) {
      if (!chk?.id || !chk?.name || !chk?.type) {
        throw new Error(`Check is missing required fields (id,name,type) in instance ${inst.id}`)
      }
      if (chk.enabled === false) continue
      if (chk.type !== 'journey' && !chk?.url) {
        throw new Error(`Check is missing url (required for type=${chk.type}) in instance ${inst.id}`)
      }
      if (chk.severity && chk.severity !== 'critical' && chk.severity !== 'optional') {
        throw new Error(`Check ${inst.id}:${chk.id} has invalid severity: ${chk.severity}`)
      }
    }
  }
  return cfg as UptimeConfig
}


