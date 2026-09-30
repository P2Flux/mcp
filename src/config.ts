import { homedir } from 'node:os'
import { join } from 'node:path'
import { base, baseSepolia } from 'viem/chains'

/** USDC, 6 decimals. Money is integer units everywhere; decimals only at the edges. */
export const UNITS = 1_000_000n
export const toUnits = (usd: string): bigint | null => {
  const m = /^(\d{1,6})(?:\.(\d{1,6}))?$/.exec(usd.trim())
  return m ? BigInt(m[1]!) * UNITS + BigInt((m[2] ?? '').padEnd(6, '0')) : null
}
export const fromUnits = (units: bigint): string => {
  const frac = (units % UNITS).toString().padStart(6, '0').replace(/0+$/, '')
  return `${units / UNITS}.${frac.padEnd(2, '0')}`
}

const NETWORKS = {
  test: { chain: baseSepolia, caip: 'eip155:84532', usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', api: 'https://api-test.p2flux.com', explorer: 'https://sepolia.basescan.org', label: 'Base Sepolia (test money)' },
  live: { chain: base, caip: 'eip155:8453', usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', api: 'https://api.p2flux.com', explorer: 'https://basescan.org', label: 'Base (real USDC)' },
} as const

export type Config = ReturnType<typeof loadConfig>

/** An override of where the wallet talks to: https, or plain http to this machine only. Anything else is an error, never ignored. */
function endpoint(name: string, raw: string | undefined): string | null {
  const value = (raw ?? '').trim().replace(/\/$/, '')
  if (!value) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${name} is not an address: "${value}"`)
  }
  const local = url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
  if ((url.protocol !== 'https:' && !local) || url.username || url.password) throw new Error(`${name} must be an https address (or http://localhost): "${value}"`)
  return value
}

/**
 * Everything comes from the environment (the desktop extension fills it from its settings form).
 * A limit that cannot be read is an error, never "no limit".
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const limit = (name: string, fallback: string, max: string) => {
    const raw = (env[name] ?? '').trim() || fallback
    const units = toUnits(raw)
    if (units === null || units <= 0n || units > toUnits(max)!) throw new Error(`${name} must be an amount in USDC between 0.01 and ${max} (got "${raw}")`)
    return units
  }
  const network = (env.P2FLUX_NETWORK ?? 'test').trim() === 'live' ? NETWORKS.live : NETWORKS.test
  const perPayment = limit('P2FLUX_MAX_PER_PAYMENT', '0.50', '100')
  const perDay = limit('P2FLUX_MAX_PER_DAY', '5', '1000')
  return {
    network,
    dir: (env.P2FLUX_MCP_DIR ?? '').trim() || join(homedir(), '.p2flux-mcp'),
    perPayment,
    perDay,
    /** The most one prepaid deposit may be. 0 switches prepaid off: every page is paid on its own. */
    maxPrepaid: (env.P2FLUX_MAX_PREPAID ?? '').trim() === '0' ? 0n : limit('P2FLUX_MAX_PREPAID', '1', '100'),
    rpcUrl: endpoint('P2FLUX_RPC_URL', env.P2FLUX_RPC_URL) ?? undefined,
    apiUrl: endpoint('P2FLUX_API_URL', env.P2FLUX_API_URL) ?? network.api,
  }
}
