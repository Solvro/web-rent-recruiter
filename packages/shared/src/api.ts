/**
 * REST contract between /app and /backend. Both sides import these schemas;
 * the backend validates requests with them, the app parses responses with them.
 *
 * Identity (hackathon scope): every request carries `x-wallet: <base58 pubkey>`
 * of the logged-in embedded wallet. Anything that moves money is still enforced
 * on-chain by the user's own signature, so a spoofed header can't move funds.
 */
import { z } from "zod";
import {
	AgentReview,
	BaseUnits,
	Criteria,
	Pubkey,
	RejectReason,
	RoleStatus,
	SubmissionStatus,
	TaskType,
} from "./domain.ts";
import { RecruiterReputation, RecruiterSkill } from "./reputation.ts";

/** @deprecated The server no longer trusts this header; send `Authorization: Bearer <session token>` (auth.verify). */
export const WALLET_HEADER = "x-wallet";

// ---- Auth: Sign-In-With-Solana ---------------------------------------------------
/**
 * 1. auth.nonce({ wallet }) → { message } ; 2. the wallet signs `message` (UTF-8 bytes, ed25519);
 * 3. auth.verify({ wallet, message, signature: base64 }) → { token } ; 4. send `Authorization: Bearer <token>`
 * (httpBatchLink headers) and `connectionParams: { token }` (httpSubscriptionLink).
 */
export const AuthNonceRequest = z.object({ wallet: Pubkey });
export const AuthNonceResponse = z.object({ message: z.string(), expiresAt: z.string() });
export const AuthVerifyRequest = z.object({
	wallet: Pubkey,
	message: z.string(),
	/** ed25519 signature of the UTF-8 message, base64 (base58 also accepted). */
	signature: z.string(),
});
export const AuthVerifyResponse = z.object({ token: z.string(), wallet: Pubkey, expiresAt: z.string() });

/** A transaction built by the backend with the relayer as fee payer, waiting for the user's signature. */
export const UnsignedTx = z.object({
	/** base64 wire transaction (v0), relayer signature slot empty. */
	transaction: z.string(),
	/** Human summary shown before signing, e.g. "Deposit 200 USDC into role budget". */
	summary: z.string(),
	/**
	 * Set when someone else must co-sign after you (the role's own agent or the company): sign, then send it with
	 * tx.submitForCosign instead of tx.submit.
	 */
	cosigner: Pubkey.optional(),
});
export type UnsignedTx = z.infer<typeof UnsignedTx>;

/** Organization that vouched for a recruiter on-chain (e.g. a recruiting academy). Takes `feeBps` of each payout. */
export const OperatorInfo = z.object({ name: z.string(), feeBps: z.number().int() });
export type OperatorInfo = z.infer<typeof OperatorInfo>;

export const Outcome = z.enum(["NONE", "ADVANCED", "FABRICATED"]);
export type Outcome = z.infer<typeof Outcome>;

// ---- Me / profiles ---------------------------------------------------------

export const AccountKind = z.enum(["company", "scout"]);
export const UpsertMeRequest = z.object({
	kind: AccountKind,
	displayName: z.string().min(1),
	avatarUrl: z.string().nullable().optional(), // absolute URL or /avatars/<file>
	/** Companies only. */
	companyName: z.string().optional(),
	/** IANA time zone, e.g. "Europe/Warsaw" (shown next to the candidate's when booking calls). */
	timeZone: z.string().max(64).optional(),
});
export const Me = z.object({
	wallet: Pubkey,
	kind: AccountKind,
	displayName: z.string(),
	/** URL-safe handle for the public profile, e.g. "ola-wisniewska" (unique). */
	slug: z.string(),
	avatarUrl: z.string().nullable(),
	companyName: z.string().nullable(),
	timeZone: z.string().nullable().optional(),
	/** Scouts: whether ScoutProfile exists on-chain. If false, POST /scouts/register first. */
	scoutRegistered: z.boolean(),
	usdcBalance: BaseUnits,
	/** Scouts: the operator that vouched for them on-chain, if any. */
	operator: OperatorInfo.nullable(),
	/** Scouts: skills by source and the quality score. */
	skills: z.array(RecruiterSkill).optional(),
	reputation: RecruiterReputation.optional(),
});
export type Me = z.infer<typeof Me>;

// ---- Roles -----------------------------------------------------------------

export const DraftRoleRequest = z.object({ jobDescription: z.string().min(50) });
export const DraftRoleResponse = z.object({
	title: z.string(),
	summary: z.string(),
	criteria: Criteria,
	suggestedBounty: BaseUnits,
	suggestedMaxCandidates: z.number().int().positive(),
	rationale: z.string(),
});
export type DraftRoleResponse = z.infer<typeof DraftRoleResponse>;

