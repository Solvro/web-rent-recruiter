/**
 * Apply a transaction the backend just relayed and saw confirmed, without waiting for the indexer.
 *
 * The decoded instructions say which submission / role the tx touched; their new state is read from the chain
 * (accounts at `confirmed`) and written to the DB, and the matching LiveEvent goes out right away. The indexer
 * later replays the same events from logs with exact amounts; everything here is idempotent and events are
 * de-duplicated by signature (events.ts).
 */
import { type Address, address } from "@solana/kit";
import { eq, sql } from "drizzle-orm";
import { markAttended } from "../api/gigs.ts";
import { db, schema } from "../db/index.ts";
import { publish } from "../events.ts";
import { splitBounty } from "../lib/money.ts";
import { reviewInBackground } from "../services/reviews.ts";
import { enumName, fetchProgramAccount, invalidateCached, type SubmissionAccount } from "../solana/chain.ts";
import type { ConfirmedTx, DecodedScoutIx } from "../solana/tx.ts";
import { refreshGig } from "./gigs.ts";
import { processSignature, reasonFromCode, refreshRole } from "./sync.ts";

const SUBMISSION_IXS = new Set([
	"submit_deliverable",
	"submit_candidate",
	"accept_submission",
	"settle_expired",
	"reject_submission",
	"attest_outcome",
	"release_holdback",
]);

export async function applyConfirmedTx({ signature, instructions }: ConfirmedTx) {
	const vaults = new Set<string>();
	for (const ix of instructions) {
		if (ix.accounts.roleVault) vaults.add(ix.accounts.roleVault);
		if (ix.accounts.scout) invalidateCached(ix.accounts.scout);
		if (SUBMISSION_IXS.has(ix.name) && ix.accounts.submission) await applySubmission(signature, ix);
	}
	for (const v of vaults) await refreshRole(address(v));
	const tasks = new Set(instructions.flatMap((ix) => (ix.accounts.task ? [ix.accounts.task] : [])));
	for (const t of tasks) await refreshGig(t, signature);
	for (const ix of instructions) {
		if (ix.name !== "close_role" || !ix.accounts.roleVault) continue;
		const [role] = await db
			.select({ id: schema.roles.id })
			.from(schema.roles)
			.where(eq(schema.roles.roleVault, ix.accounts.roleVault));
		if (role) publish({ type: "role.closed", roleId: role.id, signature });
	}
	// Exact amounts from the logs + tx_log bookkeeping, in the background.
	processSignature(signature).catch((err) =>
		console.warn(`[apply-tx] processSignature ${signature}: ${(err as Error).message}`),
	);
}

