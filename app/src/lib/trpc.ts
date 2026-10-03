import type { AppRouter } from "@scout/backend/router";
import {
	createTRPCClient,
	createTRPCUntypedClient,
	httpBatchLink,
	httpSubscriptionLink,
	retryLink,
	splitLink,
	TRPCClientError,
	type TRPCLink,
} from "@trpc/client";
import { observable } from "@trpc/server/observable";
import { createTRPCContext } from "@trpc/tanstack-react-query";
import superjson from "superjson";
import { backoff, isTransient, setOffline, trackingFetch } from "./connection";
import { API_MOCK, TRPC_URL } from "./env";
import { mockLink } from "./mock/link";
import { dropSession, sessionToken } from "./session";

export type { AppRouter };
export const { TRPCProvider, useTRPC, useTRPCClient } = createTRPCContext<AppRouter>();

/** Identity of the logged-in account; set synchronously by the wallet layer so every request carries it. */
let currentWallet: string | null = null;
export function setCurrentWallet(wallet: string | null) {
	currentWallet = wallet;
}
export const getCurrentWallet = () => currentWallet;

const isUnauthorized = (e: unknown) => e instanceof TRPCClientError && e.data?.code === "UNAUTHORIZED";

/** A session the server no longer accepts: forget it, sign in again quietly, and retry the call once. */
const renewOnUnauthorized: TRPCLink<AppRouter> =
	() =>
	({ op, next }) =>
		observable((observer) => {
			let retried = false;
			let sub: { unsubscribe: () => void } | null = null;
			const attempt = () => {
				sub = next(op).subscribe({
					next: (v) => observer.next(v),
					complete: () => observer.complete(),
					error: (err) => {
						if (retried || !isUnauthorized(err) || !currentWallet) return observer.error(err);
						retried = true;
						dropSession();
						attempt();
					},
				});
			};
			attempt();
			return () => sub?.unsubscribe();
		});

/** Real backend: batched HTTP for queries/mutations, SSE for the live events subscription. Both carry the session. */
const httpLinks: TRPCLink<AppRouter>[] = [
	renewOnUnauthorized,
	splitLink({
		condition: (op) => op.type === "subscription",
		// The live stream reconnects by itself after a backend restart.
		true: [
			retryLink({
				retry: ({ error }) => {
					if (isTransient(error)) setOffline(true);
					return true;
				},
				retryDelayMs: backoff,
			}),
			httpSubscriptionLink({
				url: TRPC_URL,
				transformer: superjson,
				// EventSource can't send headers; the backend reads the token from connectionParams instead.
				connectionParams: async () => {
					const token = await sessionToken().catch(() => null);
					return token ? { token } : {};
				},
			}),
		],
		false: httpBatchLink({
			url: TRPC_URL,
			transformer: superjson,
			fetch: trackingFetch,
			headers: async (): Promise<Record<string, string>> => {
				const token = await sessionToken().catch(() => null);
				return token ? { Authorization: `Bearer ${token}` } : {};
			},
		}),
	}),
];

const links = (): TRPCLink<AppRouter>[] => (API_MOCK ? [mockLink(getCurrentWallet)] : httpLinks);

export function makeTRPCClient() {
	return createTRPCClient<AppRouter>({ links: links() });
}

/**
 * Same links, no router types: for procedures the backend is still building (gigs.*, roles.activity/shortlist/
 * decide/message). Responses are parsed with the shared zod schemas in lib/gigs/api.ts. Swap to the typed client
 * once they are in AppRouter.
 */
export const untypedClient = createTRPCUntypedClient<AppRouter>({ links: links() });

export type TRPCClient = ReturnType<typeof makeTRPCClient>;

/** Typed client for code outside React (lib/gigs/api.ts). */
export const typedClient = makeTRPCClient();
