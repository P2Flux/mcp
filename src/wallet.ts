import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createPublicClient, http, parseAbi, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import type { Config } from './config.js'

/**
 * The wallet: one private key in one file on this computer, readable only by this user. It is never
 * sent anywhere, never logged, and returned by exactly one tool, on explicit request.
 */
const keyPath = (config: Config) => join(config.dir, 'wallet.key')

export const walletExists = (config: Config) => existsSync(keyPath(config))

function readKey(config: Config): Hex {
  const path = keyPath(config)
  // A key other users of this machine can read is not a private key.
  if (process.platform !== 'win32' && (statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600)
  const key = readFileSync(path, 'utf8').trim()
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`the wallet file ${path} is damaged`)
  return key as Hex
}

/** The account, created on first use. */
export function account(config: Config, create = false) {
  if (!walletExists(config)) {
    if (!create) throw new Error('No wallet yet. Run the wallet_setup tool first.')
    mkdirSync(config.dir, { recursive: true, mode: 0o700 })
    // wx: never overwrite a key that appeared meanwhile.
    writeFileSync(keyPath(config), generatePrivateKey(), { mode: 0o600, flag: 'wx' })
  }
  return privateKeyToAccount(readKey(config))
}

export const exportKey = (config: Config): Hex => readKey(config)

export const chainClient = (config: Config) => createPublicClient({ chain: config.network.chain, transport: http(config.rpcUrl) })

export async function usdcBalance(config: Config, address: Hex): Promise<bigint> {
  return chainClient(config).readContract({
    address: config.network.usdc,
    abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
    functionName: 'balanceOf',
    args: [address],
  })
}
