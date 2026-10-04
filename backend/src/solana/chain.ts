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
	getU32Encoder,
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

/** Client-side limiter: spaces requests so the backend alone stays well under the public RPC's per-IP limit. */
const minIntervalMs = 1000 / Number(process.env.RPC_MAX_RPS ?? 8);
let nextSlot = 0;
const recentRequests: number[] = [];
/** HTTP RPC requests the backend made in the last 60 s (shown on /health). */
export function rpcRequestsLastMinute() {
	const cutoff = Date.now() - 60_000;
	while (recentRequests.length && (recentRequests[0] ?? 0) < cutoff) recentRequests.shift();
	return recentRequests.length;
}
async function rateLimit() {
	recentRequests.push(Date.now());
	rpcRequestsLastMinute();
	const now = Date.now();
	const at = Math.max(now, nextSlot);
	nextSlot = at + minIntervalMs;
	if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

const retryingTransport: typeof baseTransport = async (config) => {
	for (let attempt = 0; ; attempt++) {
		try {
			await rateLimit();
			return await baseTransport(config);
		} catch (err) {
			const status = isSolanaError(err, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR) ? err.context.statusCode : 0;
			const transient = status === 429 || status >= 500;
			if (!transient || attempt >= 7) throw err;
			await new Promise((r) => setTimeout(r, Math.min(500 * 2 ** attempt, 8000) + Math.random() * 300));
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

let agentPromise: Promise<KeyPairSigner> | null = null;
/** The agent's wallet: role.agent on agent-run roles (creates gigs, accepts/rejects deliverables). */
export function agentSigner(): Promise<KeyPairSigner> {
	agentPromise ??= createKeyPairSignerFromBytes(
		Uint8Array.from(JSON.parse(readFileSync(env.agentKeypairPath, "utf8")) as number[]),
	);
	return agentPromise;
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
const u32 = getU32Encoder();

const pda = async (seeds: (Uint8Array | ReturnType<typeof addr.encode>)[]) =>
	(await getProgramDerivedAddress({ programAddress: programAddress(), seeds }))[0];

export const findConfigPda = () => pda([enc.encode(SEEDS.config)]);
export const findRoleVaultPda = (company: Address, roleId: bigint | number) =>
	pda([enc.encode(SEEDS.role), addr.encode(company), u64.encode(BigInt(roleId))]);
export const findScoutProfilePda = (scout: Address) => pda([enc.encode(SEEDS.scout), addr.encode(scout)]);
export const findTaskPda = (roleVault: Address, taskId: number) =>
	pda([enc.encode(SEEDS.task), addr.encode(roleVault), u32.encode(taskId)]);
/** Deliverables live under their task: ["submission", task, deliverable_hash]. */
export const findSubmissionPda = (task: Address, deliverableHash: Uint8Array) =>
	pda([enc.encode(SEEDS.submission), addr.encode(task), deliverableHash]);

export const findAta = async (owner: Address, mint: Address) =>
	(await findAssociatedTokenPda({ owner, mint, tokenProgram: tokenProgram() }))[0];

export { ASSOCIATED_TOKEN_PROGRAM_ADDRESS };

// ---- Account reads ---------------------------------------------------------

export type RoleVaultAccount = {
	company: Address;
	roleId: bigint;
	agent: Address | null;
	feeBps: number;
	reviewWindowSeconds: bigint;
	claimTimeoutSeconds: bigint;
	holdbackWindowSeconds: bigint;
	/** The next create_task must use task_id = task_count. */
	taskCount: number;
	openTaskCount: number;
	acceptedCount: number;
	pendingCount: number;
	pendingValue: bigint;
	openCapacity: bigint;
	heldBackTotal: bigint;
	totalDeposited: bigint;
	totalPaid: bigint;
	status: string | { __kind: string };
	vaultTokenAccount?: Address;
};
export type ScoutProfileAccount = {
	scout: Address;
	submitted: number;
	accepted: number;
	rejected: number;
	advanced: number;
	flagged: number;
	totalEarned: bigint;
	/** Operator PDA that vouched for this scout. */
	operator: Address | null;
};
export type OperatorAccount = {
	authority: Address;
	name: string;
	feeBps: number;
	tokenAccount: Address;
};
export type SubmissionAccount = {
	roleVault: Address;
	scout: Address;
	submittedAt: bigint;
	reviewDeadline: bigint;
	status: string | { __kind: string };
	rejectReason: number;
	holdbackAmount: bigint;
	holdbackDeadline: bigint;
	outcome: string | { __kind: string };
};

export async function fetchProgramAccount<T>(name: string, at: Address): Promise<T | null> {
	const idl = loadIdl();
	if (!idl) return null;
	const res = await rpc.getAccountInfo(at, { encoding: "base64", commitment: "confirmed" }).send();
	if (!res.value) return null;
	const data = Buffer.from(res.value.data[0], "base64");
	return decodeAccount<T>(idl, name, data);
}

export async function tokenBalance(tokenAccount: Address): Promise<bigint> {
	try {
		const res = await rpc.getTokenAccountBalance(tokenAccount, { commitment: "confirmed" }).send();
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

/** The scout's on-chain profile and, if vouched, its operator. Cached briefly; invalidated by the indexer. */
export async function scoutChainInfo(scout: Address): Promise<{
	profileAddress: Address;
	profile: ScoutProfileAccount | null;
	operator: (OperatorAccount & { address: Address }) | null;
}> {
	return cached(`scoutinfo:${scout}`, 10_000, async () => {
		const profileAddress = await findScoutProfilePda(scout);
		const profile = await fetchProgramAccount<ScoutProfileAccount>("ScoutProfile", profileAddress);
		if (!profile?.operator) return { profileAddress, profile, operator: null };
		const op = await cached(`operator:${profile.operator}`, 5 * 60_000, () =>
			fetchProgramAccount<OperatorAccount>("Operator", profile.operator as Address),
		);
		return { profileAddress, profile, operator: op ? { ...op, address: profile.operator } : null };
	});
}

export const enumName = (v: string | { __kind: string }) => (typeof v === "string" ? v : v.__kind);

/**
 * Wall clock minus the chain's clock, in ms (cached 30 s). On-chain deadlines are in chain time; a local validator
 * can drift minutes behind, so deadlines shown to people are shifted by this.
 */
export async function chainClockOffsetMs(): Promise<number> {
	return cached("chain-clock-offset", 30_000, async () => {
		try {
			const slot = await rpc.getSlot({ commitment: "confirmed" }).send();
			const t = await rpc.getBlockTime(slot).send();
			return t ? Date.now() - Number(t) * 1000 : 0;
		} catch {
			return 0;
		}
	});
}

/** "Now" on the chain's clock (ms): compare on-chain deadlines (review, holdback) against this, not Date.now(). */
export async function chainNowMs(): Promise<number> {
	return Date.now() - (await chainClockOffsetMs());
}
