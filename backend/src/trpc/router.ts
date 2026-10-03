/**
 * The app's API. Every procedure reuses a use-case from src/api and the shared zod schemas, so the frontend
 * gets end-to-end types via `import type { AppRouter } from "@scout/backend/router"`.
 */
import {
	AckEscalationRequest,
	AgentReview,
	AnswerFollowUpRequest,
	AppealDecideRequest,
	AppealDecideResponse,
	AppealRequest,
	AuthNonceRequest,
	AuthNonceResponse,
	AuthVerifyRequest,
	AuthVerifyResponse,
	CandidateConfirmRequest,
	CandidateConfirmResponse,
	CandidateView,
	CandidateViewRequest,
	CheckDuplicateRequest,
	CheckDuplicateResponse,
	CompanyDeliverable,
	CosignRequest,
	CreateRoleRequest,
	CreateRoleResponse,
	DecisionRequest,
	DecisionResponse,
	DeliverableView,
	DismissReportRequest,
	DraftRoleRequest,
	DraftRoleResponse,
	GigClaimResponse,
	GigDeliverRequest,
	GigDeliverResponse,
	GigListRequest,
	GigView,
	LiveEvent,
	LoosenRequirementRequest,
	ManualDecideRequest,
	ManualDecideResponse,
	Me,
	NoShowResponse,
	OutcomeRequest,
	OutcomeResponse,
	PendingCosign,
	RaiseGigPriceRequest,
	RaiseGigPriceResponse,
	RegisterScoutResponse,
	ReportCandidateRequest,
	ReportCandidateResponse,
	ReportGigRequest,
	ResendConfirmationRequest,
	ResendConfirmationResponse,
	RoleActivity,
	RoleDecideRequest,
	RoleDecideResponse,
	RoleDetail,
	RoleMessageRequest,
	RoleMessageResponse,
	RoleStatusView,
	RoleSummary,
	ScoutProfileRequest,
	ScoutPublicProfile,
	SetReviewerRequest,
	SetReviewerResponse,
	SetSkillsRequest,
	SettleResponse,
	ShortlistItem,
	ShowUpFeeResponse,
	SubmissionView,
	SubmitForCosignRequest,
	SubmitForCosignResponse,
	SubmitTxRequest,
	SubmitTxResponse,
	TaskView,
	TopUpRequest,
	TopUpResponse,
	UnsignedTx,
	UpsertMeRequest,
	VerifySkillRequest,
} from "@scout/shared";
import { z } from "zod";
import { candidateRespond, candidateView } from "../agent-runner/confirmations.ts";
import { messageAgent, stepNow } from "../agent-runner/runner.ts";
import {
	claimGig,
	deliver,
	getGig,
	listGigs,
	myGigs,
	requireRoleOwner,
	roleActivity,
	roleDecide,
	roleShortlist,
} from "../api/gigs.ts";
import { ackEscalation, loosenRequirement, raiseGigPrice, resendConfirmation } from "../api/loop.ts";
import { findMe, setSkills, upsertMe, verifySkill } from "../api/me.ts";
import { declineCosign, listCosigns, setReviewer, submitCosign, submitForCosign } from "../api/protocol.ts";
import { answerFollowUp, appeal, companyQueue, decideAppeal, manualDecide } from "../api/review.ts";
import { closeRole, createRole, draftRole, getRole, listRoles, listTasks, topUp } from "../api/roles.ts";
import { registerScout, scoutProfile } from "../api/scouts.ts";
import { claimShowUpFee, dismissReport, noShow, reportCandidate, reportGig } from "../api/screening.ts";
import { roleStatus } from "../api/status.ts";
import {
	attestOutcome,
	checkDuplicate,
	decide,
	mySubmissions,
	release,
	requireSubmissionCompany,
	reviewSubmission,
	settle,
} from "../api/submissions.ts";
import { submitTx } from "../api/tx.ts";
import { createNonce, logout, verifyLogin } from "../auth.ts";
import { eventStream } from "../events.ts";
import { DAY, MINUTE, rateLimit } from "../lib/rate-limit.ts";
import { reviewerMode } from "../solana/gatekeeper.ts";
import { visibleEvent } from "./event-visibility.ts";
import { publicProcedure, router, walletProcedure } from "./init.ts";
import { agentApiRouter } from "./routers/agent.ts";
import { draftRouter } from "./routers/draft.ts";
import { recallRouter } from "./routers/recall.ts";

const Id = z.object({ id: z.string().uuid() });

