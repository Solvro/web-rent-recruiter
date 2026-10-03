/**
 * Candidates as the company manages them (candidates.*), the full call detail (company and the screener), and
 * the recruiter's own edits to a pending deliverable (deliverables.edit / withdraw).
 */
import { z } from "zod";
import { UnsignedTx } from "./api.ts";
import { AgentReview, BaseUnits, Criteria, Pubkey } from "./domain.ts";
import {
	CandidateConfirmation,
	DeliverableReview,
	DeliverableView,
	FollowUp,
	RecruiterRecommendation,
} from "./gigs.ts";
import { TranscriptLine } from "./recall.ts";

/**
 * REVIEWING: the agent hasn't decided. CONFIRMING: waiting for the candidate's yes. REJECTED. ACCEPTED: sourced,
 * no calls yet. IN_CALLS: a screening / language / reference is open or in review. SHORTLISTED, INVITED,
 * ATTENDED, PASSED: the company's decisions.
 */
export const CandidateStage = z.enum([
	"REVIEWING",
	"CONFIRMING",
	"REJECTED",
	"ACCEPTED",
	"IN_CALLS",
	"SHORTLISTED",
	"INVITED",
	"ATTENDED",
	"PASSED",
]);
export type CandidateStage = z.infer<typeof CandidateStage>;

export const CandidateRow = z.object({
	/** The sourcing deliverable id (same as ShortlistItem.candidateId). */
	candidateId: z.string(),
	name: z.string(),
	avatarUrl: z.string().nullable(),
	currentTitle: z.string().nullable(),
	currentCompany: z.string().nullable(),
	location: z.string().nullable(),
	profileUrl: z.string(),
	score: z.number().int().nullable(),
	stage: CandidateStage,
	sourcedBy: z.object({ wallet: Pubkey, displayName: z.string() }),
	/** The candidate confirmed interest themselves. */
	confirmed: z.boolean(),
	lastActivityAt: z.string(),
	/** candidates.remove: passed and hidden (listed only with includeRemoved). */
	removed: z.boolean(),
});
export type CandidateRow = z.infer<typeof CandidateRow>;

/** roles.candidate: one person, everything about them. */
export const CandidateRequest = z.object({ roleId: z.string().uuid(), candidateId: z.string().uuid() });
export const CandidateListRequest = z.object({
	roleId: z.string().uuid(),
	stage: CandidateStage.optional(),
	includeRemoved: z.boolean().optional(),
});

/** One screening / language / reference call, in full. Readable by the role's company and that recruiter only. */
export const CallDetail = z.object({
	deliverableId: z.string(),
	gigId: z.string(),
	kind: z.enum(["screening", "language", "reference"]),
	recruiter: z.object({ wallet: Pubkey, displayName: z.string() }),
	status: z.enum(["PENDING", "ACCEPTED", "REJECTED"]),
	submittedAt: z.string(),
	questions: z.array(
		z.object({
			id: z.string(),
			question: z.string(),
			whatGoodLooksLike: z.string(),
			answer: z.string().nullable(),
			/** The agent's check of this answer (null until reviewed). */
			check: z
				.object({
					missing: z.boolean(),
					generic: z.boolean(),
					contradiction: z.boolean(),
					/** 0–1: how well the answer shows what good looks like. */
					fit: z.number(),
				})
				.nullable(),
		}),
	),
	recommendation: RecruiterRecommendation.nullable(),
	/** The agent's follow-up questions to the recruiter about this call, with their answers. */
	followUps: z.array(FollowUp),
	/** The recruiter's own note on the call (gigs.edit). */
	recruiterNote: z.string().nullable(),
	/** Language checks. */
	assessedLevel: z.string().nullable(),
	/** References. */
	referee: z.object({ name: z.string(), relation: z.string() }).nullable(),
	/** recording: a Recall notetaker recorded it. self-reported: the candidate confirms it happened. */
	evidence: z.enum(["recording", "self-reported"]).nullable(),
	/** self-reported calls: the candidate's "yes, we talked". */
	confirmation: CandidateConfirmation.nullable(),
	/** Normalized speaker turns from the recording (null when not recorded). */
	transcript: z.array(TranscriptLine).nullable(),
	/** Short-lived media URL from Recall, fetched fresh on every read (null in RECALL_MOCK or when not recorded). */
	recordingUrl: z.string().nullable(),
	/** Transcript checks: duration, speakers, coverage. */
	integrity: z
		.object({ durationSeconds: z.number(), speakers: z.number().int(), failed: z.array(z.string()) })
		.nullable(),
	review: DeliverableReview.nullable(),
	/** The agent's summary for the company (calls). */
	summary: z.string().nullable(),
	score: z.number().int().nullable(),
});
export type CallDetail = z.infer<typeof CallDetail>;

