/**
 * The agent's view of the chain and its own transactions. Reads come straight from the program's
 * accounts (via @scout/shared/program); writes are built here from chain state and signed with
 * the agent's key, so the platform can't make the agent sign something it didn't decide.
 */
import type { AgentConfig } from "@scout/shared";
import {
	fetchAllMaybeTask,
	fetchMaybeScoutProfile,
	fetchMaybeSubmission,
	fetchOperator,
	fetchRoleVault,
	findScoutProfilePda,
	findTaskPda,
	type RoleVault,
	type Task,
} from "@scout/shared/program";
import {
	type Address,
	address,
	appendTransactionMessageInstructions,
	createNoopSigner,
	createSolanaRpc,
	createTransactionMessage,
	getBase64EncodedWireTransaction,
	getSignatureFromTransaction,
	type Instruction,
	type KeyPairSigner,
	partiallySignTransactionMessageWithSigners,
	pipe,
	type Rpc,
	type SolanaRpcApi,
	setTransactionMessageFeePayerSigner,
	setTransactionMessageLifetimeUsingBlockhash,
	type TransactionSigner,
} from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token";
import type { AgentApi } from "./api.ts";

export type ChainRpc = Rpc<SolanaRpcApi>;

export interface ChainContext {
	rpc: ChainRpc;
	config: AgentConfig;
	agent: KeyPairSigner;
	/** "relayer": the platform pays fees (tx.submit); "self": the agent's key pays (needs SOL). */
	feePayer: "relayer" | "self";
	api: AgentApi | null;
}

export function createChain(input: Omit<ChainContext, "rpc"> & { rpcUrl?: string }): ChainContext {
	return { ...input, rpc: createSolanaRpc(input.rpcUrl ?? input.config.rpcUrl) };
}

/** Who pays fees and rent: the relayer (signs later, at tx.submit) or the agent itself. */
export function payerSigner(ctx: ChainContext): TransactionSigner {
	if (ctx.feePayer === "relayer" && ctx.config.relayer && ctx.api)
		return createNoopSigner(address(ctx.config.relayer));
	return ctx.agent;
}

export async function readRoleVault(ctx: ChainContext, roleVault: Address): Promise<RoleVault> {
	return (await fetchRoleVault(ctx.rpc, roleVault)).data;
}

export async function readTasks(
	ctx: ChainContext,
	roleVault: Address,
	taskCount: number,
): Promise<(Task & { address: Address })[]> {
	const addresses = await Promise.all(
		Array.from({ length: taskCount }, async (_, taskId) => (await findTaskPda({ roleVault, taskId }))[0]),
	);
	const accounts = addresses.length ? await fetchAllMaybeTask(ctx.rpc, addresses) : [];
	return accounts.flatMap((a) => (a.exists ? [{ ...a.data, address: a.address }] : []));
}

export async function tokenBalance(ctx: ChainContext, tokenAccount: Address): Promise<bigint> {
	const { value } = await ctx.rpc.getTokenAccountBalance(tokenAccount).send();
	return BigInt(value.amount);
}

/** USDC the vault holds that isn't promised to open tasks, held back for holdbacks or bonds. */
export function availableBudget(vault: RoleVault, balance: bigint): bigint {
	const free = balance - vault.openCapacity - vault.heldBackTotal - vault.bondsHeld;
	return free > 0n ? free : 0n;
}

export async function scoutAccounts(ctx: ChainContext, scout: Address) {
	const mint = address(ctx.config.usdcMint);
	const tokenProgram = address(ctx.config.tokenProgram);
	const [profile] = await findScoutProfilePda({ scout });
	const [tokenAccount] = await findAssociatedTokenPda({ owner: scout, mint, tokenProgram });
	const data = await fetchMaybeScoutProfile(ctx.rpc, profile);
	const operator =
		data.exists && data.data.operator.__option === "Some" ? data.data.operator.value : undefined;
	const operatorTokenAccount = operator
		? (await fetchOperator(ctx.rpc, operator)).data.tokenAccount
		: undefined;
	return { profile, tokenAccount, operator, operatorTokenAccount };
}

export async function readSubmission(ctx: ChainContext, submission: Address) {
	const s = await fetchMaybeSubmission(ctx.rpc, submission);
	return s.exists ? s.data : null;
}

/**
 * Signs with the agent and sends: through the platform relayer (fee payer signs at tx.submit) or
 * directly, paying its own fees. Returns the signature once confirmed.
 */
export async function sendAgentTx(ctx: ChainContext, instructions: Instruction[]): Promise<string> {
	const feePayer = payerSigner(ctx);
	const { value: blockhash } = await ctx.rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
	const message = pipe(
		createTransactionMessage({ version: 0 }),
		(m) => setTransactionMessageFeePayerSigner(feePayer, m),
		(m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
		(m) => appendTransactionMessageInstructions(instructions, m),
	);
	const tx = await partiallySignTransactionMessageWithSigners(message);
	const wire = getBase64EncodedWireTransaction(tx);
	if (feePayer.address !== ctx.agent.address && ctx.api) return ctx.api.submitTx(wire);
	await ctx.rpc.sendTransaction(wire, { encoding: "base64", preflightCommitment: "confirmed" }).send();
	const signature = getSignatureFromTransaction(tx);
	await confirm(ctx, signature);
	return signature;
}

async function confirm(ctx: ChainContext, signature: string, timeoutMs = 30_000) {
	const until = Date.now() + timeoutMs;
	while (Date.now() < until) {
		const { value } = await ctx.rpc.getSignatureStatuses([signature as never]).send();
		const status = value[0];
		if (status?.err) throw new Error(`transaction ${signature} failed: ${JSON.stringify(status.err)}`);
		if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return;
		await new Promise((r) => setTimeout(r, 400));
	}
	throw new Error(`transaction ${signature} not confirmed in ${timeoutMs / 1000}s`);
}
