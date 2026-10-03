import { type Criteria, USDC_UNIT } from "@scout/shared";

/** USDC per accepted candidate for a common profile, by seniority. */
const BASE_BOUNTY: Record<Criteria["seniority"], number> = {
	JUNIOR: 8,
	MID: 12,
	SENIOR: 18,
	STAFF: 28,
	PRINCIPAL: 40,
	EXECUTIVE: 60,
};

/** How many qualified candidates a company typically wants to see, by seniority. */
const BASE_CANDIDATES: Record<Criteria["seniority"], number> = {
	JUNIOR: 15,
	MID: 12,
	SENIOR: 10,
	STAFF: 8,
	PRINCIPAL: 6,
	EXECUTIVE: 5,
};

export const BOUNTY_MIN_USDC = 10;
export const BOUNTY_MAX_USDC = 150;
export const CANDIDATES_MIN = 5;
export const CANDIDATES_MAX = 20;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const isEnglish = (language: string) => /^english\b/i.test(language.trim());

/**
 * How hard the profile is to find, 1.0 = common. Driven by how much the must-haves ask for,
 * non-English language requirements, on-site presence and the number of deal breakers.
 */
export function rarityFactor(criteria: Criteria): number {
	const mustHaveWeight = criteria.mustHave.reduce((sum, c) => sum + c.weight, 0);
	const fromMustHaves = clamp(0.02 * (mustHaveWeight - 15), 0, 0.3);
	const extraLanguages = criteria.languages.filter((l) => !isEnglish(l)).length;
	const fromLanguages = clamp(0.1 * extraLanguages, 0, 0.2);
	const fromLocation = { ONSITE: 0.1, HYBRID: 0.05, REMOTE: 0 }[criteria.location.mode];
	const fromDealBreakers = clamp(0.03 * criteria.dealBreakers.length, 0, 0.1);
	return Math.round((1 + fromMustHaves + fromLanguages + fromLocation + fromDealBreakers) * 100) / 100;
}

export interface BudgetNumbers {
	/** USDC base units (6 decimals). */
	bounty: bigint;
	bountyUsdc: number;
	maxCandidates: number;
	rarity: number;
}

/** Deterministic: same criteria, same numbers. The LLM only explains them. */
export function computeBudget(criteria: Criteria): BudgetNumbers {
	const rarity = rarityFactor(criteria);
	const raw = BASE_BOUNTY[criteria.seniority] * rarity;
	const bountyUsdc = clamp(Math.round(raw / 5) * 5, BOUNTY_MIN_USDC, BOUNTY_MAX_USDC);
	// Rarer profiles: ask for fewer candidates (one fewer from 1.25, then one more per extra 0.25).
	const reduction = rarity >= 1.25 ? 1 + Math.floor((rarity - 1.25) / 0.25) : 0;
	const maxCandidates = clamp(
		BASE_CANDIDATES[criteria.seniority] - reduction,
		CANDIDATES_MIN,
		CANDIDATES_MAX,
	);
	return { bounty: BigInt(bountyUsdc) * BigInt(USDC_UNIT), bountyUsdc, maxCandidates, rarity };
}
