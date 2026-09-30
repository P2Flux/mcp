import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
/**
 * The remote server fetches addresses that strangers give it. So: https only, the host is resolved
 * once, EVERY address it has must be public, the connection is pinned to the address that was
 * checked (no DNS rebinding), redirects are not followed, and the answer is capped.
 */
/* Only globally routable unicast addresses. IPv6 forms that carry or reach an IPv4 address - mapped
 * (::ffff:0:0/96), compatible (::/96), NAT64 (64:ff9b::/96), 6to4 (2002::/16), Teredo (2001::/32) -
 * are refused outright: each is a way to write "127.0.0.1" that a check on the text would miss. */
const PRIVATE_V4 = [/^0\./, /^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^192\.0\.0\./, /^192\.0\.2\./, /^198\.1[89]\./, /^198\.51\.100\./, /^203\.0\.113\./, /^(22[4-9]|2[3-5]\d)\./];
/** The 8 groups of an IPv6 address, or null. Accepts `::` and a trailing dotted quad. */
function ipv6Groups(address) {
    let a = address.toLowerCase().split('%')[0];
    const quad = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
    if (quad) {
        const b = quad.slice(1).map(Number);
        if (b.some((x) => x > 255))
            return null;
        a = a.slice(0, quad.index) + ((b[0] << 8) | b[1]).toString(16) + ':' + ((b[2] << 8) | b[3]).toString(16);
    }
    const halves = a.split('::');
    if (halves.length > 2)
        return null;
    const head = halves[0] ? halves[0].split(':') : [];
    const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
    if (fill < 0 || (halves.length === 1 && head.length !== 8))
        return null;
    const groups = [...head, ...Array(fill).fill('0'), ...tail];
    if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g)))
        return null;
    return groups.map((g) => parseInt(g, 16));
}
export const isPublicAddress = (address) => {
    const v = isIP(address);
    if (v === 4)
        return !PRIVATE_V4.some((r) => r.test(address));
    if (v !== 6)
        return false;
    const g = ipv6Groups(address);
    if (!g)
        return false;
    if (g.slice(0, 6).every((x) => x === 0))
        return false; // ::, ::1, IPv4-compatible
    if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff)
        return false; // IPv4-mapped
    if (g[0] === 0x64 && g[1] === 0xff9b)
        return false; // NAT64
    if (g[0] === 0x2002)
        return false; // 6to4
    if (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0xdb8))
        return false; // Teredo, documentation
    if (g[0] === 0x3fff && g[1] < 0x1000)
        return false; // documentation (RFC 9637)
    if (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0)
        return false; // discard
    if ((g[0] & 0xfe00) === 0xfc00)
        return false; // unique local
    if ((g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0)
        return false; // link / site local
    if ((g[0] & 0xff00) === 0xff00)
        return false; // multicast
    return (g[0] & 0xe000) === 0x2000; // global unicast is 2000::/3; anything else is not on the internet
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
        // A site that sends one byte a second never trips an idle timeout: the whole answer has 20 s.
        const deadline = setTimeout(() => req.destroy(new Error('the site did not answer in time')), 20_000);
        req.on('close', () => clearTimeout(deadline));
        req.on('error', (e) => fail(new Error(`the site could not be read: ${e.message}`)));
        req.end();
    });
}