export const CreateRoleRequest = z.object({
	title: z.string(),
	summary: z.string(),
	jobDescription: z.string(),
	criteria: Criteria,
	taskType: TaskType.default("SOURCING"),
	/** Legacy role-level bounty. Agent-run roles price per gig, so leave it out. */
	bounty: BaseUnits.optional(),
	/** Legacy role-level cap. Agent-run roles cap per gig. */
	maxCandidates: z.number().int().positive().max(1000).optional(),
	/** How long the agent / company has to review a deliverable before it is auto-accepted. */
	reviewWindowSeconds: z.number().int().positive(),
	/** The role's whole budget: the agent spends it on gigs. */
	deposit: BaseUnits,
	/** How long a recruiter may hold an exclusive gig before it can be released. Default from the backend env. */
	claimTimeoutSeconds: z.number().int().positive().optional(),
	autoAccept: z.object({ enabled: z.boolean(), threshold: z.number().int().min(0).max(100) }).optional(),
	/** Share of the recruiter's payout held back until the candidate is confirmed. Default from the backend env. */
	holdbackBps: z.number().int().min(0).max(5000).optional(),
	/** After this many seconds post-accept the holdback can be released by anyone. */
	holdbackWindowSeconds: z.number().int().positive().optional(),
	/**
	 * Who reviews the role (role.agent): Scout's hosted agent (default), the company's own agent key, or the
	 * company itself. Change it later with roles.setReviewer.
	 */
	reviewer: z
		.discriminatedUnion("mode", [
			z.object({ mode: z.literal("scout") }),
			z.object({ mode: z.literal("custom"), agentPubkey: Pubkey }),
			z.object({ mode: z.literal("self") }),
		])
		.optional(),
});
export const CreateRoleResponse = z.object({ roleId: z.string(), unsignedTx: UnsignedTx });

export const TopUpRequest = z.object({ amount: BaseUnits });
export const TopUpResponse = z.object({ unsignedTx: UnsignedTx });

export const Budget = z.object({
	/** What the company deposited (forfeited recruiter bonds are counted apart, in bondsForfeited). */
	deposited: BaseUnits,
	/** Bonds of rejected deliverables that stayed in the role's budget (part of `remaining`). */
	bondsForfeited: BaseUnits.optional(),
	paid: BaseUnits,
	/** Current vault balance. */
	remaining: BaseUnits,
	/** remaining minus bounty * pending submissions minus heldBack. */
	available: BaseUnits,
	/** Part of `remaining` reserved for holdbacks of accepted candidates. */
	heldBack: BaseUnits,
});

export const RoleSummary = z.object({
	id: z.string(),
	/** u64 used in the RoleVault PDA seeds, as a decimal string. */
	onchainRoleId: z.string(),
	roleVault: Pubkey.nullable(),
	title: z.string(),
	summary: z.string(),
	companyName: z.string(),
	status: RoleStatus,
	taskType: TaskType,
	bounty: BaseUnits,
	feeBps: z.number().int(),
	maxCandidates: z.number().int(),
	acceptedCount: z.number().int(),
	pendingCount: z.number().int(),
	reviewWindowSeconds: z.number().int(),
	holdbackBps: z.number().int(),
	holdbackWindowSeconds: z.number().int(),
	budget: Budget,
	createdAt: z.string(),
});
export type RoleSummary = z.infer<typeof RoleSummary>;

/** Who the candidate is, shown on the candidate card. All optional so older rows still parse. */
export const CandidateInfo = z.object({
	avatarUrl: z.string().nullable(),
	currentTitle: z.string().nullable(),
	currentCompany: z.string().nullable(),
	location: z.string().nullable(),
});
export type CandidateInfo = z.infer<typeof CandidateInfo>;

/**
 * Money for one submission, following the program's math (rounding down):
 *   platformFee = bounty * feeBps; operatorFee = (bounty - platformFee) * operator.feeBps;
 *   later = (bounty - platformFee - operatorFee) * holdbackBps; now = the rest.
 * Projected for PENDING (what accepting would pay), actual once ACCEPTED.
 */
export const SubmissionPayout = z.object({
	now: BaseUnits,
	later: BaseUnits,
	operatorFee: BaseUnits,
	platformFee: BaseUnits,
	/** When the held-back part can be released by anyone (null while pending). */
	laterReleasesAt: z.string().nullable(),
	outcome: Outcome,
	/** NONE: nothing held back. HELD: waiting. RELEASED: paid to the scout. REFUNDED: back to the company. */
	laterStatus: z.enum(["NONE", "HELD", "RELEASED", "REFUNDED"]),
});
export type SubmissionPayout = z.infer<typeof SubmissionPayout>;

