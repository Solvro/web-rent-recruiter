/**
 * Deterministic budget split, pure (no LLM, server or Node imports): safe for the browser, so the
 * app's plan step can show the agent's exact split and recompute it as the budget changes.
 */
import type { Criteria } from "@scout/shared";
import { rarityFactor } from "../budget.ts";
import { requiredLanguage } from "./language.ts";
import { gigPrice, priceGig, regionOf } from "./market.ts";
import type { GigType, GigVariant } from "./types.ts";

type Seniority = Criteria["seniority"];

export const RESERVE_SHARE = 0.2;
/** Rounding sourcing up may eat into the reserve down to this share. */
export const MIN_RESERVE_SHARE = 0.15;
export const SOURCING_MIN = 5;
export const SOURCING_MAX = 30;
export const SCREENINGS_DEFAULT = 3;
export const SCREENINGS_MAX = 5;
export const REFERENCES_MAX = 2;

export interface GigCounts {
	sourcingBounty: number;
	sourcing: number;
	screeningBounty: number;
	screenings: number;
	referenceBounty: number;
	references: number;
	/** One language check per reference (the finalist) when the criteria name a language to check. */
	languageBounty: number;
	languageChecks: number;
	reserve: number;
}

/**
 * Deterministic budget split (USDC). Keeps ~20% in reserve, funds 3 screenings and 1 reference
 * by default, gives the rest to sourcing (5-30 profiles). Small budgets drop screenings and then
 * the reference; large ones add screenings (up to 5) and a second reference.
 * When the criteria name a language to check, the finalist also gets a $15 language check.
 * Demo (senior Rust/Solana, CEE, English C1): $500 → 12 × $20 sourcing, 3 × $40 screening,
 * 1 × $15 language, 1 × $25 reference, $100 reserve. $300 → 6 × $20, 2 × $40, $15, $25, $60.
 */
export function splitBudget(budgetUsdc: number, seniority: Seniority, criteria?: Criteria): GigCounts {
	// Prices from priceGig: the GIG_PRICES floor × rarity × region (see market.ts).
	const quote = (taskType: GigType, variant?: GigVariant) =>
		criteria
			? priceGig({ taskType, variant, seniority, rarity: rarityFactor(criteria), region: regionOf(criteria) })
					.usd
			: gigPrice(taskType, seniority, variant);
	const sourcingBounty = quote("SOURCING");
	const screeningBounty = quote("SCREENING_CALL");
	const referenceBounty = quote("REFERENCE_CHECK");
	const languageBounty = criteria && requiredLanguage(criteria) ? quote("SCREENING_CALL", "language") : 0;
	const spendable = Math.floor(budgetUsdc * (1 - RESERVE_SHARE));
	const minSourcing = SOURCING_MIN * sourcingBounty;

	let screenings = SCREENINGS_DEFAULT;
	let references = 1;
	const languageChecks = () => (languageBounty && screenings > 0 ? Math.max(1, references) : 0);
	const calls = () =>
		screenings * screeningBounty + references * referenceBounty + languageChecks() * languageBounty;
	while (screenings > 0 && calls() + minSourcing > spendable) {
		if (screenings > 1) screenings--;
		else if (references > 0) references--;
		else screenings--;
	}
	if (screenings === 0) references = 0;

	const forSourcing = Math.max(0, spendable - calls());
	let sourcing = Math.min(SOURCING_MAX, Math.floor(forSourcing / sourcingBounty));
	// Cheap sourcing is planned in steps of 5 (rounding to the nearest 5 while the reserve stays ≥ 15%);
	// at $10+ per profile every slot matters, so it's exact.
	if (sourcing >= SOURCING_MIN && sourcingBounty < 10) {
		const nearest = Math.min(SOURCING_MAX, Math.round(sourcing / 5) * 5);
		const reserveIfNearest = budgetUsdc - calls() - nearest * sourcingBounty;
		sourcing = reserveIfNearest >= budgetUsdc * MIN_RESERVE_SHARE ? nearest : Math.floor(sourcing / 5) * 5;
	}

	// Large budgets: more screenings, then a second reference, while sourcing stays at its cap.
	let left = spendable - calls() - sourcing * sourcingBounty;
	while (sourcing === SOURCING_MAX && screenings < SCREENINGS_MAX && left >= screeningBounty) {
		screenings++;
		left -= screeningBounty;
	}
	if (
		sourcing === SOURCING_MAX &&
		screenings === SCREENINGS_MAX &&
		references < REFERENCES_MAX &&
		left >= referenceBounty
	) {
		references++;
	}
	const committed = sourcing * sourcingBounty + calls();
	return {
		sourcingBounty,
		sourcing,
		screeningBounty,
		screenings,
		referenceBounty,
		references,
		languageBounty,
		languageChecks: languageChecks(),
		reserve: budgetUsdc - committed,
	};
}
