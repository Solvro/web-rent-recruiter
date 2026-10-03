import { createHash } from "node:crypto";
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
	type KeyPairSigner,
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
	agentSigner,
	invalidateCached,
	loadDeployment,
	programAddress,
	relayer,
	rpc,
	rpcSubscriptions,
	tokenProgram,
} from "./chain.ts";
import {
	BorshReader,
	camel,
	decodeType,
	encodeInstructionData,
	findInstruction,
	type Idl,
	loadIdl,
	requireIdl,
} from "./idl.ts";

const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
const COMPUTE_BUDGET_PROGRAM_ADDRESS = "ComputeBudget111111111111111111111111111111";
const MEMO_PROGRAM_ADDRESS = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
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
/**
 * Messages the gig board built that need the gatekeeper's (agent's) co-signature: claims and deliverables.
 * /tx.submit adds the agent signature only for these exact messages, so nothing else gets past the gate.
 */
const gatekeeperApproved = new Map<string, number>();
const messageHash = (bytes: ArrayLike<number>) =>
	createHash("sha256").update(Uint8Array.from(bytes)).digest("hex");

export async function buildUnsignedTx(
	instructions: Instruction[],
	summary: string,
	/** gatekeeper: our agent co-signs at tx.submit. cosigner: someone else must (tx.submitForCosign). */
	opts: { gatekeeper?: boolean; cosigner?: Address } = {},
): Promise<UnsignedTx> {
	const tx = await compile(instructions);
	if (opts.gatekeeper) {
		const now = Date.now();
		for (const [k, until] of gatekeeperApproved) if (until < now) gatekeeperApproved.delete(k);
		gatekeeperApproved.set(messageHash(tx.messageBytes), now + 5 * 60_000);
	}
	return {
		transaction: getBase64EncodedWireTransaction(tx),
		summary,
		...(opts.cosigner ? { cosigner: opts.cosigner } : {}),
	};
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
/**
 * Relayer pays and signs; `cosigners` add their signatures (e.g. the agent key acting as role.agent).
 * Only for transactions the backend built itself.
 */
export async function sendAsRelayer(
	instructions: Instruction[],
	cosigners: KeyPairSigner[] = [],
): Promise<ConfirmedTx> {
	const payer = await relayer();
	const tx = await signTransaction(
		[payer.keyPair, ...cosigners.map((c) => c.keyPair)],
		await compile(instructions),
	);
	const signature = await sendAndConfirm(tx);
	// Payouts change balances: the next me.get must not serve a cached one.
	invalidateCached(...instructions.flatMap((ix) => (ix.accounts ?? []).map((a) => a.address)));
	const decoded = instructions.flatMap((ix) =>
		decodeScoutInstruction(
			ix.programAddress,
			(ix.accounts ?? []).map((a) => a.address),
			ix.data ?? new Uint8Array(),
		),
	);
	return { signature, instructions: decoded };
}

/** A Scout instruction from a confirmed tx: the backend knows exactly which accounts it touched. */
export type DecodedScoutIx = {
	name: string;
	accounts: Record<string, string>;
	args: Record<string, unknown>;
};
export type ConfirmedTx = { signature: Signature; instructions: DecodedScoutIx[] };

function decodeScoutInstruction(
	program: string,
	accountAddresses: readonly string[],
	data: ArrayLike<number>,
): DecodedScoutIx[] {
	const idl = loadIdl();
	if (!idl || program !== programAddress()) return [];
	const bytes = Uint8Array.from(data);
	const def = idl.instructions.find((d) => d.discriminator.every((b, j) => bytes[j] === b));
	if (!def) return [];
	const accounts: Record<string, string> = {};
	def.accounts.forEach((a, i) => {
		const addr = accountAddresses[i];
		if (addr && addr !== program) accounts[camel(a.name)] = addr; // program ID = omitted optional account
	});
	const r = new BorshReader(bytes.subarray(8));
	const args: Record<string, unknown> = {};
	for (const a of def.args) args[camel(a.name)] = decodeType(idl, r, a.type);
	return [{ name: def.name, accounts, args }];
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
 * - top-level programs: Scout, Associated Token, Compute Budget, Memo, and Token `transfer_checked` of our USDC
 *   (a user paying another user, e.g. an overturned appeal; the relayer can't be referenced by it) — no System;
 * - the relayer key may appear only as fee payer, as the IDL account named `payer` of a Scout instruction, as the
 *   non-signer `rent_payer` refund target, or as the funding account (index 0) of an ATA create instruction.
 * Returns an error message, or null if the tx is acceptable.
 */
export function checkRelayerPolicy(
	msg: CompiledMessageLike,
	opts: {
		relayer: string;
		programId: string;
		idl: Pick<Idl, "instructions">;
		usdcMint?: string;
		/** Token programs whose USDC transfer_checked a user may sign (fees only for the relayer). */
		tokenPrograms?: string[];
	},
): string | null {
	if (msg.staticAccounts[0] !== opts.relayer) return "fee payer must be the relayer";
	if (msg.addressTableLookups && msg.addressTableLookups.length > 0)
		return "address lookup tables not allowed";
	const allowed = new Set([
		opts.programId,
		ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
		COMPUTE_BUDGET_PROGRAM_ADDRESS,
		MEMO_PROGRAM_ADDRESS,
	]);
	for (const [i, ix] of msg.instructions.entries()) {
		const program = msg.staticAccounts[ix.programAddressIndex];
		if (program && opts.tokenPrograms?.includes(program)) {
			// transfer_checked = 12: (source, mint, destination, authority). Only our USDC, never the relayer.
			if (ix.data?.[0] !== 12) return `instruction ${i}: only USDC transfer_checked is allowed`;
			const accs = (ix.accountIndices ?? []).map((a) => msg.staticAccounts[a]);
			if (opts.usdcMint && accs[1] !== opts.usdcMint)
				return `instruction ${i}: transfer of an unexpected mint`;
			if (accs.includes(opts.relayer)) return `instruction ${i}: relayer referenced by a token transfer`;
			continue;
		}
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
				const acc = def.accounts[pos] as { name?: string; signer?: boolean } | undefined;
				// `rent_payer` (reject_submission) only receives the closed Submission's rent back.
				if (acc?.name !== "payer" && !(acc?.name === "rent_payer" && !acc.signer)) {
					return `instruction ${i} (${def.name}): relayer used as "${def.accounts[pos]?.name ?? pos}"`;
				}
			}
		} else if (program === ASSOCIATED_TOKEN_PROGRAM_ADDRESS) {
			// create(payer, ata, owner, mint, …): only token accounts for our USDC mint.
			const mint = msg.staticAccounts[ix.accountIndices?.[3] ?? -1];
			if (opts.usdcMint && mint !== opts.usdcMint) return `instruction ${i}: ATA for an unexpected mint`;
			if (relayerPositions.some((p) => p !== 0))
				return `instruction ${i}: relayer may only fund ATA creation`;
		} else {
			return `instruction ${i}: relayer referenced by ${program}`;
		}
	}
	return null;
}

/** Validate a user-signed tx, add the relayer signature, send and confirm. */
export async function relayUserTx(signedTxBase64: string, caller?: string): Promise<ConfirmedTx> {
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
		usdcMint: loadDeployment()?.usdcMint,
		tokenPrograms: [tokenProgram()],
	});
	if (violation) throw new RelayerPolicyError(violation);
	// The signed-in caller must be one of the signers: nobody relays transactions for other wallets.
	if (caller && !(caller in tx.signatures && tx.signatures[caller as keyof typeof tx.signatures])) {
		throw new RelayerPolicyError("the transaction must be signed by the signed-in wallet");
	}
	// v3.2 gatekeeper: the agent co-signs claims/deliverables, but only messages the gig board built.
	const agent = await agentSigner().catch(() => null);
	const needsAgent = Boolean(
		agent && agent.address in tx.signatures && !tx.signatures[agent.address as keyof typeof tx.signatures],
	);
	if (needsAgent && !gatekeeperApproved.has(messageHash(tx.messageBytes))) {
		throw new RelayerPolicyError(
			"this claim or delivery wasn't prepared by the gig board; request a new one",
		);
	}
	const missing = Object.entries(tx.signatures).filter(
		([k, v]) => k !== payer.address && !(needsAgent && k === agent?.address) && v === null,
	);
	if (missing.length)
		throw new RelayerPolicyError(`missing signature from ${missing.map(([k]) => k).join(", ")}`);
	const signed = await partiallySignTransaction(
		needsAgent && agent ? [payer.keyPair, agent.keyPair] : [payer.keyPair],
		tx,
	);
	if (needsAgent) gatekeeperApproved.delete(messageHash(tx.messageBytes));
	const signature = await sendAndConfirm(signed);
	invalidateCached(...msg.staticAccounts);
	const instructions = msg.instructions.flatMap((ix) =>
		decodeScoutInstruction(
			msg.staticAccounts[ix.programAddressIndex] ?? "",
			(ix.accountIndices ?? []).map((i) => msg.staticAccounts[i] ?? ""),
			ix.data ?? [],
		),
	);
	return { signature, instructions };
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
	return confirm(signature);
}

