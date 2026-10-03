/**
 * Agent-run hiring with human gigs (docs/agent-gigs.md). The company funds the role and its agent; the agent
 * posts gigs, recruiters claim and deliver, the agent reviews and pays, the company decides on the shortlist.
 */
import { z } from "zod";
import { CandidateInfo, SubmissionPayout, UnsignedTx } from "./api.ts";
import { AgentReview, BaseUnits, Pubkey, RejectReason, Seniority, WorkMode } from "./domain.ts";

export const GigType = z.enum(["SOURCING", "SCREENING_CALL", "REFERENCE_CHECK"]);
export type GigType = z.infer<typeof GigType>;
/** PAUSED: the agent (or the company through it) took the gig off the board for now. */
export const GigStatus = z.enum(["DRAFT", "OPEN", "PAUSED", "CLOSED"]);

/** One question of the agent's script for a screening or reference call. */
export const ScriptQuestion = z.object({
	id: z.string(),
	question: z.string(),
	/** What a good answer should establish (shown to the recruiter as guidance). */
	whatGoodLooksLike: z.string(),
	/** The criterion this question checks, when it maps to one. */
	criterionId: z.string().optional(),
});
export type ScriptQuestion = z.infer<typeof ScriptQuestion>;

/**
 * The person a screening / reference gig is about. Privacy: until a recruiter takes the gig, everyone except
 * that recruiter and the company sees only `summary` (redacted: true; identifying fields null).
 */
export const GigCandidate = z.object({
	redacted: z.boolean(),
	/** Anonymized: e.g. { headline: "Senior backend engineer · 7 yrs", city: "Warsaw", seniority: "SENIOR" }. */
	summary: z.object({ headline: z.string(), city: z.string().nullable(), seniority: z.string().nullable() }),
	id: z.string().nullable(),
	name: z.string().nullable(),
	profileUrl: z.string().nullable(),
	card: CandidateInfo.nullable(),
	/** What the candidate told us on their confirmation page (claimant and company only; null when redacted). */
	availability: z.string().nullable().optional(),
	salaryExpectation: z.string().nullable().optional(),
});
export type GigCandidate = z.infer<typeof GigCandidate>;

/** Who may take a gig (the agent's gigRequirements; enforced at the gatekeeper co-sign). */
export const GigRequirementsView = z.object({
	minAccepted: z.number().int(),
	/** 0–1 acceptance rate over the window. */
	minRate: z.number(),
	windowDays: z.number().int(),
	/** One of these skills is required (empty: none). */
	skills: z.array(z.string()),
	/** Plain-language summary for the gig card. */
	summary: z.string(),
});
export const GigEligibility = z.object({ allowed: z.boolean(), reason: z.string(), needsBond: z.boolean() });

/**
 * The job post as recruiters see it on every gig: from the role's criteria and summary only (no private notes,
 * no budget, no other recruiters' candidates).
 */
export const GigPost = z.object({
	title: z.string(),
	companyDescriptor: z.string(),
	/** "Warsaw, Kraków" or null when remote-only. */
	location: z.string().nullable(),
	workMode: WorkMode,
	seniority: Seniority,
	salaryRange: z
		.object({ min: z.number(), max: z.number(), currency: z.string(), period: z.enum(["YEAR", "MONTH"]) })
		.nullable(),
	mustHave: z.array(z.string()),
	niceToHave: z.array(z.string()),
	dealBreakers: z.array(z.string()),
	languages: z.array(z.string()),
	summary: z.string(),
});
export type GigPost = z.infer<typeof GigPost>;

