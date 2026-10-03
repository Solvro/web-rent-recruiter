import { EventEmitter } from "node:events";

import type { LiveEvent } from "@scout/shared";

export type { LiveEvent };

const bus = new EventEmitter();
bus.setMaxListeners(0);

/**
 * The same chain event can be applied twice (right after /tx.submit, then again by the indexer). Events carrying
 * a signature are emitted once per (signature, type, subject).
 */
const seen = new Set<string>();
export function publish(e: LiveEvent) {
	if (e.signature) {
		const key = `${e.signature}:${e.type}:${e.submissionId ?? e.roleId ?? ""}`;
		if (seen.has(key)) return;
		seen.add(key);
		if (seen.size > 5000) seen.delete(seen.values().next().value as string);
	}
	bus.emit("event", e);
}
export function subscribe(fn: (e: LiveEvent) => void) {
	bus.on("event", fn);
	return () => bus.off("event", fn);
}

/** Async iterator over live events, ended by `signal` (used by the tRPC `events` subscription). */
export async function* eventStream(signal: AbortSignal | undefined): AsyncGenerator<LiveEvent> {
	const queue: LiveEvent[] = [];
	let wake: (() => void) | null = null;
	const unsubscribe = subscribe((e) => {
		queue.push(e);
		wake?.();
	});
	const onAbort = () => wake?.();
	signal?.addEventListener("abort", onAbort);
	try {
		while (!signal?.aborted) {
			const next = queue.shift();
			if (next) {
				yield next;
				continue;
			}
			await new Promise<void>((resolve) => {
				wake = resolve;
			});
			wake = null;
		}
	} finally {
		unsubscribe();
		signal?.removeEventListener("abort", onAbort);
	}
}
