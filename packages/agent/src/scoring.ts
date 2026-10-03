import type { AgentReview, Criteria, Criterion } from "@scout/shared";

export type Verdict = AgentReview["verdicts"][number];
export type VerdictValue = Verdict["verdict"];
export type CriterionKind = "mustHave" | "niceToHave" | "dealBreaker";

export interface KindedCriterion extends Criterion {
	kind: CriterionKind;
}

export function allCriteria(criteria: Criteria): KindedCriterion[] {
	return [
		...criteria.mustHave.map((c) => ({ ...c, kind: "mustHave" as const })),
		...criteria.niceToHave.map((c) => ({ ...c, kind: "niceToHave" as const })),
		...criteria.dealBreakers.map((c) => ({ ...c, kind: "dealBreaker" as const })),
	];
}

/** Credit per verdict. UNKNOWN gets a little credit: missing info is a question, not a no. */
const CREDIT: Record<VerdictValue, number> = { MET: 1, PARTIAL: 0.5, NOT_MET: 0, UNKNOWN: 0.3 };
/** Must-haves count double against nice-to-haves of the same weight. */
const MUST_HAVE_MULTIPLIER = 2;
export const DEAL_BREAKER_CAP = 30;
export const DEAL_BREAKER_PARTIAL_PENALTY = 10;
export const ADVANCE_THRESHOLD = 75;
export const MAYBE_THRESHOLD = 50;

/**
 * Score 0-100 from weighted verdicts. Must-haves and nice-to-haves add up; a deal breaker that
 * applies (MET) caps the score at 30, a partial one costs 10 points.
 */
export function computeScore(criteria: Criteria, verdicts: Verdict[]): number {
	const byId = new Map(verdicts.map((v) => [v.criterionId, v.verdict]));
	let earned = 0;
	let possible = 0;
	for (const c of allCriteria(criteria)) {
		if (c.kind === "dealBreaker") continue;
		const weight = c.kind === "mustHave" ? c.weight * MUST_HAVE_MULTIPLIER : c.weight;
		earned += weight * CREDIT[byId.get(c.id) ?? "UNKNOWN"];
		possible += weight;
	}
	let score = possible === 0 ? 50 : Math.round((100 * earned) / possible);
	for (const c of criteria.dealBreakers) {
		const verdict = byId.get(c.id);
		if (verdict === "MET") score = Math.min(score, DEAL_BREAKER_CAP);
		else if (verdict === "PARTIAL") score -= DEAL_BREAKER_PARTIAL_PENALTY;
	}
	return Math.max(0, Math.min(100, score));
}

export function recommend(score: number): AgentReview["recommendation"] {
	if (score >= ADVANCE_THRESHOLD) return "ADVANCE";
	if (score >= MAYBE_THRESHOLD) return "MAYBE";
	return "PASS";
}

/** Keeps exactly one verdict per criterion, in criteria order; missing ones become UNKNOWN. */
export function normalizeVerdicts(criteria: Criteria, verdicts: Verdict[]): Verdict[] {
	const byId = new Map(verdicts.map((v) => [v.criterionId, v]));
	return allCriteria(criteria).map(
		(c) =>
			byId.get(c.id) ?? {
				criterionId: c.id,
				verdict: "UNKNOWN",
				reasoning: "The notes don't mention this.",
			},
	);
}
