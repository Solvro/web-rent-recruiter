import type { AgentReview, Criteria } from "@scout/shared";
import { sql } from "drizzle-orm";
import {
	bigint,
	bigserial,
	boolean,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp({ withTimezone: true, mode: "date" }).notNull().defaultNow();
/** Token amounts in base units (6 decimals). */
const amount = () => bigint({ mode: "bigint" }).notNull().default(sql`0`);

export const accounts = pgTable("accounts", {
	wallet: text().primaryKey(),
	/** Public profile handle, kebab-case display name, unique ("-2" suffix on clashes). */
	slug: text().unique(),
	kind: text().$type<"company" | "scout">().notNull(),
	displayName: text().notNull(),
	avatarUrl: text(),
	companyName: text(),
	/** IANA time zone for booking calls. */
	timeZone: text(),
	createdAt: createdAt(),
});

export const roles = pgTable(
	"roles",
	{
		id: uuid().primaryKey().defaultRandom(),
		/** u64 used in the RoleVault PDA seeds. */
		onchainRoleId: bigserial({ mode: "number" }).notNull().unique(),
		companyWallet: text()
			.notNull()
			.references(() => accounts.wallet),
		title: text().notNull(),
		summary: text().notNull(),
		jobDescription: text().notNull(),
		criteria: jsonb().$type<Criteria>().notNull(),
		/** 16 random bytes, hex. Never leaves the backend. */
		roleSalt: text().notNull(),
		taskType: text().$type<"SOURCING" | "SCREENING_CALL" | "REFERENCE_CHECK">().notNull().default("SOURCING"),
		bounty: amount(),
		maxCandidates: integer().notNull(),
		reviewWindowSeconds: integer().notNull(),
		feeBps: integer().notNull(),
		holdbackBps: integer().notNull().default(0),
		holdbackWindowSeconds: integer().notNull().default(0),
		autoAccept: jsonb().$type<{ enabled: boolean; threshold: number }>(),
		status: text().$type<"DRAFT" | "OPEN" | "CLOSED">().notNull().default("DRAFT"),
		roleVault: text(),
		// Cached on-chain state (indexer + poller keep these fresh).
		deposited: amount(),
		paid: amount(),
		remaining: amount(),
		acceptedCount: integer().notNull().default(0),
		pendingCount: integer().notNull().default(0),
		/** RoleVault.held_back_total */
		heldBack: amount(),
		/** Forfeited recruiter bonds (counted on-chain in total_deposited; shown apart from the company's deposits). */
		bondsForfeited: amount(),
		/** RoleVault.pending_value + open_capacity: what pending deliverables and open gig slots may still cost. */
		committed: amount(),
		pipelineSummary: text(),
		/** Agent-run role (docs/agent-gigs.md): the backend's agent key is role.agent and posts gigs. */
		agentManaged: boolean().notNull().default(false),
		/** role.agent on-chain (synced). Our hosted agent's key = "scout" mode; another key = "custom"; null = "self". */
		agentPubkey: text(),
		/** One-line agent status for the company ("Your agent is screening 3 candidates"). */
		agentStatus: text(),
		/** Company paused its agent (no new gigs, no reviews) until resumed. */
		agentPaused: boolean().notNull().default(false),
		/** Gig types the company told the agent to stop posting (e.g. "pause screenings"). */
		pausedTaskTypes: jsonb()
			.$type<("SOURCING" | "SCREENING_CALL" | "REFERENCE_CHECK")[]>()
			.notNull()
			.default([]),
		/** State the summary was written for (see services/pipeline.ts). */
		pipelineSummaryKey: text(),
		createdAt: createdAt(),
	},
	(t) => [index("roles_company_idx").on(t.companyWallet), index("roles_status_idx").on(t.status)],
);

export const submissions = pgTable(
	"submissions",
	{
		id: uuid().primaryKey().defaultRandom(),
		roleId: uuid()
			.notNull()
			.references(() => roles.id),
		scoutWallet: text()
			.notNull()
			.references(() => accounts.wallet),
		candidateName: text().notNull(),
		// Candidate card (optional, from the scout's submission form).
		candidateAvatarUrl: text(),
		candidateTitle: text(),
		candidateCompany: text(),
		candidateLocation: text(),
		profileUrl: text().notNull(),
		notes: text().notNull(),
		consent: boolean().notNull(),
		// Gig deliverables (agent-run roles). Legacy role-level submissions leave these null.
		gigId: uuid(),
		deliverableType: text().$type<"SOURCING" | "SCREENING_CALL" | "REFERENCE_CHECK">(),
		/** ScreeningDeliverable / ReferenceDeliverable body (answers etc.); sourcing uses the candidate columns. */
		payload: jsonb().$type<Record<string, unknown>>(),
		/** Screening / reference deliverables: the sourced candidate (submission id) they are about. */
		aboutCandidateId: uuid(),
		/** The agent's review of this deliverable (DeliverableReview). */
		agentReview: jsonb().$type<Record<string, unknown>>(),
		/** A rejected deliverable's bond that stayed with the role (BondForfeited). */
		bondForfeited: bigint({ mode: "bigint" }),
		/** The recruiter's appeal of a rejection (AppealView). */
		appeal: jsonb().$type<{
			status: "OPEN" | "OVERTURNED" | "UPHELD";
			reason: string;
			createdAt: string;
			decidedAt: string | null;
			note: string | null;
			paid: string | null;
			signature: string | null;
		}>(),
		/** The agent's follow-up questions to the recruiter and their answers. */
		followUps: jsonb()
			.$type<{ question: string; askedAt: string; answer: string | null; answeredAt: string | null }[]>()
			.notNull()
			.default([]),
		/** Last time the recruiter changed the deliverable (e.g. answered a follow-up): the agent re-reviews. */
		updatedAt: timestamp({ withTimezone: true, mode: "date" }),
		/** Set while the agent is deciding, so two runner ticks never act twice. */
		agentLockedAt: timestamp({ withTimezone: true, mode: "date" }),
		/** SCREENING_CALL: the call notes; sha256 of them is the on-chain evidence_hash. */
		screeningNotes: text(),
		evidenceHash: text(),
		/** Operator fee (bps) of the scout's voucher at submit time; 0 if none. Used to project the payout. */
		operatorFeeBps: integer().notNull().default(0),
		// Actual split, from SubmissionAccepted (null until accepted).
		payoutNow: bigint({ mode: "bigint" }),
		payoutLater: bigint({ mode: "bigint" }),
		operatorFee: bigint({ mode: "bigint" }),
		platformFee: bigint({ mode: "bigint" }),
		holdbackDeadline: timestamp({ withTimezone: true, mode: "date" }),
		outcome: text().$type<"NONE" | "ADVANCED" | "FABRICATED">().notNull().default("NONE"),
		laterStatus: text().$type<"NONE" | "HELD" | "RELEASED" | "REFUNDED">().notNull().default("NONE"),
		laterTx: text(),
		/** hex sha256(roleSalt + normalized profileUrl) */
		candidateHash: text().notNull(),
		onchainAddress: text(),
		/** False until the submit_candidate tx is confirmed. Unconfirmed rows are invisible. */
		confirmed: boolean().notNull().default(false),
		status: text().$type<"PENDING" | "ACCEPTED" | "REJECTED">().notNull().default("PENDING"),
		rejectReason: text().$type<"NOT_MATCHING" | "NOT_INTERESTED" | "ALREADY_IN_PIPELINE" | "OTHER">(),
		/** v3.3: the reject text shown to the recruiter; sha256 of it is the on-chain reason_hash. */
		rejectText: text(),
		autoSettled: boolean().notNull().default(false),
		submittedAt: timestamp({ withTimezone: true, mode: "date" }).notNull().defaultNow(),
		reviewDeadline: timestamp({ withTimezone: true, mode: "date" }).notNull(),
		settlementTx: text(),
		submitTx: text(),
	},
	(t) => [
		uniqueIndex("submissions_role_hash_uq").on(t.roleId, t.candidateHash),
		index("submissions_scout_idx").on(t.scoutWallet),
	],
);

export const agentReviews = pgTable("agent_reviews", {
	submissionId: uuid()
		.primaryKey()
		.references(() => submissions.id),
	review: jsonb().$type<AgentReview>().notNull(),
	createdAt: createdAt(),
});

export const txLog = pgTable(
	"tx_log",
	{
		signature: text().primaryKey(),
		kind: text().notNull(),
		wallet: text(),
		roleId: uuid(),
		submissionId: uuid(),
		processed: boolean().notNull().default(false),
		createdAt: createdAt(),
	},
	(t) => [index("tx_log_role_idx").on(t.roleId)],
);

/** Gigs the agent posts for a role (on-chain Task PDAs). */
export const gigs = pgTable(
	"gigs",
	{
		id: uuid().primaryKey().defaultRandom(),
		roleId: uuid()
			.notNull()
			.references(() => roles.id),
		/** u32 task_id in the Task PDA seeds, per role. */
		onchainTaskId: integer().notNull(),
		taskAddress: text(),
		type: text().$type<"SOURCING" | "SCREENING_CALL" | "REFERENCE_CHECK">().notNull(),
		title: text().notNull(),
		brief: text().notNull(),
		/** Call script for screening / reference gigs (ScriptQuestion[] + the candidate it's about). */
		script: jsonb().$type<Record<string, unknown>>(),
		/** hex sha256 of the brief + script; goes on-chain as brief_hash. */
		briefHash: text().notNull(),
		bounty: bigint({ mode: "bigint" }).notNull(),
		maxDeliverables: integer().notNull(),
		exclusive: boolean().notNull(),
		holdbackBps: integer().notNull().default(0),
		/** DRAFT (planned, not yet on-chain) → POSTING (tx in flight) → OPEN → CLOSED. */
		status: text().$type<"DRAFT" | "POSTING" | "OPEN" | "PAUSED" | "CLOSED">().notNull().default("DRAFT"),
		/** "now" | "after_sourcing" | "after_screening" from the plan. */
		postWhen: text().notNull().default("now"),
		/** SCREENING_CALL flavour: "standard" | "language" (a short language check with its own script). */
		variant: text().$type<"standard" | "language">(),
		aboutCandidateId: uuid(),
		claimantWallet: text(),
		claimedAt: timestamp({ withTimezone: true, mode: "date" }),
		acceptedCount: integer().notNull().default(0),
		pendingCount: integer().notNull().default(0),
		createTx: text(),
		/** Bounty raises by the agent (repricing), oldest first. */
		priceHistory: jsonb().$type<{ bounty: string; at: string; reason: string }[]>().notNull().default([]),
		/** Calls: times the candidate didn't join. */
		noShows: integer().notNull().default(0),
		/** Someone reported the candidate as possibly fake; on hold until the company decides. */
		reported: boolean().notNull().default(false),
		/**
		 * null: a real gig. "show_up_fee": a one-slot task that only pays a recruiter's show-up fee for the gig
		 * `aboutGigId` (hidden from the board, the agent and stats).
		 */
		purpose: text().$type<"show_up_fee">(),
		aboutGigId: uuid(),
		/** Calls: show-up fee offered to the claimant (base units), once per gig. */
		showUpFee: bigint({ mode: "bigint" }),
		createdAt: createdAt(),
	},
	(t) => [
		uniqueIndex("gigs_role_task_uq").on(t.roleId, t.onchainTaskId),
		index("gigs_status_idx").on(t.status),
	],
);

export const claims = pgTable(
	"claims",
	{
		id: uuid().primaryKey().defaultRandom(),
		gigId: uuid()
			.notNull()
			.references(() => gigs.id),
		wallet: text().notNull(),
		claimedAt: createdAt(),
		releasedAt: timestamp({ withTimezone: true, mode: "date" }),
		tx: text(),
	},
	(t) => [index("claims_gig_idx").on(t.gigId)],
);

export const agentActivity = pgTable(
	"agent_activity",
	{
		id: uuid().primaryKey().defaultRandom(),
		roleId: uuid()
			.notNull()
			.references(() => roles.id),
		kind: text().notNull(),
		message: text().notNull(),
		gigId: uuid(),
		deliverableId: uuid(),
		signature: text(),
		data: jsonb().$type<Record<string, unknown>>(),
		createdAt: createdAt(),
	},
	(t) => [index("agent_activity_role_idx").on(t.roleId, t.createdAt)],
);

export const shortlist = pgTable(
	"shortlist",
	{
		roleId: uuid()
			.notNull()
			.references(() => roles.id),
		/** The sourcing submission of the candidate. */
		candidateId: uuid().notNull(),
		rank: integer().notNull(),
		score: integer(),
		agentNote: text().notNull(),
		screening: jsonb().$type<{ summary: string; recommendation: string; recruiter: string }>(),
		reference: jsonb().$type<{ summary: string; recommendation: string; recruiter: string }>(),
		decision: text().$type<"NONE" | "INVITED" | "PASSED" | "ATTENDED">().notNull().default("NONE"),
		decidedAt: timestamp({ withTimezone: true, mode: "date" }),
		decisionTx: text(),
		updatedAt: createdAt(),
	},
	(t) => [uniqueIndex("shortlist_role_candidate_uq").on(t.roleId, t.candidateId)],
);

/** Sign-In-With-Solana sessions (token stored hashed). */
export const sessions = pgTable(
	"sessions",
	{
		tokenHash: text().primaryKey(),
		wallet: text().notNull(),
		expiresAt: timestamp({ withTimezone: true, mode: "date" }).notNull(),
		createdAt: createdAt(),
	},
	(t) => [index("sessions_wallet_idx").on(t.wallet)],
);

/** Verification v2 §1: the candidate confirms interest before a sourcing deliverable is paid. */
export const candidateConfirmations = pgTable(
	"candidate_confirmations",
	{
		/** sha256 of the one-time token in the /c/<token> link (the token itself is never stored). */
		tokenHash: text().primaryKey(),
		submissionId: uuid()
			.notNull()
			.unique()
			.references(() => submissions.id),
		status: text().$type<"PENDING" | "YES" | "NO" | "EXPIRED">().notNull().default("PENDING"),
		/** { interested, availability?, salaryExpectation? } as the candidate answered. */
		answers: jsonb().$type<Record<string, unknown>>(),
		/** sha256(token ‖ timestamp ‖ answer), put on-chain in the accept tx's Memo. */
		proofHash: text(),
		expiresAt: timestamp({ withTimezone: true, mode: "date" }).notNull(),
		respondedAt: timestamp({ withTimezone: true, mode: "date" }),
		/** Kept so the recruiter can re-copy the link (only shown to the deliverable's recruiter). */
		link: text().notNull(),
		/**
		 * interest: a sourced candidate confirms interest (link to the sourcer). call: the candidate confirms a
		 * self-reported call happened (link to the candidate's sourcer, never to the recruiter who claims the call).
		 */
		kind: text().$type<"interest" | "call">().notNull().default("interest"),
		createdAt: createdAt(),
	},
	(t) => [index("candidate_confirmations_status_idx").on(t.status, t.expiresAt)],
);

/** Recruiter skills from three sources: self-declared, operator-verified, and seeded demo history. ("Earned" is computed.) */
export const recruiterSkills = pgTable(
	"recruiter_skills",
	{
		wallet: text().notNull(),
		/** e.g. "engineer:rust", "tech-screener", "lang:en:C2" (same tags as the agent's gigRequirements). */
		skill: text().notNull(),
		source: text().$type<"self" | "operator" | "seeded">().notNull(),
		/** Operator name for operator-verified skills ("Kraków Recruiting Academy"). */
		verifiedBy: text(),
		createdAt: createdAt(),
	},
	(t) => [uniqueIndex("recruiter_skills_uq").on(t.wallet, t.skill, t.source)],
);

/**
 * Demo-only history so the demo personas meet the screening requirements from day one. Always shown as
 * "seeded demo history" next to real counts; never written on-chain.
 */
export const recruiterSeededStats = pgTable(
	"recruiter_seeded_stats",
	{
		wallet: text().notNull(),
		gigType: text().$type<"SOURCING" | "SCREENING_CALL" | "REFERENCE_CHECK">().notNull(),
		accepted: integer().notNull(),
		decided: integer().notNull(),
		advanced: integer().notNull().default(0),
		note: text().notNull().default("seeded demo history"),
		createdAt: createdAt(),
	},
	(t) => [uniqueIndex("recruiter_seeded_stats_uq").on(t.wallet, t.gigType)],
);

/**
 * Claims / deliveries waiting for the role's gatekeeper (an external agent or the company itself) to co-sign.
 * The recruiter already signed; the gatekeeper adds its signature and the relayer sends it.
 */
export const pendingCosigns = pgTable(
	"pending_cosigns",
	{
		id: uuid().primaryKey().defaultRandom(),
		roleId: uuid()
			.notNull()
			.references(() => roles.id),
		gigId: uuid(),
		submissionId: uuid(),
		kind: text().$type<"claim" | "deliver">().notNull(),
		/** Who must co-sign. */
		gatekeeper: text().notNull(),
		/** Recruiter-signed wire transaction (base64), gatekeeper slot empty. */
		transaction: text().notNull(),
		summary: text().notNull(),
		status: text().$type<"PENDING" | "DONE" | "EXPIRED">().notNull().default("PENDING"),
		signature: text(),
		createdAt: createdAt(),
	},
	(t) => [index("pending_cosigns_role_idx").on(t.roleId, t.status)],
);

/**
 * Candidate-level flags, across roles (keyed by the unsalted normalized profile URL hash).
 * FABRICATED: the company confirmed a fake candidate → do-not-contact everywhere. NO_SHOW: a strike.
 * REPORTED: a recruiter's suspicion, pending the company's decision (resolved = dismissed or confirmed).
 */
export const candidateFlags = pgTable(
	"candidate_flags",
	{
		id: uuid().primaryKey().defaultRandom(),
		profileKey: text().notNull(),
		kind: text().$type<"FABRICATED" | "NO_SHOW" | "REPORTED" | "CALL_DENIED">().notNull(),
		roleId: uuid().notNull(),
		/** The sourcing deliverable it is about. */
		submissionId: uuid(),
		gigId: uuid(),
		byWallet: text().notNull(),
		reason: text().notNull(),
		resolvedAt: timestamp({ withTimezone: true, mode: "date" }),
		createdAt: createdAt(),
	},
	(t) => [index("candidate_flags_key_idx").on(t.profileKey, t.kind)],
);
