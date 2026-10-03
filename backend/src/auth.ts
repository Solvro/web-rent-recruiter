/**
 * Sign-In-With-Solana. The only way the backend learns who the caller is:
 *   auth.nonce → the wallet signs the exact message → auth.verify → opaque session token (hashed in the DB).
 * Works the same for Privy embedded wallets (signMessage) and demo keypairs.
 */
import { createHash, randomBytes } from "node:crypto";
import { PROJECT_NAME } from "@scout/shared";
import {
	type Address,
	address,
	getBase58Encoder,
	getPublicKeyFromAddress,
	verifySignature,
} from "@solana/kit";
import { and, eq, gt, lt } from "drizzle-orm";
import { db, schema } from "./db/index.ts";
import { env } from "./env.ts";
import { HttpError } from "./http.ts";

const NONCE_TTL_MS = 5 * 60_000;
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_SECONDS ?? 8 * 3600) * 1000;
const hash = (token: string) => createHash("sha256").update(token).digest("hex");

/** Issued messages by nonce (single process; a lost nonce just means signing again). */
const pending = new Map<string, { wallet: string; message: string; expiresAt: number }>();

export function createNonce(wallet: string) {
	const nonce = randomBytes(16).toString("hex");
	const issuedAt = new Date();
	const expiresAt = new Date(issuedAt.getTime() + NONCE_TTL_MS);
	const message = [
		`${env.authDomain} wants you to sign in with your Solana account:`,
		wallet,
		"",
		`Sign in to ${PROJECT_NAME}. This does not send a transaction or cost anything.`,
		"",
		`URI: ${env.authUri}`,
		"Version: 1",
		`Chain ID: ${env.cluster}`,
		`Nonce: ${nonce}`,
		`Issued At: ${issuedAt.toISOString()}`,
		`Expiration Time: ${expiresAt.toISOString()}`,
	].join("\n");
	for (const [k, v] of pending) if (v.expiresAt < Date.now()) pending.delete(k);
	pending.set(nonce, { wallet, message, expiresAt: expiresAt.getTime() });
	return { message, expiresAt: expiresAt.toISOString() };
}

function decodeSignature(sig: string): Uint8Array {
	const b64 = Buffer.from(sig, "base64");
	if (b64.length === 64) return new Uint8Array(b64);
	try {
		const b58 = getBase58Encoder().encode(sig);
		if (b58.length === 64) return new Uint8Array(b58);
	} catch {
		// fall through
	}
	throw new HttpError(400, "BAD_SIGNATURE", "signature must be 64 bytes, base64 or base58");
}

export async function verifyLogin(input: { wallet: string; message: string; signature: string }) {
	const nonce = input.message.match(/^Nonce: ([0-9a-f]{32})$/m)?.[1];
	const issued = nonce ? pending.get(nonce) : undefined;
	if (!issued || issued.message !== input.message || issued.wallet !== input.wallet) {
		throw new HttpError(401, "BAD_LOGIN", "unknown or altered sign-in message; request a new one");
	}
	if (issued.expiresAt < Date.now()) throw new HttpError(401, "LOGIN_EXPIRED", "sign-in message expired");
	const key = await getPublicKeyFromAddress(address(input.wallet));
	const ok = await verifySignature(
		key,
		decodeSignature(input.signature) as Parameters<typeof verifySignature>[1],
		new TextEncoder().encode(input.message),
	);
	if (!ok) throw new HttpError(401, "BAD_SIGNATURE", "signature does not match the wallet");
	pending.delete(nonce as string); // one use only

	const token = randomBytes(32).toString("base64url");
	const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
	await db.insert(schema.sessions).values({ tokenHash: hash(token), wallet: input.wallet, expiresAt });
	await db.delete(schema.sessions).where(lt(schema.sessions.expiresAt, new Date()));
	return { token, wallet: input.wallet, expiresAt: expiresAt.toISOString() };
}

const cache = new Map<string, { wallet: Address | null; until: number }>();

/** Wallet behind a session token, or null. Cached for a few seconds. */
export async function walletFromToken(token: string | undefined | null): Promise<Address | null> {
	if (!token) return null;
	const key = hash(token);
	const hit = cache.get(key);
	if (hit && hit.until > Date.now()) return hit.wallet;
	const [row] = await db
		.select()
		.from(schema.sessions)
		.where(and(eq(schema.sessions.tokenHash, key), gt(schema.sessions.expiresAt, new Date())));
	const wallet = row ? address(row.wallet) : null;
	cache.set(key, { wallet, until: Date.now() + 10_000 });
	return wallet;
}

export async function logout(token: string) {
	const key = hash(token);
	cache.delete(key);
	await db.delete(schema.sessions).where(eq(schema.sessions.tokenHash, key));
}

/** "Bearer <token>" → token. */
export const bearer = (header: string | string[] | undefined) => {
	const h = Array.isArray(header) ? header[0] : header;
	return h?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
};
