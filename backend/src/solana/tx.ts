import { explorerTxUrl, type UnsignedTx } from "@scout/shared";
import {
	AccountRole,
	type Address,
	address,
	appendTransactionMessageInstructions,
	compileTransaction,
	createTransactionMessage,
	getBase64EncodedWireTransaction,
	getCompiledTransactionMessageDecoder,
	getSignatureFromTransaction,
	getTransactionDecoder,
	type Instruction,
	isSolanaError,
	partiallySignTransaction,
	pipe,
	type Signature,
	SOLANA_ERROR__TRANSACTION_ERROR__ALREADY_PROCESSED,
	SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND,
	setTransactionMessageFeePayer,
	setTransactionMessageLifetimeUsingBlockhash,
	signTransaction,
	type Transaction,
} from "@solana/kit";
import {
	ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
	invalidateCached,
	programAddress,
	relayer,
	rpc,
	tokenProgram,
} from "./chain.ts";
import { camel, encodeInstructionData, findInstruction, type Idl, requireIdl } from "./idl.ts";

const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
const COMPUTE_BUDGET_PROGRAM_ADDRESS = "ComputeBudget111111111111111111111111111111";
const RENT_SYSVAR = address("SysvarRent111111111111111111111111111111111");

/** Accounts every instruction may reference without the caller naming them. */
const wellKnown = (): Record<string, Address> => ({
	systemProgram: SYSTEM_PROGRAM,
	tokenProgram: tokenProgram(),
	associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
	rent: RENT_SYSVAR,
});

/**
 * Build a Scout program instruction from the IDL. `accounts` uses camelCase IDL account names; `payer` defaults
 * to the relayer when omitted by the caller.
 */
export function buildScoutInstruction(
	name: string,
	args: Record<string, unknown>,
	accounts: Record<string, Address | null | undefined>,
): Instruction {
	const idl = requireIdl();
	const ix = findInstruction(idl, name);
	const known = wellKnown();
	const metas = ix.accounts.map((a) => {
		const key = camel(a.name);
		const addr = accounts[key] ?? (a.address ? address(a.address) : known[key]);
		if (!addr) {
			if (a.optional) return { address: programAddress(), role: AccountRole.READONLY }; // Anchor's "None"
			throw new Error(`buildScoutInstruction(${name}): no address for account "${a.name}"`);
		}
		const role =
			a.signer && a.writable
				? AccountRole.WRITABLE_SIGNER
				: a.signer
					? AccountRole.READONLY_SIGNER
					: a.writable
						? AccountRole.WRITABLE
						: AccountRole.READONLY;
		return { address: addr, role };
	});
	return { programAddress: programAddress(), accounts: metas, data: encodeInstructionData(idl, ix, args) };
}

/** Compile a v0 tx with the relayer as fee payer. All signature slots (incl. the relayer's) are left empty. */
export async function buildUnsignedTx(instructions: Instruction[], summary: string): Promise<UnsignedTx> {
	const tx = await compile(instructions);
	return { transaction: getBase64EncodedWireTransaction(tx), summary };
}

