import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
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
  /** exact: a transaction hash. prepaid: a deposit is 'deposit', a page paid from the balance 'voucher'. */
  kind: 'exact' | 'deposit' | 'voucher' | 'reserved'
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
  list.filter((e) => now - e.at < DAY_MS && e.kind !== 'voucher').reduce((sum, e) => sum + BigInt(e.units), 0n)

/** Why `units` may not leave the wallet now, or null. */
export function refusal(config: Config, units: bigint, list: Entry[], now = Date.now()): string | null {
  if (units > config.perPayment && units > config.maxPrepaid) return 'above the limit per payment'
  if (spentToday(list, now) + units > config.perDay) return 'above the daily limit'
  return null
}

/** Reserve before paying; returns a function that replaces the reservation with what happened. */
export function reserve(config: Config, url: string, units: bigint, now = Date.now()) {
  const list = entries(config)
  const reservation: Entry = { at: now, url, units: units.toString(), kind: 'reserved' }
  save(config, [...list, reservation])
  return (outcome: Entry[] ) => {
    const current = entries(config).filter((e) => !(e.kind === 'reserved' && e.at === reservation.at && e.url === url))
    save(config, [...current, ...outcome])
  }
}
