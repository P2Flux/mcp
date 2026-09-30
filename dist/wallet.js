import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPublicClient, http, parseAbi } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
/**
 * The wallet: one private key in one file on this computer, readable only by this user. It is never
 * sent anywhere, never logged, and returned by exactly one tool, on explicit request.
 */
const keyPath = (config) => join(config.dir, 'wallet.key');
export const walletExists = (config) => existsSync(keyPath(config));
function readKey(config) {
    const path = keyPath(config);
    // A key other users of this machine can read is not a private key.
    if (process.platform !== 'win32' && (statSync(path).mode & 0o077) !== 0)
        chmodSync(path, 0o600);
    // The folder too: it holds the channel records and the spending log next to the key.
    if (process.platform !== 'win32' && (statSync(config.dir).mode & 0o077) !== 0)
        chmodSync(config.dir, 0o700);
    const key = readFileSync(path, 'utf8').trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(key))
        throw new Error(`the wallet file ${path} is damaged`);
    return key;
}
/** The account, created on first use. */
export function account(config, create = false) {
    if (!walletExists(config)) {
        if (!create)
            throw new Error('No wallet yet. Run the wallet_setup tool first.');
        mkdirSync(config.dir, { recursive: true, mode: 0o700 });
        // wx: never overwrite a key that appeared meanwhile.
        writeFileSync(keyPath(config), generatePrivateKey(), { mode: 0o600, flag: 'wx' });
    }
    return privateKeyToAccount(readKey(config));
}
export const exportKey = (config) => readKey(config);
export const chainClient = (config) => createPublicClient({ chain: config.network.chain, transport: http(config.rpcUrl) });
export async function usdcBalance(config, address) {
    return chainClient(config).readContract({
        address: config.network.usdc,
        abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
        functionName: 'balanceOf',
        args: [address],
    });
}