export const GigView = z.object({
	id: z.string(),
	roleId: z.string(),
	roleTitle: z.string(),
	companyName: z.string(),
	type: GigType,
	/** SCREENING_CALL flavour: a regular screening ("standard") or a language check (e.g. 15 min in German). */
	variant: z.enum(["standard", "language"]).nullable(),
	status: GigStatus,
	/** The role's location, for the board filter. */
	city: z.string().nullable(),
	remote: z.boolean(),
	/** Never contains the candidate's name unless the viewer took the gig (or is the company). */
	title: z.string(),
	brief: z.string(),
	/** SCREENING_CALL / REFERENCE_CHECK: the questions the deliverable must answer. Null when `redacted`. */
	script: z.array(ScriptQuestion).nullable(),
	/** Candidate details and script are hidden from this viewer (they haven't taken the gig). */
	redacted: z.boolean(),
	candidate: GigCandidate.nullable(),
	bounty: BaseUnits,
	/** What a recruiter without an operator earns per accepted deliverable (now + held back). */
	payout: z.object({ now: BaseUnits, later: BaseUnits }),
	maxDeliverables: z.number().int(),
	acceptedCount: z.number().int(),
	pendingCount: z.number().int(),
	slotsLeft: z.number().int(),
	/** Exclusive gigs (screening, reference) have one claimant. */
	exclusive: z.boolean(),
	claimant: z
		.object({ wallet: Pubkey, displayName: z.string(), avatarUrl: z.string().nullable() })
		.nullable(),
	claimedByMe: z.boolean(),
	taskAddress: Pubkey.nullable(),
	createdAt: z.string(),
	requirements: GigRequirementsView,
	/** For the signed-in recruiter: can they take / deliver to this gig? null when not signed in. */
	eligibility: GigEligibility.nullable(),
	/** Bounty raises by the agent (repricing), oldest first. */
	priceHistory: z.array(z.object({ bounty: BaseUnits, at: z.string(), reason: z.string() })),
	/** The job post (same in gigs.list and gigs.byId). */
	post: GigPost.optional(),
	/** Calls: when the current recruiter took it (the 24 h to hold the call run from here). */
	claimedAt: z.string().nullable().optional(),
	/** Calls: times the candidate didn't join (1 = rescheduled once; 2 = gig closed, nothing against the recruiter). */
	noShows: z.number().int().optional(),
	/** Calls: IANA time zones for booking ("Europe/Warsaw"); null when unknown (fall back to the city). */
	candidateTimeZone: z.string().nullable().optional(),
	recruiterTimeZone: z.string().nullable().optional(),
	/**
	 * Calls, claimant only: the role pays a show-up fee when the notetaker joined but the candidate didn't.
	 * OFFERED: claim it with gigs.claimShowUpFee (one signature). PAID: done (signature on-chain).
	 */
	showUpFee: z
		.object({ amount: BaseUnits, status: z.enum(["OFFERED", "PAID"]), signature: z.string().nullable() })
		.nullable()
		.optional(),
	/** Someone reported the candidate as possibly fake: the gig is on hold until the company decides. */
	reported: z.boolean().optional(),
});
export type GigView = z.infer<typeof GigView>;

// ---- Deliverables -------------------------------------------------------------

export const ScriptAnswer = z.object({ questionId: z.string(), answer: z.string().min(1) });
/** The recruiter's own call on the candidate (screening and reference). */
export const RecruiterRecommendation = z.enum(["ADVANCE", "MAYBE", "PASS"]);

export const SourcingDeliverable = z.object({
	type: z.literal("SOURCING"),
	name: z.string().min(1),
	profileUrl: z.string().url(),
	notes: z.string().min(1),
	/** The candidate agreed to be presented. */
	/** @deprecated Consent now comes from the candidate's own confirmation (verification v2). Ignored if sent. */
	consent: z.boolean().optional(),
	candidate: CandidateInfo.partial().optional(),
});
export const ScreeningDeliverable = z.object({
	type: z.literal("SCREENING_CALL"),
	answers: z.array(ScriptAnswer).min(1),
	recommendation: RecruiterRecommendation,
	/** Ignored when the call was recorded: the server uses the Recall transcript as evidence. */
	transcript: z.string().optional(),
	/** Set by the server: "recording" (Recall transcript) or "self-reported" (needs candidate confirmation). */
	evidence: z.enum(["recording", "self-reported"]).optional(),
	/** Language checks: the level the recruiter assessed. */
	assessedLevel: z.enum(["A1", "A2", "B1", "B2", "C1", "C2"]).optional(),
});
export const ReferenceDeliverable = z.object({
	type: z.literal("REFERENCE_CHECK"),
	refereeName: z.string().min(1),
	refereeRelation: z.string().min(1),
	answers: z.array(ScriptAnswer).min(1),
	recommendation: RecruiterRecommendation,
});
export const Deliverable = z.discriminatedUnion("type", [
	SourcingDeliverable,
	ScreeningDeliverable,
	ReferenceDeliverable,
]);
export type Deliverable = z.infer<typeof Deliverable>;