export const appRouter = router({
	/** Sign-In-With-Solana: nonce → wallet signs → verify → Bearer token. */
	auth: router({
		nonce: publicProcedure
			.input(AuthNonceRequest)
			.output(AuthNonceResponse)
			.mutation(({ ctx, input }) => {
				rateLimit(`nonce:${ctx.ip}`, 30, MINUTE, "sign-in attempts");
				return createNonce(input.wallet);
			}),
		verify: publicProcedure
			.input(AuthVerifyRequest)
			.output(AuthVerifyResponse)
			.mutation(({ ctx, input }) => {
				rateLimit(`verify:${ctx.ip}`, 30, MINUTE, "sign-in attempts");
				return verifyLogin(input);
			}),
		logout: walletProcedure.mutation(async ({ ctx }) => {
			if (ctx.token) await logout(ctx.token);
			return { ok: true };
		}),
	}),

	me: router({
		/** null until the wallet has a profile (then call `upsert`). */
		get: walletProcedure.output(Me.nullable()).query(({ ctx }) => findMe(ctx.wallet)),
		upsert: walletProcedure
			.input(UpsertMeRequest)
			.output(Me)
			.mutation(({ ctx, input }) => upsertMe(ctx.wallet, input)),
		/** Self-declared skills (e.g. "engineer:rust", "lang:de:native"). */
		setSkills: walletProcedure
			.input(SetSkillsRequest)
			.output(Me)
			.mutation(({ ctx, input }) => setSkills(ctx.wallet, input.skills)),
	}),

	roles: router({
		/** Agent: job description → criteria + suggested bounty (slow: an LLM call). */
		draft: publicProcedure
			.input(DraftRoleRequest)
			.output(DraftRoleResponse)
			.mutation(({ ctx, input }) => {
				// An LLM call per request: cap it per IP.
				rateLimit(`draft:${ctx.ip}`, 20, MINUTE * 10, "job descriptions");
				return draftRole(input);
			}),
		create: walletProcedure
			.input(CreateRoleRequest)
			.output(CreateRoleResponse)
			.mutation(({ ctx, input }) => createRole(ctx.wallet, input)),
		/** The caller's (company's) roles. */
		list: walletProcedure.output(z.array(RoleSummary)).query(({ ctx }) => listRoles(ctx.wallet)),
		/** Company of the role only: contains every candidate's details. */
		byId: walletProcedure
			.input(Id)
			.output(RoleDetail)
			.query(async ({ ctx, input }) => {
				await requireRoleOwner(ctx.wallet, input.id);
				return getRole(input.id);
			}),
		topUp: walletProcedure
			.input(Id.extend(TopUpRequest.shape))
			.output(TopUpResponse)
			.mutation(({ ctx, input }) => topUp(ctx.wallet, input.id, input)),
		reviewer: walletProcedure
			.input(z.object({ roleId: z.string().uuid() }))
			.output(z.object({ mode: z.enum(["scout", "custom", "self"]), agentPubkey: z.string().nullable() }))
			.query(async ({ ctx, input }) => {
				const role = await requireRoleOwner(ctx.wallet, input.roleId);
				return { mode: await reviewerMode(role), agentPubkey: role.agentPubkey };
			}),
		/** Same as deliverables.queue: deliverables and appeals waiting for the company. */
		reviewQueue: walletProcedure
			.input(z.object({ roleId: z.string().uuid() }))
			.output(z.array(CompanyDeliverable))
			.query(({ ctx, input }) => companyQueue(ctx.wallet, input.roleId)),
		/** "Raise to $X" on a slow gig: our agent reposts the open slots at the new price (new gigId). */
		raiseGigPrice: walletProcedure
			.input(RaiseGigPriceRequest)
			.output(RaiseGigPriceResponse)
			.mutation(({ ctx, input }) => raiseGigPrice(ctx.wallet, input)),
		/** "Got it" on an agent's inbox question (waitingOn action "acknowledge"). */
		ackEscalation: walletProcedure
			.input(AckEscalationRequest)
			.output(z.object({ ok: z.boolean() }))
			.mutation(({ ctx, input }) => ackEscalation(ctx.wallet, input)),
		/** Must-have → nice-to-have; pending sourced profiles are scored again. */
		loosenRequirement: walletProcedure
			.input(LoosenRequirementRequest)
			.output(z.object({ ok: z.boolean(), rescoring: z.number().int() }))
			.mutation(({ ctx, input }) => loosenRequirement(ctx.wallet, input)),
		/** The candidate is fake: Fabricated on the sourcing deliverable, do-not-contact, their gigs stop. */
		reportCandidate: walletProcedure
			.input(ReportCandidateRequest)
			.output(ReportCandidateResponse)
			.mutation(({ ctx, input }) => reportCandidate(ctx.wallet, input)),
		dismissReport: walletProcedure
			.input(DismissReportRequest)
			.output(z.object({ ok: z.boolean() }))
			.mutation(({ ctx, input }) => dismissReport(ctx.wallet, input)),
		/** Who reviews this role: Scout's agent, the company's own agent key, or the company itself (set_agent). */
		setReviewer: walletProcedure
			.input(SetReviewerRequest)
			.output(SetReviewerResponse)
			.mutation(({ ctx, input }) => setReviewer(ctx.wallet, input)),
		/** Agent cockpit: what it's doing now, who it waits on, pipeline, one budget snapshot. */
		status: walletProcedure
			.input(z.object({ roleId: z.string().uuid() }))
			.output(RoleStatusView)
			.query(async ({ ctx, input }) => {
				await requireRoleOwner(ctx.wallet, input.roleId);
				return roleStatus(input.roleId);
			}),
		/** The agent's status line + timeline (incl. the company ↔ agent thread). */
		activity: walletProcedure
			.input(z.object({ roleId: z.string().uuid() }))
			.output(RoleActivity)
			.query(({ ctx, input }) => roleActivity(ctx.wallet, input.roleId)),
		shortlist: walletProcedure
			.input(z.object({ roleId: z.string().uuid() }))
			.output(z.array(ShortlistItem))
			.query(({ ctx, input }) => roleShortlist(ctx.wallet, input.roleId)),
		/**
		 * Talk to the role's agent. Returns at once; the reply streams on `events` as agent.message
		 * (delta…, then final) and agent.tool, and is persisted in roles.activity.
		 */
		message: walletProcedure
			.input(RoleMessageRequest)
			.output(RoleMessageResponse)
			.mutation(async ({ ctx, input }) => {
				await requireRoleOwner(ctx.wallet, input.roleId);
				return messageAgent(input.roleId, input.text);
			}),
		/** "Invite to interview" (returns a tx to sign) / "Pass" (unsignedTx null). */
		decide: walletProcedure
			.input(RoleDecideRequest)
			.output(RoleDecideResponse)
			.mutation(({ ctx, input }) => roleDecide(ctx.wallet, input)),
		close: walletProcedure
			.input(Id)
			.output(z.object({ unsignedTx: UnsignedTx }))
			.mutation(({ ctx, input }) => closeRole(ctx.wallet, input.id)),
	}),

	tasks: router({
		/** Open, funded roles as recruiters see them. */
		list: publicProcedure.output(z.array(TaskView)).query(() => listTasks()),
	}),

	/** The company reviews deliverables itself (reviewer mode "self", or overriding its agent). */
	deliverables: router({
		queue: walletProcedure
			.input(z.object({ roleId: z.string().uuid() }))
			.output(z.array(CompanyDeliverable))
			.query(({ ctx, input }) => companyQueue(ctx.wallet, input.roleId)),
		decide: walletProcedure
			.input(ManualDecideRequest)
			.output(ManualDecideResponse)
			.mutation(({ ctx, input }) => manualDecide(ctx.wallet, input)),
	}),

	submissions: router({
		/** A rejected recruiter asks the company to look again (once, within APPEAL_WINDOW_DAYS). */
		appeal: walletProcedure
			.input(AppealRequest)
			.output(z.object({ ok: z.boolean() }))
			.mutation(({ ctx, input }) => {
				rateLimit(`appeal:${ctx.wallet}`, 10, DAY, "appeals today");
				return appeal(ctx.wallet, input);
			}),
		/** "Accept and pay" (a USDC transfer to sign) / "Keep rejected". */
		decideAppeal: walletProcedure
			.input(AppealDecideRequest)
			.output(AppealDecideResponse)
			.mutation(({ ctx, input }) => decideAppeal(ctx.wallet, input)),
		/** Live duplicate check while a recruiter types a profile URL. */
		checkDuplicate: walletProcedure
			.input(CheckDuplicateRequest)
			.output(CheckDuplicateResponse)
			.query(({ ctx, input }) => {
				rateLimit(`dup:${ctx.wallet}`, 60, MINUTE, "duplicate checks");
				return checkDuplicate(input);
			}),
		mine: walletProcedure.output(z.array(SubmissionView)).query(({ ctx }) => mySubmissions(ctx.wallet)),
		/** Idempotent agent review. */
		review: walletProcedure
			.input(Id)
			.output(AgentReview)
			.mutation(async ({ ctx, input }) => {
				await requireSubmissionCompany(ctx.wallet, input.id);
				return reviewSubmission(input.id);
			}),
		decide: walletProcedure
			.input(Id.and(DecisionRequest))
			.output(DecisionResponse)
			.mutation(({ ctx, input }) => decide(ctx.wallet, input.id, input)),
		/** Permissionless auto-accept after the review window (the relayer signs). */
		settle: walletProcedure
			.input(Id)
			.output(SettleResponse)
			.mutation(({ ctx, input }) => {
				rateLimit(`relay:${ctx.wallet}`, 30, MINUTE, "transactions");
				return settle(input.id);
			}),
		/** "Came to interview" (advanced) / "Report a problem" (fabricated). */
		outcome: walletProcedure
			.input(Id.extend(OutcomeRequest.shape))
			.output(OutcomeResponse)
			.mutation(({ ctx, input }) => attestOutcome(ctx.wallet, input.id, input)),
		/** Permissionless release of the held-back part after its window (the relayer signs). */
		release: walletProcedure
			.input(Id)
			.output(SettleResponse)
			.mutation(({ ctx, input }) => {
				rateLimit(`relay:${ctx.wallet}`, 30, MINUTE, "transactions");
				return release(input.id);
			}),
	}),

	scouts: router({
		register: walletProcedure.output(RegisterScoutResponse).mutation(({ ctx }) => registerScout(ctx.wallet)),
		/** By wallet or by public slug ("ola-wisniewska"). */
		profile: publicProcedure
			.input(ScoutProfileRequest)
			.output(ScoutPublicProfile)
			.query(({ input }) => scoutProfile(input)),
	}),

	/** Agent-posted gigs (docs/agent-gigs.md). */
	gigs: router({
		/** The candidate didn't join the call: 1st time +24 h to reschedule, 2nd time the gig closes. */
		noShow: walletProcedure
			.input(z.object({ gigId: z.string().uuid() }))
			.output(NoShowResponse)
			.mutation(({ ctx, input }) => noShow(ctx.wallet, input.gigId)),
		/** One signature: the role pays the recruiter's show-up fee (offered by noShow). */
		claimShowUpFee: walletProcedure
			.input(z.object({ gigId: z.string().uuid() }))
			.output(ShowUpFeeResponse)
			.mutation(({ ctx, input }) => claimShowUpFee(ctx.wallet, input.gigId)),
		/** "This candidate may be fake": the gig goes on hold, the company decides. */
		report: walletProcedure
			.input(ReportGigRequest)
			.output(z.object({ ok: z.boolean() }))
			.mutation(({ ctx, input }) => {
				rateLimit(`report:${ctx.wallet}`, 10, DAY, "reports today");
				return reportGig(ctx.wallet, input);
			}),
		/** The recruiter answers the agent's follow-up question; the agent re-reviews. */
		answerFollowUp: walletProcedure
			.input(AnswerFollowUpRequest)
			.output(z.object({ ok: z.boolean() }))
			.mutation(({ ctx, input }) => answerFollowUp(ctx.wallet, input)),
		/** Open gigs (board). Filter by role / type; includeClosed for history. */
		list: publicProcedure
			.input(GigListRequest)
			.output(z.array(GigView))
			.query(({ ctx, input }) => listGigs(ctx.wallet, input)),
		byId: publicProcedure
			.input(Id)
			.output(GigView)
			.query(({ ctx, input }) => getGig(ctx.wallet, input.id)),
		/** Exclusive gigs only. CONFLICT/GIG_TAKEN, ALREADY_CLAIMED, CLAIM_NOT_NEEDED, NO_OPEN_GIG. */
		claim: walletProcedure
			.input(Id)
			.output(GigClaimResponse)
			.mutation(({ ctx, input }) => claimGig(ctx.wallet, input.id)),
		/**
		 * NO_OPEN_GIG, NOT_CLAIMANT, GIG_FULL, DUPLICATE_CANDIDATE (details.firstSubmittedAt),
		 * INCOMPLETE_ANSWERS (details.missing question ids).
		 */
		deliver: walletProcedure
			.input(GigDeliverRequest)
			.output(GigDeliverResponse)
			.mutation(({ ctx, input }) => deliver(ctx.wallet, input)),
		mine: walletProcedure
			.output(z.object({ gigs: z.array(GigView), deliverables: z.array(DeliverableView) }))
			.query(({ ctx }) => myGigs(ctx.wallet)),
	}),

	tx: router({
		/** Relay a user-signed transaction (the backend adds the fee-payer signature). */
		submit: walletProcedure
			.input(SubmitTxRequest)
			.output(SubmitTxResponse)
			.mutation(({ ctx, input }) => {
				rateLimit(`relay:${ctx.wallet}`, 30, MINUTE, "transactions");
				rateLimit(
					`relay-day:${ctx.wallet}`,
					Number(process.env.RELAY_DAILY_CAP ?? 300),
					DAY,
					"transactions today",
				);
				return submitTx(input, ctx.wallet);
			}),
		/** Claim/delivery whose gatekeeper isn't Scout's agent (UnsignedTx.cosigner): park it for them. */
		submitForCosign: walletProcedure
			.input(SubmitForCosignRequest)
			.output(SubmitForCosignResponse)
			.mutation(({ ctx, input }) => {
				rateLimit(`cosign:${ctx.wallet}`, 30, MINUTE, "transactions");
				return submitForCosign(ctx.wallet, input.signedTx);
			}),
	}),

	/** The candidate's public confirmation page /c/<token> (no login). */
	candidate: router({
		/** A fresh link for a pending confirmation (sourcer or company; only the sourcer gets the url). */
		resendConfirmation: walletProcedure
			.input(ResendConfirmationRequest)
			.output(ResendConfirmationResponse)
			.mutation(({ ctx, input }) => {
				rateLimit(`resend:${ctx.wallet}`, 20, DAY, "new links today");
				return resendConfirmation(ctx.wallet, input.deliverableId);
			}),
		view: publicProcedure
			.input(CandidateViewRequest)
			.output(CandidateView)
			.query(({ ctx, input }) => {
				rateLimit(`cand-view:${ctx.ip}`, 60, MINUTE, "requests");
				return candidateView(input.token);
			}),
		confirm: publicProcedure
			.input(CandidateConfirmRequest)
			.output(CandidateConfirmResponse)
			.mutation(({ ctx, input }) => {
				rateLimit(`cand-confirm:${ctx.ip}`, 10, MINUTE, "answers");
				return candidateRespond(input);
			}),
	}),

	/** Recall.ai notetaker for screening calls (Stream E): invite / status / stop. */
	recall: recallRouter,

	operators: router({
		/** "Verified by <operator>": the operator (signed in as its authority) verifies a recruiter's skill. */
		verifySkill: walletProcedure
			.input(VerifySkillRequest)
			.output(z.object({ ok: z.boolean(), verifiedBy: z.string() }))
			.mutation(({ ctx, input }) => verifySkill(ctx.wallet, input)),
	}),

	/** Hidden demo/debug tools. */
	/** The company reviews claims/deliveries itself (no agent): its co-sign queue. */
	gatekeeper: router({
		pending: walletProcedure
			.input(z.object({ roleId: z.string().uuid() }))
			.output(z.array(PendingCosign))
			.query(({ ctx, input }) => listCosigns(ctx.wallet, input.roleId)),
		cosign: walletProcedure
			.input(CosignRequest)
			.output(z.object({ ok: z.boolean() }))
			.mutation(({ ctx, input }) => submitCosign(ctx.wallet, input)),
		decline: walletProcedure
			.input(z.object({ id: z.string().uuid(), reason: z.string().min(1).max(500) }))
			.output(z.object({ ok: z.boolean() }))
			.mutation(({ ctx, input }) => declineCosign(ctx.wallet, input)),
	}),

	/** New-role page: the agent's reading of a job description, streamed (Stream F). */
	draft: draftRouter,

	agent: router({
		...agentApiRouter,
		/** Run one deterministic agent pass now (the "run agent step now" button). Company of the role only. */
		step: walletProcedure
			.input(z.object({ roleId: z.string().uuid() }))
			.output(z.object({ done: z.array(z.string()) }))
			.mutation(async ({ ctx, input }) => {
				await requireRoleOwner(ctx.wallet, input.roleId);
				return { done: await stepNow(input.roleId) };
			}),
	}),

	/** Live indexer updates (SSE via httpSubscriptionLink). Filter client-side by roleId / scout. */
	events: publicProcedure.subscription(async function* ({ ctx, signal }) {
		for await (const event of eventStream(signal)) {
			const visible = await visibleEvent(event, ctx.wallet);
			if (visible) yield LiveEvent.parse(visible);
		}
	}),
});

export type AppRouter = typeof appRouter;
