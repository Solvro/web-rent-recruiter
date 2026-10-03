/**
 * The company's candidates (candidates.*), the full call detail (company and the recruiter who held the call) and
 * the recruiter's own edits to a pending deliverable (deliverables.edit / withdraw).
 */
import {
	type CallDetail,
	type CandidateDetail,
	type CandidateRow,
	type CandidateStage,
	explorerTxUrl,
	type GigWorkView,
	type PaymentLedgerItem,
	REJECT_REASONS,
	type UnsignedTx,
} from "@scout/shared";
import { type Address, address } from "@solana/kit";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { confirmationOf } from "../agent-runner/confirmations.ts";
import { db, schema } from "../db/index.ts";
import { publish } from "../events.ts";
import { forbidden, HttpError, notFound } from "../http.ts";
import { applyConfirmedTx } from "../indexer/apply-tx.ts";
import { recordingFor } from "../recall/service.ts";
import { agentSigner, fetchProgramAccount } from "../solana/chain.ts";
import { isHosted } from "../solana/gatekeeper.ts";
import { rejectIx } from "../solana/scout.ts";
import { sendAsRelayer } from "../solana/tx.ts";
import { deliverableView, logActivity, requireRoleOwner, roleDecide, toDeliverableReview } from "./gigs.ts";
import { decide, onchainAccounts } from "./submissions.ts";

type SubRow = typeof schema.submissions.$inferSelect;
const str = (v: unknown) => (typeof v === "string" && v ? v : null);
type GigRow = typeof schema.gigs.$inferSelect;

const confirmationView = (c: typeof schema.candidateConfirmations.$inferSelect | null) =>
	c
		? {
				status: c.status === "PENDING" && c.expiresAt < new Date() ? ("EXPIRED" as const) : c.status,
				// Links go to the sourcer only (their own deliverable view), never into these detail views.
				url: null,
				expiresAt: c.expiresAt.toISOString(),
				respondedAt: c.respondedAt?.toISOString() ?? null,
			}
		: null;

async function loadCandidate(candidateId: string) {
	const [sub] = await db.select().from(schema.submissions).where(eq(schema.submissions.id, candidateId));
	if (!sub || sub.deliverableType !== "SOURCING" || !sub.confirmed) throw notFound("candidate");
	return sub;
}

async function requireCandidateOwner(wallet: Address, candidateId: string) {
	const sub = await loadCandidate(candidateId);
	const role = await requireRoleOwner(wallet, sub.roleId);
	return { sub, role };
}

// ---- List ----------------------------------------------------------------------------------------

