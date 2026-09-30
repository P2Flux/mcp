// The remote server live on Base Sepolia: the built server over Streamable HTTP, driven by the official
// MCP client; a local WordPress with the Agent Paywall plugin; api-test; and the approval page in a
// real browser (Playwright) whose "wallet" signs with a test key. Spends 0.05 test USDC.
//
//   (local WordPress on :8082)  set -a; . ~/projects/p2flux_payment/.env; set +a
//   PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs node test/remote-live.mjs
// Without PLAYWRIGHT the page is skipped and its two requests are made directly.
import { execFileSync, spawn } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createPublicClient, http, parseAbi } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'

const WP = `${process.env.HOME}/projects/p2flux_wp_paywall`
const wp = (...a) => execFileSync('wp', [`--path=${WP}`, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const chain = createPublicClient({ chain: baseSepolia, transport: http('https://sepolia.base.org') })
const usdc = (a) => chain.readContract({ address: USDC, abi: parseAbi(['function balanceOf(address) view returns (uint256)']), functionName: 'balanceOf', args: [a] })
const payer = privateKeyToAccount(process.env.P2FLUX_E2E_WALLET_PRIVATE_KEY)
const BASE = 'http://localhost:8787'

try { wp('option', 'delete', 'p2flux_ap_fake') } catch {}
wp('transient', 'delete', '--all')
wp('option', 'update', 'p2flux_ap_settings', JSON.stringify({ wallet: process.env.SELLER_WALLET, environment: 'test', default_price: '0.05', paid_post_types: ['post'], paid_categories: [], paid_routes: [], api_down: 'refuse', prepaid: 'yes', directory: 'yes' }), '--format=json')
const id = wp('post', 'create', '--post_type=post', '--post_title=Remote', '--post_content=REMOTE-SECRET-1', '--post_status=publish', '--porcelain')
const url = wp('post', 'url', id)

const server = spawn('node', ['dist/remote.js'], { env: { PATH: process.env.PATH, P2FLUX_NETWORK: 'test', P2FLUX_PUBLIC_URL: BASE, P2FLUX_REMOTE_ALLOW_LOCAL: '1', PORT: '8787' }, stdio: ['ignore', 'inherit', 'inherit'] })
for (let i = 0; i < 50; i++) { try { if ((await fetch(`${BASE}/health`)).ok) break } catch {} await new Promise((r) => setTimeout(r, 200)) }

const results = []
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + String(detail).replace(/\s+/g, ' ').slice(0, 200) : ''}`) }
let browser
try {
  const client = new Client({ name: 'remote-live', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)))
  const call = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); return { error: !!r.isError, text: r.content.map((c) => c.text).join('\n') } }

  const names = (await client.listTools()).tools.map((t) => t.name).sort().join()
  check('1 the server lists its four tools over Streamable HTTP; none can hold or export a key', names === 'check_price,find_paid_content,get_paid_page,request_paid_page', names)
  check('2 check_price reads the price', /costs 0\.05 USDC/.test((await call('check_price', { url })).text))
  const local = await call('check_price', { url: 'https://127.0.0.1/' })
  check('3 a private address is not read', local.error && /not a public website/.test(local.text), local.text)
  const asked = await call('request_paid_page', { url })
  const link = /(http:\/\/localhost:8787\/approve\/[0-9a-f]{32})/.exec(asked.text)?.[1]
  const requestId = link?.split('/').pop()
  check('4 request_paid_page returns a link for the user, and pays nothing', !!link && /0\.05 USDC/.test(asked.text) && !asked.text.includes('REMOTE-SECRET'), asked.text)
  const early = await call('get_paid_page', { request_id: requestId })
  check('5 before approval the assistant gets nothing but the link', /Not approved yet/.test(early.text) && !early.text.includes('REMOTE-SECRET'), early.text)

  const [payerBefore, sellerBefore] = await Promise.all([usdc(payer.address), usdc(process.env.SELLER_WALLET)])
  if (process.env.PLAYWRIGHT) {
    const { chromium } = await import(process.env.PLAYWRIGHT)
    browser = await chromium.launch()
    const page = await browser.newPage()
    let reject = true
    await page.exposeFunction('__sign', async (json) => {
      if (reject) throw Object.assign(new Error('User rejected the request.'), { code: 4001 })
      const t = JSON.parse(json)
      const { EIP712Domain: _d, ...types } = t.types
      return payer.signTypedData({ domain: t.domain, types, primaryType: t.primaryType, message: t.message })
    })
    await page.addInitScript(`window.ethereum = { request: async ({ method, params }) => {
      if (method === 'eth_requestAccounts') return ['${payer.address}']
      if (method === 'eth_chainId') return '0x14a34'
      if (method === 'eth_signTypedData_v4') return window.__sign(params[1])
      throw new Error('unsupported ' + method) } }`)
    await page.goto(link)
    await page.waitForFunction(() => document.getElementById('amount').textContent.includes('USDC'))
    const shown = await page.evaluate(() => [document.getElementById('amount').textContent, document.getElementById('url').textContent, document.getElementById('payto').textContent])
    check('6 the page shows the amount, the page and the seller address before anything is signed', shown[0] === '0.05 USDC' && shown[1] === url && /^0x[0-9a-fA-F]{40}$/.test(shown[2]), shown.join(' | '))
    if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT })
    await page.click('#approve')
    await page.waitForFunction(() => document.getElementById('status').className === 'err')
    check('7 the user says no in the wallet: nothing is paid, the request stays open', /rejected/i.test(await page.textContent('#status')) && /Not approved yet/.test((await call('get_paid_page', { request_id: requestId })).text))
    reject = false
    await page.click('#approve')
    await page.waitForFunction(() => ['ok', 'err'].includes(document.getElementById('status').className) && !/rejected/i.test(document.getElementById('status').textContent), null, { timeout: 60_000 })
    check('8 the user approves in the wallet: paid', (await page.getAttribute('#status', 'class')) === 'ok', await page.textContent('#status'))
  } else {
    const d = await (await fetch(`${link}/data`)).json()
    const authorization = { from: payer.address, to: d.payTo, value: d.units, validAfter: '0', validBefore: String(Math.floor(Date.now() / 1000) + d.timeout), nonce: `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex')}` }
    const signature = await payer.signTypedData({
      domain: { name: d.tokenName, version: d.tokenVersion, chainId: d.chainId, verifyingContract: d.asset },
      types: { TransferWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] },
      primaryType: 'TransferWithAuthorization', message: { ...authorization, value: BigInt(d.units), validAfter: 0n, validBefore: BigInt(authorization.validBefore) },
    })
    const forged = await fetch(link, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signature, authorization: { ...authorization, value: '1' } }) })
    check('6-7 a signature for another amount is refused', forged.status === 400, await forged.text())
    const ok = await fetch(link, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signature, authorization }) })
    check('8 the signed approval pays', ok.status === 200, await ok.text())
  }

  const got = await call('get_paid_page', { request_id: requestId })
  check('9 the assistant now gets the page text and the transaction', !got.error && got.text.includes('REMOTE-SECRET-1') && /Paid 0\.05 USDC/.test(got.text) && /basescan\.org\/tx\/0x/.test(got.text), got.text)
  await new Promise((r) => setTimeout(r, 5000))
  const [payerAfter, sellerAfter] = await Promise.all([usdc(payer.address), usdc(process.env.SELLER_WALLET)])
  check('10 on chain: the user paid 0.05, the seller got 0.047, P2Flux held nothing', payerBefore - payerAfter === 50_000n && sellerAfter - sellerBefore === 47_000n, `payer -${payerBefore - payerAfter}, seller +${sellerAfter - sellerBefore}`)
  const again = await fetch(link, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  check('11 the request cannot be paid twice', again.status === 400 && /already paid/.test(await again.text()))
  await client.close()
} finally {
  await browser?.close()
  server.kill()
  wp('post', 'delete', id, '--force')
}
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
