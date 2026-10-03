import { env } from "../env.ts";
import { programAddress, rpcSubscriptions } from "../solana/chain.ts";
import { loadIdl } from "../solana/idl.ts";
import { pollOnce, processLogs } from "./sync.ts";

/** Resubscribe if the socket has been silent this long: devnet WS connections can die without a close frame. */
const IDLE_RESUBSCRIBE_MS = 3 * 60_000;

/** Websocket indexer (logsSubscribe on the program) + periodic reconciliation poller. */
export function startIndexer(log: { info: (m: string) => void; warn: (m: string) => void }) {
	const stop = new AbortController();
	if (!env.indexerEnabled) return () => stop.abort();

	const catchUp = () => pollOnce().catch((err) => log.warn(`[poller] ${(err as Error).message}`));

	const run = async () => {
		let backoff = 1000;
		let connectedOnce = false;
		while (!stop.signal.aborted) {
			const sub = new AbortController();
			const onStop = () => sub.abort();
			stop.signal.addEventListener("abort", onStop);
			let lastActivity = Date.now();
			const watchdog = setInterval(() => {
				if (Date.now() - lastActivity > IDLE_RESUBSCRIBE_MS) sub.abort();
			}, 30_000);
			try {
				if (!loadIdl()) throw new Error("IDL not available yet");
				const program = programAddress();
				const notifications = await rpcSubscriptions
					.logsNotifications({ mentions: [program] }, { commitment: "confirmed" })
					.subscribe({ abortSignal: sub.signal });
				log.info(`[indexer] subscribed to logs of ${program} via ${env.wsUrl}`);
				// Anything that happened while we were disconnected.
				if (connectedOnce) void catchUp();
				connectedOnce = true;
				backoff = 1000;
				for await (const n of notifications) {
					lastActivity = Date.now();
					if (n.value.err) continue;
					await processLogs(n.value.signature, n.value.logs).catch((err) =>
						log.warn(`[indexer] ${n.value.signature}: ${(err as Error).message}`),
					);
				}
				if (!stop.signal.aborted) log.warn("[indexer] subscription ended; reconnecting");
			} catch (err) {
				if (stop.signal.aborted) return;
				if (sub.signal.aborted) log.info("[indexer] idle for too long; resubscribing");
				else log.warn(`[indexer] ${(err as Error).message}; retrying in ${backoff / 1000}s`);
			} finally {
				clearInterval(watchdog);
				stop.signal.removeEventListener("abort", onStop);
				sub.abort();
			}
			await new Promise((r) => setTimeout(r, backoff));
			backoff = Math.min(backoff * 2, 30_000);
		}
	};
	void run();

	const timer = setInterval(catchUp, env.pollIntervalMs);

	return () => {
		stop.abort();
		clearInterval(timer);
	};
}