async function rowsFor(roleId: string, subs: SubRow[]): Promise<CandidateRow[]> {
	if (!subs.length) return [];
	const ids = subs.map((s) => s.id);
	const [calls, gigs, shortlist, confirmations, scouts, activity] = await Promise.all([
		db
			.select()
			.from(schema.submissions)
			.where(and(eq(schema.submissions.roleId, roleId), inArray(schema.submissions.aboutCandidateId, ids))),
		db
			.select()
			.from(schema.gigs)
			.where(
				and(
					eq(schema.gigs.roleId, roleId),
					inArray(schema.gigs.aboutCandidateId, ids),
					isNull(schema.gigs.purpose),
				),
			),
		db.select().from(schema.shortlist).where(eq(schema.shortlist.roleId, roleId)),
		db
			.select()
			.from(schema.candidateConfirmations)
			.where(inArray(schema.candidateConfirmations.submissionId, ids)),
		db
			.select()
			.from(schema.accounts)
			.where(inArray(schema.accounts.wallet, [...new Set(subs.map((s) => s.scoutWallet))])),
		db
			.select({ id: schema.agentActivity.deliverableId, at: schema.agentActivity.createdAt })
			.from(schema.agentActivity)
			.where(and(eq(schema.agentActivity.roleId, roleId), inArray(schema.agentActivity.deliverableId, ids)))
			.orderBy(desc(schema.agentActivity.createdAt)),
	]);
	return subs.map((sub) => {
		const conf = confirmations.find((c) => c.submissionId === sub.id) ?? null;
		const item = shortlist.find((x) => x.candidateId === sub.id);
		const myCalls = calls.filter((c) => c.aboutCandidateId === sub.id);
		const myGigs = gigs.filter((g) => g.aboutCandidateId === sub.id);
		const stage: CandidateStage =
			sub.status === "PENDING"
				? conf?.status === "PENDING"
					? "CONFIRMING"
					: "REVIEWING"
				: sub.status === "REJECTED"
					? "REJECTED"
					: sub.passedAt || item?.decision === "PASSED"
						? "PASSED"
						: item?.decision === "ATTENDED"
							? "ATTENDED"
							: item?.decision === "INVITED"
								? "INVITED"
								: item
									? "SHORTLISTED"
									: myCalls.length || myGigs.some((g) => g.status === "OPEN" || g.status === "PAUSED")
										? "IN_CALLS"
										: "ACCEPTED";
		const times = [
			sub.submittedAt,
			...myCalls.map((c) => c.submittedAt),
			...activity.filter((a) => a.id === sub.id).map((a) => a.at),
			...(item ? [item.updatedAt] : []),
			...(conf?.respondedAt ? [conf.respondedAt] : []),
		];
		const scout = scouts.find((a) => a.wallet === sub.scoutWallet);
		return {
			candidateId: sub.id,
			name: sub.candidateName,
			avatarUrl: sub.candidateAvatarUrl,
			currentTitle: sub.candidateTitle,
			currentCompany: sub.candidateCompany,
			location: sub.candidateLocation,
			profileUrl: sub.profileUrl,
			score: (sub.agentReview as { sourcing?: { score?: number } } | null)?.sourcing?.score ?? null,
			stage,
			sourcedBy: { wallet: sub.scoutWallet, displayName: scout?.displayName ?? "A recruiter" },
			confirmed: conf?.status === "YES",
			lastActivityAt: new Date(Math.max(...times.map((t) => t.getTime()))).toISOString(),
			removed: sub.removed,
		};
	});
}

export async function listCandidates(
	wallet: Address,
	input: { roleId: string; stage?: CandidateStage; includeRemoved?: boolean },
): Promise<CandidateRow[]> {
	await requireRoleOwner(wallet, input.roleId);
	const subs = await db
		.select()
		.from(schema.submissions)
		.where(
			and(
				eq(schema.submissions.roleId, input.roleId),
				eq(schema.submissions.deliverableType, "SOURCING"),
				eq(schema.submissions.confirmed, true),
				...(input.includeRemoved ? [] : [eq(schema.submissions.removed, false)]),
			),
		)
		.orderBy(desc(schema.submissions.submittedAt));
	const rows = await rowsFor(input.roleId, subs);
	return (input.stage ? rows.filter((r) => r.stage === input.stage) : rows).sort((a, b) =>
		b.lastActivityAt.localeCompare(a.lastActivityAt),
	);
}

// ---- Call detail ------------------------------------------------------------------------------------