async function applySubmission(signature: string, ix: DecodedScoutIx) {
	const at = ix.accounts.submission as Address;
	const [row] = await db
		.select({ sub: schema.submissions, role: schema.roles })
		.from(schema.submissions)
		.innerJoin(schema.roles, eq(schema.roles.id, schema.submissions.roleId))
		.where(eq(schema.submissions.onchainAddress, at));
	if (!row) return;
	const { sub, role } = row;
	const acc = await fetchProgramAccount<SubmissionAccount>("Submission", at);
	if (!acc) {
		// v3.2: reject_submission closes the account (rent back to the relayer). Apply it from the instruction.
		if (ix.name !== "reject_submission") return;
		await recordCompanyOverride(sub, role, ix, "reject");
		await db
			.update(schema.submissions)
			.set({
				confirmed: true,
				status: "REJECTED",
				rejectReason: reasonFromCode(Number(ix.args.reasonCode ?? 3)),
				settlementTx: sub.settlementTx ?? signature,
			})
			.where(eq(schema.submissions.id, sub.id));
		publish({
			type: "submission.rejected",
			roleId: sub.roleId,
			submissionId: sub.id,
			signature,
			scout: sub.scoutWallet,
			gigId: sub.gigId ?? undefined,
		});
		return;
	}

	const status = enumName(acc.status).toUpperCase() as "PENDING" | "ACCEPTED" | "REJECTED";
	const outcomeName = enumName(acc.outcome);
	const outcome =
		outcomeName === "Advanced" ? "ADVANCED" : outcomeName === "Fabricated" ? "FABRICATED" : "NONE";
	// Agent-run roles price per gig: the role-level bounty is 0 there.
	const [gig] = sub.gigId ? await db.select().from(schema.gigs).where(eq(schema.gigs.id, sub.gigId)) : [];
	const split = splitBounty(
		gig?.bounty ?? role.bounty,
		role.feeBps,
		sub.operatorFeeBps,
		gig?.holdbackBps ?? role.holdbackBps,
	);
	const later =
		sub.payoutLater ?? (BigInt(acc.holdbackAmount) > 0n ? BigInt(acc.holdbackAmount) : split.later);
	const laterStatus =
		status !== "ACCEPTED"
			? "NONE"
			: outcome === "FABRICATED"
				? "REFUNDED"
				: BigInt(acc.holdbackAmount) > 0n
					? "HELD"
					: later > 0n
						? "RELEASED"
						: "NONE";

	await db
		.update(schema.submissions)
		.set({
			confirmed: true,
			status,
			outcome,
			laterStatus,
			reviewDeadline: new Date(Number(acc.reviewDeadline) * 1000),
			...(ix.name === "submit_candidate" ? { submitTx: sub.submitTx ?? signature } : {}),
			...(status === "REJECTED"
				? {
						rejectReason: reasonFromCode(Number(acc.rejectReason)),
						settlementTx: sub.settlementTx ?? signature,
					}
				: {}),
			...(status === "ACCEPTED"
				? {
						// The SubmissionAccepted event (indexer) carries the exact amounts and may land first: keep them.
						payoutNow: sql`coalesce(${schema.submissions.payoutNow}, ${split.now})`,
						payoutLater: later,
						operatorFee: sql`coalesce(${schema.submissions.operatorFee}, ${split.operatorFee})`,
						platformFee: sql`coalesce(${schema.submissions.platformFee}, ${split.platformFee})`,
						holdbackDeadline: acc.holdbackDeadline ? new Date(Number(acc.holdbackDeadline) * 1000) : null,
						settlementTx: sub.settlementTx ?? signature,
						autoSettled: sub.autoSettled || ix.name === "settle_expired",
					}
				: {}),
			...(ix.name === "attest_outcome" || ix.name === "release_holdback" ? { laterTx: signature } : {}),
		})
		.where(eq(schema.submissions.id, sub.id));

	const base = {
		roleId: sub.roleId,
		submissionId: sub.id,
		signature,
		scout: sub.scoutWallet,
		gigId: sub.gigId ?? undefined,
	};
	switch (ix.name) {
		case "submit_deliverable":
		case "submit_candidate":
			publish({ type: "submission.created", ...base });
			if (!sub.confirmed) reviewInBackground(sub.id);
			return;
		case "accept_submission":
		case "settle_expired":
			await recordCompanyOverride(sub, role, ix, "accept");
			publish({ type: "submission.accepted", ...base, payout: (sub.payoutNow ?? split.now).toString() });
			return;
		case "reject_submission":
			await recordCompanyOverride(sub, role, ix, "reject");
			publish({ type: "submission.rejected", ...base });
			return;
		case "attest_outcome": {
			const released = outcome === "ADVANCED" && sub.laterStatus === "HELD" ? later : 0n;
			publish({ type: "submission.outcome", ...base, outcome, payout: released.toString() });
			// "Came to the interview" attests the candidate's deliverables: that's the company's decision landing.
			if (outcome === "ADVANCED") await markAttended(sub.roleId, sub.aboutCandidateId ?? sub.id, signature);
			return;
		}
		case "release_holdback":
			publish({ type: "submission.released", ...base, payout: later.toString() });
			return;
	}
}

/**
 * When the company (not the agent) decides an escalated deliverable, or silence settles it, write that into the
 * agent's stored review so the agent's next pass sees the outcome (e.g. a referenced finalist → shortlist).
 */
async function recordCompanyOverride(
	sub: typeof schema.submissions.$inferSelect,
	role: typeof schema.roles.$inferSelect,
	ix: DecodedScoutIx,
	action: "accept" | "reject",
) {
	const stored = sub.agentReview as {
		decision?: { action: string; reason: string };
		call?: { verdict?: string };
	} | null;
	const byCompany = ix.accounts.authority === role.companyWallet;
	const bySilence = ix.name === "settle_expired";
	if (!stored?.decision || (!byCompany && !bySilence) || stored.decision.action === action) return;
	const reason = bySilence
		? "Accepted automatically: nobody reviewed it in time."
		: `The company decided to ${action} it.`;
	await db
		.update(schema.submissions)
		.set({
			agentReview: {
				...stored,
				decision: { action, reason },
				...(stored.call
					? { call: { ...stored.call, verdict: action === "accept" ? "ACCEPT" : "REJECT" } }
					: {}),
			},
		})
		.where(eq(schema.submissions.id, sub.id));
}
