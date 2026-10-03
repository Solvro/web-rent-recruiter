import { AgentReview, Criteria, TaskType } from "@scout/shared";
import { z } from "zod";

/** Gig types the agent posts: the shared/on-chain TaskType (SOURCING | SCREENING_CALL | REFERENCE_CHECK). */
export const GigType = TaskType;
export type GigType = z.infer<typeof GigType>;

/**
 * Variant of a SCREENING_CALL gig. "language": a short call in the required language, judged on
 * the CEFR scale ($15). "tech": a technical screen run by an engineer (premium, $100+).
 * Off-chain only: on-chain it's an ordinary SCREENING_CALL task.
 */
export const GigVariant = z.enum(["standard", "language", "tech"]);
export type GigVariant = z.infer<typeof GigVariant>;

export const GigWhen = z.enum(["now", "after_sourcing", "after_screening"]);

export const PlannedGig = z.object({
	taskType: GigType,
	/** SCREENING_CALL only; omitted means "standard". */
	variant: GigVariant.optional(),
	title: z.string(),
	brief: z.string(),
	/** USDC base units per accepted deliverable. */
	bounty: z.bigint(),
	maxDeliverables: z.number().int().positive(),
	/** One claimer (screening, reference) vs. open to many recruiters (sourcing). */
	exclusive: z.boolean(),
	when: GigWhen,
});
export type PlannedGig = z.infer<typeof PlannedGig>;

export interface GigPlan {
	gigs: PlannedGig[];
	rationale: string;
	/** Σ bounty × maxDeliverables over all gigs. */
	committed: bigint;
	/** Budget kept back for re-posting gigs (a candidate drops out, a deliverable is rejected). */
	reserve: bigint;
}

// ---- Call scripts (screening + reference) -----------------------------------

export const ScriptQuestion = z.object({
	id: z.string(),
	question: z.string(),
	whatGoodLooksLike: z.string(),
	/** The criterion this question checks, when it maps to one. */
	criterionId: z.string().optional(),
});
export type ScriptQuestion = z.infer<typeof ScriptQuestion>;

export const ScriptCandidate = z.object({ name: z.string(), profileUrl: z.string(), notes: z.string() });
export type ScriptCandidate = z.infer<typeof ScriptCandidate>;

export const CallScript = z.object({
	kind: z.enum(["screening", "reference", "language"]),
	/** Language checks: the language and CEFR level the role requires. */
	language: z.object({ name: z.string(), level: z.enum(["A1", "A2", "B1", "B2", "C1", "C2"]) }).optional(),
	/** Carried so the review can check answers against the profile. */
	candidate: ScriptCandidate,
	questions: z.array(ScriptQuestion),
});
export type CallScript = z.infer<typeof CallScript>;

export const CallAnswer = z.object({ questionId: z.string(), answer: z.string() });
export type CallAnswer = z.infer<typeof CallAnswer>;

/** The recruiter's own call: should the candidate move forward? */
export const RecruiterRecommendation = z.enum(["ADVANCE", "MAYBE", "PASS"]);
export type RecruiterRecommendation = z.infer<typeof RecruiterRecommendation>;

/** Metadata from the call recording (Recall), used for transcript-integrity checks. */
export const RecordingMeta = z.object({
	provider: z.string().optional(),
	durationSeconds: z.number().nonnegative(),
	/** Speaker labels/names as the recorder identified them. */
	speakers: z.array(z.string()),
});
export type RecordingMeta = z.infer<typeof RecordingMeta>;

export const CallDeliverable = z.object({
	script: CallScript,
	/** Recruiter's notes per question. May be empty when a transcript (e.g. a Recall recording) is given. */
	answers: z.array(CallAnswer).default([]),
	/** The recruiter's call; absent for transcript-only deliverables. */
	recommendation: RecruiterRecommendation.optional(),
	transcript: z.string().optional(),
	/** Language checks: the CEFR level the recruiter assessed. */
	assessedLevel: z.enum(["A1", "A2", "B1", "B2", "C1", "C2"]).optional(),
	recording: RecordingMeta.optional(),
});
export type CallDeliverable = z.infer<typeof CallDeliverable>;

export const QuestionCheck = z.object({
	questionId: z.string(),
	missing: z.boolean(),
	generic: z.boolean(),
	contradiction: z.boolean(),
	/** 0-1: how well the answer shows `whatGoodLooksLike` (candidate signal, not work quality). */
	fit: z.number(),
	/** 0-1: work quality of this answer. */
	quality: z.number(),
});
export type QuestionCheck = z.infer<typeof QuestionCheck>;

/**
 * Review of a screening/reference deliverable. `verdict` and `score` judge the recruiter's
 * work (pay or not); `candidateFit` is the candidate signal the shortlist uses.
 */
export const CallReview = z.object({
	verdict: z.enum(["ACCEPT", "REJECT", "ESCALATE"]),
	score: z.number().int().min(0).max(100),
	missing: z.array(z.string()),
	reasons: z.array(z.string()),
	summaryForCompany: z.string(),
	candidateFit: z.number().int().min(0).max(100),
	checks: z.array(QuestionCheck),
	engine: z.enum(["jev", "offline"]),
	/** Prompt-injection patterns found in the deliverable; a flagged deliverable is never auto-accepted. */
	flags: z.array(z.string()).default([]),
	/** "recorded" when a recording/transcript backs the notes; self-reported calls pay with a holdback. */
	confidence: z.enum(["recorded", "self-reported"]).default("self-reported"),
	/** The candidate didn't show up (from recording metadata): no payout, rebook per POLICY. */
	noShow: z.boolean().default(false),
	/** Transcript checks (when a transcript is attached): failed checks lower the score. */
	integrity: z
		.object({
			speakers: z.number().int(),
			durationSeconds: z.number(),
			durationSource: z.enum(["recording", "estimated"]),
			candidateNamed: z.boolean(),
			coverage: z.number(),
			failed: z.array(z.string()),
		})
		.optional(),
	/** Transcript-only deliverables: the answer quoted from the transcript for each question. */
	extractedAnswers: z.array(CallAnswer).optional(),
	/** Language checks only. */
	language: z
		.object({
			required: z.string(),
			cefrLevel: z.enum(["A1", "A2", "B1", "B2", "C1", "C2", "UNKNOWN"]),
			meetsLevel: z.boolean(),
			/** Where the level came from. */
			source: z.enum(["transcript", "recruiter", "notes"]),
		})
		.optional(),
});
export type CallReview = z.infer<typeof CallReview>;
export type CefrLevel = "A1" | "A2" | "B1" | "B2" | "C1" | "C2";

// ---- Shortlist --------------------------------------------------------------

export const ShortlistInput = z.object({
	role: z.object({ title: z.string(), criteria: Criteria }),
	candidates: z.array(
		z.object({
			id: z.string(),
			name: z.string(),
			sourcing: AgentReview,
			screening: CallReview.optional(),
			reference: CallReview.optional(),
			language: CallReview.optional(),
		}),
	),
});
export type ShortlistInput = z.infer<typeof ShortlistInput>;

export interface ShortlistEntry {
	id: string;
	name: string;
	rank: number;
	/** 0-100, deterministic blend of sourcing score and call signals. */
	overall: number;
	stage: "sourced" | "screened" | "referenced";
	summary: string;
}
