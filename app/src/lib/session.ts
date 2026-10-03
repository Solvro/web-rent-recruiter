/**
 * Sign-In-With-Solana sessions (backend auth.nonce / auth.verify). The wallet layer registers how to sign a
 * message for the current account; the tRPC links ask for a token right before each request. Signing happens
 * once per account per 8 hours, without any prompt (embedded key or demo keypair).
 */
import type { AppRouter } from "@scout/backend/router";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import { trackingFetch } from "./connection";
import { API_MOCK, TRPC_URL } from "./env";

type Signer = { wallet: string; signMessage: (message: Uint8Array) => Promise<Uint8Array> };
type Session = { token: string; expiresAt: number };

const KEY = "scout.sessions.v1";
/** Renew a little before the server's expiry so a request never lands on a dead token. */
const MARGIN_MS = 60_000;

let signer: Signer | null = null;
const inflight = new Map<string, Promise<string>>();

function read(): Record<string, Session> {
	try {
		return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, Session>;
	} catch {
		return {};
	}
}
function write(all: Record<string, Session>) {
	try {
		localStorage.setItem(KEY, JSON.stringify(all));
	} catch {
		// Private mode: the session lives in memory for this page only.
	}
}
const memory: Record<string, Session> = {};

/** Called by the wallet provider whenever the active account (or its signer) changes. */
export function setSessionSigner(next: Signer | null) {
	signer = next;
}

/** Raw client for the auth procedures themselves: no session header, no retries. */
const authClient = createTRPCClient<AppRouter>({
	links: [httpBatchLink({ url: TRPC_URL, transformer: superjson, fetch: trackingFetch })],
});

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

async function signIn(s: Signer): Promise<string> {
	const { message } = await authClient.auth.nonce.mutate({ wallet: s.wallet });
	const signature = await s.signMessage(new TextEncoder().encode(message));
	const session = await authClient.auth.verify.mutate({
		wallet: s.wallet,
		message,
		signature: toBase64(signature),
	});
	const entry = { token: session.token, expiresAt: Date.parse(session.expiresAt) };
	memory[s.wallet] = entry;
	write({ ...read(), [s.wallet]: entry });
	return entry.token;
}

/** A valid token for the current account, signing in if needed. null when logged out (public calls). */
export async function sessionToken(): Promise<string | null> {
	if (API_MOCK || !signer) return null;
	const s = signer;
	const cached = memory[s.wallet] ?? read()[s.wallet];
	if (cached && cached.expiresAt - MARGIN_MS > Date.now()) return cached.token;
	let pending = inflight.get(s.wallet);
	if (!pending) {
		pending = signIn(s).finally(() => inflight.delete(s.wallet));
		inflight.set(s.wallet, pending);
	}
	return pending;
}

/** The server said the token is no longer valid (revoked or expired early): forget it so the next call renews. */
export function dropSession(wallet = signer?.wallet) {
	if (!wallet) return;
	delete memory[wallet];
	const all = read();
	delete all[wallet];
	write(all);
}

export const currentSessionWallet = () => signer?.wallet ?? null;
