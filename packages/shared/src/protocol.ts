/**
 * Scout as a protocol: any agent (or the company itself) can review a role. These are the API shapes for a
 * self-hosted reviewer; deliverable and role payloads reuse the role-agent ports' shapes as JSON.
 */
import { z } from "zod";
import { UnsignedTx } from "./api.ts";
import { Pubkey } from "./domain.ts";
import { GigType, ScriptQuestion } from "./gigs.ts";

/** Who reviews a role: our hosted agent, your own agent key, or you (the company) by hand. */
export const ReviewerMode = z.enum(["scout", "custom", "self"]);
export const SetReviewerRequest = z.discriminatedUnion("mode", [
	z.object({ roleId: z.string().uuid(), mode: z.literal("scout") }),
	z.object({ roleId: z.string().uuid(), mode: z.literal("custom"), agentPubkey: Pubkey }),
	z.object({ roleId: z.string().uuid(), mode: z.literal("self") }),
]);
export const SetReviewerResponse = z.object({ unsignedTx: UnsignedTx });

export const SubmitForCosignRequest = z.object({ signedTx: z.string() });
export const SubmitForCosignResponse = z.object({ pendingId: z.string() });

export const PendingCosign = z.object({
	id: z.string(),
	roleId: z.string(),
	gigId: z.string().nullable(),
	kind: z.enum(["claim", "deliver"]),
	summary: z.string(),
	/** Recruiter-signed wire tx (base64): add your signature and send it to gatekeeper.cosign. */
	transaction: z.string(),
	createdAt: z.string(),
});
export const CosignRequest = z.object({ id: z.string().uuid(), signedTx: z.string() });

export const AgentRoleRef = z.object({
	roleId: z.string(),
	title: z.string(),
	roleVault: Pubkey.nullable(),
	status: z.string(),
});
export const AgentDecisionRequest = z.object({
	deliverableId: z.string().uuid(),
	action: z.enum(["accept", "reject"]),
	/** 0 not matching, 1 not interested, 2 already in pipeline, 3 other. */
	reasonCode: z.number().int().min(0).max(3).default(0),
	reason: z.string().max(500),
});
export const AgentPostGigRequest = z.object({
	roleId: z.string().uuid(),
	type: GigType,
	variant: z.enum(["standard", "language"]).optional(),
	title: z.string().min(3).max(120),
	brief: z.string().min(10).max(4000),
	/** USDC base units. */
	bounty: z.string().regex(/^\d+$/),
	maxDeliverables: z.number().int().positive().max(500),
	exclusive: z.boolean(),
	script: z.array(ScriptQuestion).optional(),
	aboutCandidateId: z.string().uuid().optional(),
	holdbackBps: z.number().int().min(0).max(5000).optional(),
});
export const AgentPostGigResponse = z.object({ gigId: z.string(), unsignedTx: UnsignedTx });
export const AgentLogRequest = z.object({
	roleId: z.string().uuid(),
	message: z.string().min(1).max(500),
	deliverableId: z.string().uuid().optional(),
	gigId: z.string().uuid().optional(),
});
