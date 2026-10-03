/**
 * The company as reviewer: its manual review queue (deliverables.queue / deliverables.decide), recruiters'
 * appeals of rejections, and recruiters' answers to the agent's follow-up questions.
 */
import { createHash } from "node:crypto";
import {
	APPEAL_WINDOW_DAYS,
	type AppealDecideRequest,
	type CompanyDeliverable,
	type ManualDecideRequest,
	type UnsignedTx,
} from "@scout/shared";
import { type Address, address, createNoopSigner, getTransactionDecoder } from "@solana/kit";
import {
	getCreateAssociatedTokenIdempotentInstruction,
	getTransferCheckedInstruction,
} from "@solana-program/token";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import type { z } from "zod";
import { confirmationOf, memoIx } from "../agent-runner/confirmations.ts";
import { db, schema } from "../db/index.ts";
import { publish } from "../events.ts";
import { forbidden, HttpError, notFound } from "../http.ts";
import { splitBounty } from "../lib/money.ts";
import { findAta, relayer, requireDeployment, tokenProgram } from "../solana/chain.ts";
import { buildUnsignedTx } from "../solana/tx.ts";
import { deliverableView, logActivity } from "./gigs.ts";
import { decide, loadSubmission } from "./submissions.ts";

const usd = (base: bigint) => `$${(Number(base) / 1e6).toFixed(2).replace(/\.00$/, "")}`;
const messageHash = (wire: string) =>
	createHash("sha256")
		.update(Uint8Array.from(getTransactionDecoder().decode(Buffer.from(wire, "base64")).messageBytes))
		.digest("hex");

// ---- Manual review queue -----------------------------------------------------------------------

export async function companyQueue(wallet: Address, roleId: string): Promise<CompanyDeliverable[]> {
	const [role] = await db.select().from(schema.roles).where(eq(schema.roles.id, roleId));
	if (!role) throw notFound("role");
	if (role.companyWallet !== wallet) throw forbidden("only the role's company can see this");
	const rows = await db
		.select({ sub: schema.submissions, gig: schema.gigs, scout: schema.accounts })
		.from(schema.submissions)
		.innerJoin(schema.gigs, eq(schema.gigs.id, schema.submissions.gigId))
		.leftJoin(schema.accounts, eq(schema.accounts.wallet, schema.submissions.scoutWallet))
		.where(
			and(
				eq(schema.submissions.roleId, roleId),
				eq(schema.submissions.confirmed, true),
				isNotNull(schema.submissions.gigId),
			),
		)
		.orderBy(asc(schema.submissions.submittedAt));
	const out: CompanyDeliverable[] = [];
	for (const { sub, gig, scout } of rows) {
		const appealOpen = sub.status === "REJECTED" && sub.appeal?.status === "OPEN";
		if (sub.status !== "PENDING" && !appealOpen) continue;
		const c = await confirmationOf(sub.id);
		const awaiting = appealOpen
			? "appeal"
			: c?.status === "PENDING"
				? "candidate"
				: c?.status === "YES"
					? "pay"
					: "decision";
		out.push({
			...deliverableView(sub, gig, role, c),
			recruiter: { wallet: sub.scoutWallet, displayName: scout?.displayName ?? "A recruiter" },
			awaiting,
			reviewDeadline: sub.reviewDeadline.toISOString(),
		});
	}
	return out;
}

/** "Accept" / "Reject" with the company's own words (hashed on-chain). */
export async function manualDecide(wallet: Address, input: z.output<typeof ManualDecideRequest>) {
	// On an appealed rejection, accept = overturn and pay, reject = keep it rejected (reasonText = the note).
	const { sub } = await loadSubmission(input.id);
	if (sub.status === "REJECTED" && sub.appeal?.status === "OPEN") {
		return decideAppeal(wallet, {
			id: input.id,
			decision: input.decision === "accept" ? "overturn" : "uphold",
			note: input.reasonText,
		});
	}
	return decide(
		wallet,
		input.id,
		input.decision === "accept"
			? { decision: "accept", reasonText: input.reasonText }
			: { decision: "reject", reasonCode: input.reasonCode ?? "NOT_MATCHING", reasonText: input.reasonText },
	);
}

// ---- Appeals -----------------------------------------------------------------------------------

export async function appeal(wallet: Address, input: { id: string; reason: string }) {
	const { sub, role } = await loadSubmission(input.id);
	if (sub.scoutWallet !== wallet) throw forbidden("only the recruiter who delivered it can appeal");
	if (sub.status !== "REJECTED")
		throw new HttpError(409, "NOT_REJECTED", "Only a rejected deliverable can be appealed.");
	if (sub.appeal) throw new HttpError(409, "ALREADY_APPEALED", "You already appealed this rejection.");
	if (Date.now() - sub.submittedAt.getTime() > APPEAL_WINDOW_DAYS * 86_400_000) {
		throw new HttpError(409, "APPEAL_WINDOW_CLOSED", `Appeals are possible for ${APPEAL_WINDOW_DAYS} days.`);
	}
	const appealRow = {
		status: "OPEN" as const,
		reason: input.reason,
		createdAt: new Date().toISOString(),
		decidedAt: null,
		note: null,
		paid: null,
		signature: null,
	};
	await db.update(schema.submissions).set({ appeal: appealRow }).where(eq(schema.submissions.id, sub.id));
	await logActivity(role.id, "ESCALATED", `Appeal on ${sub.candidateName}: "${input.reason}"`, {
		gigId: sub.gigId,
		deliverableId: sub.id,
		data: { why: sub.rejectText },
	});
	publish({
		type: "submission.updated",
		roleId: role.id,
		submissionId: sub.id,
		scout: wallet,
		message: "appeal.opened",
	});
	return { ok: true };
}

