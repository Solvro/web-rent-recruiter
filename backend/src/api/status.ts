/**
 * The agent cockpit for the company (roles.status): what the agent is doing now, who it is waiting on,
 * pipeline counts and one budget snapshot. `role.status` is published whenever any of it changes.
 */
import type { AgentReview, RoleStatusView } from "@scout/shared";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { blockingCriterion, PRICING, repriceRule } from "../agent/index.ts";
import { db, schema } from "../db/index.ts";
import { env } from "../env.ts";
import { publish } from "../events.ts";
import { availableBudget } from "../lib/views.ts";
import { currentWorkSince } from "./gigs.ts";
import { pendingProposals } from "./proposals.ts";

const name = (full: string) => full.split(" ")[0] ?? full;
const HOUR = 3_600_000;
const MIN = 60_000;
type Stage = "confirm" | "sourcing" | "take_screening" | "take_reference" | "run_call";
/** Real-world norms (hours): when each kind of wait usually ends. */
const REAL_HOURS: Record<Stage, number> = {
	confirm: 24,
	sourcing: PRICING.raiseAfterHours.SOURCING,
	take_screening: PRICING.raiseAfterHours.SCREENING_CALL,
	take_reference: PRICING.raiseAfterHours.REFERENCE_CHECK,
	run_call: 24,
};
/**
 * DEMO_FAST norms (minutes), generous on purpose: "slower than usual" on stage should mean it really is.
 * COCKPIT_DEMO_FACTOR scales them (the e2e uses a small factor to see "slow" quickly).
 */
const DEMO_MINUTES: Record<Stage, number> = {
	confirm: 15,
	sourcing: 15,
	take_screening: 30,
	take_reference: 30,
	run_call: 30,
};
const typicalMs = (stage: Stage) =>
	process.env.DEMO_FAST === "1"
		? DEMO_MINUTES[stage] * MIN * Number(process.env.COCKPIT_DEMO_FACTOR ?? 1)
		: REAL_HOURS[stage] * HOUR;
const takeStage = (type: string): Stage =>
	type === "REFERENCE_CHECK" ? "take_reference" : type === "SOURCING" ? "sourcing" : "take_screening";
const toUsd = (base: bigint) => Number(base) / 1e6;
const fromUsd = (usd: number) => BigInt(Math.round(usd * 1e6)).toString();

