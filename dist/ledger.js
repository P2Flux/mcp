import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
const path = (config) => join(config.dir, 'spending.json');
export function entries(config) {
    if (!existsSync(path(config)))
        return [];
    const parsed = JSON.parse(readFileSync(path(config), 'utf8'));
    if (!Array.isArray(parsed))
        throw new Error('the spending log is damaged; refusing to pay until it is fixed or removed');
    return parsed;
}
function save(config, list) {
    mkdirSync(config.dir, { recursive: true, mode: 0o700 });
    const tmp = `${path(config)}.tmp`;
    writeFileSync(tmp, JSON.stringify(list.slice(-5000)), { mode: 0o600 });
    renameSync(tmp, path(config));
}
const DAY_MS = 86_400_000;
/** Money that left the wallet in the last 24 hours: payments and prepaid deposits, not vouchers (those spend a deposit already counted). */
export const spentToday = (list, now = Date.now()) => list.filter((e) => now - e.at < DAY_MS && e.kind !== 'voucher' && e.kind !== 'refund').reduce((sum, e) => sum + BigInt(e.units), 0n);
/** Why `units` may not leave the wallet now, or null. */
export function refusal(config, units, list, now = Date.now()) {
    if (units > config.perPayment && units > config.maxPrepaid)
        return 'above the limit per payment';
    if (spentToday(list, now) + units > config.perDay)
        return 'above the daily limit';
    return null;
}
/** Reserve before paying; returns a function that replaces the reservation with what happened. */
export function reserve(config, url, units, now = Date.now()) {
    const list = entries(config);
    const reservation = { at: now, url, units: units.toString(), kind: 'reserved', id: randomUUID() };
    save(config, [...list, reservation]);
    return (outcome) => {
        const current = entries(config).filter((e) => !(e.kind === 'reserved' && e.id === reservation.id));
        save(config, [...current, ...outcome]);
    };
}