export async function callDetail(sub: SubRow, gig: GigRow): Promise<CallDetail> {
	const [who] = await db.select().from(schema.accounts).where(eq(schema.accounts.wallet, sub.scoutWallet));
	const payload = (sub.payload ?? {}) as {
		answers?: { questionId: string; answer: string }[];
		recommendation?: "ADVANCE" | "MAYBE" | "PASS";
		assessedLevel?: string;
		refereeName?: string;
		refereeRelation?: string;
		evidence?: "recording" | "self-reported";
		note?: string;
	};
	const call = (sub.agentReview as { call?: Record<string, unknown> } | null)?.call as
		| {
				checks?: {
					questionId: string;
					missing: boolean;
					generic: boolean;
					contradiction: boolean;
					fit: number;
				}[];
				integrity?: { durationSeconds: number; speakers: number; failed: string[] };
				summaryForCompany?: string;
				score?: number;
		  }
		| undefined;
	const questions = ((
		gig.script as { questions?: { id: string; question: string; whatGoodLooksLike: string }[] } | null
	)?.questions ?? []) as { id: string; question: string; whatGoodLooksLike: string }[];
	// Any call can be recorded (screening, language, reference); self-reported ones have no recording row.
	const recording = payload.evidence === "self-reported" ? null : await recordingFor(gig.id, sub.scoutWallet);
	const conf = await confirmationOf(sub.id);
	return {
		deliverableId: sub.id,
		gigId: gig.id,
		kind:
			gig.type === "REFERENCE_CHECK" ? "reference" : gig.variant === "language" ? "language" : "screening",
		recruiter: { wallet: sub.scoutWallet, displayName: who?.displayName ?? "A recruiter" },
		status: sub.status,
		submittedAt: sub.submittedAt.toISOString(),
		questions: questions.map((q) => {
			const c = call?.checks?.find((x) => x.questionId === q.id);
			return {
				id: q.id,
				question: q.question,
				whatGoodLooksLike: q.whatGoodLooksLike ?? "",
				answer: payload.answers?.find((a) => a.questionId === q.id)?.answer ?? null,
				check: c
					? { missing: c.missing, generic: c.generic, contradiction: c.contradiction, fit: c.fit }
					: null,
			};
		}),
		recommendation: payload.recommendation ?? null,
		followUps: sub.followUps,
		recruiterNote: payload.note ?? null,
		assessedLevel: payload.assessedLevel ?? null,
		referee:
			payload.refereeName && payload.refereeRelation
				? { name: payload.refereeName, relation: payload.refereeRelation }
				: null,
		evidence: payload.evidence ?? (recording ? "recording" : null),
		confirmation: conf?.kind === "call" ? confirmationView(conf) : null,
		transcript: recording?.lines ?? null,
		recordingUrl: recording?.mediaUrl ?? null,
		integrity: call?.integrity
			? {
					durationSeconds: call.integrity.durationSeconds,
					speakers: call.integrity.speakers,
					failed: call.integrity.failed,
				}
			: null,
		review: toDeliverableReview(sub, Boolean(conf), gig),
		summary: call?.summaryForCompany ?? null,
		score: call?.score ?? null,
	};
}

// ---- Detail ----------------------------------------------------------------------------------------

export async function candidateDetail(
	wallet: Address,
	candidateId: string,
	roleId: string,
): Promise<CandidateDetail> {
	const { sub, role } = await requireCandidateOwner(wallet, candidateId);
	if (role.id !== roleId) throw notFound("candidate");
	const [row] = await rowsFor(role.id, [sub]);
	const conf = await confirmationOf(sub.id);
	const callRows = await db
		.select({ sub: schema.submissions, gig: schema.gigs, who: schema.accounts })
		.from(schema.submissions)
		.innerJoin(schema.gigs, eq(schema.gigs.id, schema.submissions.gigId))
		.leftJoin(schema.accounts, eq(schema.accounts.wallet, schema.submissions.scoutWallet))
		.where(and(eq(schema.submissions.aboutCandidateId, sub.id), eq(schema.submissions.confirmed, true)))
		.orderBy(schema.submissions.submittedAt);
	const [sourcer] = await db
		.select()
		.from(schema.accounts)
		.where(eq(schema.accounts.wallet, sub.scoutWallet));
	const notes = await db
		.select()
		.from(schema.companyNotes)
		.where(eq(schema.companyNotes.candidateId, sub.id))
		.orderBy(desc(schema.companyNotes.createdAt));
	const paid = [{ sub, gig: null as GigRow | null, who: sourcer ?? null }, ...callRows].filter(
		(x) => x.sub.status === "ACCEPTED",
	);
	return {
		...(row as CandidateRow),
		recruiterNote: sub.notes,
		review: (sub.agentReview as { sourcing?: CandidateDetail["review"] } | null)?.sourcing ?? null,
		confirmation: confirmationView(conf),
		candidateAnswers:
			conf?.status === "YES"
				? {
						availability: str(conf.answers?.availability),
						salaryExpectation: str(conf.answers?.salaryExpectation),
						timeZone: str(conf.answers?.timeZone),
					}
				: null,
		followUps: sub.followUps,
		calls: await Promise.all(callRows.map((c) => callDetail(c.sub, c.gig))),
		payments: paid.map(({ sub: s, gig, who }) => ({
			deliverableId: s.id,
			kind:
				s.deliverableType === "SOURCING"
					? ("sourcing" as const)
					: s.deliverableType === "REFERENCE_CHECK"
						? ("reference" as const)
						: gig?.variant === "language"
							? ("language" as const)
							: ("screening" as const),
			recruiter: who?.displayName ?? "A recruiter",
			now: (s.payoutNow ?? 0n).toString(),
			later: (s.payoutLater ?? 0n).toString(),
			laterStatus: s.laterStatus,
			signature: s.settlementTx,
			explorerUrl: s.settlementTx ? explorerTxUrl(s.settlementTx) : null,
		})),
		notes: notes.map((n) => ({ id: n.id, text: n.text, createdAt: n.createdAt.toISOString() })),
	};
}

