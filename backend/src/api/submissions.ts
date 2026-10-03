/**
 * Deliverable (Submission) use-cases that aren't the gig flow itself: the company's own decisions on escalated
 * deliverables, permissionless settle / release, outcome attestation, and the duplicate check.
 * Recruiters create deliverables only through gigs (api/gigs.ts); there is no free-form submit any more.
 */
import {
	type AgentReview,
	type CheckDuplicateRequest,
	type CheckDuplicateResponse,
	type DecisionRequest,
	explorerTxUrl,
	fromBaseUnits,
	type OutcomeRequest,
	REJECT_REASON_LABELS,
	REJECT_REASONS,
	type SettleResponse,
	type SubmissionView,
	type UnsignedTx,
} from "@scout/shared";
import { type Address, address, type Instruction } from "@solana/kit";
import { and, desc, eq, or } from "drizzle-orm";
import type { z } from "zod";
import { confirmationKind, confirmationOf, memoIx, preAccept } from "../agent-runner/confirmations.ts";
import { db, schema } from "../db/index.ts";
import { forbidden, HttpError, notFound } from "../http.ts";
import { applyConfirmedTx } from "../indexer/apply-tx.ts";
import { candidateHash, toHex } from "../lib/candidate-hash.ts";
import { splitBounty } from "../lib/money.ts";
import { submissionView } from "../lib/views.ts";
import { ensureReview } from "../services/reviews.ts";
import { agentSigner, fetchProgramAccount, findSubmissionPda } from "../solana/chain.ts";
import { isHosted } from "../solana/gatekeeper.ts";
import { acceptIx, attestOutcomeIx, rejectIx, releaseHoldbackIx, settleExpiredIx } from "../solana/scout.ts";
import { buildUnsignedTx, sendAsRelayer } from "../solana/tx.ts";
import { loadRole } from "./roles.ts";

const usdc = (base: bigint) =>
	`${fromBaseUnits(base).toLocaleString("en-US", { maximumFractionDigits: 2 })} USDC`;

type SubRow = typeof schema.submissions.$inferSelect;
type RoleRow = typeof schema.roles.$inferSelect;
type GigRow = typeof schema.gigs.$inferSelect;

/** Money terms of a deliverable: the gig's bounty/holdback, the role's fee. */
export const termsOf = (role: RoleRow, gig: GigRow | null) => ({
	title: role.title,
	bounty: gig?.bounty ?? role.bounty,
	feeBps: role.feeBps,
	holdbackBps: gig?.holdbackBps ?? role.holdbackBps,
});

/** A confirmed sourced candidate with this hash anywhere in the role (DB), or its Submission under a gig. */
export async function findDuplicate(role: RoleRow, hash: Uint8Array) {
	const [existing] = await db
		.select()
		.from(schema.submissions)
		.where(and(eq(schema.submissions.roleId, role.id), eq(schema.submissions.candidateHash, toHex(hash))));
	let onchain: { submittedAt: bigint } | null = null;
	const sourcing = await db
		.select({ taskAddress: schema.gigs.taskAddress })
		.from(schema.gigs)
		.where(and(eq(schema.gigs.roleId, role.id), eq(schema.gigs.type, "SOURCING")));
	for (const g of sourcing) {
		if (!g.taskAddress || onchain) continue;
		onchain = await fetchProgramAccount<{ submittedAt: bigint }>(
			"Submission",
			await findSubmissionPda(address(g.taskAddress), hash),
		).catch(() => null);
	}
	const firstSubmittedAt = onchain
		? new Date(Number(onchain.submittedAt) * 1000)
		: existing?.confirmed
			? existing.submittedAt
			: null;
	return { existing, firstSubmittedAt };
}

/** Live check for the sourcing form. Says nothing about who submitted the candidate. */
export async function checkDuplicate(
	input: z.output<typeof CheckDuplicateRequest>,
): Promise<z.output<typeof CheckDuplicateResponse>> {
	const { role } = await loadRole(input.roleId);
	const { firstSubmittedAt } = await findDuplicate(role, candidateHash(role.roleSalt, input.profileUrl));
	return firstSubmittedAt
		? { duplicate: true, firstSubmittedAt: firstSubmittedAt.toISOString() }
		: { duplicate: false };
}

