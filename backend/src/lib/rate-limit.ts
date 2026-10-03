/** In-process sliding-window rate limits (single backend instance). */
import { HttpError } from "../http.ts";

const hits = new Map<string, number[]>();

/**
 * Throws 429 RATE_LIMITED when `key` exceeded `limit` hits within `windowMs`.
 * Used per wallet (relayer, deliveries) and per IP (sign-in).
 */
export function rateLimit(key: string, limit: number, windowMs: number, what = "requests") {
	const now = Date.now();
	const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
	if (list.length >= limit) {
		const retryIn = Math.ceil((windowMs - (now - (list[0] ?? now))) / 1000);
		throw new HttpError(429, "RATE_LIMITED", `Too many ${what}; try again in ${retryIn}s.`, {
			retryInSeconds: retryIn,
		});
	}
	list.push(now);
	hits.set(key, list);
	if (hits.size > 50_000) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
}

export const MINUTE = 60_000;
export const DAY = 24 * 3600_000;
