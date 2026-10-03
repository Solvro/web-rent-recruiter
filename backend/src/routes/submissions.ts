/** @deprecated REST transport; the app uses tRPC (src/trpc). Kept for scripts. */
import {
	AgentReview,
	DecisionRequest,
	DecisionResponse,
	OutcomeRequest,
	OutcomeResponse,
	SettleResponse,
	SubmissionView,
} from "@scout/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
	attestOutcome,
	decide,
	mySubmissions,
	release,
	reviewSubmission,
	settle,
} from "../api/submissions.ts";
import { requireWallet } from "../http.ts";

const IdParams = z.object({ id: z.string().uuid() });

export const submissionRoutes: FastifyPluginAsyncZod = async (app) => {
	app.get("/submissions/mine", { schema: { response: { 200: z.array(SubmissionView) } } }, async (req) =>
		mySubmissions(await requireWallet(req)),
	);
	app.post(
		"/submissions/:id/review",
		{ schema: { params: IdParams, response: { 200: AgentReview } } },
		(req) => reviewSubmission(req.params.id),
	);
	app.post(
		"/submissions/:id/decision",
		{ schema: { params: IdParams, body: DecisionRequest, response: { 200: DecisionResponse } } },
		async (req) => decide(await requireWallet(req), req.params.id, req.body),
	);
	app.post(
		"/submissions/:id/settle",
		{ schema: { params: IdParams, response: { 200: SettleResponse } } },
		(req) => settle(req.params.id),
	);
	app.post(
		"/submissions/:id/outcome",
		{ schema: { params: IdParams, body: OutcomeRequest, response: { 200: OutcomeResponse } } },
		async (req) => attestOutcome(await requireWallet(req), req.params.id, req.body),
	);
	app.post(
		"/submissions/:id/release",
		{ schema: { params: IdParams, response: { 200: SettleResponse } } },
		(req) => release(req.params.id),
	);
};
