/**
 * The agent API: what any role agent (the hosted one or a company's self-hosted `scout-agent`)
 * needs from the platform besides the chain. Served by the backend as tRPC procedures under
 * `agent.*` (superjson transformer, same endpoint as the app).
 *
 * Trust model
 * - The agent signs in with SIWS using its own key (`auth.nonce` → sign → `auth.verify`).
 * - Every `agent.*` procedure except `agent.config` requires the caller to be `role_vault.agent`
 *   of the role it touches, checked on-chain by the backend.
 * - Money moves only on-chain, signed by the agent's key: create_task, accept_submission,
 *   reject_submission (the relayer may pay fees via `tx.submit`). The backend never signs as
 *   the agent for a self-hosted role; it records what the chain confirms.
 * - Payloads (candidate notes, call answers, transcripts) are recruiter-written text: the agent
 *   treats them as data, never instructions.
 *
 * Agent-internal shapes (reviews, call scripts, shortlist entries) travel as JSON (`Json`): the
 * platform stores and shows them; @scout/agent owns and validates their schema.
 */
import { z } from "zod";
import { BaseUnits, Criteria, Pubkey, TaskType } from "./domain.ts";
import { AgentRoleRef, CosignRequest, PendingCosign } from "./protocol.ts";

export const AGENT_API_VERSION = 1;

/** JSON object owned by @scout/agent (StoredReview, CallScript, ShortlistEntry, CandidateView…). */
export const Json = z.record(z.string(), z.unknown());
export type Json = z.infer<typeof Json>;

export const GigVariantName = z.enum(["standard", "language", "tech"]);
export const AgentGigStatus = z.enum(["POSTING", "OPEN", "PAUSED", "CLOSED"]);
export const EscalationDeliveryName = z.enum(["now", "digest"]);

// ---- Config -------------------------------------------------------------------------------

/** agent.config (public): where the chain is and how the platform helps the agent. */
export const AgentConfig = z.object({
	apiVersion: z.number().int(),
	cluster: z.string(),
	rpcUrl: z.string(),
	programId: Pubkey,
	usdcMint: Pubkey,
	tokenProgram: Pubkey,
	/** The Config PDA and the treasury's token account (needed by accept_submission). */
	config: Pubkey,
	treasuryTokenAccount: Pubkey,
	/** Fee payer for `tx.submit`; null if the platform doesn't relay agent transactions. */
	relayer: Pubkey.nullable(),
	/**
	 * Key that settles SOURCING deliverables once the candidate confirms interest on the platform's
	 * confirmation page (`create_task.confirmation_attestor`). null: the agent settles them itself.
	 */
	confirmationAttestor: Pubkey.nullable(),
});
export type AgentConfig = z.infer<typeof AgentConfig>;

// ---- Roles and gigs -----------------------------------------------------------------------

/** Off-chain metadata of a gig; bounty, slots and counters come from the Task account. */
export const AgentGigMeta = z.object({
	gigId: z.string(),
	taskAddress: Pubkey.nullable(),
	onchainTaskId: z.number().int().nullable(),
	taskType: TaskType,
	variant: GigVariantName,
	title: z.string(),
	status: AgentGigStatus,
	/** Screening/reference/language gigs are about one candidate (a CandidateView id). */
	candidateId: z.string().nullable(),
	postedAt: z.string().nullable(),
	lastRepricedAt: z.string().nullable(),
	/** Recruiters who claimed or started it, and deliveries so far (any status). */
	claims: z.number().int(),
	deliveries: z.number().int(),
});
export type AgentGigMeta = z.infer<typeof AgentGigMeta>;