export const CandidatePayment = z.object({
	deliverableId: z.string(),
	kind: z.enum(["sourcing", "screening", "language", "reference", "show_up_fee"]),
	recruiter: z.string(),
	now: BaseUnits,
	later: BaseUnits,
	laterStatus: z.enum(["NONE", "HELD", "RELEASED", "REFUNDED"]),
	signature: z.string().nullable(),
	explorerUrl: z.string().nullable(),
});

export const CompanyNote = z.object({ id: z.string(), text: z.string(), createdAt: z.string() });

export const CandidateDetail = CandidateRow.extend({
	/** The sourcer's note. */
	recruiterNote: z.string(),
	/** The agent's sourcing review: per-criterion verdicts with their reasoning (the evidence). */
	review: AgentReview.nullable(),
	confirmation: CandidateConfirmation.nullable(),
	/** What the candidate told us on /c (when they confirmed interest). */
	candidateAnswers: z
		.object({
			availability: z.string().nullable(),
			salaryExpectation: z.string().nullable(),
			timeZone: z.string().nullable(),
		})
		.nullable(),
	/** The agent's follow-up questions to the sourcer, with their answers. */
	followUps: z.array(FollowUp),
	calls: z.array(CallDetail),
	payments: z.array(CandidatePayment),
	/** Private to the company. */
	notes: z.array(CompanyNote),
});
export type CandidateDetail = z.infer<typeof CandidateDetail>;

/**
 * stageOverride: accept / pass through the existing on-chain paths (a pending candidate: deliverables.decide;
 * a shortlisted one: roles.decide pass). unsignedTx when money moves; note adds a private note.
 */
export const CandidateUpdateRequest = z.object({
	candidateId: z.string().uuid(),
	stageOverride: z.enum(["accept", "pass"]).optional(),
	note: z.string().min(1).max(4000).optional(),
});
export const CandidateUpdateResponse = z.object({ unsignedTx: UnsignedTx.nullable() });
export const AddNoteRequest = z.object({ candidateId: z.string().uuid(), text: z.string().min(1).max(4000) });
export const DeleteNoteRequest = z.object({ noteId: z.string().uuid() });

/** gigs.edit (recruiter): change the note while the deliverable is pending and the agent hasn't decided. */
export const DeliverableEditRequest = z.object({
	deliverableId: z.string().uuid(),
	note: z.string().min(1).max(4000),
});
export const DeliverableRef = z.object({ deliverableId: z.string().uuid() });
/**
 * gigs.withdraw (recruiter): take back a pending deliverable before the agent decides. Scout's agent
 * rejects it on-chain with "Withdrawn by the recruiter" (not counted against them). Any bond stays with the role.
 */
export const DeliverableWithdrawResponse = z.object({ signature: z.string(), bondKept: BaseUnits });

/** gigs.work (recruiter, their own deliverable only): the "My work" detail page. */
export const GigWorkView = z.object({
	/** The same row as gigs.mine. */
	work: DeliverableView,
	kind: z.enum(["sourcing", "screening", "language", "reference"]),
	companyName: z.string(),
	/** The sourced person, or the person the call was about. */
	candidateName: z.string().nullable(),
	/** The role's criteria, to label work.review.candidateReview.verdicts. */
	criteria: Criteria.nullable(),
	/** Calls: questions with text, answers and checks, transcript, recording, evidence, confirmation, summary. */
	call: CallDetail.nullable(),
	/** The rejection in words (the agent's, the company's, or "Withdrawn by the recruiter."). */
	rejectText: z.string().nullable(),
	/** gigs.edit / gigs.withdraw are allowed: pending and the agent hasn't decided. */
	editable: z.boolean(),
	/** The current note (sourcing notes / call note) for the edit box. */
	note: z.string().nullable(),
});
export type GigWorkView = z.infer<typeof GigWorkView>;

/** roles.payments: the budget popover's ledger (who got what, for which gig, with the tx). */
export const PaymentLedgerItem = z.object({
	deliverableId: z.string(),
	recruiter: z.string(),
	gigTitle: z.string(),
	kind: z.enum(["sourcing", "screening", "language", "reference", "show_up_fee", "appeal"]),
	/** Paid to the recruiter now (after fees). */
	amount: BaseUnits,
	/** Held back until the candidate is confirmed / attends; released or refunded later. */
	held: BaseUnits,
	heldStatus: z.enum(["NONE", "HELD", "RELEASED", "REFUNDED"]),
	/** Platform + operator fees on this payment. */
	fees: BaseUnits,
	signature: z.string().nullable(),
	explorerUrl: z.string().nullable(),
	at: z.string(),
});
export type PaymentLedgerItem = z.infer<typeof PaymentLedgerItem>;