/** The agent's review of a deliverable. */
export const DeliverableReview = z.object({
	/** FOLLOW_UP: the agent asked the recruiter a question; the deliverable stays pending. */
	verdict: z.enum(["ACCEPT", "REJECT", "ESCALATE", "FOLLOW_UP"]),
	reasons: z.array(z.string()),
	/** SOURCING: the candidate score review. */
	candidateReview: AgentReview.nullable(),
	reviewedAt: z.string(),
});
export type DeliverableReview = z.infer<typeof DeliverableReview>;

/** Verification v2 §1: the candidate's own "yes" before a sourcing deliverable is paid. */
export const CandidateConfirmation = z.object({
	status: z.enum(["PENDING", "YES", "NO", "EXPIRED"]),
	/** One-time link the recruiter sends the candidate (only shown to that recruiter). */
	url: z.string().nullable(),
	expiresAt: z.string(),
	respondedAt: z.string().nullable(),
});
export type CandidateConfirmation = z.infer<typeof CandidateConfirmation>;

export const FollowUp = z.object({
	question: z.string(),
	askedAt: z.string(),
	answer: z.string().nullable(),
	answeredAt: z.string().nullable(),
});
export type FollowUp = z.infer<typeof FollowUp>;

/**
 * A rejected recruiter asks the company to look again (within APPEAL_WINDOW_DAYS, once). OVERTURNED: the company
 * paid the recruiter directly (the on-chain Submission is closed by the rejection); UPHELD: the rejection stands.
 */
export const AppealView = z.object({
	status: z.enum(["OPEN", "OVERTURNED", "UPHELD"]),
	reason: z.string(),
	createdAt: z.string(),
	decidedAt: z.string().nullable(),
	/** The company's note to the recruiter. */
	note: z.string().nullable(),
	/** OVERTURNED: what the company paid and the transfer. */
	paid: BaseUnits.nullable(),
	signature: z.string().nullable(),
});
export type AppealView = z.infer<typeof AppealView>;
export const APPEAL_WINDOW_DAYS = 7;

export const DeliverableView = z.object({
	id: z.string(),
	gigId: z.string(),
	gigType: GigType,
	/** SCREENING_CALL flavour (null for other types). */
	gigVariant: z.enum(["standard", "language"]).nullable().optional(),
	gigTitle: z.string(),
	roleId: z.string(),
	roleTitle: z.string(),
	status: z.enum(["PENDING", "ACCEPTED", "REJECTED"]),
	/** null until the agent has looked at it ("The agent is checking your work"). */
	review: DeliverableReview.nullable(),
	deliverable: Deliverable,
	payout: SubmissionPayout.nullable(),
	submittedAt: z.string(),
	settlementTx: z.string().nullable(),
	/** SOURCING after the agent pre-accepted: "send this link to the candidate". */
	confirmation: CandidateConfirmation.nullable(),
	/** The agent's questions about this deliverable; answering one makes it re-review. */
	followUps: z.array(FollowUp).optional(),
	/**
	 * Sourcer only: self-reported calls about this candidate waiting for the candidate's "yes, we talked".
	 * Send them the link (the recruiter who claims the call never sees it).
	 */
	callChecks: z
		.array(
			z.object({
				deliverableId: z.string(),
				recruiterName: z.string(),
				callKind: z.string(),
				status: z.enum(["PENDING", "YES", "NO", "EXPIRED"]),
				url: z.string().nullable(),
				expiresAt: z.string(),
			}),
		)
		.optional(),
	/** The recruiter's appeal of a rejection, and the company's answer. */
	appeal: AppealView.nullable().optional(),
});
export type DeliverableView = z.infer<typeof DeliverableView>;

// ---- Requests ------------------------------------------------------------------

export const GigListRequest = z
	.object({
		roleId: z.string().uuid().optional(),
		type: GigType.optional(),
		includeClosed: z.boolean().optional(),
	})
	.optional();
export const GigClaimResponse = z.object({ unsignedTx: UnsignedTx });
export const GigDeliverRequest = z.object({ gigId: z.string().uuid(), deliverable: Deliverable });
export const GigDeliverResponse = z.object({ deliverableId: z.string(), unsignedTx: UnsignedTx });

// ---- Company views ---------------------------------------------------------------

