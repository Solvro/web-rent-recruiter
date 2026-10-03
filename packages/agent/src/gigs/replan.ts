/**
 * Pipeline replanning ladder, in order, never above the budget:
 *   1. more sourcing from the reserve
 *   2. raise the sourcing price (repriceRule, within the role's max bounty and budget)
 *   3. propose loosening one criterion (the must-have that blocks most candidates)
 *   4. ask the company for a top-up
 * Each rung runs at most once per dry spell; `done` lists the rungs already taken.
 */
import type { AgentReview, Criteria } from "@scout/shared";
import { expectedSourcingDeliveries, PRICING, repriceRule } from "./market.ts";

export type ReplanStepName = "more_sourcing" | "raise_price" | "loosen_criterion" | "request_top_up";

export const REPLAN = {
	/** Sourcing counts as dry after this many hours below half the pace that fills it in a week. */
	dryAfterHours: 48,
	/** Candidates needed in flight (screening-worthy or in calls) to keep the pipeline healthy. */
	targetInFlight: 3,
	/** Extra sourcing posted per rung 1 (capped by budget). */
	extraSourcing: 10,
	/** A must-have counts as blocking when it's NOT_MET or UNKNOWN for this share of reviewed profiles. */
	blockingShare: 0.5,
	/** Top-up asked for: this many sourcing slots plus one screening call. */
	topUpSourcingSlots: 10,
} as const;

export interface PipelineState {
	criteria: Criteria;
	/** USDC not promised to anything. */
	budgetAvailable: number;
	/** The company's per-deliverable cap. */
	maxBounty: number;
	sourcing: {
		bounty: number;
		maxDeliverables: number;
		acceptedCount: number;
		deliveries: number;
		claims: number;
		hoursOpen: number;
		/** All slots used (closed) or the gig is gone. */
		exhausted: boolean;
	} | null;
	screeningBounty: number;
	/** ADVANCE candidates not yet screened, plus open/booked screenings. */
	inFlight: number;
	/** In-flight candidates needed (default REPLAN.targetInFlight, e.g. the planned screenings). */
	targetInFlight?: number;
	/**
	 * Reviews of every sourced profile so far, accepted AND rejected, with per-criterion verdicts:
	 * loosen_criterion looks for the must-have most profiles miss.
	 */
	reviews: AgentReview[];
	done: ReplanStepName[];
}

export interface ReplanStep {
	step: ReplanStepName | "none";
	/** One line for the agent thread. */
	reason: string;
	/** more_sourcing: slots; raise_price: new bounty; loosen: criterion id; top_up: USDC. */
	value?: number | string;
	/** Steps 3 and 4 need the company's yes. */
	needsCompany: boolean;
}

/**
 * Dry: fewer candidates in flight than needed, and sourcing won't close the gap on its own
 * (exhausted, or after 48 h under half the pace that fills it in a week).
 */
export function isDry(state: PipelineState): boolean {
	if (state.inFlight >= (state.targetInFlight ?? REPLAN.targetInFlight)) return false;
	const s = state.sourcing;
	if (!s) return true;
	if (s.exhausted) return true;
	return (
		s.hoursOpen >= REPLAN.dryAfterHours &&
		s.deliveries < PRICING.sourcingBehindShare * expectedSourcingDeliveries(s.maxDeliverables, s.hoursOpen)
	);
}

/** The must-have most often unmet among reviewed profiles, if it blocks at least half of them. */
export function blockingCriterion(state: PipelineState): { id: string; label: string; share: number } | null {
	if (!state.reviews.length) return null;
	let best: { id: string; label: string; share: number } | null = null;
	for (const c of state.criteria.mustHave) {
		const misses = state.reviews.filter((r) =>
			r.verdicts.some((v) => v.criterionId === c.id && (v.verdict === "NOT_MET" || v.verdict === "UNKNOWN")),
		).length;
		const share = misses / state.reviews.length;
		if (share >= REPLAN.blockingShare && (!best || share > best.share))
			best = { id: c.id, label: c.label, share };
	}
	return best;
}

export function replanStep(state: PipelineState): ReplanStep {
	const none = (reason: string): ReplanStep => ({ step: "none", reason, needsCompany: false });
	if (!isDry(state)) return none("The pipeline is moving.");
	const bounty = state.sourcing?.bounty ?? 0;

	if (!state.done.includes("more_sourcing") && bounty > 0) {
		const slots = Math.min(REPLAN.extraSourcing, Math.floor(state.budgetAvailable / bounty));
		if (slots >= 5)
			return {
				step: "more_sourcing",
				value: slots,
				needsCompany: false,
				reason: `The pipeline ran dry, so I'm posting ${slots} more sourcing slots at $${bounty} from the reserve.`,
			};
	}
	if (!state.done.includes("raise_price") && state.sourcing && !state.sourcing.exhausted) {
		const r = repriceRule({
			gig: {
				taskType: "SOURCING",
				bounty,
				maxDeliverables: state.sourcing.maxDeliverables,
				acceptedCount: state.sourcing.acceptedCount,
			},
			hoursOpen: state.sourcing.hoursOpen,
			claims: state.sourcing.claims,
			deliveries: state.sourcing.deliveries,
			maxBounty: state.maxBounty,
			budgetAvailable: state.budgetAvailable,
		});
		if (r.action === "raise")
			return { step: "raise_price", value: r.bounty, needsCompany: false, reason: r.reason };
	}
	const blocking = blockingCriterion(state);
	if (!state.done.includes("loosen_criterion") && blocking) {
		return {
			step: "loosen_criterion",
			value: blocking.id,
			needsCompany: true,
			reason: `${Math.round(blocking.share * 100)}% of the profiles so far miss "${blocking.label}". Should I make it a nice-to-have?`,
		};
	}
	if (!state.done.includes("request_top_up")) {
		const amount = Math.max(0, REPLAN.topUpSourcingSlots * Math.max(bounty, 1) + state.screeningBounty);
		return {
			step: "request_top_up",
			value: amount,
			needsCompany: true,
			reason: `The budget left ($${state.budgetAvailable}) can't keep the search going. A $${amount} top-up buys ${REPLAN.topUpSourcingSlots} more profiles and one screening call.`,
		};
	}
	return none("Every replanning step has been tried; waiting for the company.");
}
