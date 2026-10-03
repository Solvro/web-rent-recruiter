/**
 * Which devices (IP + user agent) each signed-in wallet used recently. A cheap guard against a recruiter
 * answering their own candidate-confirmation link: a "yes" from the link holder's device isn't paid
 * automatically (the company decides). In memory, 24 h: a restart forgets it (see docs/security.md).
 */
const SEEN = new Map<string, Map<string, number>>();
const DAY = 24 * 3600 * 1000;
const key = (ip: string | null | undefined, ua: string | null | undefined) =>
	`${ip ?? "?"}|${(ua ?? "").slice(0, 200)}`;

export function noteDevice(wallet: string, ip: string | null | undefined, ua: string | null | undefined) {
	let m = SEEN.get(wallet);
	if (!m) {
		m = new Map();
		SEEN.set(wallet, m);
	}
	m.set(key(ip, ua), Date.now());
	if (m.size > 50) for (const [k, t] of m) if (Date.now() - t > DAY) m.delete(k);
}

/** The device answering was used by one of these wallets in the last 24 h. */
export function usedBy(wallets: string[], ip: string | null | undefined, ua: string | null | undefined) {
	const k = key(ip, ua);
	return wallets.some((w) => {
		const t = SEEN.get(w)?.get(k);
		return t !== undefined && Date.now() - t < DAY;
	});
}

export function forgetDevices() {
	SEEN.clear();
}