export const AgentActivityKind = z.enum([
	"PLANNED",
	"GIG_POSTED",
	"GIG_CLAIMED",
	"DELIVERY_RECEIVED",
	"REVIEWED",
	"DELIVERY_ACCEPTED",
	"DELIVERY_REJECTED",
	"ESCALATED",
	"SHORTLISTED",
	"DECISION",
	"BUDGET",
	"ERROR",
	// Company ↔ agent thread (roles.message)
	"COMPANY_MESSAGE",
	"AGENT_MESSAGE",
	"TOOL",
	"PAUSED",
	"RESUMED",
	"CRITERIA_UPDATED",
	"NOTE",
	"REPRICED",
	"REPLANNED",
]);
export const AgentActivity = z.object({
	id: z.string(),
	roleId: z.string(),
	kind: AgentActivityKind,
	/** Company-facing sentence, e.g. "Accepted 6 profiles", "Booked a screening for Karolina". */
	message: z.string(),
	/** The "why" behind the step (the agent's reasons), when there is one. */
	detail: z.string().optional(),
	gigId: z.string().nullable(),
	deliverableId: z.string().nullable(),
	signature: z.string().nullable(),
	explorerUrl: z.string().nullable(),
	/** Solscan link for the tx (shows the agent as signer). */
	solscanUrl: z.string().nullable(),
	createdAt: z.string(),
});
export type AgentActivity = z.infer<typeof AgentActivity>;

export const RoleActivity = z.object({
	/** One-line agent status: "Your agent is screening 3 candidates". */
	status: z.string(),
	/** What the agent is doing right now, while a step runs ("Reviewing Karolina's screening notes"). */
	working: z.string().optional(),
	items: z.array(AgentActivity),
});

export const ShortlistItem = z.object({
	candidateId: z.string(),
	name: z.string(),
	profileUrl: z.string(),
	card: CandidateInfo,
	score: z.number().int().nullable(),
	agentNote: z.string(),
	screening: z.object({ summary: z.string(), recommendation: z.string(), recruiter: z.string() }).nullable(),
	reference: z.object({ summary: z.string(), recommendation: z.string(), recruiter: z.string() }).nullable(),
	/** INVITED = "Invite to interview"; ATTENDED = "Came to the interview" (releases the recruiters' holdbacks). */
	decision: z.enum(["NONE", "INVITED", "PASSED", "ATTENDED"]),
	decidedAt: z.string().nullable(),
});
export type ShortlistItem = z.infer<typeof ShortlistItem>;

/** roles.decide: "Invite to interview" attests Advanced on the candidate's deliverables (releases holdbacks). */
export const RoleDecideRequest = z.object({
	roleId: z.string().uuid(),
	candidateId: z.string(),
	/**
	 * invite: "Invite to interview" (recorded, nothing paid). pass: "Pass". attended: "Came to the interview" →
	 * returns a tx attesting Advanced on the candidate's deliverables, which releases the recruiters' holdbacks.
	 */
	decision: z.enum(["invite", "pass", "attended"]),
});
/** unsignedTx is null unless decision is "attended" (and something is still held). */
/** roles.message: talk to the role's agent. The reply streams as `agent.message` / `agent.tool` events. */
export const RoleMessageRequest = z.object({ roleId: z.string().uuid(), text: z.string().min(1).max(4000) });
export const RoleMessageResponse = z.object({ messageId: z.string() });

export const RoleDecideResponse = z.object({
	unsignedTx: UnsignedTx.nullable(),
	/** attended: what each recruiter gets released once the tx confirms (their held-back parts). */
	releases: z
		.array(
			z.object({ recruiter: z.string(), wallet: Pubkey, amount: BaseUnits, deliverables: z.number().int() }),
		)
		.optional(),
});

// ---- Candidate confirmation page (/c/<token>, public) -------------------------------

export const CandidateViewRequest = z.object({ token: z.string().min(16) });
/** What the candidate sees: no internal brief, no other candidates, no budget. */
export const CandidateView = z.object({
	candidateFirstName: z.string(),
	recruiterName: z.string(),
	roleTitle: z.string(),
	companyDescriptor: z.string(),
	summary: z.string(),
	location: z.string().nullable(),
	salaryLabel: z.string().nullable(),
	status: z.enum(["PENDING", "YES", "NO", "EXPIRED"]),
	expiresAt: z.string(),
	/**
	 * interest (default): "Are you interested in this role?". call: "Did you talk to <callWith> about this role?"
	 * (a self-reported screening call; yes releases the recruiter's payment, no rejects it).
	 */
	kind: z.enum(["interest", "call"]).optional(),
	/** call: the recruiter who says they held the call, and what kind of call. */
	callWith: z.string().nullable().optional(),
	callKind: z.string().nullable().optional(),
});
export const CandidateConfirmRequest = z.object({
	token: z.string().min(16),
	interested: z.boolean(),
	availability: z.string().max(500).optional(),
	salaryExpectation: z.string().max(200).optional(),
	/** The candidate's IANA time zone (the page sends Intl's), so recruiters book calls in their time. */
	timeZone: z.string().max(64).optional(),
});
export const CandidateConfirmResponse = z.object({ status: z.enum(["YES", "NO"]) });

