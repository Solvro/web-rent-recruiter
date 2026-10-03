import type { AgentReview, Criteria } from "@scout/shared";
import type { CallReview } from "./types.ts";

/** The agent's autonomy limits. Anything outside them goes to the company. */
export const POLICY = {
	/**
	 * Sourcing: only ADVANCE (≥ 75) is pre-accepted automatically. The final payout still waits for
	 * the candidate's confirmation (backend/on-chain holdback), not for the agent.
	 */
	sourcingAcceptScore: 75,
	/** Sourcing 60-74: one follow-up question to the recruiter, then the daily digest if still unclear. */
	sourcingFollowUpScore: 60,
	/** Sourcing 55-59: escalated to the company in the daily digest; below 55 it's rejected. */
	sourcingEscalateScore: 55,
	/** Max follow-up questions per sourced profile. */
	maxFollowUps: 1,
	/** Book a screening call only for candidates at or above this score (ADVANCE). */
	screeningMinScore: 75,
	/** Max screening calls booked per role at a time. */
	maxConcurrentScreenings: 3,
	/** Screening/reference/language gigs: who may claim them (90-day window, re-match rejections excluded). */
	screenerMinAccepted: 10,
	screenerMinAcceptanceRate: 0.5,
	reputationWindowDays: 90,
	/** No-show: the candidate isn't among the recording's speakers, or the call is shorter than this. */
	noShowMaxSeconds: 5 * 60,
	/** One free rebook after a no-show; the second no-show is a candidate strike. */
	maxRebooks: 1,
	/** Paid to the recruiter for a recorded no-show (they did show up). */
	showUpFeeUsd: 5,
} as const;

export type Payout = "full" | "holdback";

/** follow_up: ask the recruiter for one more data point before deciding (sourcing 60-74, once). */
export type AgentAction = "accept" | "reject" | "escalate" | "follow_up";
/** "now" for things that block work or need a human fast; everything else waits for the daily digest. */
export type EscalationDelivery = "now" | "digest";
export type DecisionInput =
	| {
			kind: "sourcing";
			review: AgentReview;
			flags?: string[];
			followUps?: number;
			criteria?: Criteria;
			/** The recruiter's note: a follow-up never asks about something it already covers. */
			notes?: string;
			/** The review couldn't be done properly (e.g. the model was down): a person decides. */
			degraded?: boolean;
	  }
	| { kind: "screening" | "reference" | "language"; review: CallReview; flags?: string[] };

/**
 * What the agent does with a deliverable. Accept signs as role.agent and pays the recruiter.
 * Decided only from structured scores. A deliverable flagged for prompt injection is never
 * accepted automatically: what would be an accept becomes an escalation; a reject stays a reject.
 */
export function agentDecision(input: DecisionInput): {
	action: AgentAction;
	reason: string;
	/** follow_up: the question for the recruiter. */
	question?: string;
	/** escalate: immediately, or batched into the company's daily digest. */
	delivery?: EscalationDelivery;
	/** Calls only: self-reported (no recording) accepts are paid with a holdback until the candidate confirms. */
	payout?: Payout;
} {
	const decision = decideFromScores(input);
	const flags = input.flags ?? (input.kind === "sourcing" ? [] : (input.review.flags ?? []));
	if (flags.length && (decision.action === "accept" || decision.action === "follow_up")) {
		const what =
			flags.includes("identity-mismatch") && flags.length === 1
				? "a profile link that doesn't match the name"
				: `text aimed at the agent (${flags.join(", ")})`;
		return {
			action: "escalate",
			delivery: "now",
			reason: `Would ${decision.action === "accept" ? "accept" : "follow up"} (${decision.reason}), but the deliverable has ${what}. Please check it.`,
		};
	}
	if (input.kind !== "sourcing" && decision.action === "accept") {
		return { ...decision, payout: input.review.confidence === "recorded" ? "full" : "holdback" };
	}
	return decision;
}

type Decision = { action: AgentAction; reason: string; question?: string; delivery?: EscalationDelivery };