/** agent.role: the off-chain half of the role (the agent overlays budget and counters from chain). */
export const AgentRoleSnapshot = z.object({
	roleId: z.string(),
	roleVault: Pubkey,
	company: Pubkey,
	title: z.string(),
	criteria: Criteria,
	/** The company paused the agent; it should only answer chat. */
	paused: z.boolean(),
	pausedTaskTypes: z.array(TaskType),
	/** The company's holdback for new tasks (bps of each payout held until the outcome is known). */
	holdbackBps: z.number().int().min(0).max(5000).default(0),
	gigs: z.array(AgentGigMeta),
	/**
	 * CandidateView[] (accepted sourcing deliverables with their reviews). Each also carries
	 * `sourcer` (the scout's wallet) so calls about the candidate can exclude them on-chain.
	 */
	candidates: z.array(Json),
});
export type AgentRoleSnapshot = z.infer<typeof AgentRoleSnapshot>;

// ---- Deliverables ------------------------------------------------------------------------

export const AgentDeliverableStage = z.enum([
	/** Waiting for the agent's review and decision. */
	"pending",
	/** Sourcing, pre-accepted: waiting for the candidate to confirm interest. */
	"pre_accepted",
	/** Sourcing, candidate confirmed: the agent (or the confirmation attestor) settles on-chain. */
	"candidate_confirmed",
]);

/**
 * A recruiter's deliverable. `payload` is the agent's Deliverable minus the base fields:
 * sourcing → { candidate: { name, profileUrl, notes } }; calls → { candidateId, script, answers,
 * recommendation?, transcript?, assessedLevel?, recording? }.
 */
export const AgentDeliverable = z.object({
	id: z.string(),
	roleId: z.string(),
	gigId: z.string(),
	kind: z.enum(["sourcing", "screening", "reference", "language"]),
	stage: AgentDeliverableStage,
	/** On-chain accounts the agent signs against. */
	submission: Pubkey,
	task: Pubkey,
	scout: Pubkey,
	recruiter: z.object({ wallet: Pubkey, displayName: z.string() }),
	submittedAt: z.string(),
	updatedAt: z.string().nullable(),
	payload: Json,
});
export type AgentDeliverable = z.infer<typeof AgentDeliverable>;

// ---- Requests ------------------------------------------------------------------------------

const RoleInput = z.object({ roleId: z.string() });
const DeliverableInput = z.object({ deliverableId: z.string() });

export const AgentRegisterGig = z.object({
	roleId: z.string(),
	/** The confirmed create_task: the platform checks the Task on-chain and the brief hash. */
	taskAddress: Pubkey,
	signature: z.string(),
	gig: z.object({
		taskType: TaskType,
		variant: GigVariantName,
		title: z.string(),
		brief: z.string(),
		/** CallScript JSON for calls; hashed with title and brief into brief_hash. */
		script: Json.nullable(),
		bounty: BaseUnits,
		maxDeliverables: z.number().int().positive(),
		exclusive: z.boolean(),
		when: z.enum(["now", "after_sourcing", "after_screening"]),
		candidateId: z.string().nullable(),
	}),
});

export const AgentDecisionReport = z.object({
	deliverableId: z.string(),
	/**
	 * pre_accept (sourcing): the platform sends the candidate their confirmation link; nothing
	 * on-chain yet. accept/reject: `signature` of the confirmed transaction signed by the agent.
	 */
	action: z.enum(["pre_accept", "accept", "reject"]),
	reason: z.string(),
	signature: z.string().nullable(),
});

/** Gatekeeper co-signing (v3.2) uses protocol.ts PendingCosign / CosignRequest. */
export type PendingCosignItem = z.infer<typeof PendingCosign>;
export type AgentRoleRefItem = z.infer<typeof AgentRoleRef>;

/**
 * Procedure map: path → kind, input, output. The backend implements these; the agent calls
 * them with an untyped tRPC client and validates both sides with these schemas.
 */