export const SubmissionView = z.object({
	id: z.string(),
	roleId: z.string(),
	roleTitle: z.string(),
	candidateName: z.string(),
	candidate: CandidateInfo.optional(),
	profileUrl: z.string(),
	notes: z.string(),
	candidateHash: z.string(),
	onchainAddress: Pubkey.nullable(),
	scout: z.object({ wallet: Pubkey, displayName: z.string(), avatarUrl: z.string().nullable() }),
	status: SubmissionStatus,
	rejectReason: RejectReason.nullable(),
	submittedAt: z.string(),
	reviewDeadline: z.string(),
	/** Signature of the tx that paid or rejected it. */
	settlementTx: z.string().nullable(),
	review: AgentReview.nullable(),
	/** null for rejected submissions. */
	payout: SubmissionPayout.nullable(),
});
export type SubmissionView = z.infer<typeof SubmissionView>;

export const RoleDetail = RoleSummary.extend({
	jobDescription: z.string(),
	criteria: Criteria,
	submissions: z.array(SubmissionView),
	/** Agent's short pipeline status for the company. */
	pipelineSummary: z.string().nullable(),
	/** Who reviews deliverables (role.agent): Scout's agent, the company's own agent key, or the company itself. */
	reviewer: z
		.object({ mode: z.enum(["scout", "custom", "self"]), agentPubkey: Pubkey.nullable() })
		.optional(),
});
export type RoleDetail = z.infer<typeof RoleDetail>;

/** GET /tasks: open roles as scouts see them (no other scouts' candidates). */
export const TaskView = RoleSummary.extend({
	criteria: Criteria,
	slotsLeft: z.number().int(),
	payoutPerCandidate: BaseUnits, // bounty minus fee
});
export type TaskView = z.infer<typeof TaskView>;

// ---- Submissions -----------------------------------------------------------

export const CreateSubmissionRequest = z.object({
	name: z.string().min(1),
	profileUrl: z.string().url(),
	notes: z.string().min(1),
	consent: z.literal(true),
	/** Required for SCREENING_CALL roles: notes/transcript of the call. Its sha256 goes on-chain as evidence. */
	screeningNotes: z.string().min(1).optional(),
	candidate: CandidateInfo.partial().optional(),
});
export const CreateSubmissionResponse = z.object({
	submissionId: z.string(),
	candidateHash: z.string(),
	unsignedTx: UnsignedTx,
});
/** 409 when the hash already exists for this role: the first scout keeps the credit. */
export const DuplicateCandidateError = z.object({
	error: z.literal("DUPLICATE_CANDIDATE"),
	firstSubmittedAt: z.string(),
	message: z.string(),
});

/** scouts.profile input: by wallet or by the public slug. */
export const ScoutProfileRequest = z.union([
	z.object({ wallet: Pubkey }),
	z.object({ slug: z.string().min(1) }),
]);

/** submissions.checkDuplicate: is this candidate already taken for the role? (No data about who took it.) */
export const CheckDuplicateRequest = z.object({ roleId: z.string().uuid(), profileUrl: z.string().url() });
export const CheckDuplicateResponse = z.object({
	duplicate: z.boolean(),
	firstSubmittedAt: z.string().optional(),
});

export const DecisionRequest = z.discriminatedUnion("decision", [
	/** reasonText: the review summary whose sha256 is review_hash. Default "Accepted by the company: <name>". */
	z.object({ decision: z.literal("accept"), reasonText: z.string().max(1000).optional() }),
	/** reasonText: what the recruiter is shown (sha256 = reason_hash). Default: the reason code's label. */
	z.object({
		decision: z.literal("reject"),
		reasonCode: RejectReason,
		reasonText: z.string().max(1000).optional(),
	}),
]);
/**
 * unsignedTx is null when accepting a SOURCING deliverable: that pre-accepts it and the payout waits for the
 * candidate's confirmation (the agent then signs the accept).
 */
export const DecisionResponse = z.object({ unsignedTx: UnsignedTx.nullable() });

export const SettleResponse = z.object({ signature: z.string(), explorerUrl: z.string() });

/**
 * POST /submissions/:id/outcome (company). UI labels: advanced = "Came to interview" (releases the held-back
 * part to the recruiter), fabricated = "Report a problem" (refunds it to the company, flags the recruiter;
 * only before laterReleasesAt).
 */
export const OutcomeRequest = z.object({
	outcome: z.enum(["advanced", "fabricated"]),
	reasonCode: z.number().int().min(0).max(255).default(0),
});
export const OutcomeResponse = z.object({ unsignedTx: UnsignedTx });

// ---- Scouts ----------------------------------------------------------------

export const RegisterScoutResponse = z.object({ unsignedTx: UnsignedTx });

