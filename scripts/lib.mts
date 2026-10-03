// Shared helpers for the deployment/demo scripts. Plain @solana/kit, v0 transactions.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	type Address,
	address,
	appendTransactionMessageInstructions,
	createDefaultRpcTransport,
	createKeyPairSignerFromBytes,
	createSolanaRpcFromTransport,
	createSolanaRpcSubscriptions,
	createTransactionMessage,
	getAddressDecoder,
	getAddressEncoder,
	getProgramDerivedAddress,
	getSignatureFromTransaction,
	type Instruction,
	type KeyPairSigner,
	pipe,
	sendAndConfirmTransactionFactory,
	setTransactionMessageFeePayerSigner,
	setTransactionMessageLifetimeUsingBlockhash,
	signTransactionMessageWithSigners,
	type TransactionSigner,
} from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { SCOUT_PROGRAM_ADDRESS } from "../packages/shared/src/generated/index.ts";

export type Cluster = "localnet" | "devnet";

export const CLUSTER = (process.env.CLUSTER ?? "localnet") as Cluster;
if (CLUSTER !== "localnet" && CLUSTER !== "devnet")
	throw new Error(`CLUSTER must be localnet or devnet, got ${CLUSTER}`);

/** Public endpoint per cluster; this (never a keyed URL) is what goes into deployments/<cluster>.json. */
export const PUBLIC_RPC_URL =
	CLUSTER === "devnet" ? "https://api.devnet.solana.com" : "http://127.0.0.1:8899";

/** RPC_URL env, else on devnet the (keyed, e.g. Helius) RPC_URL from backend/.env, else the public endpoint. */
function backendRpcUrl(): string | undefined {
	const envFile = join(import.meta.dirname, "..", "backend", ".env");
	if (!existsSync(envFile)) return undefined;
	const line = readFileSync(envFile, "utf8")
		.split("\n")
		.find((l) => l.startsWith("RPC_URL="));
	return line?.slice("RPC_URL=".length).trim() || undefined;
}
export const RPC_URL =
	process.env.RPC_URL ?? (CLUSTER === "devnet" ? backendRpcUrl() : undefined) ?? PUBLIC_RPC_URL;
const WS_URL =
	process.env.WS_URL ??
	(CLUSTER === "localnet"
		? RPC_URL.replace(/^http/, "ws").replace(/:(\d+)$/, (_, port) => `:${Number(port) + 1}`)
		: RPC_URL.replace(/^http/, "ws"));
/** For logs: the host only, so API keys in the query string never get printed. */
export const RPC_LABEL = new URL(RPC_URL).host;

// Every RPC call backs off on 429: the public devnet endpoint rate-limits per IP.
const transport = createDefaultRpcTransport({ url: RPC_URL });
export const rpc = createSolanaRpcFromTransport(((request: Parameters<typeof transport>[0]) =>
	with429Retry(() => transport(request))) as typeof transport);
const rpcSubscriptions = createSolanaRpcSubscriptions(WS_URL);
const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });

export const PROGRAM_ID = SCOUT_PROGRAM_ADDRESS;
export const FEE_BPS = 1000;
export const USDC_DECIMALS = 6;
export const USDC = 1_000_000n;

// ---- Keypairs ---------------------------------------------------------------

export const expandHome = (p: string) => p.replace(/^~(?=$|\/)/, homedir());
export const KEYPAIRS = {
	/** Deploys the program (pays buffers) and is the mock-USDC mint authority. Not used by the backend. */
	deployer: process.env.DEPLOYER_KEYPAIR ?? "~/.config/solana/id.json",
	/** Fee payer for every user transaction (the backend's RELAYER_KEYPAIR). Holds a little SOL only. */
	relayer: process.env.RELAYER_KEYPAIR ?? "~/.config/solana/superrecruiter/relayer.json",
	/** Platform fee wallet. Only receives. */
	treasury: process.env.TREASURY_KEYPAIR ?? "~/.config/solana/superrecruiter/treasury.json",
	/** Cold key: program upgrade authority and Config admin. Never loaded by the backend. */
	upgradeAuthority:
		process.env.UPGRADE_AUTHORITY_KEYPAIR ?? "~/.config/solana/superrecruiter/upgrade-authority.json",
	company: process.env.COMPANY_KEYPAIR ?? "~/.config/solana/superrecruiter/client.json",
	scout: process.env.SCOUT_KEYPAIR ?? "~/.config/solana/superrecruiter/recruiter.json",
	scout2: process.env.SCOUT2_KEYPAIR ?? "~/.config/solana/superrecruiter/scout2.json",
	/** The AI agent's wallet: `role.agent`, creates tasks and accepts deliverables. Holds no SOL (relayer pays). */
	agent: process.env.AGENT_KEYPAIR ?? "~/.config/solana/superrecruiter/agent.json",
	/** Authority of the demo operator ("Kraków Recruiting Academy"). */
	operator: process.env.OPERATOR_KEYPAIR ?? "~/.config/solana/superrecruiter/operator.json",
};
export type DemoWallet = keyof typeof KEYPAIRS;

