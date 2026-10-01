import { join } from 'node:path'
import { x402Client, wrapFetchWithPayment } from '@x402/fetch'
import { ExactEvmScheme, toClientEvmSigner } from '@x402/evm'
import { BatchSettlementEvmScheme } from '@x402/evm/batch-settlement/client'
import { FileClientChannelStorage } from '@x402/evm/batch-settlement/client/file-storage'
import { fromUnits, type Config } from './config.js'
import { accessTokens, entries, refusal, rememberAccess, reserve, spentToday, type Entry } from './ledger.js'
import { account, chainClient } from './wallet.js'

/**
 * Paying for a URL. The payment itself is the official x402 client; what is here is everything that
 * stands between a web page and the wallet:
 *   - the page says what it costs (HTTP 402). That is text from a stranger: only an offer in USDC on
 *     the configured network is considered, and its price is checked against the caller's maximum
 *     and the owner's limits BEFORE anything is signed;
 *   - the client is then allowed to sign exactly that price and nothing else - a site that answers a
 *     second, higher price to the paying request gets no signature;
 *   - money that may leave is written down first, so a crash cannot forget it.
 */

const USER_AGENT = 'P2Flux-MCP/0.3 (+https://p2flux.com)'
const MAX_BODY = 2 * 1024 * 1024
export const MAX_TEXT = 60_000

export type Offer = { scheme: 'exact' | 'batch-settlement'; units: bigint; minDeposit: bigint }
type Fetch = typeof fetch

/** https everywhere; plain http only for this machine, and only with test money. */
export function checkedUrl(config: Config, input: string): URL {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new Error(`"${input}" is not a web address`)
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local && config.network.caip === 'eip155:84532')) {
    throw new Error('only https addresses can be paid')
  }
  if (url.username || url.password) throw new Error('addresses with a user name or password are not paid')
  return url
}

/** The offers of a 402 this wallet may consider. Anything malformed, on another network or in another token is dropped. */
export function offersFrom(config: Config, header: string | null): Offer[] {
  if (!header || header.length > 65_536) return []
  let doc: { accepts?: unknown }
  try {
    doc = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as { accepts?: unknown }
  } catch {
    return []
  }
  const out: Offer[] = []
  for (const a of Array.isArray(doc?.accepts) ? doc.accepts : []) {
    const o = a as { scheme?: unknown; network?: unknown; asset?: unknown; amount?: unknown; extra?: { minDeposit?: unknown } }
    if (o?.scheme !== 'exact' && o?.scheme !== 'batch-settlement') continue
    if (o.network !== config.network.caip || String(o.asset).toLowerCase() !== config.network.usdc.toLowerCase()) continue
    if (typeof o.amount !== 'string' || !/^[1-9]\d{0,17}$/.test(o.amount)) continue
    const min = typeof o.extra?.minDeposit === 'string' && /^\d{1,18}$/.test(o.extra.minDeposit) ? BigInt(o.extra.minDeposit) : 0n
    out.push({ scheme: o.scheme, units: BigInt(o.amount), minDeposit: min })
  }
  return out
}

/** Readable text from a page: no scripts, no markup. */
export function toText(body: string, contentType: string): string {
  if (!/html/i.test(contentType)) return body.slice(0, MAX_TEXT)
  return body
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|header|footer|blockquote)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d{1,10});/g, (_m, n: string) => (Number(n) > 31 && Number(n) < 0x110000 ? String.fromCodePoint(Number(n)) : ' '))
    .replace(/&#x([0-9a-f]{1,6});/gi, (_m, n: string) => (parseInt(n, 16) > 31 && parseInt(n, 16) < 0x110000 ? String.fromCodePoint(parseInt(n, 16)) : ' '))
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_TEXT)
}

