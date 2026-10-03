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

export const WALLET_HEADER = "x-wallet";

/** A transaction built by the backend with the relayer as fee payer, waiting for the user's signature. */
export const UnsignedTx = z.object({
	/** base64 wire transaction (v0), relayer signature slot empty. */
	transaction: z.string(),
	/** Human summary shown before signing, e.g. "Deposit 200 USDC into role budget". */
	summary: z.string(),
});
export type UnsignedTx = z.infer<typeof UnsignedTx>;

// ---- Me / profiles ---------------------------------------------------------

export const AccountKind = z.enum(["company", "scout"]);
export const UpsertMeRequest = z.object({
	kind: AccountKind,
	displayName: z.string().min(1),
	avatarUrl: z.string().url().nullable().optional(),
	/** Companies only. */
	companyName: z.string().optional(),
});
export const Me = z.object({
	wallet: Pubkey,
	kind: AccountKind,
	displayName: z.string(),
	avatarUrl: z.string().nullable(),
	companyName: z.string().nullable(),
	/** Scouts: whether ScoutProfile exists on-chain. If false, POST /scouts/register first. */
	scoutRegistered: z.boolean(),
	usdcBalance: BaseUnits,
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
	bounty: BaseUnits,
	maxCandidates: z.number().int().positive().max(1000),
	reviewWindowSeconds: z.number().int().positive(),
	deposit: BaseUnits,
	autoAccept: z.object({ enabled: z.boolean(), threshold: z.number().int().min(0).max(100) }).optional(),
});
export const CreateRoleResponse = z.object({ roleId: z.string(), unsignedTx: UnsignedTx });

export const TopUpRequest = z.object({ amount: BaseUnits });
export const TopUpResponse = z.object({ unsignedTx: UnsignedTx });

export const Budget = z.object({
	deposited: BaseUnits,
	paid: BaseUnits,
	/** Current vault balance. */
	remaining: BaseUnits,
	/** remaining minus bounty * pending submissions. */
	available: BaseUnits,
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
	budget: Budget,
	createdAt: z.string(),
});
export type RoleSummary = z.infer<typeof RoleSummary>;

export const SubmissionView = z.object({
	id: z.string(),
	roleId: z.string(),
	roleTitle: z.string(),
	candidateName: z.string(),
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
});
export type SubmissionView = z.infer<typeof SubmissionView>;

export const RoleDetail = RoleSummary.extend({
	jobDescription: z.string(),
	criteria: Criteria,
	submissions: z.array(SubmissionView),
	/** Agent's short pipeline status for the company. */
	pipelineSummary: z.string().nullable(),
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

export const DecisionRequest = z.discriminatedUnion("decision", [
	z.object({ decision: z.literal("accept") }),
	z.object({ decision: z.literal("reject"), reasonCode: RejectReason }),
]);
export const DecisionResponse = z.object({ unsignedTx: UnsignedTx });

export const SettleResponse = z.object({ signature: z.string(), explorerUrl: z.string() });

// ---- Scouts ----------------------------------------------------------------

export const RegisterScoutResponse = z.object({ unsignedTx: UnsignedTx });

export const ScoutPublicProfile = z.object({
	wallet: Pubkey,
	displayName: z.string(),
	avatarUrl: z.string().nullable(),
	/** Read from the on-chain ScoutProfile. */
	reputation: z.object({
		submitted: z.number().int(),
		accepted: z.number().int(),
		rejected: z.number().int(),
		totalEarned: BaseUnits,
	}),
	profileAddress: Pubkey.nullable(),
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
 *   POST /scouts/register                     -> RegisterScoutResponse
 *   GET  /scouts/:pubkey                      -> ScoutPublicProfile
 *   POST /tx/submit          SubmitTxRequest  -> SubmitTxResponse
 *   GET  /events (SSE)                        -> { type, roleId?, submissionId?, signature? } on indexer updates
 */
