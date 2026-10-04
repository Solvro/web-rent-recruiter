/**
 * Verification v2 §1: a sourcing deliverable is paid only after the candidate confirms interest.
 *
 * Agent pre-accepts → one-time /c/<token> link → the recruiter sends it to the candidate →
 *   "Yes"  → the agent signs accept_submission + an SPL Memo "scout:confirm:<sha256(token‖ts‖answer)>"
 *   "No" / no answer by review_deadline − margin → the agent signs reject_submission(NOT_INTERESTED).
 */
import { createHash, randomBytes } from "node:crypto";
import { REJECT_REASONS } from "@scout/shared";
import { address, type Instruction } from "@solana/kit";
import { and, eq, lt } from "drizzle-orm";
import { logActivity } from "../api/gigs.ts";
import { onchainAccounts } from "../api/submissions.ts";
import { db, schema } from "../db/index.ts";
import { env } from "../env.ts";
import { publish } from "../events.ts";
import { HttpError } from "../http.ts";
import { applyConfirmedTx } from "../indexer/apply-tx.ts";
import { agentSigner, chainClockOffsetMs } from "../solana/chain.ts";
import { isHosted } from "../solana/gatekeeper.ts";
import { acceptIx, rejectIx } from "../solana/scout.ts";
import { sendAsRelayer } from "../solana/tx.ts";

export const MEMO_PROGRAM_ADDRESS = address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
/** Reject unconfirmed candidates this long before the review deadline (silence must not pay). */
const MARGIN_MS = 30_000;

import { normalizeProfileUrl } from "../lib/candidate-hash.ts";
import { usedBy } from "../lib/devices.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export const memoIx = (text: string): Instruction => ({
	programAddress: MEMO_PROGRAM_ADDRESS,
	accounts: [],
	data: new TextEncoder().encode(text),
});

async function load(submissionId: string) {
	const [row] = await db
		.select({ sub: schema.submissions, role: schema.roles, gig: schema.gigs, scout: schema.accounts })
		.from(schema.submissions)
		.innerJoin(schema.roles, eq(schema.roles.id, schema.submissions.roleId))
		.leftJoin(schema.gigs, eq(schema.gigs.id, schema.submissions.gigId))
		.leftJoin(schema.accounts, eq(schema.accounts.wallet, schema.submissions.scoutWallet))
		.where(eq(schema.submissions.id, submissionId));
	if (!row) throw new Error(`submission ${submissionId} not found`);
	return row;
}

/**
 * Which deliverables wait for the candidate before they are paid: a sourced candidate confirms interest; a
 * self-reported (unrecorded) screening call is confirmed by the candidate as having happened.
 */
export function confirmationKind(
	sub: { deliverableType: string | null; payload: unknown },
	gig: { type: string } | null,
): "interest" | "call" | null {
	if ((gig?.type ?? sub.deliverableType) === "SOURCING") return "interest";
	const p = sub.payload as { type?: string; evidence?: string } | null;
	return p?.type === "SCREENING_CALL" && p.evidence === "self-reported" ? "call" : null;
}

const callKindOf = (gig: { variant: string | null } | null) =>
	gig?.variant === "language" ? "language check" : "screening call";

/** Called instead of paying when the agent accepts a sourced candidate or a self-reported call. Idempotent. */
export async function preAccept(submissionId: string): Promise<{ status: string; link: string | null }> {
	const [existing] = await db
		.select()
		.from(schema.candidateConfirmations)
		.where(eq(schema.candidateConfirmations.submissionId, submissionId));
	if (existing) {
		if (existing.status === "YES") await payConfirmed(submissionId);
		return { status: existing.status, link: existing.link };
	}
	const { sub, role, scout, gig } = await load(submissionId);
	const kind = confirmationKind(sub, gig) ?? "interest";
	const score = (sub.agentReview as { sourcing?: { score?: number } } | null)?.sourcing?.score ?? null;
	const token = randomBytes(24).toString("base64url");
	const link = `${env.publicAppUrl}/c/${token}`;
	// review_deadline is chain time: turn it into wall time before people (and the keeper) see it.
	const expiresAt = new Date(sub.reviewDeadline.getTime() + (await chainClockOffsetMs()) - MARGIN_MS);
	await db
		.insert(schema.candidateConfirmations)
		.values({ tokenHash: sha(token), submissionId, expiresAt, link, kind });
	const firstName = sub.candidateName.split(" ")[0];
	// One line per candidate: this pre-accept line replaces "X sourced Y" (it says who delivered whom).
	await db
		.delete(schema.agentActivity)
		.where(
			and(
				eq(schema.agentActivity.deliverableId, submissionId),
				eq(schema.agentActivity.kind, "DELIVERY_RECEIVED"),
			),
		);
	await logActivity(
		role.id,
		"DELIVERY_ACCEPTED",
		kind === "call"
			? `${scout?.displayName ?? "A recruiter"}'s ${callKindOf(gig)} with ${sub.candidateName} wasn't recorded → waiting for ${firstName} to confirm it happened`
			: `${scout?.displayName ?? "A recruiter"} delivered ${sub.candidateName}${score !== null ? ` → scored ${score}` : ""} → waiting for ${firstName} to confirm interest`,
		{ gigId: sub.gigId, deliverableId: submissionId },
	);
	publish({
		type: "submission.reviewed",
		roleId: role.id,
		submissionId,
		gigId: sub.gigId ?? undefined,
		scout: sub.scoutWallet,
	});
	return { status: "PENDING", link };
}