async function bodyOf(res: Response): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > MAX_BODY) {
      await reader.cancel()
      break
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Access tokens this site gave earlier go back to it, and only to it (always over https, see checkedUrl). */
const tokenHeader = (tokens: string[]): Record<string, string> => (tokens.length ? { 'p2flux-access-token': tokens.join(', ') } : {})

const plain = (f: Fetch, url: URL, tokens: string[] = []) =>
  f(url, { headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/json;q=0.9,*/*;q=0.5', ...tokenHeader(tokens) }, redirect: 'error', signal: AbortSignal.timeout(30_000) })

/** Every request that carries a signed payment: never redirected (a payment must not follow a site
 *  elsewhere), and a whole answer within 30 s. */
const named = (f: Fetch, tokens: string[] = []): Fetch =>
  ((i: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(i, { ...init, redirect: 'error', signal: AbortSignal.timeout(30_000) })
    request.headers.set('user-agent', USER_AGENT)
    for (const [k, v] of Object.entries(tokenHeader(tokens))) request.headers.set(k, v)
    return f(request)
  }) as Fetch

/** What the site says the payment buys (x402 resource.description): a stranger's words, clipped. */
export function offerText(header: string | null): string | undefined {
  if (!header || header.length > 65_536) return undefined
  try {
    const d = (JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as { resource?: { description?: unknown } }).resource?.description
    return typeof d === 'string' && d.trim() ? d.replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 400) : undefined
  } catch {
    return undefined
  }
}

export type Price = { free: true } | { free: false; price: string; prepaid: boolean; offers: Offer[]; says?: string }

/** What a URL costs. Pays nothing. */
export async function checkPrice(config: Config, input: string, f: Fetch = fetch): Promise<Price> {
  const url = checkedUrl(config, input)
  const res = await plain(f, url, accessTokens(config, url.host))
  if (res.status !== 402) {
    await res.body?.cancel()
    if (res.ok) return { free: true }
    throw new Error(`the site answered HTTP ${res.status}`)
  }
  await res.body?.cancel()
  const offers = offersFrom(config, res.headers.get('payment-required'))
  const exact = offers.find((o) => o.scheme === 'exact')
  if (!exact) throw new Error(`this page asks for payment, but not in USDC on ${config.network.label} - it cannot be paid from this wallet`)
  const says = offerText(res.headers.get('payment-required'))
  return { free: false, price: fromUnits(exact.units), prepaid: offers.some((o) => o.scheme === 'batch-settlement'), offers, ...(says ? { says } : {}) }
}

export type Read = { text: string; paid: string; how: 'free' | 'per page' | 'prepaid balance'; transaction?: string; deposited?: string; accessUntil?: string; accessSent?: true }

/** Read a URL, paying if it asks - within `maxPrice`, the limit per payment and the daily limit. */
export async function readPaid(config: Config, input: string, maxPrice: bigint | null, f: Fetch = fetch, now: () => number = Date.now): Promise<Read> {
  const url = checkedUrl(config, input)
  const tokens = accessTokens(config, url.host, now())
  const first = await plain(f, url, tokens)
  if (first.ok) return { text: toText(await bodyOf(first), first.headers.get('content-type') ?? ''), paid: '0.00', how: 'free', ...(tokens.length ? { accessSent: true as const } : {}) }
  await first.body?.cancel()
  if (first.status !== 402) throw new Error(`the site answered HTTP ${first.status}`)

  const offers = offersFrom(config, first.headers.get('payment-required'))
  const exact = offers.find((o) => o.scheme === 'exact')
  if (!exact) throw new Error(`this page asks for payment, but not in USDC on ${config.network.label} - it cannot be paid from this wallet`)
  const price = exact.units
  if (maxPrice !== null && price > maxPrice) throw new Error(`this page costs ${fromUnits(price)} USDC, above the maximum of ${fromUnits(maxPrice)} given for it. Nothing was paid.`)
  if (price > config.perPayment) throw new Error(`this page costs ${fromUnits(price)} USDC, above the owner's limit of ${fromUnits(config.perPayment)} per payment. Nothing was paid.`)

  const signer = toClientEvmSigner(account(config), chainClient(config) as never)
  const paying = (scheme: 'exact' | 'batch-settlement', onDeposit?: (units: bigint) => void) => {
    const client = new x402Client()
    // The client may sign this scheme, on this network, in USDC, at the price that was checked. Nothing else.
    client.registerPolicy((_version, requirements) =>
      requirements.filter((r) => r.scheme === scheme && r.network === config.network.caip && String(r.asset).toLowerCase() === config.network.usdc.toLowerCase() && r.amount === price.toString()),
    )
    if (scheme === 'exact') client.register(config.network.caip, new ExactEvmScheme(signer))
    else {
      client.register(
        config.network.caip,
        new BatchSettlementEvmScheme(signer, {
          storage: new FileClientChannelStorage({ directory: join(config.dir, 'channels') }),
          depositPolicy: { depositMultiplier: 3 },
          // A deposit is money leaving the wallet: it must fit the prepaid cap and what is left of today.
          depositStrategy: (ctx) => {
            const deposit = BigInt(ctx.depositAmount)
            if (deposit > config.maxPrepaid || spentToday(entries(config), now()) + deposit > config.perDay) return false
            onDeposit?.(deposit)
            return undefined
          },
        }),
      )
    }
    const signedFetch = named(f, tokens)
    return wrapFetchWithPayment(signedFetch, client)
  }
  // A payment that bought a period (a subscription) is answered with a token for later requests.
  const accessOf = (res: Response): { accessUntil?: string } => {
    const until = rememberAccess(config, url.host, res.headers.get('p2flux-access-token'), res.headers.get('p2flux-access-expires'), now())
    return until === null ? {} : { accessUntil: new Date(until).toISOString().slice(0, 10) }
  }
  const transactionOf = (res: Response): string | undefined => {
    try {
      const t = (JSON.parse(Buffer.from(res.headers.get('payment-response') ?? '', 'base64').toString('utf8')) as { transaction?: unknown }).transaction
      return typeof t === 'string' && /^0x[0-9a-fA-F]{64}$/.test(t) ? t : undefined
    } catch {
      return undefined
    }
  }

  // Prepaid first when the site offers it and the owner allows it: no transaction per page.
  const batch = offers.find((o) => o.scheme === 'batch-settlement' && o.units === price)
  if (batch && config.maxPrepaid > 0n && batch.minDeposit <= config.maxPrepaid) {
    let deposited = 0n
    // A deposit is written down the moment it is decided, before it is signed.
    let settleDeposit: ReturnType<typeof reserve> | null = null
    const onDeposit = (d: bigint) => {
      deposited += d
      settleDeposit = reserve(config, url.toString(), d, now())
    }
    const depositEntry = (transaction?: string): Entry[] =>
      deposited > 0n ? [{ at: now(), url: url.toString(), units: deposited.toString(), kind: 'deposit', ...(transaction ? { transaction } : {}) }] : []
    const close = (list: Entry[], voucher: boolean) => {
      const outcome = voucher ? [...list, { at: now(), url: url.toString(), units: price.toString(), kind: 'voucher' as const }] : list
      if (settleDeposit) (settleDeposit as ReturnType<typeof reserve>)(outcome)
      else if (outcome.length) reserve(config, url.toString(), 0n, now())(outcome)
    }
    try {
      const res = await paying('batch-settlement', onDeposit)(url)
      if (res.ok) {
        close(depositEntry(transactionOf(res)), true)
        return { text: toText(await bodyOf(res), res.headers.get('content-type') ?? ''), paid: fromUnits(price), how: 'prepaid balance', ...(deposited > 0n ? { deposited: fromUnits(deposited) } : {}), ...accessOf(res) }
      }
      await res.body?.cancel()
      // Whether a signed deposit went out is not known here: it stays counted.
      close(depositEntry(), false)
    } catch {
      close(depositEntry(), false)
    }
  }

  const why = refusal(config, price, entries(config), now())
  if (why) throw new Error(`paying ${fromUnits(price)} USDC for this page would go ${why} (${fromUnits(config.perDay)} USDC a day, ${fromUnits(spentToday(entries(config), now()))} spent in the last 24 hours). Nothing was paid.`)
  const settle = reserve(config, url.toString(), price, now())
  let res: Response
  try {
    res = await paying('exact')(url)
  } catch (err) {
    // Nothing was signed if the client refused the offer; anything else is unknown and stays counted.
    if (/No network\/scheme registered|no payment requirements|Failed to create payment/i.test(String((err as Error).message))) settle([])
    throw new Error(`the payment could not be made: ${(err as Error).message}`)
  }
  if (res.status === 402) {
    await res.body?.cancel()
    settle([])
    throw new Error('the site refused the payment (is there enough USDC in the wallet? check with wallet_balance). Nothing was paid.')
  }
  const transaction = transactionOf(res)
  settle([{ at: now(), url: url.toString(), units: price.toString(), kind: 'exact', ...(transaction ? { transaction } : {}) }])
  if (!res.ok) throw new Error(`paid ${fromUnits(price)} USDC, but the site answered HTTP ${res.status}`)
  return { text: toText(await bodyOf(res), res.headers.get('content-type') ?? ''), paid: fromUnits(price), how: 'per page', ...(transaction ? { transaction } : {}), ...accessOf(res) }
}

/**
 * Take the unused prepaid balance for a site back into the wallet. The site is asked to return it
 * (the official cooperative refund): nothing is paid, and the money can only go to this wallet - the
 * escrow contract refunds a channel to its payer and to nobody else.
 */
export async function withdrawPrepaid(config: Config, input: string, f: Fetch = fetch, now: () => number = Date.now): Promise<{ transaction?: string; amount?: string }> {
  const url = checkedUrl(config, input)
  const signer = toClientEvmSigner(account(config), chainClient(config) as never)
  const scheme = new BatchSettlementEvmScheme(signer, { storage: new FileClientChannelStorage({ directory: join(config.dir, 'channels') }) })
  const signedFetch = named(f)
  let settled: { success?: boolean; transaction?: string; amount?: string; errorReason?: string }
  try {
    settled = (await scheme.refund(url.toString(), { fetch: signedFetch })) as typeof settled
  } catch (err) {
    const message = (err as Error).message
    if (/refund_too_early/.test(message)) throw new Error('this balance was barely used, so it is returned after 24 hours without use - ask again tomorrow. It stays yours meanwhile.')
    throw new Error(`the prepaid balance could not be taken back: ${message}. It stays yours: the site returns balances idle for a week on its own.`)
  }
  if (!settled.success) {
    if (/refund_too_early/.test(String(settled.errorReason))) throw new Error('this balance was barely used, so it is returned after 24 hours without use - ask again tomorrow. It stays yours meanwhile.')
    throw new Error(`the site did not return the balance (${settled.errorReason ?? 'no reason given'}). It stays yours: the site returns balances idle for a week on its own.`)
  }
  const transaction = typeof settled.transaction === 'string' && /^0x[0-9a-fA-F]{64}$/.test(settled.transaction) ? settled.transaction : undefined
  const amount = typeof settled.amount === 'string' && /^\d{1,18}$/.test(settled.amount) ? settled.amount : undefined
  reserve(config, url.toString(), 0n, now())([{ at: now(), url: url.toString(), units: amount ?? '0', kind: 'refund', ...(transaction ? { transaction } : {}) }])
  return { ...(transaction ? { transaction } : {}), ...(amount ? { amount: fromUnits(BigInt(amount)) } : {}) }
}