export async function roleStatus(roleId: string): Promise<RoleStatusView> {
	const [role] = await db.select().from(schema.roles).where(eq(schema.roles.id, roleId));
	if (!role) throw new Error(`role ${roleId} not found`);
	const gigs = await db
		.select()
		.from(schema.gigs)
		.where(and(eq(schema.gigs.roleId, roleId), isNull(schema.gigs.purpose)));
	const subs = await db
		.select({ sub: schema.submissions, scout: schema.accounts })
		.from(schema.submissions)
		.leftJoin(schema.accounts, eq(schema.accounts.wallet, schema.submissions.scoutWallet))
		.where(and(eq(schema.submissions.roleId, roleId), eq(schema.submissions.confirmed, true)));
	const subIds = subs.map((s) => s.sub.id);
	const confirmations = subIds.length
		? await db
				.select()
				.from(schema.candidateConfirmations)
				.where(inArray(schema.candidateConfirmations.submissionId, subIds))
		: [];
	const shortlist = await db.select().from(schema.shortlist).where(eq(schema.shortlist.roleId, roleId));
	const claimants = gigs.flatMap((g) => (g.claimantWallet ? [g.claimantWallet] : []));
	const people = claimants.length
		? await db.select().from(schema.accounts).where(inArray(schema.accounts.wallet, claimants))
		: [];
	const byId = new Map(subs.map((s) => [s.sub.id, s]));
	const about = (gig: (typeof gigs)[number]) =>
		gig.aboutCandidateId
			? name(byId.get(gig.aboutCandidateId)?.sub.candidateName ?? "the candidate")
			: "a candidate";
	const kind = (g: (typeof gigs)[number]) =>
		g.type === "SCREENING_CALL"
			? g.variant === "language"
				? "language check"
				: "screening call"
			: "reference check";

	const now = Date.now();
	const available = availableBudget(role);
	const expect = (since: Date, stage: Stage) => {
		const by = new Date(since.getTime() + typicalMs(stage));
		return { expectedBy: by.toISOString(), slow: now > by.getTime() };
	};
	/** C's repriceRule on the cockpit clock: the price it would raise to, or null. */
	const suggestRaise = (g: (typeof gigs)[number]) => {
		// On the cockpit clock: the stage's norm maps to C's raiseAfterHours for this gig type.
		const hoursOpen =
			((now - g.createdAt.getTime()) / typicalMs(takeStage(g.type))) * PRICING.raiseAfterHours[g.type];
		const r = repriceRule({
			gig: {
				taskType: g.type,
				variant: (g.variant ?? undefined) as "standard" | "language" | undefined,
				bounty: toUsd(g.bounty),
				maxDeliverables: g.maxDeliverables,
				acceptedCount: g.acceptedCount,
			},
			hoursOpen,
			claims: g.claimantWallet ? 1 : 0,
			deliveries: subs.filter((x) => x.sub.gigId === g.id).length,
			maxBounty: toUsd(env.agentMaxBounty),
			budgetAvailable: toUsd(available),
		});
		return r.action === "raise" ? { bounty: r.bounty, reason: r.reason } : null;
	};
	const raiseAction = (g: (typeof gigs)[number]) => {
		const r = suggestRaise(g);
		return r && !g.claimantWallet && g.pendingCount === 0
			? [
					{
						id: "raise_price" as const,
						label: `Raise to $${r.bounty}`,
						gigId: g.id,
						bounty: fromUsd(r.bounty),
					},
				]
			: [];
	};
	const sourcingReviews = subs.flatMap(({ sub }) =>
		sub.deliverableType === "SOURCING"
			? [(sub.agentReview as { sourcing?: AgentReview } | null)?.sourcing].filter((x): x is AgentReview =>
					Boolean(x),
				)
			: [],
	);
	const blocking = blockingCriterion({
		criteria: role.criteria,
		budgetAvailable: toUsd(available),
		maxBounty: toUsd(env.agentMaxBounty),
		sourcing: null,
		screeningBounty: 0,
		inFlight: 0,
		reviews: sourcingReviews,
		done: [],
	});

	const waitingOn: RoleStatusView["waitingOn"] = [];
	for (const c of confirmations) {
		if (c.status !== "PENDING") continue;
		const s = byId.get(c.submissionId);
		waitingOn.push({
			who: "candidate",
			what: `${name(s?.sub.candidateName ?? "The candidate")} to confirm interest (link sent by ${s?.scout?.displayName ?? "the recruiter"})`,
			since: c.createdAt.toISOString(),
			deadline: c.expiresAt.toISOString(),
			gigId: s?.sub.gigId ?? null,
			deliverableId: c.submissionId,
			...expect(c.createdAt, "confirm"),
			actions: [{ id: "resend_confirmation", label: "Send a new link", deliverableId: c.submissionId }],
		});
	}
	for (const g of gigs) {
		if (g.status === "POSTING") {
			waitingOn.push({
				who: "chain",
				what: `Posting "${g.title}"`,
				since: g.createdAt.toISOString(),
				deadline: null,
				gigId: g.id,
				deliverableId: null,
			});
			continue;
		}
		if (
			g.status !== "OPEN" ||
			g.reported ||
			!g.exclusive ||
			g.acceptedCount + g.pendingCount >= g.maxDeliverables
		)
			continue;
		if (!g.claimantWallet) {
			waitingOn.push({
				who: "recruiter",
				what: `A recruiter to take the ${kind(g)} with ${about(g)}`,
				since: g.createdAt.toISOString(),
				deadline: null,
				gigId: g.id,
				deliverableId: null,
				...expect(g.createdAt, takeStage(g.type)),
				actions: raiseAction(g),
			});
		} else {
			const who = people.find((p) => p.wallet === g.claimantWallet)?.displayName ?? "The recruiter";
			const since = g.claimedAt ?? g.createdAt;
			waitingOn.push({
				who: "recruiter",
				what: `${who} to run the ${kind(g)} with ${about(g)}`,
				since: since.toISOString(),
				deadline: new Date(since.getTime() + env.claimTimeoutSeconds * 1000).toISOString(),
				gigId: g.id,
				deliverableId: null,
				...expect(since, "run_call"),
				actions: [],
			});
		}
	}
	// Sourcing: recruiters finding candidates. Slow = C's repriceRule would raise it (on the cockpit clock).
	for (const g of gigs) {
		if (g.type !== "SOURCING" || g.status !== "OPEN" || g.acceptedCount >= g.maxDeliverables) continue;
		const delivered = subs.filter((x) => x.sub.gigId === g.id).length;
		const raise = suggestRaise(g);
		const actions: NonNullable<RoleStatusView["waitingOn"][number]["actions"]> = [...raiseAction(g)];
		if (raise && blocking)
			actions.push({
				id: "loosen_requirement",
				label: `Make "${blocking.label}" a nice-to-have (${Math.round(blocking.share * 100)}% miss it)`,
				criterionId: blocking.id,
			});
		waitingOn.push({
			who: "recruiter",
			what: `Recruiters to find candidates (${g.acceptedCount} of ${g.maxDeliverables} accepted, ${delivered} delivered)`,
			since: g.createdAt.toISOString(),
			deadline: null,
			gigId: g.id,
			deliverableId: null,
			expectedBy: new Date(g.createdAt.getTime() + typicalMs("sourcing")).toISOString(),
			slow: Boolean(raise),
			actions,
		});
	}
	for (const g of gigs) {
		if (!g.reported) continue;
		waitingOn.push({
			who: "company",
			what: `A recruiter reported ${about(g)} as possibly fake: report the candidate or dismiss`,
			since: g.createdAt.toISOString(),
			deadline: null,
			gigId: g.id,
			deliverableId: g.aboutCandidateId,
			actions: g.aboutCandidateId
				? [
						{
							id: "report_candidate",
							label: "Report as fake",
							deliverableId: g.aboutCandidateId,
							candidateId: g.aboutCandidateId,
						},
						{
							id: "dismiss_report",
							label: "Dismiss",
							deliverableId: g.aboutCandidateId,
							candidateId: g.aboutCandidateId,
						},
					]
				: [],
		});
	}
	// Changes the agent proposed in chat: nothing runs until the company says yes.
	for (const p of await pendingProposals(roleId))
		waitingOn.push({
			who: "company",
			what: p.summary,
			since: p.createdAt.toISOString(),
			deadline: null,
			gigId: null,
			deliverableId: null,
			actions: [
				{ id: "approve_proposal", label: "Yes", proposalId: p.id },
				{ id: "decline_proposal", label: "No", proposalId: p.id },
			],
		});
	// The agent's inbox questions (replanning, concerns about paid work) until the company answers them.
	const inbox = await db
		.select()
		.from(schema.agentActivity)
		.where(
			and(
				eq(schema.agentActivity.roleId, roleId),
				eq(schema.agentActivity.kind, "ESCALATED"),
				sql`${schema.agentActivity.data}->>'inbox' = 'true'`,
				sql`${schema.agentActivity.data}->>'ackedAt' is null`,
			),
		);
	for (const a of inbox)
		waitingOn.push({
			who: "company",
			what: a.message,
			since: a.createdAt.toISOString(),
			deadline: null,
			gigId: a.gigId,
			deliverableId: a.deliverableId,
			actions: [{ id: "acknowledge", label: "Got it", activityId: a.id }],
		});
	for (const { sub } of subs) {
		const r = sub.agentReview as {
			escalatedAt?: string;
			decision?: { action?: string; reason?: string };
		} | null;
		if (sub.status === "PENDING" && r?.escalatedAt) {
			waitingOn.push({
				who: "company",
				what: `Your call on ${sub.candidateName}: ${r.decision?.reason ?? "the agent isn't sure"}`,
				since: r.escalatedAt,
				deadline: sub.reviewDeadline.toISOString(),
				gigId: sub.gigId,
				deliverableId: sub.id,
				actions: [
					{
						id: "decide",
						label: "Decide",
						deliverableId: sub.id,
						bounty: (gigs.find((g) => g.id === sub.gigId)?.bounty ?? 0n).toString(),
					},
				],
			});
		}
	}
	for (const x of shortlist) {
		const s = byId.get(x.candidateId)?.sub;
		if (x.decision === "NONE")
			waitingOn.push({
				who: "company",
				what: `Decide on ${s?.candidateName ?? "a shortlisted candidate"}: invite or pass`,
				since: x.updatedAt.toISOString(),
				deadline: null,
				gigId: null,
				deliverableId: x.candidateId,
				actions: [
					{
						id: "invite",
						label: "Invite to interview",
						deliverableId: x.candidateId,
						candidateId: x.candidateId,
					},
					{ id: "pass", label: "Pass", deliverableId: x.candidateId, candidateId: x.candidateId },
				],
			});
		if (x.decision === "INVITED")
			waitingOn.push({
				who: "company",
				what: `Tell your agent when ${name(s?.candidateName ?? "the candidate")} came to the interview (releases the recruiters' holdbacks)`,
				since: (x.decidedAt ?? x.updatedAt).toISOString(),
				deadline: null,
				gigId: null,
				deliverableId: x.candidateId,
				actions: [
					{
						id: "attended",
						label: "Came to the interview",
						deliverableId: x.candidateId,
						candidateId: x.candidateId,
					},
					{ id: "no_show", label: "Didn't come", deliverableId: x.candidateId, candidateId: x.candidateId },
				],
			});
	}

	const accepted = (type: string, variant?: "language") =>
		subs.filter(
			({ sub }) =>
				sub.status === "ACCEPTED" &&
				sub.deliverableType === type &&
				(type !== "SCREENING_CALL" ||
					(variant === "language") === (gigs.find((g) => g.id === sub.gigId)?.variant === "language")),
		).length;
	const slots = (type: string, variant?: "language") =>
		gigs
			.filter(
				(g) =>
					g.type === type &&
					(type !== "SCREENING_CALL" || (variant === "language") === (g.variant === "language")),
			)
			.reduce((n, g) => n + (g.status === "CLOSED" ? g.acceptedCount : g.maxDeliverables), 0);

	const busy = currentWorkSince(roleId);
	if (role.status === "CLOSED") {
		const at = (lastStatusChange.get(roleId) ?? role.createdAt).toISOString();
		return {
			roleId,
			now: { text: "Closed", since: at, startedAt: at, busy: false, detail: null },
			waitingOn: [],
			pipeline: {
				sourcingAccepted: accepted("SOURCING"),
				sourcingSlots: slots("SOURCING"),
				confirmed: confirmations.filter((c) => c.status === "YES").length,
				screeningDone: accepted("SCREENING_CALL"),
				screeningSlots: slots("SCREENING_CALL"),
				languageDone: accepted("SCREENING_CALL", "language"),
				referenceDone: accepted("REFERENCE_CHECK"),
				shortlisted: shortlist.length,
			},
			budget: {
				deposited: (role.deposited - role.bondsForfeited).toString(),
				bondsForfeited: role.bondsForfeited.toString(),
				paid: role.paid.toString(),
				heldBack: role.heldBack.toString(),
				committed: "0",
				available: "0",
				spent: (role.paid + role.heldBack).toString(),
				refunded: role.refunded.toString(),
			},
			nextCheckAt: null,
		};
	}
	// The company's own decision comes first in the header when one is waiting.
	const yours = waitingOn
		.filter((w) => w.who === "company")
		.sort((a, b) => a.since.localeCompare(b.since))[0];
	return {
		roleId,
		now: busy
			? {
					text: busy.what,
					since: busy.since.toISOString(),
					startedAt: busy.since.toISOString(),
					busy: true,
					detail: busy.detail ?? null,
				}
			: {
					detail: null,
					text: role.agentPaused
						? "Paused"
						: yours
							? `Waiting for you: ${yours.what.replace(/^./, (c) => c.toLowerCase())}`
							: (role.agentStatus ?? "Waiting for the budget to land"),
					since: (lastStatusChange.get(roleId) ?? role.createdAt).toISOString(),
					startedAt: (lastStatusChange.get(roleId) ?? role.createdAt).toISOString(),
					busy: false,
				},
		waitingOn: waitingOn.sort((a, b) => a.since.localeCompare(b.since)),
		pipeline: {
			sourcingAccepted: accepted("SOURCING"),
			sourcingSlots: slots("SOURCING"),
			confirmed: confirmations.filter((c) => c.status === "YES").length,
			screeningDone: accepted("SCREENING_CALL"),
			screeningSlots: slots("SCREENING_CALL"),
			languageDone: accepted("SCREENING_CALL", "language"),
			referenceDone: accepted("REFERENCE_CHECK"),
			shortlisted: shortlist.length,
		},
		budget: {
			deposited: (role.deposited - role.bondsForfeited).toString(),
			bondsForfeited: role.bondsForfeited.toString(),
			paid: role.paid.toString(),
			heldBack: role.heldBack.toString(),
			committed: role.committed.toString(),
			available: availableBudget(role).toString(),
			spent: (role.paid + role.heldBack).toString(),
		},
		nextCheckAt:
			role.agentManaged && !role.agentPaused ? new Date(Date.now() + env.agentTickMs).toISOString() : null,
	};
}

const lastStatusChange = new Map<string, Date>();
const lastFingerprint = new Map<string, string>();

/** Publish `role.status` when the cockpit changed (cheap: compares a fingerprint without nextCheckAt). */
export async function emitStatusIfChanged(roleId: string) {
	const s = await roleStatus(roleId).catch(() => null);
	if (!s) return;
	const fp = JSON.stringify({ ...s, nextCheckAt: null, now: { ...s.now, since: null, startedAt: null } });
	if (lastFingerprint.get(roleId) === fp) return;
	if (lastFingerprint.get(roleId) !== undefined && !s.now.busy) lastStatusChange.set(roleId, new Date());
	lastFingerprint.set(roleId, fp);
	publish({ type: "role.status", roleId });
}
