import { existsSync, readFileSync } from "node:fs";
import { SEEDS } from "@scout/shared";
import {
	type Address,
	address,
	createDefaultRpcTransport,
	createKeyPairSignerFromBytes,
	createSolanaRpcFromTransport,
	createSolanaRpcSubscriptions,
	getAddressEncoder,
	getProgramDerivedAddress,
	getU64Encoder,
	isSolanaError,
	type KeyPairSigner,
	SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
} from "@solana/kit";
import {
	ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
	findAssociatedTokenPda,
	TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { env } from "../env.ts";
import { decodeAccount, loadIdl } from "./idl.ts";

/**
 * The public devnet RPC rate-limits per IP (HTTP 429) and the backend, indexer and browser share that budget.
 * Retry 429/5xx with backoff so a burst never surfaces as a failed user action. Retrying is safe even for
 * sendTransaction: a re-sent signed tx has the same signature and lands at most once.
 */
const baseTransport = createDefaultRpcTransport({ url: env.rpcUrl });
const retryingTransport: typeof baseTransport = async (config) => {
	for (let attempt = 0; ; attempt++) {
		try {
			return await baseTransport(config);
		} catch (err) {
			const status = isSolanaError(err, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR) ? err.context.statusCode : 0;
			const transient = status === 429 || status >= 500;
			if (!transient || attempt >= 5) throw err;
			await new Promise((r) => setTimeout(r, 400 * 2 ** attempt + Math.random() * 200));
		}
	}
};
export const rpc = createSolanaRpcFromTransport(retryingTransport);
export const rpcSubscriptions = createSolanaRpcSubscriptions(env.wsUrl);

/** Written by scripts/ (stream A) after deploying + creating the mock USDC mint. */
export type Deployment = {
	programId: string;
	usdcMint: string;
	config: string;
	treasury: string;
	treasuryTokenAccount: string;
	tokenProgram?: string;
};

let deploymentCache: Deployment | null = null;
export function loadDeployment(): Deployment | null {
	if (deploymentCache) return deploymentCache;
	if (!existsSync(env.deploymentPath)) return null;
	deploymentCache = JSON.parse(readFileSync(env.deploymentPath, "utf8")) as Deployment;
	return deploymentCache;
}

export class ChainNotReadyError extends Error {
	constructor(what: string) {
		super(`Solana program not ready: ${what}. Deploy the program and run the setup script first.`);
	}
}

export function requireDeployment(): Deployment {
	const d = loadDeployment();
	if (!d) throw new ChainNotReadyError(`missing ${env.deploymentPath}`);
	return d;
}

export function programAddress(): Address {
	const d = loadDeployment();
	if (d?.programId) return address(d.programId);
	const idl = loadIdl();
	if (idl) return address(idl.address);
	throw new ChainNotReadyError("no deployment file or IDL");
}

export function tokenProgram(): Address {
	return address(loadDeployment()?.tokenProgram ?? TOKEN_PROGRAM_ADDRESS);
}

let relayerPromise: Promise<KeyPairSigner> | null = null;
export function relayer(): Promise<KeyPairSigner> {
	relayerPromise ??= createKeyPairSignerFromBytes(
		Uint8Array.from(JSON.parse(readFileSync(env.relayerKeypairPath, "utf8")) as number[]),
	);
	return relayerPromise;
}

// ---- PDAs (seeds must match docs/program-interface.md) ---------------------

const enc = new TextEncoder();
const addr = getAddressEncoder();
const u64 = getU64Encoder();

const pda = async (seeds: (Uint8Array | ReturnType<typeof addr.encode>)[]) =>
	(await getProgramDerivedAddress({ programAddress: programAddress(), seeds }))[0];

export const findConfigPda = () => pda([enc.encode(SEEDS.config)]);
export const findRoleVaultPda = (company: Address, roleId: bigint | number) =>
	pda([enc.encode(SEEDS.role), addr.encode(company), u64.encode(BigInt(roleId))]);
export const findScoutProfilePda = (scout: Address) => pda([enc.encode(SEEDS.scout), addr.encode(scout)]);
export const findSubmissionPda = (roleVault: Address, candidateHash: Uint8Array) =>
	pda([enc.encode(SEEDS.submission), addr.encode(roleVault), candidateHash]);

export const findAta = async (owner: Address, mint: Address) =>
	(await findAssociatedTokenPda({ owner, mint, tokenProgram: tokenProgram() }))[0];

export { ASSOCIATED_TOKEN_PROGRAM_ADDRESS };

// ---- Account reads ---------------------------------------------------------

export type RoleVaultAccount = {
	company: Address;
	roleId: bigint;
	bountyPerCandidate: bigint;
	maxCandidates: number;
	acceptedCount: number;
	pendingCount: number;
	totalDeposited: bigint;
	totalPaid: bigint;
	reviewWindowSeconds: bigint;
	feeBps: number;
	status: string | { __kind: string };
	vaultTokenAccount?: Address;
};
export type ScoutProfileAccount = {
	scout: Address;
	submitted: number;
	accepted: number;
	rejected: number;
	totalEarned: bigint;
};
export type SubmissionAccount = {
	roleVault: Address;
	scout: Address;
	submittedAt: bigint;
	reviewDeadline: bigint;
	status: string | { __kind: string };
	rejectReason: number;
};

export async function fetchProgramAccount<T>(name: string, at: Address): Promise<T | null> {
	const idl = loadIdl();
	if (!idl) return null;
	const res = await rpc.getAccountInfo(at, { encoding: "base64" }).send();
	if (!res.value) return null;
	const data = Buffer.from(res.value.data[0], "base64");
	return decodeAccount<T>(idl, name, data);
}

export async function tokenBalance(tokenAccount: Address): Promise<bigint> {
	try {
		const res = await rpc.getTokenAccountBalance(tokenAccount).send();
		return BigInt(res.value.amount);
	} catch {
		return 0n; // account doesn't exist yet
	}
}

/** Tiny TTL cache for read-mostly RPC lookups the UI polls (keeps us under the public RPC rate limit). */
const ttlCache = new Map<string, { at: number; value: Promise<unknown> }>();
export function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
	const hit = ttlCache.get(key);
	if (hit && Date.now() - hit.at < ttlMs) return hit.value as Promise<T>;
	const value = load();
	ttlCache.set(key, { at: Date.now(), value });
	value.catch(() => ttlCache.delete(key));
	return value;
}
/** Call after a tx that changes balances/accounts of these owners. */
export function invalidateCached(...keys: string[]) {
	for (const k of ttlCache.keys()) if (keys.some((x) => k.includes(x))) ttlCache.delete(k);
}

export async function usdcBalanceOf(owner: Address): Promise<bigint> {
	const d = loadDeployment();
	if (!d) return 0n;
	return cached(`balance:${owner}`, 5_000, async () =>
		tokenBalance(await findAta(owner, address(d.usdcMint))),
	);
}

export const enumName = (v: string | { __kind: string }) => (typeof v === "string" ? v : v.__kind);