function decideFromScores(input: DecisionInput): Decision {
	if (input.kind === "sourcing" && input.degraded) {
		return {
			action: "escalate",
			delivery: "digest",
			reason: "I couldn't check this profile properly right now, so you decide.",
		};
	}
	if (input.kind === "sourcing") {
		const { score, recommendation } = input.review;
		if (recommendation === "ADVANCE" && score >= POLICY.sourcingAcceptScore)
			return { action: "accept", reason: `A strong match (${score}/100) against the must-haves.` };
		if (score >= POLICY.sourcingFollowUpScore) {
			const question =
				(input.followUps ?? 0) < POLICY.maxFollowUps
					? followUpQuestion(input.review, input.criteria, input.notes)
					: null;
			if (question)
				return {
					action: "follow_up",
					reason: `A possible match (${score}/100); one more fact decides it.`,
					question,
				};
			return {
				action: "escalate",
				delivery: "digest",
				reason: `Still a possible match (${score}/100) after a follow-up; your call.`,
			};
		}
		if (score >= POLICY.sourcingEscalateScore)
			return {
				action: "escalate",
				delivery: "digest",
				reason: `Borderline (${score}/100); your call.`,
			};
		return { action: "reject", reason: `Not a match (${score}/100): doesn't meet the must-haves.` };
	}
	const { verdict, reasons, score, checks, language, noShow } = input.review;
	if (noShow) return { action: "reject", reason: reasons[0] ?? "The candidate didn't show up." };
	const reason = reasons[0] ?? verdict;
	if (verdict === "ACCEPT") {
		const answered = checks.filter((c) => !c.missing).length;
		const level = language
			? ` ${language.required.split(" ")[0]} ${language.cefrLevel} (needs ${language.required.split(" ").at(-1)}).`
			: "";
		return {
			action: "accept",
			reason: `Usable answers to ${answered}/${checks.length} questions, ${score}/100.${level}`,
		};
	}
	if (verdict === "REJECT") return { action: "reject", reason };
	// A call deliverable blocks a booked step, so the company sees it now.
	return { action: "escalate", delivery: "now", reason };
}

/** The question for the recruiter: the heaviest must-have the review couldn't confirm. */
const STOP = new Set(
	"with from that this have your their years year experience strong solid good great deep proven working work skills plus least using level production".split(
		" ",
	),
);
const fold = (t: string) =>
	t
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/ł/g, "l")
		.toLowerCase();
const words = (t: string) =>
	fold(t)
		.split(/[^a-z0-9+#]+/)
		.filter((w) => w.length > 2 && !STOP.has(w));

/** True when the note already talks about the criterion (most of its key words appear). */
export function noteCovers(notes: string, label: string): boolean {
	const key = words(label);
	if (!key.length) return false;
	const text = fold(notes);
	const hits = key.filter((w) => text.includes(w.slice(0, Math.max(4, w.length - 2)))).length;
	return hits / key.length >= 0.5;
}

/**
 * The follow-up for the recruiter: the heaviest must-have the review couldn't confirm AND the
 * note doesn't already talk about (UNKNOWN before PARTIAL). null when there's nothing to ask.
 */
export function followUpQuestion(review: AgentReview, criteria?: Criteria, notes = ""): string | null {
	const verdictOf = new Map(review.verdicts.map((v) => [v.criterionId, v]));
	const must = [...(criteria?.mustHave ?? [])].sort((a, b) => b.weight - a.weight);
	const askable = (verdict: string) =>
		must.find((c) => {
			const v = verdictOf.get(c.id);
			return v?.verdict === verdict && !noteCovers(notes, c.label) && !noteCovers(v.reasoning ?? "", c.label);
		});
	const pick = askable("UNKNOWN") ?? askable("PARTIAL");
	if (!pick) return null;
	return `The note doesn't say much about “${pick.label}”. Can you add one concrete fact (a project, a number or a link)?`;
}

/** Which accepted sourced candidates get a screening call next: ADVANCE-level (≥ 75), best first. */
export function pickForScreening<T extends { id: string; review: AgentReview }>(
	candidates: T[],
	alreadyBooked = 0,
): T[] {
	const slots = Math.max(0, POLICY.maxConcurrentScreenings - alreadyBooked);
	return candidates
		.filter((c) => c.review.score >= POLICY.screeningMinScore)
		.sort((a, b) => b.review.score - a.review.score)
		.slice(0, slots);
}

/**
 * Whether a recruiter may claim a screening, reference or language gig: enough accepted work at a
 * good rate over the last 90 days, and never the person who sourced this candidate.
 */
export function canClaimCallGig(input: {
	recruiter: { wallet: string; acceptedLast90d: number; decidedLast90d: number };
	sourcerWallet?: string;
}): { allowed: boolean; reason: string } {
	const { recruiter } = input;
	if (input.sourcerWallet && input.sourcerWallet === recruiter.wallet)
		return { allowed: false, reason: "The recruiter who sourced a candidate can't also screen them." };
	if (recruiter.acceptedLast90d < POLICY.screenerMinAccepted)
		return {
			allowed: false,
			reason: `Needs ${POLICY.screenerMinAccepted} accepted gigs in ${POLICY.reputationWindowDays} days (has ${recruiter.acceptedLast90d}).`,
		};
	const rate = recruiter.decidedLast90d ? recruiter.acceptedLast90d / recruiter.decidedLast90d : 0;
	if (rate < POLICY.screenerMinAcceptanceRate)
		return {
			allowed: false,
			reason: `Acceptance rate ${Math.round(rate * 100)}% is below ${POLICY.screenerMinAcceptanceRate * 100}%.`,
		};
	return { allowed: true, reason: "Eligible." };
}

/** After a no-show: one free rebook, then a candidate strike. The recruiter gets the show-up fee. */
export function noShowPolicy(previousNoShows: number): {
	action: "rebook" | "strike";
	showUpFeeUsd: number;
} {
	return {
		action: previousNoShows < POLICY.maxRebooks ? "rebook" : "strike",
		showUpFeeUsd: POLICY.showUpFeeUsd,
	};
}
