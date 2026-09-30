import { randomBytes } from 'node:crypto';
import { fromUnits, toUnits } from '../config.js';
import { MAX_TEXT, offersFrom, toText } from '../pay.js';
/**
 * Paying from an assistant that runs on someone else's computer (ChatGPT, claude.ai): there is no
 * place for a wallet there, and P2Flux must never hold one. So the assistant only ASKS; the person
 * approves each payment in their own browser wallet, on a page that shows the amount and the seller.
 *
 *   request(url)   - reads the page's price, checks the seller is paid through P2Flux, opens a request
 *   approve(id, …) - the person's signature for exactly that amount to exactly that seller; the page is
 *                    fetched with it at once, so the signature cannot expire or be used for anything else
 *   result(id)     - the page text, for the assistant that asked
 *
 * What this server holds: a signature that can move one amount to one seller, for seconds. No keys,
 * no balances.
 */
const USER_AGENT = 'P2Flux-MCP/0.2 (remote; +https://p2flux.com)';
const TTL_MS = 15 * 60_000;
const MAX_OPEN = 1_000;
/** Open requests one caller (one network address) may hold: a flood from one place cannot push out everyone else's. */
const MAX_OPEN_PER_OWNER = 20;
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
export function createRemote(deps) {
    const now = deps.now ?? Date.now;
    const api = deps.api ?? fetch;
    const open = new Map();
    const config = { network: deps.network };
    const sweep = () => {
        for (const [id, p] of open)
            if (now() - p.created > TTL_MS)
                open.delete(id);
        while (open.size >= MAX_OPEN)
            open.delete(open.keys().next().value);
    };
    const get = (id) => {
        const p = /^[0-9a-f]{32}$/.test(id) ? open.get(id) : undefined;
        if (!p || now() - p.created > TTL_MS)
            throw new Error('this payment request does not exist or has expired; ask for the page again');
        return p;
    };
    /** What a page costs and whom it pays. Throws unless it is a P2Flux seller asking USDC on this network within the cap. */
    async function offerOf(url, maxPrice) {
        const res = await deps.fetchPage(url, { 'user-agent': USER_AGENT, accept: 'text/html,application/json;q=0.9,*/*;q=0.5' });
        if (res.status >= 200 && res.status < 300)
            return { free: true };
        if (res.status !== 402)
            throw new Error(`the site answered HTTP ${res.status}`);
        const header = res.headers['payment-required'] ?? null;
        const exact = offersFrom(config, header).find((o) => o.scheme === 'exact');
        if (!exact || !header)
            throw new Error(`this page asks for payment, but not in USDC on ${deps.network.label} - it cannot be paid here`);
        const doc = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
        const requirement = doc.accepts.find((a) => a?.scheme === 'exact' && a.network === deps.network.caip && same(a.asset, deps.network.usdc) && a.amount === exact.units.toString());
        if (!requirement || !ADDRESS.test(String(requirement.payTo)) || typeof requirement.extra?.name !== 'string' || typeof requirement.extra?.version !== 'string')
            throw new Error('this page asks for payment in a form that cannot be shown to you safely');
        if (exact.units > deps.maxPrice)
            throw new Error(`this page costs ${fromUnits(exact.units)} USDC, above the ${fromUnits(deps.maxPrice)} USDC this service pays at most. Nothing was paid.`);
        if (maxPrice !== null && exact.units > maxPrice)
            throw new Error(`this page costs ${fromUnits(exact.units)} USDC, above the maximum of ${fromUnits(maxPrice)} given for it. Nothing was paid.`);
        // Only sellers paid through P2Flux: payTo must be the P2Flux address of the wallet the site names.
        const recipient = requirement.extra?.p2flux?.recipient;
        if (typeof recipient !== 'string' || !ADDRESS.test(recipient))
            throw new Error('this site is not paid through P2Flux; it cannot be paid here');
        const vault = await api(`${deps.apiUrl}/x402/vault`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ recipient }) });
        const named = vault.ok ? (await vault.json()).pay_to : null;
        if (!same(named, requirement.payTo))
            throw new Error('this site is not paid through P2Flux; it cannot be paid here');
        return { free: false, units: exact.units, requirement, resource: doc.resource ?? { url } };
    }
    return {
        async price(url) {
            const o = await offerOf(url, null);
            return o.free ? 'This page is free to read.' : `This page costs ${fromUnits(o.units)} USDC.`;
        },
        /** Open a payment request for the person to approve. */
        async request(url, maxPrice, owner = '') {
            const max = maxPrice === undefined || maxPrice === '' ? null : toUnits(maxPrice);
            if (maxPrice && max === null)
                throw new Error(`max_price "${maxPrice}" is not an amount like 0.10`);
            const o = await offerOf(url, max);
            if (o.free)
                return { free: true };
            sweep();
            let mine = 0;
            for (const p of open.values())
                if (p.owner === owner && p.state === 'waiting')
                    mine++;
            if (mine >= MAX_OPEN_PER_OWNER)
                throw new Error('too many payment requests are waiting for approval; approve or let some expire (15 minutes) first');
            const id = randomBytes(16).toString('hex');
            open.set(id, { id, url, units: o.units, requirement: o.requirement, resource: o.resource, state: 'waiting', created: now(), owner });
            return { free: false, id, link: `${deps.publicUrl}/approve/${id}`, price: fromUnits(o.units) };
        },
        /** What the approval page shows and asks the wallet to sign. Nothing here is secret. */
        data(id) {
            const p = get(id);
            return {
                state: p.state === 'paying' ? 'waiting' : p.state,
                url: p.url,
                price: fromUnits(p.units),
                units: p.units.toString(),
                payTo: p.requirement.payTo,
                asset: p.requirement.asset,
                chainId: deps.network.chain.id,
                networkLabel: deps.network.label,
                tokenName: p.requirement.extra.name,
                tokenVersion: p.requirement.extra.version,
                timeout: Math.min(Math.max(Number(p.requirement.maxTimeoutSeconds) || 300, 60), 600),
            };
        },
        /** The person's signature. It must authorize exactly what was shown; then the page is paid and fetched at once. */
        async approve(id, input) {
            const p = get(id);
            if (p.state !== 'waiting')
                throw new Error(p.state === 'paid' ? 'this page is already paid' : p.state === 'paying' ? 'this payment is being made; wait for it' : 'this request is closed');
            const a = input.authorization ?? {};
            const signature = input.signature;
            const seconds = Math.floor(now() / 1000);
            const until = Number(a.validBefore);
            if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130,4096}$/.test(signature) ||
                typeof a.from !== 'string' || !ADDRESS.test(a.from) ||
                !same(a.to, p.requirement.payTo) || a.value !== p.units.toString() || a.validAfter !== '0' ||
                typeof a.validBefore !== 'string' || !/^\d{1,12}$/.test(a.validBefore) || until <= seconds || until > seconds + 660 ||
                typeof a.nonce !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(a.nonce))
                throw new Error('the signature is not for the payment that was shown');
            const authorization = a;
            // Taken before anything is awaited: a second approval arriving meanwhile finds it closed.
            p.state = 'paying';
            if (!(await deps.verifySignature(p, authorization, signature).catch(() => false))) {
                p.state = 'waiting';
                throw new Error('the signature is not valid for this wallet');
            }
            const payment = Buffer.from(JSON.stringify({ x402Version: 2, accepted: p.requirement, payload: { signature, authorization }, resource: p.resource })).toString('base64');
            let res;
            try {
                res = await deps.fetchPage(p.url, { 'user-agent': USER_AGENT, accept: 'text/html,application/json;q=0.9,*/*;q=0.5', 'payment-signature': payment });
            }
            catch (err) {
                // Whether the site took the payment is not known: closed, not retried with the same signature.
                p.state = 'failed';
                p.error = `the site did not answer after the payment was sent: ${err.message}`;
                throw new Error(p.error);
            }
            try {
                const t = JSON.parse(Buffer.from(res.headers['payment-response'] ?? '', 'base64').toString('utf8')).transaction;
                if (typeof t === 'string' && /^0x[0-9a-fA-F]{64}$/.test(t))
                    p.transaction = t;
            }
            catch {
                /* no receipt */
            }
            if (res.status === 402) {
                // Refused before any money moved: the person may try again (another wallet, more USDC).
                p.state = 'waiting';
                let reason = '';
                try {
                    reason = String(JSON.parse(Buffer.from(res.headers['payment-required'] ?? '', 'base64').toString('utf8')).error ?? '').slice(0, 120);
                }
                catch {
                    /* no reason given */
                }
                throw new Error(`the payment was refused${reason ? ` (${reason.replace(/[^a-z0-9_ -]/gi, '')})` : ''}. Is there enough USDC on ${deps.network.label} in this wallet? Nothing was paid.`);
            }
            if (res.status < 200 || res.status >= 300) {
                p.state = 'failed';
                p.error = `the site answered HTTP ${res.status} to the paid request`;
                throw new Error(p.error);
            }
            p.text = toText(res.body, res.headers['content-type'] ?? '').slice(0, MAX_TEXT);
            p.state = 'paid';
            return { paid: true, ...(p.transaction ? { transaction: p.transaction } : {}) };
        },
        /** For the assistant: the page, once the person has approved. */
        result(id) {
            const p = get(id);
            if (p.state === 'paid')
                return { state: 'paid', text: p.text ?? '', price: fromUnits(p.units), ...(p.transaction ? { transaction: p.transaction } : {}) };
            if (p.state === 'failed')
                return { state: 'failed', error: p.error ?? 'the payment failed' };
            return { state: 'waiting', link: `${deps.publicUrl}/approve/${p.id}`, price: fromUnits(p.units) };
        },
        size: () => open.size,
    };
}