// ---- Company actions ---------------------------------------------------------------------------------

export async function addNote(wallet: Address, input: { candidateId: string; text: string }) {
	const { sub, role } = await requireCandidateOwner(wallet, input.candidateId);
	const [n] = await db
		.insert(schema.companyNotes)
		.values({ roleId: role.id, candidateId: sub.id, text: input.text })
		.returning();
	return { id: n.id, text: n.text, createdAt: n.createdAt.toISOString() };
}

export async function deleteNote(wallet: Address, noteId: string) {
	const [n] = await db.select().from(schema.companyNotes).where(eq(schema.companyNotes.id, noteId));
	if (!n) throw notFound("note");
	await requireRoleOwner(wallet, n.roleId);
	await db.delete(schema.companyNotes).where(eq(schema.companyNotes.id, noteId));
	return { ok: true };
}

/** The candidate's open calls stop (off-chain; nothing new gets booked for them). */
async function stopCandidateGigs(roleId: string, candidateId: string) {
	await db
		.update(schema.gigs)
		.set({ status: "PAUSED" })
		.where(
			and(
				eq(schema.gigs.roleId, roleId),
				eq(schema.gigs.aboutCandidateId, candidateId),
				eq(schema.gigs.status, "OPEN"),
			),
		);
}

/** accept / pass a candidate through the existing paths; returns a tx when money moves. */
export async function updateCandidate(
	wallet: Address,
	input: { candidateId: string; stageOverride?: "accept" | "pass"; note?: string },
): Promise<{ unsignedTx: UnsignedTx | null }> {
	const { sub, role } = await requireCandidateOwner(wallet, input.candidateId);
	if (input.note) await addNote(wallet, { candidateId: sub.id, text: input.note });
	if (!input.stageOverride) return { unsignedTx: null };
	if (sub.status === "PENDING") {
		return decide(
			wallet,
			sub.id,
			input.stageOverride === "accept"
				? { decision: "accept" }
				: {
						decision: "reject",
						reasonCode: "NOT_MATCHING",
						reasonText: "The company passed on this candidate.",
					},
		);
	}
	if (input.stageOverride === "accept") {
		if (sub.status === "REJECTED")
			throw new HttpError(
				409,
				"ALREADY_DECIDED",
				"This candidate was rejected; the recruiter can appeal it.",
			);
		if (sub.passedAt) {
			await db.update(schema.submissions).set({ passedAt: null }).where(eq(schema.submissions.id, sub.id));
			await logActivity(role.id, "DECISION", `You moved ${sub.candidateName} back into the pipeline`, {
				deliverableId: sub.id,
			});
			publish({ type: "shortlist.updated", roleId: role.id, submissionId: sub.id });
		}
		return { unsignedTx: null };
	}
	// pass an accepted candidate
	const [item] = await db
		.select()
		.from(schema.shortlist)
		.where(and(eq(schema.shortlist.roleId, role.id), eq(schema.shortlist.candidateId, sub.id)));
	if (item?.decision === "NONE")
		return roleDecide(wallet, { roleId: role.id, candidateId: sub.id, decision: "pass" });
	if (!sub.passedAt && item?.decision !== "PASSED") {
		await db
			.update(schema.submissions)
			.set({ passedAt: new Date() })
			.where(eq(schema.submissions.id, sub.id));
		await stopCandidateGigs(role.id, sub.id);
		await logActivity(role.id, "DECISION", `You passed on ${sub.candidateName}`, { deliverableId: sub.id });
		publish({ type: "shortlist.updated", roleId: role.id, submissionId: sub.id });
	}
	return { unsignedTx: null };
}