export async function requireSubmissionCompany(wallet: Address, id: string) {
	const { role } = await loadSubmission(id);
	if (role.companyWallet !== wallet) throw forbidden("only the role's company can see this");
}

export async function loadSubmission(id: string) {
	const [row] = await db
		.select({ sub: schema.submissions, role: schema.roles, gig: schema.gigs })
		.from(schema.submissions)
		.innerJoin(schema.roles, eq(schema.roles.id, schema.submissions.roleId))
		.leftJoin(schema.gigs, eq(schema.gigs.id, schema.submissions.gigId))
		.where(eq(schema.submissions.id, id));
	if (!row) throw notFound("submission");
	return row;
}

export function onchainAccounts(sub: SubRow, role: RoleRow, gig: GigRow | null) {
	if (!sub.confirmed || !sub.onchainAddress || !role.roleVault || !gig?.taskAddress) {
		throw new HttpError(409, "NOT_ON_CHAIN", "submission is not confirmed on-chain yet");
	}
	return {
		company: address(role.companyWallet),
		scout: address(sub.scoutWallet),
		roleVault: address(role.roleVault),
		task: address(gig.taskAddress),
		submission: address(sub.onchainAddress),
	};
}

function pendingOnchain(sub: SubRow, role: RoleRow, gig: GigRow | null) {
	if (sub.status !== "PENDING")
		throw new HttpError(409, "ALREADY_DECIDED", `submission is already ${sub.status}`);
	return onchainAccounts(sub, role, gig);
}

/** Accepted with the held-back part still undecided (outcome NONE). */
export function acceptedOnchain(sub: SubRow, role: RoleRow, gig: GigRow | null) {
	if (sub.status !== "ACCEPTED") throw new HttpError(409, "NOT_ACCEPTED", "submission is not accepted");
	if (sub.outcome !== "NONE")
		throw new HttpError(409, "OUTCOME_ALREADY_SET", `outcome is already ${sub.outcome}`);
	return onchainAccounts(sub, role, gig);
}

export function payoutLabel(terms: ReturnType<typeof termsOf>, operatorFeeBps: number) {
	const s = splitBounty(terms.bounty, terms.feeBps, operatorFeeBps, terms.holdbackBps);
	return s.later > 0n ? `${usdc(s.now)} now + ${usdc(s.later)} once the candidate is confirmed` : usdc(s.now);
}

/** Recruiter's deliverables (all gig types), newest first. */
export async function mySubmissions(wallet: Address): Promise<SubmissionView[]> {
	const rows = await db
		.select({ sub: schema.submissions, scout: schema.accounts, role: schema.roles, gig: schema.gigs })
		.from(schema.submissions)
		.innerJoin(schema.accounts, eq(schema.accounts.wallet, schema.submissions.scoutWallet))
		.innerJoin(schema.roles, eq(schema.roles.id, schema.submissions.roleId))
		.leftJoin(schema.gigs, eq(schema.gigs.id, schema.submissions.gigId))
		.where(and(eq(schema.submissions.scoutWallet, wallet), eq(schema.submissions.confirmed, true)))
		.orderBy(desc(schema.submissions.submittedAt));
	return rows.map((r) => submissionView(r.sub, r.scout, null, termsOf(r.role, r.gig)));
}

export async function reviewSubmission(id: string): Promise<AgentReview> {
	const { sub } = await loadSubmission(id);
	if (!sub.confirmed) throw new HttpError(409, "NOT_ON_CHAIN", "submission is not confirmed on-chain yet");
	return ensureReview(sub.id);
}

