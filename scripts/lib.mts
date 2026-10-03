// Shared helpers for the deployment/demo scripts. Plain @solana/kit, v0 transactions.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	type Address,
	appendTransactionMessageInstructions,
	createKeyPairSignerFromBytes,
	createSolanaRpc,
	createSolanaRpcSubscriptions,
	createTransactionMessage,
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

export const RPC_URL =
	process.env.RPC_URL ?? (CLUSTER === "devnet" ? "https://api.devnet.solana.com" : "http://127.0.0.1:8899");
const WS_URL =
	process.env.WS_URL ??
	(CLUSTER === "devnet"
		? "wss://api.devnet.solana.com"
		: RPC_URL.replace(/^http/, "ws").replace(/:(\d+)$/, (_, port) => `:${Number(port) + 1}`));

export const rpc = createSolanaRpc(RPC_URL);
const rpcSubscriptions = createSolanaRpcSubscriptions(WS_URL);
const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });

export const PROGRAM_ID = SCOUT_PROGRAM_ADDRESS;
export const FEE_BPS = 1000;
export const USDC_DECIMALS = 6;
export const USDC = 1_000_000n;

// ---- Keypairs ---------------------------------------------------------------

export const expandHome = (p: string) => p.replace(/^~(?=$|\/)/, homedir());
export const KEYPAIRS = {
	deployer: process.env.DEPLOYER_KEYPAIR ?? "~/.config/solana/id.json",
	company: process.env.COMPANY_KEYPAIR ?? "~/.config/solana/superrecruiter/client.json",
	scout: process.env.SCOUT_KEYPAIR ?? "~/.config/solana/superrecruiter/recruiter.json",
	scout2: process.env.SCOUT2_KEYPAIR ?? "~/.config/solana/superrecruiter/scout2.json",
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
};

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

/** Sends instructions with `feePayer` paying fees; any signers referenced by the instructions sign too. */
export async function send(feePayer: TransactionSigner, instructions: Instruction[]): Promise<string> {
	const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
	const message = pipe(
		createTransactionMessage({ version: 0 }),
		(m) => setTransactionMessageFeePayerSigner(feePayer, m),
		(m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
		(m) => appendTransactionMessageInstructions(instructions, m),
	);
	const signed = await signTransactionMessageWithSigners(message);
	await sendAndConfirm(signed as Parameters<typeof sendAndConfirm>[0], { commitment: "confirmed" });
	return getSignatureFromTransaction(signed);
}

export const explorerTx = (sig: string) =>
	CLUSTER === "devnet"
		? `https://explorer.solana.com/tx/${sig}?cluster=devnet`
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
