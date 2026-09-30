import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
/**
 * The remote server fetches addresses that strangers give it. So: https only, the host is resolved
 * once, EVERY address it has must be public, the connection is pinned to the address that was
 * checked (no DNS rebinding), redirects are not followed, and the answer is capped.
 */
const PRIVATE_V4 = [/^0\./, /^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^192\.0\.0\./, /^198\.1[89]\./, /^(22[4-9]|2[3-5]\d)\./];
export const isPublicAddress = (address) => {
    const v = isIP(address);
    if (v === 4)
        return !PRIVATE_V4.some((r) => r.test(address));
    if (v === 6) {
        const a = address.toLowerCase();
        if (a.startsWith('::ffff:'))
            return isPublicAddress(a.slice(7));
        return !(a === '::' || a === '::1' || /^f[cd]/.test(a) || /^fe[89ab]/.test(a) || a.startsWith('ff') || a.startsWith('64:ff9b:'));
    }
    return false;
};
const resolve = async (host) => (await lookup(host, { all: true })).map((a) => a.address);
const MAX_BODY = 2 * 1024 * 1024;
/** GET one public address. `allowLocal` (test money only) also lets http://localhost through. */
export async function publicFetch(input, headers, allowLocal = false, resolver = resolve) {
    let url;
    try {
        url = new URL(input);
    }
    catch {
        throw new Error(`"${input.slice(0, 200)}" is not a web address`);
    }
    const local = allowLocal && url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
    if (url.protocol !== 'https:' && !local)
        throw new Error('only https addresses can be read');
    if (url.username || url.password)
        throw new Error('addresses with a user name or password are not read');
    if (!local && url.port && url.port !== '443')
        throw new Error('only the standard https port is read');
    const addresses = local ? ['127.0.0.1'] : await resolver(url.hostname).catch(() => []);
    if (!addresses.length || (!local && !addresses.every(isPublicAddress)))
        throw new Error('that address is not a public website');
    const address = addresses[0];
    return new Promise((done, fail) => {
        const req = (local ? httpRequest : httpsRequest)({
            host: url.hostname, servername: url.hostname, port: url.port || (local ? 80 : 443), path: url.pathname + url.search, method: 'GET', timeout: 15_000, headers,
            lookup: (_h, o, cb) => {
                const family = isIP(address);
                // Node asks for all addresses when it picks a family itself.
                if (o.all)
                    cb(null, [{ address, family }]);
                else
                    cb(null, address, family);
            },
        }, (res) => {
            const chunks = [];
            let size = 0;
            res.on('data', (c) => {
                size += c.length;
                if (size > MAX_BODY)
                    req.destroy(new Error('the page is too large'));
                else
                    chunks.push(c);
            });
            res.on('end', () => {
                const out = {};
                for (const [k, v] of Object.entries(res.headers))
                    if (typeof v === 'string')
                        out[k] = v;
                done({ status: res.statusCode ?? 0, headers: out, body: Buffer.concat(chunks).toString('utf8') });
            });
            res.on('error', fail);
        });
        req.on('timeout', () => req.destroy(new Error('the site did not answer in time')));
        req.on('error', (e) => fail(new Error(`the site could not be read: ${e.message}`)));
        req.end();
    });
}