/** Pass + hide from the list. */
export async function removeCandidate(wallet: Address, candidateId: string) {
	const r = await updateCandidate(wallet, { candidateId, stageOverride: "pass" });
	await db.update(schema.submissions).set({ removed: true }).where(eq(schema.submissions.id, candidateId));
	return r;
}

// ---- Recruiter: edit / withdraw ----------------------------------------------------------------------

async function requireOwnUndecided(wallet: Address, id: string) {
	const [row] = await db
		.select({ sub: schema.submissions, role: schema.roles, gig: schema.gigs })
		.from(schema.submissions)
		.innerJoin(schema.roles, eq(schema.roles.id, schema.submissions.roleId))
		.leftJoin(schema.gigs, eq(schema.gigs.id, schema.submissions.gigId))
		.where(eq(schema.submissions.id, id));
	if (!row || !row.sub.confirmed) throw notFound("deliverable");
	if (row.sub.scoutWallet !== wallet) throw forbidden("only the recruiter who delivered it");
	const decision = (row.sub.agentReview as { decision?: { action?: string } } | null)?.decision?.action;
	if (row.sub.status !== "PENDING" || (decision && decision !== "follow_up") || (await confirmationOf(id)))
		throw new HttpError(409, "ALREADY_DECIDED", "The agent already decided on this deliverable.");
	return row;
}

export async function editDeliverable(wallet: Address, input: { deliverableId: string; note: string }) {
	const { sub } = await requireOwnUndecided(wallet, input.deliverableId);
	await db
		.update(schema.submissions)
		.set(
			sub.deliverableType === "SOURCING"
				? { notes: input.note, updatedAt: new Date() }
				: {
						payload: { ...((sub.payload ?? {}) as Record<string, unknown>), note: input.note },
						updatedAt: new Date(),
					},
		)
		.where(eq(schema.submissions.id, sub.id));
	publish({
		type: "submission.updated",
		roleId: sub.roleId,
		submissionId: sub.id,
		scout: wallet,
		message: "deliverable.edited",
	});
	return { ok: true };
}

export async function withdrawDeliverable(wallet: Address, id: string) {
	const { sub, role, gig } = await requireOwnUndecided(wallet, id);
	if (!(await isHosted(role)))
		throw new HttpError(
			409,
			"NOT_HOSTED",
			"Ask this role's reviewer to reject it; withdrawals need Scout's agent.",
		);
	const agent = await agentSigner();
	// The program keeps a rejected deliverable's bond in the role: read it before the account closes.
	const onchain = sub.onchainAddress
		? await fetchProgramAccount<{ bondAmount?: bigint | number }>("Submission", address(sub.onchainAddress))
		: null;
	const bondKept = BigInt(onchain?.bondAmount ?? 0);
	const reasonText = "Withdrawn by the recruiter.";
	await db
		.update(schema.submissions)
		.set({ withdrawn: true, rejectText: reasonText })
		.where(eq(schema.submissions.id, sub.id));
	const confirmed = await sendAsRelayer(
		[
			await rejectIx({
				...onchainAccounts(sub, role, gig),
				authority: agent.address,
				reasonCode: REJECT_REASONS.OTHER,
				reasonText,
			}),
		],
		[agent],
	);
	await applyConfirmedTx(confirmed);
	await logActivity(role.id, "NOTE", `The recruiter withdrew ${sub.candidateName}`, {
		deliverableId: sub.id,
		gigId: sub.gigId,
		signature: confirmed.signature,
	});
	return { signature: confirmed.signature, bondKept: bondKept.toString() };
}

// ---- Recruiter: My work detail ---------------------------------------------------------------------