async function compile(instructions: Instruction[]) {
	const payer = await relayer();
	const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
	const message = pipe(
		createTransactionMessage({ version: 0 }),
		(m) => setTransactionMessageFeePayer(payer.address, m),
		(m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
		(m) => appendTransactionMessageInstructions(instructions, m),
	);
	return compileTransaction(message);
}

/** Relayer signs and sends a tx it fully owns (e.g. permissionless settle_expired). */
export async function sendAsRelayer(instructions: Instruction[]): Promise<Signature> {
	const payer = await relayer();
	const tx = await signTransaction([payer.keyPair], await compile(instructions));
	return sendAndConfirm(tx);
}

// ---- Relayer policy ---------------------------------------------------------

export type CompiledMessageLike = {
	staticAccounts: readonly string[];
	instructions: readonly {
		programAddressIndex: number;
		accountIndices?: readonly number[];
		data?: ArrayLike<number>;
	}[];
	addressTableLookups?: readonly unknown[];
};

/**
 * The relayer co-signs user transactions as fee payer, so it must never sign something that spends its own SOL
 * beyond fees/rent for our program. Rules:
 * - fee payer (static account 0) is the relayer;
 * - no address lookup tables;
 * - top-level programs: Scout, Associated Token, Compute Budget only (no System/Token transfers);
 * - the relayer key may appear only as fee payer, as the IDL account named `payer` of a Scout instruction, or as
 *   the funding account (index 0) of an ATA create instruction.
 * Returns an error message, or null if the tx is acceptable.
 */
export function checkRelayerPolicy(
	msg: CompiledMessageLike,
	opts: { relayer: string; programId: string; idl: Pick<Idl, "instructions"> },
): string | null {
	if (msg.staticAccounts[0] !== opts.relayer) return "fee payer must be the relayer";
	if (msg.addressTableLookups && msg.addressTableLookups.length > 0)
		return "address lookup tables not allowed";
	const allowed = new Set([opts.programId, ASSOCIATED_TOKEN_PROGRAM_ADDRESS, COMPUTE_BUDGET_PROGRAM_ADDRESS]);
	for (const [i, ix] of msg.instructions.entries()) {
		const program = msg.staticAccounts[ix.programAddressIndex];
		if (!program || !allowed.has(program)) return `instruction ${i}: program ${program} not allowed`;
		const relayerPositions = (ix.accountIndices ?? []).flatMap((acc, pos) =>
			msg.staticAccounts[acc] === opts.relayer ? [pos] : [],
		);
		if (relayerPositions.length === 0) continue;
		if (program === opts.programId) {
			const data = Array.from(ix.data ?? []);
			const def = opts.idl.instructions.find((d) => d.discriminator.every((b, j) => data[j] === b));
			if (!def) return `instruction ${i}: unknown Scout instruction`;
			for (const pos of relayerPositions) {
				if (def.accounts[pos]?.name !== "payer") {
					return `instruction ${i} (${def.name}): relayer used as "${def.accounts[pos]?.name ?? pos}"`;
				}
			}
		} else if (program === ASSOCIATED_TOKEN_PROGRAM_ADDRESS) {
			if (relayerPositions.some((p) => p !== 0))
				return `instruction ${i}: relayer may only fund ATA creation`;
		} else {
			return `instruction ${i}: relayer referenced by ${program}`;
		}
	}
	return null;
}

/** Validate a user-signed tx, add the relayer signature, send and confirm. */
export async function relayUserTx(signedTxBase64: string): Promise<Signature> {
	const payer = await relayer();
	let tx: Transaction;
	let msg: ReturnType<ReturnType<typeof getCompiledTransactionMessageDecoder>["decode"]>;
	try {
		tx = getTransactionDecoder().decode(Buffer.from(signedTxBase64, "base64"));
		msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
	} catch {
		throw new RelayerPolicyError("signedTx is not a valid base64 wire transaction");
	}
	if (msg.version !== 0) throw new RelayerPolicyError("only v0 transactions are relayed");
	const violation = checkRelayerPolicy(msg, {
		relayer: payer.address,
		programId: programAddress(),
		idl: requireIdl(),
	});
	if (violation) throw new RelayerPolicyError(violation);
	const missing = Object.entries(tx.signatures).filter(([k, v]) => k !== payer.address && v === null);
	if (missing.length)
		throw new RelayerPolicyError(`missing signature from ${missing.map(([k]) => k).join(", ")}`);
	const signed = await partiallySignTransaction([payer.keyPair], tx);
	const signature = await sendAndConfirm(signed);
	invalidateCached(...msg.staticAccounts);
	return signature;
}

export class RelayerPolicyError extends Error {}

export class TxFailedError extends Error {
	constructor(
		message: string,
		readonly logs: readonly string[] = [],
	) {
		super(message);
	}
}

async function sendAndConfirm(tx: Transaction): Promise<Signature> {
	const wire = getBase64EncodedWireTransaction(tx);
	const signature = getSignatureFromTransaction(tx);
	// Transport-level 429/5xx are retried in chain.ts. Here we also retry a preflight "blockhash not found":
	// devnet's load balancer can route the send to a node a few slots behind the one that gave us the blockhash.
	for (let attempt = 0; ; attempt++) {
		try {
			await rpc
				.sendTransaction(wire, { encoding: "base64", preflightCommitment: "confirmed", maxRetries: 5n })
				.send();
			break;
		} catch (err) {
			if (isBlockhashNotFound(err) && attempt < 4) {
				await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
				continue;
			}
			if (isAlreadyProcessed(err)) break; // an earlier attempt landed
			throw toTxError(err);
		}
	}
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		const { value } = await rpc.getSignatureStatuses([signature]).send();
		const status = value[0];
		if (status?.err) throw new TxFailedError(`transaction failed: ${JSON.stringify(status.err, jsonBigint)}`);
		if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized")
			return signature;
		await new Promise((r) => setTimeout(r, 800));
	}
	throw new TxFailedError(`transaction not confirmed in time: ${signature}`);
}

const jsonBigint = (_: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

function errorChain(err: unknown): unknown[] {
	const out: unknown[] = [];
	for (let e = err; e && out.length < 6; e = (e as { cause?: unknown }).cause) out.push(e);
	return out;
}
const isBlockhashNotFound = (err: unknown) =>
	errorChain(err).some(
		(e) =>
			isSolanaError(e, SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND) ||
			/blockhash not found/i.test((e as Error)?.message ?? ""),
	);
const isAlreadyProcessed = (err: unknown) =>
	errorChain(err).some(
		(e) =>
			isSolanaError(e, SOLANA_ERROR__TRANSACTION_ERROR__ALREADY_PROCESSED) ||
			/already been processed/i.test((e as Error)?.message ?? ""),
	);

/**
 * Turn a kit SolanaError into a readable 422: the Anchor error line if the program failed, otherwise the
 * innermost RPC/transaction error message (e.g. "Blockhash not found", "insufficient funds").
 */
function toTxError(err: unknown): TxFailedError {
	const chain = errorChain(err);
	const logs =
		chain.map((e) => (e as { context?: { logs?: string[] } })?.context?.logs).find((l) => l?.length) ?? [];
	const anchorLine = logs.find((l) => l.includes("AnchorError") || l.includes("Error Message"));
	const messages = chain
		.map(
			(e) =>
				(e as { context?: { __serverMessage?: string } })?.context?.__serverMessage ?? (e as Error)?.message,
		)
		.filter((m): m is string => Boolean(m));
	const message = anchorLine ?? [...new Set(messages)].join(" → ") ?? "transaction simulation failed";
	return new TxFailedError(message, logs);
}

export const explorerUrl = (sig: string) => explorerTxUrl(sig);