async function byToken(token: string) {
	const [c] = await db
		.select()
		.from(schema.candidateConfirmations)
		.where(eq(schema.candidateConfirmations.tokenHash, sha(token)));
	if (!c) throw new HttpError(404, "LINK_NOT_FOUND", "This link isn't valid.");
	return c;
}

/** What the candidate sees: role, company descriptor, salary range. Nothing internal. */
export async function candidateView(token: string) {
	const c = await byToken(token);
	const { sub, role, scout, gig } = await load(c.submissionId);
	const [company] = await db
		.select()
		.from(schema.accounts)
		.where(eq(schema.accounts.wallet, role.companyWallet));
	const range = role.criteria.salaryRange;
	return {
		candidateFirstName: sub.candidateName.split(" ")[0] ?? sub.candidateName,
		recruiterName: scout?.displayName ?? "Your recruiter",
		recruiterSlug: scout?.slug ?? null,
		dealBreakers: role.criteria.dealBreakers.map((d) => d.label),
		recruiterAvatarUrl: scout?.avatarUrl ?? null,
		roleTitle: role.title,
		companyDescriptor: company?.companyName ?? "A hiring company",
		summary: role.summary,
		location:
			role.criteria.location.mode === "REMOTE"
				? "Remote"
				: [role.criteria.location.places[0], role.criteria.location.mode.toLowerCase()]
						.filter(Boolean)
						.join(" · "),
		salaryLabel: range
			? `${range.min.toLocaleString("en-US")}–${range.max.toLocaleString("en-US")} ${range.currency} / ${range.period.toLowerCase()}`
			: null,
		status: c.status === "PENDING" && c.expiresAt < new Date() ? ("EXPIRED" as const) : c.status,
		expiresAt: c.expiresAt.toISOString(),
		kind: c.kind,
		callWith: c.kind === "call" ? (scout?.displayName ?? "a recruiter") : null,
		callKind: c.kind === "call" ? callKindOf(gig) : null,
	};
}

const validTimeZone = (tz: string | undefined): tz is string => {
	if (!tz) return false;
	try {
		new Intl.DateTimeFormat("en", { timeZone: tz });
		return true;
	} catch {
		return false;
	}
};