export const ScoutPublicProfile = z.object({
	wallet: Pubkey,
	slug: z.string(),
	displayName: z.string(),
	avatarUrl: z.string().nullable(),
	/** Read from the on-chain ScoutProfile. */
	reputation: z.object({
		submitted: z.number().int(),
		accepted: z.number().int(),
		rejected: z.number().int(),
		totalEarned: BaseUnits,
		/** Candidates the company confirmed came to interview. */
		advanced: z.number().int(),
		/** Candidates the company reported as a problem. */
		flagged: z.number().int(),
	}),
	profileAddress: Pubkey.nullable(),
	operator: OperatorInfo.nullable(),
	skills: z.array(RecruiterSkill).optional(),
	score: RecruiterReputation.optional(),
	recent: z.array(
		SubmissionView.pick({ id: true, status: true, submittedAt: true }).extend({ roleTitle: z.string() }),
	),
});
export type ScoutPublicProfile = z.infer<typeof ScoutPublicProfile>;

// ---- Transactions ----------------------------------------------------------

export const SubmitTxRequest = z.object({
	/** base64 wire transaction signed by the user. The relayer adds its fee-payer signature. */
	signedTx: z.string(),
});
export const SubmitTxResponse = z.object({ signature: z.string(), explorerUrl: z.string() });
export type SubmitTxResponse = z.infer<typeof SubmitTxResponse>;

export const ApiError = z.object({ error: z.string(), message: z.string() });

/**
 * Endpoint map (all JSON, prefix /api):
 *   GET  /me                                  -> Me | 404
 *   PUT  /me                 UpsertMeRequest  -> Me
 *   POST /roles/draft        DraftRoleRequest -> DraftRoleResponse
 *   POST /roles              CreateRoleRequest -> CreateRoleResponse
 *   GET  /roles                               -> RoleSummary[]   (the caller's company roles)
 *   GET  /roles/:id                           -> RoleDetail
 *   POST /roles/:id/top-up   TopUpRequest     -> TopUpResponse
 *   POST /roles/:id/close                     -> { unsignedTx }
 *   GET  /tasks                               -> TaskView[]
 *   POST /roles/:id/submissions CreateSubmissionRequest -> CreateSubmissionResponse | 409 DuplicateCandidateError
 *   GET  /submissions/mine                    -> SubmissionView[] (caller as scout, review omitted)
 *   POST /submissions/:id/review              -> AgentReview (idempotent)
 *   POST /submissions/:id/decision DecisionRequest -> DecisionResponse
 *   POST /submissions/:id/settle              -> SettleResponse  (relayer signs settle_expired itself)
 *   POST /submissions/:id/outcome OutcomeRequest -> OutcomeResponse (company signs attest_outcome)
 *   POST /submissions/:id/release             -> SettleResponse  (relayer signs release_holdback itself)
 *   POST /scouts/register                     -> RegisterScoutResponse
 *   GET  /scouts/:pubkey                      -> ScoutPublicProfile
 *   POST /tx/submit          SubmitTxRequest  -> SubmitTxResponse
 *   GET  /events (SSE)                        -> LiveEvent on indexer updates
 */

/** Server-sent event payload on GET /events. */
export const LiveEvent = z.object({
	type: z.enum([
		"role.updated",
		"role.closed",
		"submission.created",
		"submission.reviewed",
		"submission.accepted",
		"submission.rejected",
		"submission.outcome",
		"submission.released",
		/** Appeal opened/decided, follow-up asked/answered (message says which): refetch the deliverable. */
		"submission.updated",
		// Agent gigs (docs/agent-gigs.md)
		"agent.activity",
		"gig.updated",
		"shortlist.updated",
		// Company ↔ agent thread: streamed reply text and tool calls.
		"agent.message",
		"agent.tool",
		/** The cockpit changed (roles.status): refetch it. */
		"role.status",
	]),
	roleId: z.string().optional(),
	submissionId: z.string().optional(),
	signature: z.string().optional(),
	/** Recruiter wallet the event concerns (for "payout arrived" toasts). */
	scout: z.string().optional(),
	/** Base units paid to the recruiter by this event: accepted = now part, outcome/released = later part. */
	payout: BaseUnits.optional(),
	/** submission.outcome only. */
	outcome: Outcome.optional(),
	/** gig.updated / agent.activity / submission.* for gig deliverables. */
	gigId: z.string().optional(),
	/** agent.activity: the company-facing sentence. */
	message: z.string().optional(),
	/** agent.message: streamed reply. `delta` chunks, then one event with `final: true` and the full `message`. */
	delta: z.string().optional(),
	final: z.boolean().optional(),
	/** agent.tool: what the agent did. */
	tool: z.object({ name: z.string(), summary: z.string() }).optional(),
	/** Activity row id (agent.activity / final agent.message / agent.tool), for de-duplicating with roles.activity. */
	activityId: z.string().optional(),
});
export type LiveEvent = z.infer<typeof LiveEvent>;
