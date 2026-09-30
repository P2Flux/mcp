// Live on Base Sepolia, through the MCP protocol: the built server over stdio, driven by the official
// MCP client; a local WordPress with the Agent Paywall plugin; api-test. Spends ~1.2 test USDC.
//
//   (local WordPress on :8082)  set -a; . ~/projects/p2flux_payment/.env; set +a; node test/live.mjs
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createPublicClient, createWalletClient, http, parseAbi } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'

const WP = `${process.env.HOME}/projects/p2flux_wp_paywall`
const wp = (...a) => execFileSync('wp', [`--path=${WP}`, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const chain = createPublicClient({ chain: baseSepolia, transport: http('https://sepolia.base.org') })
const dir = mkdtempSync(join(tmpdir(), 'p2flux-mcp-live-'))

try { wp('option', 'delete', 'p2flux_ap_fake') } catch {}
wp('transient', 'delete', '--all')
wp('option', 'update', 'p2flux_ap_settings', JSON.stringify({ wallet: process.env.SELLER_WALLET, environment: 'test', default_price: '0.05', paid_post_types: ['post'], paid_categories: [], paid_routes: [], api_down: 'refuse', prepaid: 'yes', directory: 'yes' }), '--format=json')
const posts = [0, 1, 2, 3].map((i) => {
  const id = wp('post', 'create', '--post_type=post', `--post_title=MCP ${i}`, `--post_content=MCP-SECRET-${i}`, '--post_status=publish', '--porcelain')
  return { id, url: wp('post', 'url', id) }
})

const connect = async (env) => {
  const client = new Client({ name: 'live-test', version: '1' })
  await client.connect(new StdioClientTransport({ command: 'node', args: ['dist/index.js'], env: { PATH: process.env.PATH, HOME: process.env.HOME, P2FLUX_MCP_DIR: dir, P2FLUX_NETWORK: 'test', ...env } }))
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args })
    return { error: !!r.isError, text: r.content.map((c) => c.text).join('\n') }
  }
  return { client, call }
}
const results = []
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + String(detail).replace(/\s+/g, ' ').slice(0, 170) : ''}`) }

// --- pay per page --------------------------------------------------------------------------------
let s = await connect({ P2FLUX_MAX_PREPAID: '0', P2FLUX_MAX_PER_DAY: '2' })
const listed = (await s.client.listTools()).tools.map((t) => t.name).sort()
check('1  the server lists its eight tools', listed.join() === 'check_price,export_wallet_key,find_paid_content,read_paid,spending_report,wallet_balance,wallet_setup,withdraw_prepaid', listed.join())
const setup = await s.call('wallet_setup')
const address = /Address: (0x[0-9a-fA-F]{40})/.exec(setup.text)?.[1]
check('2  wallet_setup creates a wallet and explains funding; the key is not shown', !!address && /faucet/.test(setup.text) && !/0x[0-9a-fA-F]{64}/.test(setup.text), address)
const unfunded = await s.call('read_paid', { url: posts[0].url })
check('3  an empty wallet cannot pay, and says so', unfunded.error && !unfunded.text.includes('MCP-SECRET'), unfunded.text)

const funder = createWalletClient({ account: privateKeyToAccount(process.env.P2FLUX_E2E_WALLET_PRIVATE_KEY), chain: baseSepolia, transport: http('https://sepolia.base.org') })
await chain.waitForTransactionReceipt({ hash: await funder.writeContract({ address: USDC, abi: parseAbi(['function transfer(address,uint256) returns (bool)']), functionName: 'transfer', args: [address, 1_300_000n] }) })
await new Promise((r) => setTimeout(r, 4000))
check('4  wallet_balance shows the money', /1\.30 USDC/.test((await s.call('wallet_balance')).text))

const price = await s.call('check_price', { url: posts[0].url })
check('5  check_price reads the price, pays nothing', /costs 0\.05 USDC/.test(price.text), price.text)
const tooDear = await s.call('read_paid', { url: posts[0].url, max_price: '0.01' })
check('6  read_paid refuses above max_price', tooDear.error && /above the maximum/.test(tooDear.text) && !tooDear.text.includes('MCP-SECRET'), tooDear.text)
const read = await s.call('read_paid', { url: posts[0].url, max_price: '0.10' })
check('7  read_paid pays 0.05 per page and returns the text', !read.error && read.text.includes('MCP-SECRET-0') && /Paid 0\.05 USDC \(per page\)/.test(read.text) && /basescan\.org\/tx\/0x/.test(read.text), read.text)
await s.client.close()

// --- prepaid ---------------------------------------------------------------------------------------
s = await connect({ P2FLUX_MAX_PREPAID: '1', P2FLUX_MAX_PER_DAY: '2' })
const p1 = await s.call('read_paid', { url: posts[1].url })
check('8  prepaid: the first page deposits 1 USDC and is paid from it', !p1.error && p1.text.includes('MCP-SECRET-1') && /prepaid balance/.test(p1.text) && /1\.00 USDC was put into the prepaid balance/.test(p1.text), p1.text)
const p2 = await s.call('read_paid', { url: posts[2].url })
check('9  prepaid: the next page needs no deposit', !p2.error && p2.text.includes('MCP-SECRET-2') && /prepaid balance/.test(p2.text) && !/was put into/.test(p2.text), p2.text)
await s.client.close()

// --- the daily limit, across restarts ---------------------------------------------------------------
s = await connect({ P2FLUX_MAX_PREPAID: '0', P2FLUX_MAX_PER_DAY: '1.07' })
const over = await s.call('read_paid', { url: posts[3].url })
check('10 the daily limit holds across restarts: 1.05 spent, 0.05 more would pass 1.07', over.error && /daily limit/.test(over.text) && !over.text.includes('MCP-SECRET'), over.text)
const report = await s.call('spending_report')
check('11 spending_report lists the payment, the deposit and the prepaid pages', /Total that left the wallet: 1\.05 USDC/.test(report.text) && /prepaid deposit/.test(report.text) && /from prepaid balance/.test(report.text), report.text)
const found = await s.call('find_paid_content', { query: '' })
check('12 find_paid_content asks the directory', !found.error, found.text)
const back = await s.call('withdraw_prepaid', { url: posts[1].url })
await new Promise((r) => setTimeout(r, 4000))
const after = await s.call('wallet_balance')
check('13 withdraw_prepaid returns the unused 0.90 to the wallet, and no content', !back.error && !back.text.includes('MCP-SECRET') && /basescan\.org\/tx\/0x/.test(back.text) && /1\.15 USDC/.test(after.text), back.text + ' | ' + after.text)
const twice = await s.call('withdraw_prepaid', { url: posts[1].url })
check('14 nothing left to take back: a clear refusal', twice.error && !twice.text.includes('MCP-SECRET'), twice.text)
await s.client.close()

for (const p of posts) wp('post', 'delete', p.id, '--force')
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
