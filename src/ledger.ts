import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Config } from './config.js'

/**
 * What was spent, kept on this computer: the daily limit is checked against it, and it is what
 * `spending_report` shows. Written before a payment is attempted (as a reservation) and corrected
 * after, so a crash in between counts the money as spent rather than forgetting it.
 */
export type Entry = {
  at: number
  url: string
  units: string
  /** A reservation's own id: two reservations in one millisecond for one page are still two. */
  id?: string
  /** exact: a transaction hash. prepaid: a deposit is 'deposit', a page paid from the balance 'voucher', unused balance taken back 'refund'. */
  kind: 'exact' | 'deposit' | 'voucher' | 'reserved' | 'refund'
  transaction?: string
}

const path = (config: Config) => join(config.dir, 'spending.json')

export function entries(config: Config): Entry[] {
  if (!existsSync(path(config))) return []
  const parsed = JSON.parse(readFileSync(path(config), 'utf8')) as unknown
  if (!Array.isArray(parsed)) throw new Error('the spending log is damaged; refusing to pay until it is fixed or removed')
  return parsed as Entry[]
}

function save(config: Config, list: Entry[]) {
  mkdirSync(config.dir, { recursive: true, mode: 0o700 })
  const tmp = `${path(config)}.tmp`
  writeFileSync(tmp, JSON.stringify(list.slice(-5000)), { mode: 0o600 })
  renameSync(tmp, path(config))
}

const DAY_MS = 86_400_000
/** Money that left the wallet in the last 24 hours: payments and prepaid deposits, not vouchers (those spend a deposit already counted). */
export const spentToday = (list: Entry[], now = Date.now()): bigint =>
  list.filter((e) => now - e.at < DAY_MS && e.kind !== 'voucher' && e.kind !== 'refund').reduce((sum, e) => sum + BigInt(e.units), 0n)

/** Why `units` may not leave the wallet now, or null. */
export function refusal(config: Config, units: bigint, list: Entry[], now = Date.now()): string | null {
  if (units > config.perPayment && units > config.maxPrepaid) return 'above the limit per payment'
  if (spentToday(list, now) + units > config.perDay) return 'above the daily limit'
  return null
}

/**
 * Access tokens a site gave for a payment that bought a period (a subscription), kept per site and
 * sent back only to that site. Base64url, 43 characters; expired ones are dropped.
 */
export type Access = { token: string; expires: number }
const accessPath = (config: Config) => join(config.dir, 'access.json')
export const ACCESS_TOKEN = /^[A-Za-z0-9_-]{43}$/

function accessMap(config: Config): Record<string, Access[]> {
  if (!existsSync(accessPath(config))) return {}
  try {
    const parsed = JSON.parse(readFileSync(accessPath(config), 'utf8')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, Access[]>) : {}
  } catch {
    return {}
  }
}

/** The unexpired tokens for a site, newest first, at most 10 (what a site reads). */
export function accessTokens(config: Config, host: string, now = Date.now()): string[] {
  const list = accessMap(config)[host.toLowerCase()]
  return (Array.isArray(list) ? list : []).filter((a) => a && ACCESS_TOKEN.test(a.token) && a.expires > now).sort((a, b) => b.expires - a.expires).slice(0, 10).map((a) => a.token)
}

/** Keep a token a site answered a payment with. Returns its expiry, or null when it was not one. */
export function rememberAccess(config: Config, host: string, token: string | null, expires: string | null, now = Date.now()): number | null {
  if (!token || !ACCESS_TOKEN.test(token)) return null
  const parsed = expires ? Date.parse(expires) : NaN
  // A site's word on how long it lasts, within reason: a day when it says nothing usable, never above 400 days.
  const until = Math.min(Number.isFinite(parsed) && parsed > now ? parsed : now + DAY_MS, now + 400 * DAY_MS)
  const map = accessMap(config)
  const key = host.toLowerCase()
  const kept = (Array.isArray(map[key]) ? map[key] : []).filter((a) => a && a.expires > now && a.token !== token)
  map[key] = [{ token, expires: until }, ...kept].slice(0, 20)
  for (const [h, list] of Object.entries(map)) if (!Array.isArray(list) || !list.some((a) => a.expires > now)) delete map[h]
  mkdirSync(config.dir, { recursive: true, mode: 0o700 })
  const tmp = `${accessPath(config)}.tmp`
  writeFileSync(tmp, JSON.stringify(map), { mode: 0o600 })
  renameSync(tmp, accessPath(config))
  return until
}

/** Reserve before paying; returns a function that replaces the reservation with what happened. */
export function reserve(config: Config, url: string, units: bigint, now = Date.now()) {
  const list = entries(config)
  const reservation: Entry = { at: now, url, units: units.toString(), kind: 'reserved', id: randomUUID() }
  save(config, [...list, reservation])
  return (outcome: Entry[] ) => {
    const current = entries(config).filter((e) => !(e.kind === 'reserved' && e.id === reservation.id))
    save(config, [...current, ...outcome])
  }
}