/** The company's own call on a deliverable (e.g. one the agent escalated). */
export async function decide(
	wallet: Address,
	id: string,
	input: z.output<typeof DecisionRequest>,
): Promise<{ unsignedTx: UnsignedTx | null }> {
	const { sub, role, gig } = await loadSubmission(id);
	if (role.companyWallet !== wallet) throw forbidden("only the role's company can decide");
	const accounts = pendingOnchain(sub, role, gig);
	if (Date.now() > sub.reviewDeadline.getTime()) {
		throw new HttpError(
			409,
			"REVIEW_WINDOW_EXPIRED",
			"The review window has passed: the deliverable is auto-accepted. Settle it instead.",
		);
	}
	if (input.decision === "accept") {
		const review = input.reasonText?.trim() || `Accepted by the company: ${sub.candidateName}`;
		const memo: Instruction[] = [];
		if (confirmationKind(sub, gig)) {
			// Same rule as the agent: the candidate's confirmation releases the payout. With Scout's agent it pays
			// on confirmation; when the company reviews itself, "Accept and pay" after the candidate said yes.
			const c = await confirmationOf(sub.id);
			if (c?.status !== "YES" || !c.proofHash || (await isHosted(role))) {
				await preAccept(sub.id);
				return { unsignedTx: null };
			}
			memo.push(memoIx(`scout:confirm:${c.proofHash}`));
		}
		await saveDecisionText(sub.id, review);
		const ix = await acceptIx({ ...accounts, authority: wallet, review });
		return {
			unsignedTx: await buildUnsignedTx(
				[ix, ...memo],
				`Accept ${sub.candidateName}: the recruiter gets ${payoutLabel(termsOf(role, gig), sub.operatorFeeBps)}`,
			),
		};
	}
	const reasonText = input.reasonText?.trim()
		? input.reasonText.trim()
		: `Rejected by the company: ${REJECT_REASON_LABELS[input.reasonCode]}.`;
	await db
		.update(schema.submissions)
		.set({ rejectText: reasonText })
		.where(eq(schema.submissions.id, sub.id));
	const ix = await rejectIx({
		...accounts,
		authority: wallet,
		reasonCode: REJECT_REASONS[input.reasonCode],
		reasonText,
	});
	return { unsignedTx: await buildUnsignedTx([ix], `Reject ${sub.candidateName}`) };
}

/** The company's own words on an accept (review_hash is its sha256): kept with the review for the recruiter. */
async function saveDecisionText(id: string, text: string) {
	const [row] = await db
		.select({ r: schema.submissions.agentReview })
		.from(schema.submissions)
		.where(eq(schema.submissions.id, id));
	const r = (row?.r ?? {}) as Record<string, unknown>;
	await db
		.update(schema.submissions)
		.set({
			agentReview: {
				...r,
				companyDecision: { action: "accept", reason: text, at: new Date().toISOString() },
			} as never,
		})
		.where(eq(schema.submissions.id, id));
}

/** Permissionless auto-accept after the review window (the relayer signs). */
export async function settle(id: string): Promise<z.output<typeof SettleResponse>> {
	const { sub, role, gig } = await loadSubmission(id);
	const accounts = pendingOnchain(sub, role, gig);
	if (Date.now() <= sub.reviewDeadline.getTime()) {
		throw new HttpError(
			409,
			"REVIEW_WINDOW_OPEN",
			`auto-accept is possible after ${sub.reviewDeadline.toISOString()}`,
		);
	}
	// v3.3: settling a SOURCING deliverable needs an attestor. Our key attests only what it saw: the candidate
	// confirmed on our page. It may sign as role.agent (hosted roles) or as the task's confirmation_attestor (a
	// self-hosted agent named us as its backstop). Silence never pays.
	let attestor: Awaited<ReturnType<typeof agentSigner>> | null = null;
	const memo: Instruction[] = [];
	if (gig?.type === "SOURCING") {
		const agent = await agentSigner();
		const task = await fetchProgramAccount<{ confirmationAttestor: string | null }>("Task", accounts.task);
		if (role.agentPubkey !== agent.address && task?.confirmationAttestor !== agent.address) {
			throw new HttpError(
				409,
				"NOT_ATTESTOR",
				"Only the role's own agent or company can settle a sourcing deliverable.",
			);
		}
		const c = await confirmationOf(sub.id);
		if (c?.status !== "YES" || !c.proofHash || (c.answers as { sameDevice?: boolean } | null)?.sameDevice) {
			throw new HttpError(
				409,
				"NOT_CONFIRMED",
				"A sourced candidate is paid only after they confirm interest.",
			);
		}
		attestor = agent;
		memo.push(memoIx(`scout:confirm:${c.proofHash}`));
	} else if (confirmationKind(sub, gig) === "call") {
		// An unrecorded call pays only once the candidate confirmed it happened, even by timeout.
		const c = await confirmationOf(sub.id);
		if (c?.status !== "YES" || !c.proofHash || (c.answers as { sameDevice?: boolean } | null)?.sameDevice) {
			throw new HttpError(
				409,
				"NOT_CONFIRMED",
				"An unrecorded call is paid only after the candidate confirms it happened.",
			);
		}
		memo.push(memoIx(`scout:confirm:${c.proofHash}`));
	}
	const confirmed = await sendAsRelayer(
		[await settleExpiredIx({ ...accounts, attestor: attestor?.address }), ...memo],
		attestor ? [attestor] : [],
	);
	await applyConfirmedTx(confirmed);
	return { signature: confirmed.signature, explorerUrl: explorerTxUrl(confirmed.signature) };
}