export async function candidateRespond(input: {
	token: string;
	interested: boolean;
	availability?: string;
	salaryExpectation?: string;
	timeZone?: string;
	contactEmail?: string;
	contactPhone?: string;
	reported?: boolean;
	device?: { ip: string | null; ua: string | null };
}) {
	const c = await byToken(input.token);
	// Expired first: a stale link says so, whatever happened to it.
	if (c.status === "EXPIRED" || (c.status === "PENDING" && c.expiresAt < new Date()))
		throw new HttpError(409, "LINK_EXPIRED", "This link has expired.");
	if (c.status !== "PENDING")
		throw new HttpError(409, "ALREADY_ANSWERED", "You already answered. Thank you!");
	const respondedAt = new Date();
	const yes = input.interested && !input.reported;
	// Personal details are kept only on a yes; a "no" (or a report) keeps nothing but the answer.
	const answers = {
		...(c.kind === "call" ? { callHappened: yes } : {}),
		interested: yes,
		...(input.reported ? { reported: true } : {}),
		...(yes && input.availability ? { availability: input.availability } : {}),
		...(yes && input.salaryExpectation ? { salaryExpectation: input.salaryExpectation } : {}),
		...(yes && input.contactEmail ? { contactEmail: input.contactEmail } : {}),
		...(yes && input.contactPhone ? { contactPhone: input.contactPhone } : {}),
		...(yes && validTimeZone(input.timeZone) ? { timeZone: input.timeZone } : {}),
	};
	const proofHash = sha(`${input.token}|${respondedAt.toISOString()}|${JSON.stringify(answers)}`);
	const status = yes ? ("YES" as const) : ("NO" as const);
	// Answered from the device of the recruiter who holds the link (or who claims the call)? Don't pay on it.
	const { sub: about } = await load(c.submissionId);
	const holders = [about.scoutWallet];
	if (c.kind === "call" && about.aboutCandidateId) {
		const [src] = await db
			.select({ w: schema.submissions.scoutWallet })
			.from(schema.submissions)
			.where(eq(schema.submissions.id, about.aboutCandidateId));
		if (src) holders.push(src.w);
	}
	const sameDevice = yes && Boolean(input.device) && usedBy(holders, input.device?.ip, input.device?.ua);
	if (sameDevice) Object.assign(answers, { sameDevice: true });
	const updated = await db
		.update(schema.candidateConfirmations)
		.set({ status, answers, proofHash, respondedAt })
		.where(
			and(
				eq(schema.candidateConfirmations.tokenHash, sha(input.token)),
				eq(schema.candidateConfirmations.status, "PENDING"),
			),
		)
		.returning();
	if (!updated.length) throw new HttpError(409, "ALREADY_ANSWERED", "You already answered. Thank you!");
	if (input.reported) {
		const [who] = await db
			.select()
			.from(schema.accounts)
			.where(eq(schema.accounts.wallet, about.scoutWallet));
		await logActivity(
			about.roleId,
			"ESCALATED",
			`${about.candidateName.split(" ")[0]} reported the message from ${who?.displayName ?? "the recruiter"}`,
			{ gigId: about.gigId, deliverableId: about.id, data: { inbox: true } },
		);
		await rejectUnconfirmed(c.submissionId, "The candidate reported the message", REJECT_REASONS.OTHER);
		return { status };
	}
	if (sameDevice) {
		// Not paid automatically: the company decides (deliverables.decide → accept pays with this proof).
		const stored = (about.agentReview ?? {}) as Record<string, unknown>;
		const reason = "The confirmation came from the recruiter's own device";
		await db
			.update(schema.submissions)
			.set({
				agentReview: {
					...stored,
					decision: { action: "escalate", reason },
					escalatedAt: new Date().toISOString(),
				} as never,
			})
			.where(eq(schema.submissions.id, about.id));
		await logActivity(
			about.roleId,
			"ESCALATED",
			`${about.candidateName}: ${reason.toLowerCase()}. Your call`,
			{
				gigId: about.gigId,
				deliverableId: about.id,
			},
		);
		return { status };
	}
	if (yes) {
		if (c.kind === "interest")
			await db
				.update(schema.submissions)
				.set({ consent: true })
				.where(eq(schema.submissions.id, c.submissionId));
		await payConfirmed(c.submissionId);
	} else if (c.kind === "call") {
		// The candidate says the call never happened: reject (counts against the recruiter) and flag it.
		const { sub } = await load(c.submissionId);
		await db.insert(schema.candidateFlags).values({
			profileKey: sha(normalizeProfileUrl(sub.profileUrl)),
			kind: "CALL_DENIED",
			roleId: sub.roleId,
			submissionId: sub.id,
			gigId: sub.gigId,
			byWallet: "candidate",
			reason: "The candidate says the call didn't happen",
		});
		await rejectUnconfirmed(
			c.submissionId,
			"The candidate says the call didn't happen",
			REJECT_REASONS.OTHER,
		);
		await logActivity(
			sub.roleId,
			"ESCALATED",
			`${sub.candidateName} says the call with the recruiter never happened`,
			{
				gigId: sub.gigId,
				deliverableId: sub.id,
			},
		);
	} else {
		await rejectUnconfirmed(c.submissionId, "The candidate isn't interested");
	}
	return { status };
}

/** The agent signs the accept with the confirmation proof in a Memo. */
async function notifyOwnAgent(roleId: string, sub: { id: string; gigId: string | null }, what: string) {
	await logActivity(roleId, "NOTE", `${what} · waiting for your agent to settle it on-chain`, {
		gigId: sub.gigId,
		deliverableId: sub.id,
	});
}