export const AGENT_API = {
	"agent.config": { kind: "query", input: z.void(), output: AgentConfig },
	"agent.roles": { kind: "query", input: z.void(), output: z.array(AgentRoleRef) },
	"agent.role": { kind: "query", input: RoleInput, output: AgentRoleSnapshot },
	"agent.deliverables": { kind: "query", input: RoleInput, output: z.array(AgentDeliverable) },
	"agent.deliverable": { kind: "query", input: DeliverableInput, output: AgentDeliverable.nullable() },
	"agent.review.get": { kind: "query", input: DeliverableInput, output: Json.nullable() },
	"agent.review.save": {
		kind: "mutation",
		input: z.object({ deliverableId: z.string(), review: Json }),
		output: z.object({ ok: z.boolean() }),
	},
	/** Every sourcing review in the role, accepted and rejected (the replanning ladder). */
	"agent.sourcingReviews": { kind: "query", input: RoleInput, output: z.array(Json) },
	"agent.gig.register": {
		kind: "mutation",
		input: AgentRegisterGig,
		output: z.object({ gigId: z.string() }),
	},
	"agent.gig.setStatus": {
		kind: "mutation",
		input: z.object({ roleId: z.string(), gigIds: z.array(z.string()), status: z.enum(["OPEN", "PAUSED"]) }),
		output: z.object({ ok: z.boolean() }),
	},
	"agent.gig.pauseTypes": {
		kind: "mutation",
		input: z.object({ roleId: z.string(), taskTypes: z.array(TaskType), paused: z.boolean() }),
		output: z.object({ ok: z.boolean() }),
	},
	"agent.decision": { kind: "mutation", input: AgentDecisionReport, output: z.object({ ok: z.boolean() }) },
	"agent.escalate": {
		kind: "mutation",
		input: z.object({
			roleId: z.string(),
			deliverableId: z.string().nullable(),
			candidateId: z.string().nullable(),
			question: z.string(),
			delivery: EscalationDeliveryName,
		}),
		output: z.object({ ok: z.boolean() }),
	},
	"agent.askRecruiter": {
		kind: "mutation",
		input: z.object({ deliverableId: z.string(), question: z.string() }),
		output: z.object({ ok: z.boolean() }),
	},
	"agent.criteria": {
		kind: "mutation",
		input: z.object({ roleId: z.string(), criteria: Criteria, note: z.string() }),
		output: z.object({ ok: z.boolean() }),
	},
	"agent.shortlist": {
		kind: "mutation",
		input: z.object({ roleId: z.string(), entries: z.array(Json) }),
		output: z.object({ ok: z.boolean() }),
	},
	"agent.decisionLog": {
		kind: "query",
		input: z.object({
			roleId: z.string(),
			candidateName: z.string().nullable(),
			deliverableId: z.string().nullable(),
			limit: z.number().int().positive().max(200),
		}),
		output: z.array(Json),
	},
	"agent.log": {
		kind: "mutation",
		input: z.object({ roleId: z.string(), kind: z.string(), message: z.string(), data: Json.nullable() }),
		output: z.object({ ok: z.boolean() }),
	},
	/**
	 * Recruiter-signed claim/deliver transactions waiting for the gatekeeper's signature. The agent
	 * checks each one (only claim_task / submit_deliverable on its own role, fee payer = relayer),
	 * adds its signature and returns the wire tx; the platform relays it.
	 */
	"agent.cosign.list": { kind: "query", input: RoleInput, output: z.array(PendingCosign) },
	"agent.cosign.submit": { kind: "mutation", input: CosignRequest, output: z.object({ ok: z.boolean() }) },
	"agent.cosign.decline": {
		kind: "mutation",
		input: z.object({ id: z.string(), reason: z.string() }),
		output: z.object({ ok: z.boolean() }),
	},
} as const satisfies Record<string, { kind: "query" | "mutation"; input: z.ZodType; output: z.ZodType }>;

export type AgentApiPath = keyof typeof AGENT_API;
export type AgentApiInput<P extends AgentApiPath> = z.input<(typeof AGENT_API)[P]["input"]>;
export type AgentApiOutput<P extends AgentApiPath> = z.output<(typeof AGENT_API)[P]["output"]>;
