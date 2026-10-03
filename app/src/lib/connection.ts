/**
 * Backend reachability. A restart or a proxy hiccup (502/503/504, network error) is not an error page: the app
 * shows a quiet "Reconnecting…" and keeps retrying with backoff until the server answers again.
 */
import { TRPCClientError } from "@trpc/client";
import { useSyncExternalStore } from "react";

const TRANSIENT_STATUS = new Set([502, 503, 504]);
let offline = false;
const listeners = new Set<() => void>();

export function setOffline(next: boolean) {
	if (next === offline) return;
	offline = next;
	for (const l of listeners) l();
}

export function useOffline() {
	return useSyncExternalStore(
		(cb) => {
			listeners.add(cb);
			return () => listeners.delete(cb);
		},
		() => offline,
	);
}

/** Worth retrying: the server is restarting or unreachable, not a real answer. */
export function isTransient(e: unknown): boolean {
	// The last request saw a gateway error or no answer: whatever failed now is part of the same outage.
	if (offline) return true;
	if (e instanceof TypeError) return true;
	if (!(e instanceof TRPCClientError)) return false;
	const status =
		(e.data as { httpStatus?: number } | undefined)?.httpStatus ??
		(e.meta as { response?: { status?: number } } | undefined)?.response?.status;
	if (status && TRANSIENT_STATUS.has(status)) return true;
	if (
		!e.data &&
		(e.cause instanceof TypeError ||
			/fetch|network|load failed|transform response|unexpected token|json/i.test(e.message))
	)
		return true;
	return false;
}

/** fetch for the tRPC links: notes whether the server answered. */
export const trackingFetch: typeof fetch = async (input, init) => {
	try {
		const res = await fetch(input, init);
		setOffline(TRANSIENT_STATUS.has(res.status));
		return res;
	} catch (e) {
		if (!init?.signal?.aborted) setOffline(true);
		throw e;
	}
};

/** 1 s, 2 s, 4 s … capped at 15 s. */
export const backoff = (attempt: number) => Math.min(15_000, 1_000 * 2 ** Math.max(0, attempt - 1));