async function payConfirmed(submissionId: string) {
	const { sub, role, gig } = await load(submissionId);
	if (sub.status !== "PENDING") return;
	const [c] = await db
		.select()
		.from(schema.candidateConfirmations)
		.where(eq(schema.candidateConfirmations.submissionId, submissionId));
	if (c?.status !== "YES" || !c.proofHash) return;
	const what =
		c.kind === "call"
			? `${sub.candidateName} confirmed the call happened`
			: `${sub.candidateName} confirmed interest`;
	// A company's own agent settles itself (agent.deliverables shows stage "candidate_confirmed").
	if (!(await isHosted(role))) return notifyOwnAgent(role.id, sub, what);
	const agent = await agentSigner();
	const ix = await acceptIx({
		...onchainAccounts(sub, role, gig),
		authority: agent.address,
		review: `${what} (${c.proofHash})`,
	});
	const confirmed = await sendAsRelayer([ix, memoIx(`scout:confirm:${c.proofHash}`)], [agent]);
	const [payee] = await db.select().from(schema.accounts).where(eq(schema.accounts.wallet, sub.scoutWallet));
	await applyConfirmedTx(confirmed);
	const [paid] = await db.select().from(schema.submissions).where(eq(schema.submissions.id, submissionId));
	const usd = (b: bigint) => `$${(Number(b) / 1e6).toFixed(2).replace(/\.00$/, "")}`;
	const first = (n: string | null | undefined) => (n ?? "").split(" ")[0] || "the recruiter";
	const score =
		(paid?.agentReview as { sourcing?: { score?: number }; call?: { score?: number } } | null)?.sourcing
			?.score ?? (paid?.agentReview as { call?: { score?: number } } | null)?.call?.score;
	const later = paid?.laterStatus === "HELD" ? (paid.payoutLater ?? 0n) : 0n;
	const callKind =
		gig?.type === "REFERENCE_CHECK"
			? "reference check"
			: gig?.variant === "language"
				? "language check"
				: "screening";
	const line =
		c.kind === "call"
			? `${first(sub.candidateName)} confirmed the ${callKind} happened → paid ${first(payee?.displayName)} ${usd(paid?.payoutNow ?? 0n)}${score !== undefined ? ` (${score})` : ""}${later > 0n ? `, +${usd(later)} once ${first(sub.candidateName)} attends` : ""}.`
			: `${sub.candidateName} confirmed interest → paid ${first(payee?.displayName)} ${usd(paid?.payoutNow ?? 0n)} for sourcing them${score !== undefined ? ` (${score})` : ""}.`;
	await logActivity(role.id, "DELIVERY_ACCEPTED", line, {
		gigId: sub.gigId,
		deliverableId: submissionId,
		signature: confirmed.signature,
		data: { proof: c.proofHash },
	});
}

async function rejectUnconfirmed(
	submissionId: string,
	why: string,
	reasonCode: number = REJECT_REASONS.NOT_INTERESTED,
) {
	const { sub, role, gig } = await load(submissionId);
	if (sub.status !== "PENDING") return;
	if (!(await isHosted(role))) return notifyOwnAgent(role.id, sub, `${why}: ${sub.candidateName}`);
	const agent = await agentSigner();
	const ix = await rejectIx({
		...onchainAccounts(sub, role, gig),
		authority: agent.address,
		reasonCode,
		reasonText: `${why}.`,
	});
	const confirmed = await sendAsRelayer([ix], [agent]);
	await db
		.update(schema.submissions)
		.set({ rejectText: `${why}.` })
		.where(eq(schema.submissions.id, submissionId));
	await applyConfirmedTx(confirmed);
	await logActivity(role.id, "DELIVERY_REJECTED", `${why}: ${sub.candidateName}`, {
		gigId: sub.gigId,
		deliverableId: submissionId,
		signature: confirmed.signature,
	});
}

/** Keeper: unanswered links expire just before the review deadline → reject (silence must not pay). */
export async function expireConfirmations() {
	const due = await db
		.select()
		.from(schema.candidateConfirmations)
		.where(
			and(
				eq(schema.candidateConfirmations.status, "PENDING"),
				lt(schema.candidateConfirmations.expiresAt, new Date()),
			),
		)
		.limit(5);
	for (const c of due) {
		await db
			.update(schema.candidateConfirmations)
			.set({ status: "EXPIRED" })
			.where(eq(schema.candidateConfirmations.tokenHash, c.tokenHash));
		const why =
			c.kind === "call"
				? "The candidate didn't confirm the call in time"
				: "The candidate didn't confirm in time";
		await rejectUnconfirmed(c.submissionId, why).catch((err) =>
			console.warn(`[confirm] expire ${c.submissionId}: ${(err as Error).message}`),
		);
	}
}

/** For the recruiter's DeliverableView. */
export async function confirmationOf(submissionId: string) {
	const [c] = await db
		.select()
		.from(schema.candidateConfirmations)
		.where(eq(schema.candidateConfirmations.submissionId, submissionId));
	return c ?? null;
}