/** "Came to interview" (advanced) / "Report a problem" (fabricated) on a single deliverable. */
export async function attestOutcome(
	wallet: Address,
	id: string,
	input: z.output<typeof OutcomeRequest>,
): Promise<{ unsignedTx: UnsignedTx }> {
	const { sub, role, gig } = await loadSubmission(id);
	if (role.companyWallet !== wallet) throw forbidden("only the role's company can confirm the outcome");
	const accounts = acceptedOnchain(sub, role, gig);
	const later = sub.payoutLater ?? 0n;
	const held = sub.laterStatus === "HELD" && later > 0n;
	if (
		input.outcome === "fabricated" &&
		(!held || (sub.holdbackDeadline && Date.now() > sub.holdbackDeadline.getTime()))
	) {
		throw new HttpError(
			409,
			"HOLDBACK_WINDOW_EXPIRED",
			"A problem can only be reported while the recruiter's held-back payout is still held.",
		);
	}
	const ix = await attestOutcomeIx({
		...accounts,
		authority: wallet,
		outcome: input.outcome === "advanced" ? "Advanced" : "Fabricated",
		reasonCode: input.reasonCode,
	});
	const summary =
		input.outcome === "advanced"
			? `Confirm ${sub.candidateName}${held ? ` and release ${usdc(later)} to the recruiter` : ""}`
			: `Report a problem with ${sub.candidateName}: ${usdc(later)} returns to your budget`;
	return { unsignedTx: await buildUnsignedTx([ix], summary) };
}

/** Permissionless release of the held-back part after its window (the relayer signs). */
export async function release(id: string): Promise<z.output<typeof SettleResponse>> {
	const { sub, role, gig } = await loadSubmission(id);
	const accounts = acceptedOnchain(sub, role, gig);
	if (sub.laterStatus !== "HELD") throw new HttpError(409, "NOTHING_HELD_BACK", "nothing is held back");
	if (!sub.holdbackDeadline || Date.now() <= sub.holdbackDeadline.getTime()) {
		throw new HttpError(
			409,
			"HOLDBACK_WINDOW_OPEN",
			`the held-back payout can be released after ${sub.holdbackDeadline?.toISOString() ?? "acceptance"}`,
		);
	}
	const confirmed = await sendAsRelayer([await releaseHoldbackIx(accounts)]);
	await applyConfirmedTx(confirmed);
	return { signature: confirmed.signature, explorerUrl: explorerTxUrl(confirmed.signature) };
}

/** Accepted deliverables of a candidate (sourcing + its screening/reference) whose outcome is still open. */
export async function openDeliverablesOfCandidate(candidateId: string) {
	return db
		.select({ sub: schema.submissions, gig: schema.gigs })
		.from(schema.submissions)
		.leftJoin(schema.gigs, eq(schema.gigs.id, schema.submissions.gigId))
		.where(
			and(
				eq(schema.submissions.status, "ACCEPTED"),
				eq(schema.submissions.outcome, "NONE"),
				or(eq(schema.submissions.id, candidateId), eq(schema.submissions.aboutCandidateId, candidateId)),
			),
		);
}