export async function gigWork(wallet: Address, deliverableId: string): Promise<GigWorkView> {
	const [row] = await db
		.select({ sub: schema.submissions, gig: schema.gigs, role: schema.roles, company: schema.accounts })
		.from(schema.submissions)
		.innerJoin(schema.gigs, eq(schema.gigs.id, schema.submissions.gigId))
		.innerJoin(schema.roles, eq(schema.roles.id, schema.submissions.roleId))
		.leftJoin(schema.accounts, eq(schema.accounts.wallet, schema.roles.companyWallet))
		.where(eq(schema.submissions.id, deliverableId));
	if (!row || row.gig.purpose || !row.sub.confirmed) throw notFound("deliverable");
	if (row.sub.scoutWallet !== wallet) throw forbidden("only the recruiter who delivered it");
	const { sub, gig, role } = row;
	const conf = await confirmationOf(sub.id);
	const decision = (sub.agentReview as { decision?: { action?: string } } | null)?.decision?.action;
	const sourcing = gig.type === "SOURCING";
	return {
		work: deliverableView(sub, gig, role, conf),
		kind: sourcing
			? "sourcing"
			: gig.type === "REFERENCE_CHECK"
				? "reference"
				: gig.variant === "language"
					? "language"
					: "screening",
		companyName: row.company?.companyName ?? row.company?.displayName ?? "A hiring company",
		candidateName: sub.candidateName || null,
		criteria: role.criteria,
		call: sourcing ? null : await callDetail(sub, gig),
		rejectText: sub.status === "REJECTED" ? (sub.rejectText ?? null) : null,
		editable: sub.status === "PENDING" && (!decision || decision === "follow_up") && !conf,
		note: sourcing ? sub.notes : ((sub.payload as { note?: string } | null)?.note ?? null),
	};
}

// ---- Company: payments ledger ------------------------------------------------------------------------

export async function rolePayments(wallet: Address, roleId: string): Promise<PaymentLedgerItem[]> {
	await requireRoleOwner(wallet, roleId);
	const rows = await db
		.select({ sub: schema.submissions, gig: schema.gigs, who: schema.accounts })
		.from(schema.submissions)
		.leftJoin(schema.gigs, eq(schema.gigs.id, schema.submissions.gigId))
		.leftJoin(schema.accounts, eq(schema.accounts.wallet, schema.submissions.scoutWallet))
		.where(and(eq(schema.submissions.roleId, roleId), eq(schema.submissions.confirmed, true)))
		.orderBy(desc(schema.submissions.submittedAt));
	const out: PaymentLedgerItem[] = [];
	for (const { sub, gig, who } of rows) {
		const recruiter = who?.displayName ?? "A recruiter";
		const kind =
			gig?.purpose === "show_up_fee"
				? ("show_up_fee" as const)
				: sub.deliverableType === "SOURCING"
					? ("sourcing" as const)
					: sub.deliverableType === "REFERENCE_CHECK"
						? ("reference" as const)
						: gig?.variant === "language"
							? ("language" as const)
							: ("screening" as const);
		if (sub.status === "ACCEPTED")
			out.push({
				deliverableId: sub.id,
				recruiter,
				gigTitle: gig?.title ?? "",
				kind,
				amount: (sub.payoutNow ?? 0n).toString(),
				held: (sub.payoutLater ?? 0n).toString(),
				heldStatus: sub.laterStatus,
				fees: ((sub.platformFee ?? 0n) + (sub.operatorFee ?? 0n)).toString(),
				signature: sub.settlementTx,
				explorerUrl: sub.settlementTx ? explorerTxUrl(sub.settlementTx) : null,
				at: sub.submittedAt.toISOString(),
			});
		// An overturned appeal: the company paid the recruiter directly.
		if (sub.appeal?.status === "OVERTURNED" && sub.appeal.paid)
			out.push({
				deliverableId: sub.id,
				recruiter,
				gigTitle: gig?.title ?? "",
				kind: "appeal",
				amount: sub.appeal.paid,
				held: "0",
				heldStatus: "NONE",
				fees: "0",
				signature: sub.appeal.signature,
				explorerUrl: sub.appeal.signature ? explorerTxUrl(sub.appeal.signature) : null,
				at: sub.appeal.decidedAt ?? sub.submittedAt.toISOString(),
			});
	}
	return out;
}
