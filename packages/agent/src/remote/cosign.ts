/**
 * Gatekeeper co-signing (program v3.2): role.agent co-signs every claim_task and
 * submit_deliverable on its role. The agent only signs a transaction that does exactly that:
 * Scout program instructions of those two kinds, on this role, with this agent as gatekeeper,
 * nothing that moves its own funds, and the expected fee payer.
 */
import type { PendingCosignItem } from "@scout/shared";
import { CLAIM_TASK_DISCRIMINATOR, SUBMIT_DELIVERABLE_DISCRIMINATOR } from "@scout/shared/program";
import {
	type Address,
	getBase64EncodedWireTransaction,
	getCompiledTransactionMessageDecoder,
	getTransactionDecoder,
	type KeyPairSigner,
	partiallySignTransaction,
} from "@solana/kit";

const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";

/** Account positions, from the generated client: [payer, scout, gatekeeper, …roleVault…]. */
const KINDS = [
	{ name: "claim_task", discriminator: CLAIM_TASK_DISCRIMINATOR, gatekeeper: 2, roleVault: 4 },
	{
		name: "submit_deliverable",
		discriminator: SUBMIT_DELIVERABLE_DISCRIMINATOR,
		gatekeeper: 2,
		roleVault: 3,
	},
] as const;

export interface CosignPolicy {
	programId: string;
	roleVault: Address;
	agent: Address;
	/** Fee payer the platform uses (null: the recruiter pays). */
	relayer: string | null;
}

/** null when the transaction is acceptable, otherwise why the agent won't sign it. */
export function checkCosign(wireBase64: string, policy: CosignPolicy): string | null {
	let tx: ReturnType<ReturnType<typeof getTransactionDecoder>["decode"]>;
	let msg: ReturnType<ReturnType<typeof getCompiledTransactionMessageDecoder>["decode"]>;
	try {
		tx = getTransactionDecoder().decode(Buffer.from(wireBase64, "base64"));
		msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
	} catch {
		return "not a valid wire transaction";
	}
	if (msg.version !== 0) return "only v0 transactions are co-signed";
	if (msg.addressTableLookups?.length) return "address lookup tables aren't allowed";
	const keys = msg.staticAccounts;
	if (policy.relayer && keys[0] !== policy.relayer) return "unexpected fee payer";
	if (keys[0] === policy.agent) return "the agent never pays for someone else's transaction";
	if (!(policy.agent in tx.signatures)) return "the agent isn't a signer of this transaction";
	let scoutIxs = 0;
	for (const [i, ix] of msg.instructions.entries()) {
		const program = keys[ix.programAddressIndex];
		if (program === COMPUTE_BUDGET) continue;
		if (program !== policy.programId) return `instruction ${i}: program ${program} isn't allowed`;
		const data = Array.from(ix.data ?? []);
		const kind = KINDS.find((k) => k.discriminator.every((b, j) => data[j] === b));
		if (!kind) return `instruction ${i}: only claim_task and submit_deliverable are co-signed`;
		const accounts = (ix.accountIndices ?? []).map((a: number) => keys[a]);
		if (accounts[kind.roleVault] !== policy.roleVault) return `instruction ${i}: a different role`;
		if (accounts[kind.gatekeeper] !== policy.agent) return `instruction ${i}: the agent isn't the gatekeeper`;
		// The agent's key may appear only as the gatekeeper.
		if (accounts.some((a: string | undefined, pos: number) => a === policy.agent && pos !== kind.gatekeeper))
			return `instruction ${i}: the agent's key is used as another account`;
		scoutIxs++;
	}
	return scoutIxs ? null : "nothing to co-sign";
}

/** Checks and signs pending co-sign requests; returns what it did. */
export async function cosignPending(
	pending: PendingCosignItem[],
	policy: CosignPolicy,
	agent: KeyPairSigner,
	submit: (id: string, signedTx: string) => Promise<unknown>,
	decline: (id: string, reason: string) => Promise<unknown>,
): Promise<string[]> {
	const done: string[] = [];
	for (const p of pending) {
		const problem = checkCosign(p.transaction, policy);
		if (problem) {
			await decline(p.id, problem);
			done.push(`declined ${p.kind} ${p.id}: ${problem}`);
			continue;
		}
		const tx = getTransactionDecoder().decode(Buffer.from(p.transaction, "base64"));
		const signed = await partiallySignTransaction([agent.keyPair], tx);
		await submit(p.id, getBase64EncodedWireTransaction(signed));
		done.push(`co-signed ${p.kind} ${p.id}`);
	}
	return done;
}
