/**
 * agent.* procedures for any role agent (packages/shared/src/agent-api.ts): inputs and outputs are C's
 * AGENT_API schemas, so a self-hosted `scout-agent` and this server can't drift apart.
 */
import { AGENT_API } from "@scout/shared";
import { address } from "@solana/kit";
import type { z } from "zod";
import {
	agentAskRecruiter,
	agentConfig,
	agentCriteria,
	agentDecision,
	agentDecisionLog,
	agentDeliverable,
	agentDeliverables,
	agentEscalate,
	agentLog,
	agentPauseTypes,
	agentRegisterGig,
	agentReviewGet,
	agentReviewSave,
	agentRole,
	agentRoles,
	agentSetGigStatus,
	agentShortlist,
	agentSourcingReviews,
	declineCosign,
	listCosigns,
	submitCosign,
} from "../../api/protocol.ts";
import { MINUTE, rateLimit } from "../../lib/rate-limit.ts";
import { publicProcedure, router, walletProcedure } from "../init.ts";

const A = AGENT_API;

/** Signed-in agent key, rate-limited per wallet (a busy agent polls a few times a second at most). */
const agentProcedure = walletProcedure.use(({ ctx, next }) => {
	rateLimit(`agent:${ctx.wallet}`, 600, MINUTE, "agent API calls");
	return next();
});

const q = <I extends z.ZodType, O extends z.ZodType>(spec: { input: I; output: O }) =>
	agentProcedure.input(spec.input).output(spec.output);

export const agentApiRouter = {
	config: publicProcedure
		.input(A["agent.config"].input)
		.output(A["agent.config"].output)
		.query(() => agentConfig()),
	roles: q(A["agent.roles"]).query(({ ctx }) => agentRoles(address(ctx.wallet))),
	role: q(A["agent.role"]).query(({ ctx, input }) => agentRole(address(ctx.wallet), input.roleId)),
	deliverables: q(A["agent.deliverables"]).query(({ ctx, input }) =>
		agentDeliverables(address(ctx.wallet), input.roleId),
	),
	deliverable: q(A["agent.deliverable"]).query(({ ctx, input }) =>
		agentDeliverable(address(ctx.wallet), input.deliverableId),
	),
	review: router({
		get: q(A["agent.review.get"]).query(({ ctx, input }) =>
			agentReviewGet(address(ctx.wallet), input.deliverableId),
		),
		save: q(A["agent.review.save"]).mutation(({ ctx, input }) =>
			agentReviewSave(address(ctx.wallet), input.deliverableId, input.review),
		),
	}),
	sourcingReviews: q(A["agent.sourcingReviews"]).query(({ ctx, input }) =>
		agentSourcingReviews(address(ctx.wallet), input.roleId),
	),
	gig: router({
		register: q(A["agent.gig.register"]).mutation(({ ctx, input }) =>
			agentRegisterGig(address(ctx.wallet), input),
		),
		setStatus: q(A["agent.gig.setStatus"]).mutation(({ ctx, input }) =>
			agentSetGigStatus(address(ctx.wallet), input),
		),
		pauseTypes: q(A["agent.gig.pauseTypes"]).mutation(({ ctx, input }) =>
			agentPauseTypes(address(ctx.wallet), input),
		),
	}),
	decision: q(A["agent.decision"]).mutation(({ ctx, input }) => agentDecision(address(ctx.wallet), input)),
	escalate: q(A["agent.escalate"]).mutation(({ ctx, input }) => agentEscalate(address(ctx.wallet), input)),
	askRecruiter: q(A["agent.askRecruiter"]).mutation(({ ctx, input }) =>
		agentAskRecruiter(address(ctx.wallet), input),
	),
	criteria: q(A["agent.criteria"]).mutation(({ ctx, input }) => agentCriteria(address(ctx.wallet), input)),
	shortlist: q(A["agent.shortlist"]).mutation(({ ctx, input }) => agentShortlist(address(ctx.wallet), input)),
	decisionLog: q(A["agent.decisionLog"]).query(({ ctx, input }) =>
		agentDecisionLog(address(ctx.wallet), input),
	),
	log: q(A["agent.log"]).mutation(({ ctx, input }) => agentLog(address(ctx.wallet), input)),
	cosign: router({
		list: q(A["agent.cosign.list"]).query(({ ctx, input }) => listCosigns(address(ctx.wallet), input.roleId)),
		submit: q(A["agent.cosign.submit"]).mutation(({ ctx, input }) =>
			submitCosign(address(ctx.wallet), input),
		),
		decline: q(A["agent.cosign.decline"]).mutation(({ ctx, input }) =>
			declineCosign(address(ctx.wallet), input),
		),
	}),
};