export * from "./reputation.ts";

// ---- Agent cockpit (roles.status) --------------------------------------------------------

/** One budget snapshot, used by the company UI and the agent alike. "available" = what the agent can still commit. */
export const BudgetSnapshot = z.object({
	/** The company's deposits only (forfeited bonds apart). */
	deposited: BaseUnits,
	bondsForfeited: BaseUnits.optional(),
	paid: BaseUnits,
	heldBack: BaseUnits,
	/** Pending deliverables + open gig slots. */
	committed: BaseUnits,
	available: BaseUnits,
});
/**
 * A one-click fix the company can apply to a waiting item. id → procedure:
 * raise_price → roles.raiseGigPrice({gigId, bounty}); loosen_requirement → roles.loosenRequirement({roleId,
 * criterionId}); resend_confirmation → candidate.resendConfirmation({deliverableId}); decide → deliverables.decide;
 * invite / pass / attended → roles.decide; report_candidate / dismiss_report → roles.reportCandidate / dismissReport.
 */
export const WaitingAction = z.object({
	id: z.enum([
		"raise_price",
		"loosen_requirement",
		"resend_confirmation",
		"decide",
		"invite",
		"pass",
		"attended",
		"report_candidate",
		"dismiss_report",
		/** The agent asked something that needs no form: "Got it" → roles.ackEscalation({roleId, activityId}). */
		"acknowledge",
	]),
	label: z.string(),
	activityId: z.string().optional(),
	/** invite / pass / attended / report_candidate / dismiss_report: the candidate (= their sourcing deliverable id). */
	candidateId: z.string().optional(),
	gigId: z.string().optional(),
	deliverableId: z.string().optional(),
	criterionId: z.string().optional(),
	/** raise_price: the suggested new bounty (base units). */
	bounty: BaseUnits.optional(),
});
export type WaitingAction = z.infer<typeof WaitingAction>;
export const WaitingOn = z.object({
	who: z.enum(["candidate", "recruiter", "company", "chain"]),
	what: z.string(),
	since: z.string(),
	deadline: z.string().nullable(),
	gigId: z.string().nullable(),
	deliverableId: z.string().nullable(),
	/** When this usually happens by (since + the typical duration); null when there's no norm. */
	expectedBy: z.string().nullable().optional(),
	/** Past expectedBy: show it amber and offer the actions. */
	slow: z.boolean().optional(),
	actions: z.array(WaitingAction).optional(),
});
export const RoleStatusView = z.object({
	roleId: z.string(),
	/** What the agent is doing right now (or its status line when idle). */
	now: z.object({
		text: z.string(),
		since: z.string(),
		busy: z.boolean(),
		/** The current sub-step while busy, e.g. "Scoring Karolina against 6 must-haves". */
		detail: z.string().nullable().optional(),
		/** Same as since (when the current work or status started). */
		startedAt: z.string().optional(),
	}),
	waitingOn: z.array(WaitingOn),
	pipeline: z.object({
		sourcingAccepted: z.number().int(),
		sourcingSlots: z.number().int(),
		confirmed: z.number().int(),
		screeningDone: z.number().int(),
		screeningSlots: z.number().int(),
		languageDone: z.number().int(),
		referenceDone: z.number().int(),
		shortlisted: z.number().int(),
	}),
	budget: BudgetSnapshot,
	nextCheckAt: z.string().nullable(),
});
export type RoleStatusView = z.infer<typeof RoleStatusView>;

// ---- Manual review (the company is the reviewer) and appeals -------------------------------

/** deliverables.queue: what the company has to act on for one role. */
export const CompanyDeliverable = DeliverableView.extend({
	recruiter: z.object({ wallet: Pubkey, displayName: z.string() }),
	/**
	 * decision: accept or reject it. candidate: waiting for the candidate's confirmation (nothing to do).
	 * pay: the candidate confirmed; "Accept and pay" signs the payout. appeal: the recruiter appealed a rejection.
	 */
	awaiting: z.enum(["decision", "candidate", "pay", "appeal"]),
	reviewDeadline: z.string(),
});
export type CompanyDeliverable = z.infer<typeof CompanyDeliverable>;

