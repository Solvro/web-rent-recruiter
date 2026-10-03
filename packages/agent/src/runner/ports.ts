/**
 * What the role agent needs from the outside world. Stream B implements these with the DB,
 * the relayer and on-chain transactions (signed as role.agent); the agent never touches them
 * directly. Amounts are USDC base units (bigint).
 */
import type { AgentReview, Criteria } from "@scout/shared";
import type { AgentAction, EscalationDelivery, Payout } from "../gigs/policy.ts";
import type {
	CallAnswer,
	CallReview,
	CallScript,
	CefrLevel,
	GigType,
	GigVariant,
	PlannedGig,
	RecordingMeta,
	RecruiterRecommendation,
	ShortlistEntry,
} from "../gigs/types.ts";

export type GigStatus = "OPEN" | "PAUSED" | "CLOSED";

/** Gig types the backend stores: the shared/on-chain TaskType. */
export type PortTaskType = GigType;

export interface GigView {
	gigId: string;
	taskType: PortTaskType;
	/** SCREENING_CALL only: "language" for language checks; absent means "standard". */
	variant?: GigVariant;
	title: string;
	bounty: bigint;
	maxDeliverables: number;
	acceptedCount: number;
	pendingCount: number;
	status: GigStatus;
	/** For repricing: when it was posted, how many recruiters claimed it, deliveries so far (any status). */
	postedAt?: string;
	claims?: number;
	deliveries?: number;
	/** When the bounty was last raised (repricing waits PRICING.minHoursBetweenRaises between raises). */
	lastRepricedAt?: string;
	/** Screening and reference gigs are about one candidate. */
	candidateId?: string;
}

export type CandidateStage = "sourced" | "screening" | "screened" | "reference" | "referenced" | "rejected";

export interface CandidateView {
	id: string;
	name: string;
	profileUrl: string;
	/** The sourcer's notes (plus anything learned later). */
	notes: string;
	stage: CandidateStage;
	sourcing?: AgentReview;
	screening?: CallReview;
	reference?: CallReview;
	/** Language check (when the role requires a language). */
	language?: CallReview;
}

export interface RoleSnapshot {
	roleId: string;
	title: string;
	criteria: Criteria;
	budget: {
		deposited: bigint;
		paid: bigint;
		/** Vault balance minus everything already promised (pending deliverables + open gig slots). */
		available: bigint;
	};
	gigs: GigView[];
	candidates: CandidateView[];
	/** The company's cap per deliverable (agent_max_bounty); repricing never goes above it. */
	maxBounty?: bigint;
	/** Company paused the agent: it only answers chat, takes no actions. */
	paused: boolean;
	/** Gig types the company paused: no new gigs of these types are posted until resumed. */
	pausedTaskTypes?: PortTaskType[];
}

interface DeliverableBase {
	id: string;
	gigId: string;
	recruiter: { wallet: string; displayName: string };
	submittedAt: string;
	/** Set when the recruiter edited it (e.g. answered a follow-up); triggers a re-review. */
	updatedAt?: string;
}
export type Deliverable =
	| (DeliverableBase & { kind: "sourcing"; candidate: { name: string; profileUrl: string; notes: string } })
	| (DeliverableBase & {
			kind: "screening" | "reference" | "language";
			candidateId: string;
			script: CallScript;
			answers: CallAnswer[];
			/** The recruiter's call; absent for transcript-only deliverables (Recall). */
			recommendation?: RecruiterRecommendation;
			transcript?: string;
			/** Language checks: the recruiter's CEFR estimate. */
			assessedLevel?: CefrLevel;
			/** Recall metadata, used as transcript-integrity checks. */
			recording?: RecordingMeta;
	  });

export interface StoredReview {
	deliverableId: string;
	kind: Deliverable["kind"];
	/** Sourcing deliverables. B creates the candidate row from it on accept. */
	sourcing?: AgentReview;
	/** Screening / reference deliverables. */
	call?: CallReview;
	decision: {
		action: AgentAction;
		reason: string;
		question?: string;
		delivery?: EscalationDelivery;
		/** Calls: "holdback" when there's no recording (released when the candidate confirms). */
		payout?: Payout;
	};
	/** Set once the agent asked the company; the deliverable then waits for the company's call. */
	escalatedAt?: string;
	/** When this review was made; a deliverable updated after it is reviewed again. */
	reviewedAt?: string;
	/** Follow-up questions already sent to the recruiter about this deliverable. */
	followUps?: number;
	/** Set while waiting for the recruiter's answer to a follow-up. */
	followUpAskedAt?: string;
}

