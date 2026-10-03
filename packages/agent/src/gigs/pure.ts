/**
 * Browser-safe entry for the app: pricing, budget split, requirements and language rules.
 * Everything here is pure (no LLM, server, DB or Node imports), so the UI shows the agent's exact
 * numbers. Keep it that way: pure.test.ts checks the import graph.
 */
export { rarityFactor } from "../budget.ts";
export { requiredLanguage } from "./language.ts";
export {
	canClaimGig,
	expectedSourcingDeliveries,
	GIG_PRICE_TABLE,
	GIG_PRICES,
	type GigRequirements,
	gigPrice,
	gigRequirements,
	MARKET_MULTIPLIER,
	PRICING,
	type PriceQuote,
	priceForRole,
	priceGig,
	type Region,
	regionOf,
	repriceRule,
	roleSkills,
	SENIORITY_MULTIPLIER,
} from "./market.ts";
export {
	type GigCounts,
	MIN_RESERVE_SHARE,
	REFERENCES_MAX,
	RESERVE_SHARE,
	SCREENINGS_DEFAULT,
	SCREENINGS_MAX,
	SOURCING_MAX,
	SOURCING_MIN,
	splitBudget,
} from "./split.ts";
export type { GigType, GigVariant } from "./types.ts";