/** Overturn messages built here, by message hash → the appeal they settle (finished in onRelayed). */
const overturns = new Map<string, { submissionId: string; amount: bigint; until: number }>();

export async function decideAppeal(
	wallet: Address,
	input: z.output<typeof AppealDecideRequest>,
): Promise<{ unsignedTx: UnsignedTx | null }> {
	const { sub, role, gig } = await loadSubmission(input.id);
	if (role.companyWallet !== wallet) throw forbidden("only the role's company can decide an appeal");
	if (sub.appeal?.status !== "OPEN")
		throw new HttpError(409, "NO_OPEN_APPEAL", "There is no open appeal on this.");
	if (input.decision === "uphold") {
		await closeAppeal(sub.id, { status: "UPHELD", note: input.note ?? null });
		await logActivity(
			role.id,
			"NOTE",
			`Kept the rejection of ${sub.candidateName}${input.note ? `: ${input.note}` : ""}`,
			{
				deliverableId: sub.id,
			},
		);
		return { unsignedTx: null };
	}
	// The rejection closed the on-chain Submission, so the company pays the recruiter directly: their share of the
	// bounty, without holdback (the platform fee isn't charged on an overturn).
	const { now: amount } = splitBounty(gig?.bounty ?? role.bounty, 0, sub.operatorFeeBps, 0);
	const mint = address(requireDeployment().usdcMint);
	const scout = address(sub.scoutWallet);
	const destination = await findAta(scout, mint);
	const programAddress = tokenProgram();
	const ixs = [
		getCreateAssociatedTokenIdempotentInstruction({
			payer: await relayer(),
			ata: destination,
			owner: scout,
			mint,
			tokenProgram: programAddress,
		}),
		getTransferCheckedInstruction(
			{
				source: await findAta(wallet, mint),
				mint,
				destination,
				authority: createNoopSigner(wallet), // the company signs in its wallet
				amount,
				decimals: 6,
			},
			{ programAddress },
		),
		memoIx(`scout:appeal:${sub.id}`),
	];
	const unsignedTx = await buildUnsignedTx(
		ixs,
		`Accept ${sub.candidateName} after all: pay the recruiter ${usd(amount)}`,
	);
	const now = Date.now();
	for (const [k, v] of overturns) if (v.until < now) overturns.delete(k);
	overturns.set(messageHash(unsignedTx.transaction), {
		submissionId: sub.id,
		amount,
		until: now + 10 * 60_000,
	});
	if (input.note)
		await db
			.update(schema.submissions)
			.set({ appeal: { ...sub.appeal, note: input.note } })
			.where(eq(schema.submissions.id, sub.id));
	return { unsignedTx };
}

async function closeAppeal(
	id: string,
	patch: { status: "OVERTURNED" | "UPHELD"; note?: string | null; paid?: string; signature?: string },
) {
	const [sub] = await db.select().from(schema.submissions).where(eq(schema.submissions.id, id));
	if (!sub?.appeal) return;
	await db
		.update(schema.submissions)
		.set({
			appeal: {
				...sub.appeal,
				status: patch.status,
				note: patch.note === undefined ? sub.appeal.note : patch.note,
				decidedAt: new Date().toISOString(),
				paid: patch.paid ?? null,
				signature: patch.signature ?? null,
			},
		})
		.where(eq(schema.submissions.id, id));
	publish({
		type: "submission.updated",
		roleId: sub.roleId,
		submissionId: id,
		scout: sub.scoutWallet,
		message: `appeal.${patch.status.toLowerCase()}`,
	});
}

/** tx.submit calls this after relaying: an overturn transfer confirmed → the appeal is OVERTURNED. */
export async function onRelayed(signedTx: string, signature: string) {
	const o = overturns.get(messageHash(signedTx));
	if (!o) return;
	overturns.delete(messageHash(signedTx));
	await closeAppeal(o.submissionId, { status: "OVERTURNED", paid: o.amount.toString(), signature });
	const [sub] = await db.select().from(schema.submissions).where(eq(schema.submissions.id, o.submissionId));
	if (sub)
		await logActivity(
			sub.roleId,
			"DELIVERY_ACCEPTED",
			`Appeal accepted: paid the recruiter ${usd(o.amount)} for ${sub.candidateName}`,
			{
				deliverableId: sub.id,
				signature,
			},
		);
}

// ---- Follow-ups -----------------------------------------------------------------------------------

/** The recruiter answers the agent's question: the deliverable counts as updated and is re-reviewed. */
export async function answerFollowUp(wallet: Address, input: { id: string; index: number; answer: string }) {
	const { sub } = await loadSubmission(input.id);
	if (sub.scoutWallet !== wallet) throw forbidden("only the recruiter who delivered it can answer");
	if (sub.status !== "PENDING")
		throw new HttpError(409, "ALREADY_DECIDED", "This deliverable was already decided.");
	const q = sub.followUps[input.index];
	if (!q) throw notFound("question");
	const followUps = sub.followUps.map((f, i) =>
		i === input.index ? { ...f, answer: input.answer, answeredAt: new Date().toISOString() } : f,
	);
	await db
		.update(schema.submissions)
		.set({ followUps, updatedAt: new Date() })
		.where(eq(schema.submissions.id, sub.id));
	await logActivity(sub.roleId, "DELIVERY_RECEIVED", `Recruiter answered: "${q.question}"`, {
		gigId: sub.gigId,
		deliverableId: sub.id,
	});
	publish({
		type: "submission.updated",
		roleId: sub.roleId,
		submissionId: sub.id,
		scout: wallet,
		message: "followup.answered",
	});
	return { ok: true };
}