export async function loadKeypair(path: string): Promise<KeyPairSigner> {
	const bytes = new Uint8Array(JSON.parse(readFileSync(expandHome(path), "utf8")));
	return createKeyPairSignerFromBytes(bytes);
}

/** Loads a keypair file, creating it (solana-keygen JSON format) if missing. */
export async function loadOrCreateKeypair(path: string): Promise<KeyPairSigner> {
	const full = expandHome(path);
	if (!existsSync(full)) {
		const pair = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
		const seed = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).slice(-32);
		const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, JSON.stringify([...seed, ...pub]), { mode: 0o600 });
		console.log(`created keypair ${path}`);
	}
	return loadKeypair(path);
}

/** Moves a keypair file aside as `<name>.old-<timestamp>.json` (keys are never deleted). Returns the new path. */
export function archiveKeypair(path: string): string | null {
	const full = expandHome(path);
	if (!existsSync(full)) return null;
	const archived = full.replace(/\.json$/, `.old-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
	renameSync(full, archived);
	return archived;
}

// ---- Deployment file ----------------------------------------------------------

export type Deployment = {
	cluster: Cluster;
	rpcUrl: string;
	programId: Address;
	usdcMint: Address;
	usdcDecimals: number;
	config: Address;
	treasury: Address;
	treasuryTokenAccount: Address;
	feeBps: number;
	tokenProgram: Address;
	/** Demo operator (Operator PDA), its authority wallet and fee account. */
	operator?: { address: Address; authority: Address; tokenAccount: Address; name: string; feeBps: number };
	/** The demo AI agent's wallet (role.agent). */
	agent?: Address;
	/** Fee payer the backend uses (RELAYER_KEYPAIR). */
	relayer?: Address;
	/** Program upgrade authority = Config admin (cold key). */
	upgradeAuthority?: Address;
	configParams?: {
		feeBps: number;
		minBounty: string;
		minReputableBounty: string;
		minWindowSeconds: number;
		maxWindowSeconds: number;
	};
};

/** Config per cluster. Localnet allows 1 s windows for quick manual testing. */
export const CONFIG_PARAMS = {
	feeBps: FEE_BPS,
	minBounty: 500_000n, // 0.5 USDC
	minReputableBounty: 1_000_000n, // 1 USDC
	minWindowSeconds: CLUSTER === "devnet" ? 60n : 1n,
	maxWindowSeconds: 90n * 24n * 60n * 60n,
};

export const DEMO_OPERATOR = { name: "Kraków Recruiting Academy", feeBps: 1000 };
/** Demo defaults: 30% of the scout's share held back for 120 s; 60 s review window; 10 min claim timeout. */
export const DEMO_HOLDBACK = { bps: 3000, windowSeconds: 120n };
export const DEMO_ROLE = { reviewWindowSeconds: 60n, claimTimeoutSeconds: 600n };
/** Byte size of a v3.1 RoleVault account (8 + RoleVault::INIT_SPACE); older layouts are abandoned. */
export const ROLE_VAULT_SIZE = 277n;
/** Demo gig policy: 10% bond on sourcing for unvouched scouts; screening needs 1 accepted sourcing. */
export const DEMO_TASK = { sourcingBondBps: 1000, screeningMinAccepted: 1 };
/** Demo agent limits the company signs at create_role. */
export const DEMO_AGENT_CAPS = { maxBounty: 50n * 1_000_000n, maxCommitment: 300n * 1_000_000n };

/** Upgrade authority of the deployed program, read from its ProgramData account. */
export async function programUpgradeAuthority(): Promise<Address | null> {
	const [programData] = await getProgramDerivedAddress({
		programAddress: address("BPFLoaderUpgradeab1e11111111111111111111111"),
		seeds: [getAddressEncoder().encode(PROGRAM_ID)],
	});
	const { value } = await rpc.getAccountInfo(programData, { encoding: "base64" }).send();
	if (!value) return null;
	const data = Buffer.from(value.data[0], "base64");
	if (data.length < 45 || data[12] !== 1) return null;
	return getAddressDecoder().decode(data.subarray(13, 45));
}

export const deploymentPath = (cluster: Cluster = CLUSTER) =>
	join(import.meta.dirname, "..", "deployments", `${cluster}.json`);

export function readDeployment(cluster: Cluster = CLUSTER): Deployment {
	const path = deploymentPath(cluster);
	if (!existsSync(path)) throw new Error(`${path} not found. Run: pnpm setup:${cluster}`);
	return JSON.parse(readFileSync(path, "utf8"));
}

export function writeDeployment(d: Deployment) {
	mkdirSync(dirname(deploymentPath(d.cluster)), { recursive: true });
	writeFileSync(deploymentPath(d.cluster), `${JSON.stringify(d, null, "\t")}\n`);
}

// ---- Transactions -------------------------------------------------------------

/** The public devnet RPC rate-limits (429) per IP; back off and retry. */
export async function with429Retry<T>(fn: () => Promise<T>, attempts = 6): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await fn();
		} catch (e) {
			const status = (e as { context?: { statusCode?: number } }).context?.statusCode;
			if (status !== 429 || attempt >= attempts) throw e;
			await new Promise((r) => setTimeout(r, 2000 * 2 ** Math.min(attempt, 3)));
		}
	}
}

/** Sends instructions with `feePayer` paying fees; any signers referenced by the instructions sign too. */
export async function send(feePayer: TransactionSigner, instructions: Instruction[]): Promise<string> {
	// Public devnet RPC nodes sometimes lag ("Blockhash not found"): rebuild with a fresh blockhash.
	for (let attempt = 0; ; attempt++) {
		try {
			return await sendOnce(feePayer, instructions);
		} catch (e) {
			const cause = (e as { cause?: { context?: { __code?: number } } }).cause;
			if (cause?.context?.__code !== 7050008 || attempt >= 3) throw e;
			await new Promise((r) => setTimeout(r, 2000));
		}
	}
}

async function sendOnce(feePayer: TransactionSigner, instructions: Instruction[]): Promise<string> {
	const { value: latestBlockhash } = await with429Retry(() =>
		rpc.getLatestBlockhash({ commitment: "confirmed" }).send(),
	);
	const message = pipe(
		createTransactionMessage({ version: 0 }),
		(m) => setTransactionMessageFeePayerSigner(feePayer, m),
		(m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
		(m) => appendTransactionMessageInstructions(instructions, m),
	);
	const signed = await signTransactionMessageWithSigners(message);
	const signature = getSignatureFromTransaction(signed);
	// Resending the same signed tx is idempotent; "already processed" after a retry means it landed.
	await with429Retry(async () => {
		try {
			await sendAndConfirm(signed as Parameters<typeof sendAndConfirm>[0], { commitment: "confirmed" });
		} catch (e) {
			const cause = (e as { cause?: { context?: { __code?: number } } }).cause;
			if (cause?.context?.__code !== 7050007) throw e;
			const { value } = await with429Retry(() => rpc.getSignatureStatuses([signature]).send());
			if (value[0]?.err) throw e;
		}
	});
	return signature;
}

export const explorerTx = (sig: string) =>
	CLUSTER === "devnet"
		? `https://solscan.io/tx/${sig}?cluster=devnet`
		: `https://explorer.solana.com/tx/${sig}?cluster=custom&customUrl=${encodeURIComponent(RPC_URL)}`;

export async function ata(owner: Address, mint: Address): Promise<Address> {
	const [address] = await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
	return address;
}

export async function accountExists(address: Address): Promise<boolean> {
	const { value } = await rpc.getAccountInfo(address, { encoding: "base64" }).send();
	return value !== null;
}

export async function tokenBalance(address: Address): Promise<bigint> {
	if (!(await accountExists(address))) return 0n;
	const { value } = await rpc.getTokenAccountBalance(address).send();
	return BigInt(value.amount);
}

export async function solBalance(address: Address): Promise<bigint> {
	const { value } = await rpc.getBalance(address).send();
	return value;
}

/** Best-effort airdrop: the public devnet faucet is often rate-limited, so failure is not fatal. */
export async function tryAirdrop(address: Address, sol: number): Promise<boolean> {
	try {
		const sig = await rpc.requestAirdrop(address, BigInt(sol * 1e9) as never).send();
		for (let i = 0; i < 30; i++) {
			const { value } = await rpc.getSignatureStatuses([sig]).send();
			if (value[0]?.confirmationStatus === "confirmed" || value[0]?.confirmationStatus === "finalized")
				return true;
			await new Promise((r) => setTimeout(r, 1000));
		}
		return false;
	} catch (e) {
		console.warn(`airdrop to ${address} failed: ${(e as Error).message.split("\n")[0]}`);
		return false;
	}
}

export const formatUsdc = (base: bigint) => `${(Number(base) / Number(USDC)).toFixed(2)} USDC`;