/**
 * Wait for `confirmed`. The tx is already sent, so a failed status read (429, timeout) must not surface as a
 * failure, or a client retry would build and send a second transaction (e.g. a double top-up). The public
 * devnet RPC rate-limits per method, so race a websocket notification against HTTP polling that alternates
 * between two methods.
 */
async function confirm(signature: Signature): Promise<Signature> {
	const abort = new AbortController();
	const timeout = new Promise<never>((_, reject) =>
		setTimeout(
			() =>
				reject(
					new TxFailedError(
						`transaction sent but not confirmed within 60 s; check ${explorerTxUrl(signature)} before retrying`,
					),
				),
			60_000,
		),
	);
	const viaWs = (async () => {
		const notifications = await rpcSubscriptions
			.signatureNotifications(signature, { commitment: "confirmed" })
			.subscribe({ abortSignal: abort.signal });
		for await (const n of notifications) {
			if (n.value.err)
				throw new TxFailedError(`transaction failed: ${JSON.stringify(n.value.err, jsonBigint)}`);
			return signature;
		}
		return new Promise<never>(() => {}); // stream ended: leave it to polling
	})().catch((err) => {
		if (err instanceof TxFailedError) throw err;
		return new Promise<never>(() => {}); // websocket unavailable: leave it to polling
	});
	const viaHttp = (async () => {
		for (let i = 0; !abort.signal.aborted; i++) {
			await new Promise((r) => setTimeout(r, 1500));
			const state = await (i % 2 === 0
				? statusViaSignatures(signature)
				: statusViaTransaction(signature)
			).catch(() => null);
			if (state === "failed") throw new TxFailedError(`transaction failed: ${signature}`);
			if (state === "confirmed") return signature;
		}
		return new Promise<never>(() => {});
	})();
	try {
		return await Promise.race([viaWs, viaHttp, timeout]);
	} finally {
		abort.abort();
	}
}

async function statusViaSignatures(signature: Signature) {
	const { value } = await rpc.getSignatureStatuses([signature]).send();
	const st = value[0];
	if (st?.err) return "failed" as const;
	return st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized"
		? ("confirmed" as const)
		: null;
}

async function statusViaTransaction(signature: Signature) {
	const tx = await rpc
		.getTransaction(signature, {
			commitment: "confirmed",
			maxSupportedTransactionVersion: 0,
			encoding: "json",
		})
		.send();
	if (!tx) return null;
	return tx.meta?.err ? ("failed" as const) : ("confirmed" as const);
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
