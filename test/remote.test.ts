/**
 * The remote server: it holds no wallet, so what matters is that (1) it reads only public websites,
 * (2) it asks a person to sign only for a P2Flux seller, the shown amount and nothing else, and
 * (3) it uses a signature only if it is exactly that. The real payment is proven live (test/remote-live.mjs).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadConfig } from '../src/config.js'
import { createRemote, type RemoteDeps } from '../src/remote/core.js'
import { isPublicAddress, publicFetch, type Fetched } from '../src/remote/net.js'

const network = loadConfig({} as never).network
const USDC = network.usdc
const SELLER = '0xb4e43f3fBa5Add75395adAD366627E7d74141Fa9'
const VAULT = '0x00000000000000000000000000000000000000aa'
const PAYER = '0x9B710c4Cc6A63Fc0728748Af852e2183fb936262'
const URL_ = 'https://shop.example/post'
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64')
const decode = (h: string) => JSON.parse(Buffer.from(h, 'base64').toString())
const offer = (over: Record<string, unknown> = {}) => ({ scheme: 'exact', network: 'eip155:84532', asset: USDC, amount: '50000', payTo: VAULT, maxTimeoutSeconds: 300, extra: { name: 'USDC', version: '2', p2flux: { recipient: SELLER } }, ...over })

const TOKEN = 'T'.repeat(43)
function world(over: { accepts?: unknown[]; free?: boolean; paidStatus?: number; vault?: string | null; valid?: boolean; grants?: boolean } = {}) {
  const calls: { url: string; headers: Record<string, string> }[] = []
  const clock = { now: 1_790_000_000_000 }
  const deps: RemoteDeps = {
    network, apiUrl: 'https://api.test', publicUrl: 'https://agent.test', maxPrice: 5_000_000n, now: () => clock.now,
    fetchPage: async (url, headers): Promise<Fetched> => {
      calls.push({ url, headers })
      if (over.free) return { status: 200, headers: { 'content-type': 'text/html' }, body: 'FREE-TEXT' }
      if (over.grants && (headers['p2flux-access-token'] ?? '').split(', ').includes(TOKEN)) return { status: 200, headers: { 'content-type': 'text/html' }, body: '<p>MEMBER-TEXT</p>' }
      if (!headers['payment-signature']) return { status: 402, headers: { 'payment-required': b64({ x402Version: 2, resource: { url }, accepts: over.accepts ?? [offer()] }) }, body: '{}' }
      const status = over.paidStatus ?? 200
      if (status === 402) return { status, headers: { 'payment-required': b64({ error: 'invalid_exact_evm_insufficient_balance' }) }, body: '{}' }
      const access: Record<string, string> = over.grants ? { 'p2flux-access-token': TOKEN, 'p2flux-access-expires': '2026-11-01T23:59:59Z' } : {}
      return { status, headers: { 'content-type': 'text/html', 'payment-response': b64({ success: true, transaction: `0x${'ab'.repeat(32)}` }), ...access }, body: '<p>PAID-SECRET</p><script>evil()</script>' }
    },
    api: (async () => (over.vault === null ? new Response('{}', { status: 400 }) : Response.json({ pay_to: over.vault ?? VAULT }))) as unknown as typeof fetch,
    verifySignature: async () => over.valid ?? true,
  }
  return { remote: createRemote(deps), calls, clock }
}
const SIG = `0x${'11'.repeat(65)}`
const auth = (w: ReturnType<typeof world>, over: Record<string, unknown> = {}) => ({
  signature: SIG,
  authorization: { from: PAYER, to: VAULT, value: '50000', validAfter: '0', validBefore: String(Math.floor(w.clock.now / 1000) + 300), nonce: `0x${'cd'.repeat(32)}`, ...over },
})
const opened = async (w: ReturnType<typeof world>) => {
  const r = await w.remote.request(URL_, undefined)
  assert.equal(r.free, false)
  return r as Extract<typeof r, { free: false }>
}

test('request: a P2Flux seller\'s page opens a request - a link for the person, and exactly what the wallet will be asked to sign', async () => {
  const w = world()
  const r = await opened(w)
  assert.match(r.id, /^[0-9a-f]{32}$/)
  assert.equal(r.link, `https://agent.test/approve/${r.id}`)
  assert.equal(r.price, '0.05')
  assert.deepEqual(w.remote.data(r.id), { state: 'waiting', url: URL_, price: '0.05', units: '50000', payTo: VAULT, asset: USDC, chainId: 84532, networkLabel: network.label, tokenName: 'USDC', tokenVersion: '2', timeout: 300 })
  assert.equal(w.calls.length, 1)
  assert.equal(w.calls[0]!.headers['payment-signature'], undefined)
})

test('request: only P2Flux sellers, only USDC on this network, only within the cap - otherwise nothing to sign', async () => {
  const refused: [string, Parameters<typeof world>[0], RegExp][] = [
    ['a seller not named', { accepts: [offer({ extra: { name: 'USDC', version: '2' } })] }, /not paid through P2Flux/],
    ['payTo is not the seller\'s P2Flux address', { vault: '0x00000000000000000000000000000000000000bb' }, /not paid through P2Flux/],
    ['P2Flux does not know the wallet', { vault: null }, /not paid through P2Flux/],
    ['another token', { accepts: [offer({ asset: '0x00000000000000000000000000000000000000cc' })] }, /not in USDC/],
    ['another network', { accepts: [offer({ network: 'eip155:1' })] }, /not in USDC/],
    ['no token name to sign with', { accepts: [offer({ extra: { p2flux: { recipient: SELLER } } })] }, /cannot be shown/],
    ['above what this service pays', { accepts: [offer({ amount: '5000001' })] }, /above the 5\.00 USDC/],
    ['not an amount', { accepts: [offer({ amount: '-5' })] }, /not in USDC/],
  ]
  for (const [name, over, message] of refused) {
    const w = world(over)
    await assert.rejects(w.remote.request(URL_, undefined), message, name)
    assert.equal(w.remote.size(), 0, name)
  }
  await assert.rejects(world().remote.request(URL_, '0.01'), /above the maximum of 0\.01/)
  await assert.rejects(world().remote.request(URL_, 'cheap'), /not an amount/)
})

test('request: a free page is not proxied - the assistant is told to read it itself', async () => {
  const w = world({ free: true })
  assert.deepEqual(await w.remote.request(URL_, undefined), { free: true })
  assert.equal(await w.remote.price(URL_), 'This page is free to read.')
})

test('approve: a signature for anything but the shown payment is refused, and the site never sees it', async () => {
  const w = world()
  const r = await opened(w)
  const secs = Math.floor(w.clock.now / 1000)
  const wrong: Record<string, unknown>[] = [
    { to: '0x00000000000000000000000000000000000000ee' }, { value: '50001' }, { value: '5000' }, { validAfter: '1' },
    { validBefore: String(secs - 1) }, { validBefore: String(secs + 86_400) }, { validBefore: 'soon' },
    { nonce: '0x1234' }, { from: 'me' }, { to: undefined },
  ]
  for (const over of wrong) await assert.rejects(w.remote.approve(r.id, auth(w, over)), /not for the payment that was shown/, JSON.stringify(over))
  for (const signature of ['', '0x12', 'sig', null, 5]) await assert.rejects(w.remote.approve(r.id, { ...auth(w), signature }), /not for the payment/, String(signature))
  await assert.rejects(w.remote.approve(r.id, {}), /not for the payment/)
  assert.equal(w.calls.length, 1, 'only the first, unpaid request reached the site')
  assert.equal(w.remote.result(r.id).state, 'waiting')
})

test('approve: a signature that is not this wallet\'s is refused', async () => {
  const w = world({ valid: false })
  const r = await opened(w)
  await assert.rejects(w.remote.approve(r.id, auth(w)), /not valid for this wallet/)
  assert.equal(w.calls.length, 1)
})

test('approve: the page is paid with exactly what was offered and signed, once; the assistant gets text, not scripts', async () => {
  const w = world()
  const r = await opened(w)
  assert.deepEqual(w.remote.result(r.id), { state: 'waiting', link: r.link, price: '0.05' })
  assert.deepEqual(await w.remote.approve(r.id, auth(w)), { paid: true, transaction: `0x${'ab'.repeat(32)}` })
  const sent = decode(w.calls[1]!.headers['payment-signature']!)
  assert.deepEqual(sent.accepted, offer())
  assert.deepEqual(sent.payload, auth(w))
  assert.equal(sent.x402Version, 2)
  const out = w.remote.result(r.id)
  assert.equal(out.state, 'paid')
  if (out.state === 'paid') {
    assert.match(out.text, /PAID-SECRET/)
    assert.doesNotMatch(out.text, /evil|<script/)
    assert.equal(out.transaction, `0x${'ab'.repeat(32)}`)
  }
  await assert.rejects(w.remote.approve(r.id, auth(w)), /already paid/)
  assert.equal(w.calls.length, 2)
  assert.equal(w.remote.data(r.id).state, 'paid')
})

test('approve: refused by the site - nothing was paid and the person may try again; a broken site closes the request', async () => {
  const w = world({ paidStatus: 402 })
  const r = await opened(w)
  await assert.rejects(w.remote.approve(r.id, auth(w)), /refused \(invalid_exact_evm_insufficient_balance\).*Nothing was paid/)
  assert.equal(w.remote.result(r.id).state, 'waiting')
  const broken = world({ paidStatus: 500 })
  const b = await opened(broken)
  await assert.rejects(broken.remote.approve(b.id, auth(broken)), /HTTP 500/)
  assert.equal(broken.remote.result(b.id).state, 'failed')
  await assert.rejects(broken.remote.approve(b.id, auth(broken)), /closed/)
})

test('requests expire, and an id that was never issued opens nothing', async () => {
  const w = world()
  const r = await opened(w)
  for (const id of ['', 'x', '../../etc', 'g'.repeat(32), '0'.repeat(32)]) assert.throws(() => w.remote.result(id), /does not exist or has expired/)
  w.clock.now += 15 * 60_000 + 1
  assert.throws(() => w.remote.data(r.id), /expired/)
  await assert.rejects(w.remote.approve(r.id, auth(w)), /expired/)
})

test('net: only globally routable addresses - no IPv6 form that carries or reaches an IPv4 one', () => {
  const PUBLIC = ['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111', '2a00:1450:4001:82a::200e', '2001:4860:4860::8888']
  const PRIVATE = [
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '192.0.2.1', '198.51.100.7', '203.0.113.9',
    '::', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::127.0.0.1', '::7f00:1', '::a9fe:a9fe',
    '64:ff9b::7f00:1', '64:ff9b::169.254.169.254', '2002:7f00:1::1', '2002:c0a8:101::', '2001:0:4136:e378:8000:63bf:3fff:fdd2', '2001:db8::1',
    'fd00::1', 'fc00::1', 'fe80::1', 'fe80::1%eth0', 'fec0::1', 'ff02::1', '100::1', '3fff::1', '4000::1',
    'not-an-ip', '', '1.2.3', '::ffff:999.1.1.1', '1:2:3:4:5:6:7:8:9', ':::1',
  ]
  for (const a of PUBLIC) assert.equal(isPublicAddress(a), true, a)
  for (const a of PRIVATE) assert.equal(isPublicAddress(a), false, a)
})

test('net: http, credentials, odd ports and names that resolve to a private address are refused before any connection', async () => {
  const never = async () => { throw new Error('resolved') }
  await assert.rejects(publicFetch('http://shop.example/', {}, false, never), /only https/)
  await assert.rejects(publicFetch('http://localhost:8082/', {}, false, never), /only https/)
  await assert.rejects(publicFetch('https://user:pw@shop.example/', {}, false, never), /user name or password/)
  await assert.rejects(publicFetch('https://shop.example:8443/', {}, false, never), /standard https port/)
  await assert.rejects(publicFetch('file:///etc/passwd', {}, false, never), /only https/)
  await assert.rejects(publicFetch('nonsense', {}, false, never), /not a web address/)
  await assert.rejects(publicFetch('https://inside.example/', {}, false, async () => ['10.0.0.5']), /not a public website/)
  await assert.rejects(publicFetch('https://rebind.example/', {}, false, async () => ['93.184.216.34', '127.0.0.1']), /not a public website/)
  await assert.rejects(publicFetch('https://169.254.169.254/latest/meta-data', {}, false, async (h) => [h]), /not a public website/)
  await assert.rejects(publicFetch('https://nowhere.example/', {}, false, async () => []), /not a public website/)
})

test('approve: two approvals of one request at the same moment - one payment is sent, the other is told to wait', async () => {
  const w = world()
  const r = await opened(w)
  const both = await Promise.allSettled([w.remote.approve(r.id, auth(w)), w.remote.approve(r.id, auth(w, { nonce: `0x${'ef'.repeat(32)}` }))])
  assert.deepEqual(both.map((b) => b.status).sort(), ['fulfilled', 'rejected'])
  const refused = both.find((b) => b.status === 'rejected') as PromiseRejectedResult
  assert.match(String(refused.reason), /being made|already paid/)
  assert.equal(w.calls.filter((c) => c.headers['payment-signature']).length, 1, 'exactly one payment reached the site')
  assert.equal(w.remote.result(r.id).state, 'paid')
})

test('approve: a signature refused by the wallet check leaves the request open for another try', async () => {
  const w = world({ valid: false })
  const r = await opened(w)
  await assert.rejects(w.remote.approve(r.id, auth(w)), /not valid/)
  assert.equal(w.remote.result(r.id).state, 'waiting')
})

test('request: one caller cannot hold more than 20 waiting requests - a flood from one address cannot push out everyone else', async () => {
  const w = world()
  for (let i = 0; i < 20; i++) await w.remote.request(URL_, undefined, '203.0.113.9')
  await assert.rejects(w.remote.request(URL_, undefined, '203.0.113.9'), /too many payment requests/)
  assert.equal((await w.remote.request(URL_, undefined, '198.51.100.7')).free, false, 'another caller is not affected')
})

test('access tokens: a payment that bought a period hands the token to the assistant; with it, pages of that site are read without a payment', async () => {
  const w = world({ grants: true })
  const r = await opened(w)
  await w.remote.approve(r.id, auth(w))
  const out = w.remote.result(r.id)
  assert.equal(out.state, 'paid')
  if (out.state === 'paid') {
    assert.equal(out.accessToken, TOKEN)
    assert.equal(out.accessUntil, '2026-11-01')
    assert.equal(out.host, 'shop.example')
  }
  const again = await w.remote.request(URL_, undefined, '', ['junk', TOKEN])
  assert.equal(again.free, true)
  assert.match(String((again as { text?: string }).text), /MEMBER-TEXT/)
  assert.equal(w.calls.at(-1)!.headers['p2flux-access-token'], TOKEN, 'only well-formed tokens are sent')
  assert.match(await w.remote.price(URL_, [TOKEN]), /without paying/)
})
