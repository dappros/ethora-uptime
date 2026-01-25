// Ethora.com platform, copyright: Dappros Ltd (c) 2026, all rights reserved
//
// A tiny in-memory lock to prevent overlapping check runs.
// This matters for XMPP synthetic checks: concurrent runs using the same test accounts can kick each other
// and produce stream errors like "conflict - User removed".

const inFlight = new Set<string>()

export function isCheckLocked(key: string): boolean {
  return inFlight.has(key)
}

export async function withCheckLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  if (inFlight.has(key)) {
    throw Object.assign(new Error(`CHECK_ALREADY_RUNNING:${key}`), { code: 'CHECK_ALREADY_RUNNING', checkId: key })
  }
  inFlight.add(key)
  try {
    return await fn()
  } finally {
    inFlight.delete(key)
  }
}