export interface DecisionRecord {
	at: string;
	action: AgentAction | "posted" | "booked" | "criteria" | "paused" | "resumed" | "shortlisted";
	reason: string;
	deliverableId?: string;
	candidateId?: string;
	candidateName?: string;
	gigId?: string;
}

export type ActivityKind =
	| "plan"
	| "gig_posted"
	| "review"
	| "accepted"
	| "rejected"
	| "escalated"
	| "booked"
	| "criteria_changed"
	| "gigs_paused"
	| "gigs_resumed"
	| "shortlist"
	| "repriced"
	| "replan"
	| "note";

/** Streamed to the UI: assistant text deltas, tool calls and results. */
export type AgentEvent =
	| { type: "text-delta"; text: string }
	| { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
	| { type: "tool-result"; toolCallId: string; toolName: string; output: unknown }
	| { type: "tool-error"; toolCallId: string; toolName: string; error: string }
	| { type: "finish"; text: string; costUsd: number }
	| { type: "error"; message: string };

export interface RoleAgentPorts {
	getRole(): Promise<RoleSnapshot>;
	listPendingDeliverables(): Promise<Deliverable[]>;
	getDeliverable(id: string): Promise<Deliverable | null>;
	/** Creates the Task on-chain (signed by role.agent) and the gig row. Bounty is already decided in code. */
	postGig(
		gig: PlannedGig & { candidateId?: string; script?: CallScript },
	): Promise<{ gigId: string; signature?: string }>;
	setGigStatus(gigIds: string[], status: Exclude<GigStatus, "CLOSED">): Promise<void>;
	/** Persists a role-level pause per gig type (also blocks booking new gigs of that type). */
	setTaskTypePaused?(taskTypes: PortTaskType[], paused: boolean): Promise<void>;
	saveReview(review: StoredReview): Promise<void>;
	getReview(deliverableId: string): Promise<StoredReview | null>;
	/**
	 * accept_submission signed by role.agent. Calls: pays the recruiter (holdback per decision.payout).
	 * Sourcing: only pre-accepts (creates the candidate-confirmation link, pays nothing) and returns
	 * signature "".
	 */
	acceptDeliverable(id: string, reason: string): Promise<{ signature: string }>;
	/** reject_submission signed by role.agent, with the reason shown to the recruiter. */
	rejectDeliverable(id: string, reason: string): Promise<{ signature: string }>;
	/** Puts a question in the company's inbox; the deliverable stays pending. */
	escalate(input: {
		deliverableId?: string;
		candidateId?: string;
		question: string;
		/** "digest": batch into the company's daily digest (see buildEscalationDigest); default "now". */
		delivery?: EscalationDelivery;
	}): Promise<void>;
	/**
	 * Asks the recruiter one follow-up question on their deliverable (it stays pending). When they
	 * answer, update the deliverable (and `updatedAt`); the agent re-reviews it. Without this port
	 * follow-ups fall back to a digest escalation.
	 */
	askRecruiter?(deliverableId: string, question: string): Promise<void>;
	/**
	 * Every sourcing review in this role, accepted AND rejected (the replanning ladder finds the
	 * must-have most profiles miss). Without it, only accepted candidates' reviews are used.
	 */
	listSourcingReviews?(): Promise<AgentReview[]>;
	/** Changes an open gig's bounty (on-chain + row). Raises only; see repriceRule. */
	repriceGig?(gigId: string, bounty: bigint, reason: string): Promise<{ signature?: string }>;
	updateCriteria(criteria: Criteria, note: string): Promise<void>;
	saveShortlist(entries: ShortlistEntry[]): Promise<void>;
	getDecisionLog(filter: {
		candidateName?: string;
		deliverableId?: string;
		limit?: number;
	}): Promise<DecisionRecord[]>;
	/** agent_activity row + SSE push. */
	log(entry: { kind: ActivityKind; message: string; data?: Record<string, unknown> }): Promise<void>;
	onEvent?(event: AgentEvent): void;
}
