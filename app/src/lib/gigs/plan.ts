/**
 * The agent's work plan for a budget: Stream C's own split and prices (backend/src/agent/gigs/pure.ts, browser-safe),
 * so the plan the company sees is exactly what the agent will post.
 */
import { type Criteria, toBaseUnits } from "@scout/shared";
import { priceForRole, splitBudget } from "../../../../backend/src/agent/gigs/pure";
import type { GigKind } from "../gig-types";
import type { GigType } from "./schemas";

export type PlannedGig = {
	kind: GigKind;
	type: GigType;
	label: string;
	count: number;
	price: bigint;
	/** How the agent got to the price, e.g. "$20 (floor $20; senior tier)". */
	why: string;
};
export type Plan = { gigs: PlannedGig[]; reserve: bigint };

/** Budgets the company can pick, in $50 steps. */
export const BUDGET_STEP_USD = 50;
export const DEFAULT_BUDGET_USD = 750;

/** "English (C1)" stays as is; a bare "English" gets the default level. */
export const withLevel = (language: string) => (/\(/.test(language) ? language : `${language} (C1)`);

export function planGigs(criteria: Criteria, budgetUsd: number): Plan {
	const c = splitBudget(budgetUsd, criteria.seniority, criteria);
	const why = (type: GigType, variant?: "language") => priceForRole(criteria, type, variant).explanation;
	const language = criteria.languages[0];
	const gigs: PlannedGig[] = [
		{
			kind: "SOURCING",
			type: "SOURCING",
			label: "Find candidates",
			count: c.sourcing,
			price: toBaseUnits(c.sourcingBounty),
			why: why("SOURCING"),
		},
		{
			kind: "SCREENING_CALL",
			type: "SCREENING_CALL",
			label: "Screening calls",
			count: c.screenings,
			price: toBaseUnits(c.screeningBounty),
			why: why("SCREENING_CALL"),
		},
		{
			kind: "LANGUAGE_CHECK",
			type: "SCREENING_CALL",
			label: withLevel(language ?? "English"),
			count: c.languageChecks,
			price: toBaseUnits(c.languageBounty),
			why: why("SCREENING_CALL", "language"),
		},
		{
			kind: "REFERENCE_CHECK",
			type: "REFERENCE_CHECK",
			label: "Reference check for the finalist",
			count: c.references,
			price: toBaseUnits(c.referenceBounty),
			why: why("REFERENCE_CHECK"),
		},
	];
	return { gigs: gigs.filter((g) => g.count > 0), reserve: toBaseUnits(c.reserve) };
}

export const planTotal = (plan: Plan) => plan.gigs.reduce((sum, g) => sum + g.price * BigInt(g.count), 0n);