/**
 * deliverables.decide: free-text reason; its sha256 goes on-chain (review_hash / reason_hash). On a rejected
 * deliverable with an open appeal: accept = overturn and pay (a USDC transfer to sign), reject = keep it rejected.
 */
export const ManualDecideRequest = z.object({
	id: z.string().uuid(),
	decision: z.enum(["accept", "reject"]),
	reasonText: z.string().min(1).max(1000),
	/** Reject only: the category recorded on-chain. Default NOT_MATCHING. */
	reasonCode: RejectReason.optional(),
});
export const ManualDecideResponse = z.object({ unsignedTx: UnsignedTx.nullable() });

export const AppealRequest = z.object({ id: z.string().uuid(), reason: z.string().min(10).max(1000) });
/** "Accept and pay" (overturn → a USDC transfer to sign) / "Keep rejected" (uphold → nothing to sign). */
export const AppealDecideRequest = z.object({
	id: z.string().uuid(),
	decision: z.enum(["overturn", "uphold"]),
	note: z.string().max(500).optional(),
});
export const AppealDecideResponse = z.object({ unsignedTx: UnsignedTx.nullable() });

export const AnswerFollowUpRequest = z.object({
	id: z.string().uuid(),
	index: z.number().int().min(0),
	answer: z.string().min(1).max(4000),
});

// ---- Screening quality: no-shows, show-up fees, fake-candidate reports -------------------------------

/** gigs.noShow (claimant): the candidate didn't join. 1st: +24 h to reschedule. 2nd: the gig closes. */
export const NoShowResponse = z.object({
	noShows: z.number().int(),
	status: GigStatus,
	/** Until when the call can still happen (claimedAt + 24 h after a reschedule). */
	deadline: z.string(),
	/** Offered when the notetaker was in the meeting (the recruiter showed up). */
	showUpFee: z.object({ amount: BaseUnits }).nullable(),
});
export const ShowUpFeeResponse = z.object({ unsignedTx: UnsignedTx });

/** gigs.report (recruiter on a call gig): "this candidate may be fake". The company decides. */
export const ReportGigRequest = z.object({ gigId: z.string().uuid(), reason: z.string().min(5).max(1000) });
/**
 * roles.reportCandidate (company): the candidate is fake. Attests Fabricated on the sourcing deliverable (its
 * held-back part returns to the budget, the sourcer is flagged), puts the person on do-not-contact and stops
 * their gigs. unsignedTx null when nothing is held back any more (flag and do-not-contact still apply).
 */
export const ReportCandidateRequest = z.object({
	roleId: z.string().uuid(),
	/** The sourcing deliverable id (ShortlistItem.candidateId). */
	candidateId: z.string().uuid(),
	reason: z.string().min(5).max(1000),
});
export const ReportCandidateResponse = z.object({ ok: z.boolean(), unsignedTx: UnsignedTx.nullable() });
/** roles.dismissReport (company): the report was wrong; the candidate's gigs reopen. */
export const DismissReportRequest = z.object({ roleId: z.string().uuid(), candidateId: z.string().uuid() });

// ---- In-the-loop actions (company) ------------------------------------------------------------------

/** Raise an open gig's bounty: our agent closes the task and reposts it at the new price (one tx). */
export const RaiseGigPriceRequest = z.object({ gigId: z.string().uuid(), bounty: BaseUnits });
export const RaiseGigPriceResponse = z.object({ gigId: z.string(), signature: z.string() });
/** Move a must-have to the nice-to-haves; pending sourced profiles are scored again. */
export const LoosenRequirementRequest = z.object({ roleId: z.string().uuid(), criterionId: z.string() });
/** The company read an inbox question from the agent (waitingOn action "acknowledge"). */
export const AckEscalationRequest = z.object({ roleId: z.string().uuid(), activityId: z.string().uuid() });
/** A fresh link for a pending candidate confirmation (the old link stops working). url: only for the sourcer. */
export const ResendConfirmationRequest = z.object({ deliverableId: z.string().uuid() });
export const ResendConfirmationResponse = z.object({ url: z.string().nullable(), expiresAt: z.string() });
