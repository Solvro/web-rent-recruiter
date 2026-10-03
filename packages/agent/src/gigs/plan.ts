import { type Criteria, fromBaseUnits, USDC_UNIT } from "@scout/shared";
import { z } from "zod";
import { complete } from "../llm/index.ts";
import { prompt } from "../prompts.ts";
import { requiredLanguage } from "./language.ts";
import { type GigCounts, splitBudget } from "./split.ts";
import type { GigPlan, PlannedGig } from "./types.ts";

type Seniority = Criteria["seniority"];

export { GIG_PRICE_TABLE, GIG_PRICES, gigPrice } from "./market.ts";

export type { GigCounts } from "./split.ts";
export {
	MIN_RESERVE_SHARE,
	REFERENCES_MAX,
	RESERVE_SHARE,
	SCREENINGS_DEFAULT,
	SCREENINGS_MAX,
	SOURCING_MAX,
	SOURCING_MIN,
	splitBudget,
} from "./split.ts";

const BriefsOutput = z.object({
	sourcing: z.string(),
	screening: z.string(),
	reference: z.string(),
});

const usd = (n: number) => `$${n}`;
const place = (criteria: Criteria) =>
	criteria.location.mode === "REMOTE"
		? `remote${criteria.location.places.length ? ` (${criteria.location.places.join(", ")})` : ""}`
		: criteria.location.places.join(", ") || criteria.location.mode.toLowerCase();

const article = (word: string) => `${/^[aeiou]/i.test(word) ? "an" : "a"} ${word}`;

function languageBrief(criteria: Criteria): string {
	const lang = requiredLanguage(criteria);
	return lang
		? `A 15-minute call in ${lang.name} with a shortlisted candidate, following the agent's 5 questions. Deliver what they said to each question, your CEFR estimate (the role needs ${lang.level}) and, if you can, the transcript.`
		: "";
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const listJoin = (items: string[]) =>
	items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

/** The plan line in the agent's thread, always computed from the numbers (never from the model). */
export function planRationale(criteria: Criteria, counts: GigCounts): string {
	const total =
		counts.reserve +
		counts.sourcing * counts.sourcingBounty +
		counts.screenings * counts.screeningBounty +
		counts.languageChecks * counts.languageBounty +
		counts.references * counts.referenceBounty;
	const lang = requiredLanguage(criteria)?.name ?? "";
	const parts = [
		counts.sourcing &&
			`${usd(counts.sourcing * counts.sourcingBounty)} to sourcing ${plural(counts.sourcing, "profile")}`,
		counts.screenings &&
			`${usd(counts.screenings * counts.screeningBounty)} to ${plural(counts.screenings, "screening call")} with the best of them`,
		counts.languageChecks &&
			`${usd(counts.languageChecks * counts.languageBounty)} to ${counts.languageChecks === 1 ? article(lang) : `${counts.languageChecks} ${lang}`} language check${counts.languageChecks === 1 ? "" : "s"} for the finalist`,
		counts.references &&
			`${usd(counts.references * counts.referenceBounty)} to ${plural(counts.references, "reference check")}`,
	].filter((p): p is string => Boolean(p));
	const missing =
		counts.sourcing === 0
			? " The budget doesn't cover any sourcing yet; top it up to start."
			: counts.screenings === 0
				? " No screening call fits this budget yet; top it up to add one."
				: counts.references === 0
					? " No reference check fits this budget; top it up to add one for the finalist."
					: "";
	const reserve =
		counts.reserve > 0
			? ` ${usd(counts.reserve)} stays in reserve to re-post a gig if a candidate drops out.`
			: "";
	return `Of the ${usd(total)} budget, the agent commits ${parts.length ? listJoin(parts) : "nothing yet"}.${reserve}${missing}`;
}

function offlineBriefs(input: { criteria: Criteria; title: string }, counts: GigCounts) {
	const must = input.criteria.mustHave
		.slice(0, 3)
		.map((c) => c.label.toLowerCase())
		.join("; ");
	return {
		sourcing: `Find ${input.title} candidates (${place(input.criteria)}) who are open to a conversation. Must have: ${must}. Deliver a profile link and a 2-line note on why they fit; you're paid ${usd(counts.sourcingBounty)} for each profile the agent accepts.`,
		screening: `Run a 30-minute call with a shortlisted candidate using the agent's question script. Deliver an answer to every question with concrete details (projects, numbers, dates) and your recommendation. Paid for the quality of the answers, not the minutes.`,
		reference: `Call one reference the candidate provides and work through the agent's 5 questions. Deliver specific answers, including how the reference knows the candidate and what they'd verify.`,
	};
}

export async function planGigs(input: {
	criteria: Criteria;
	title: string;
	/** USDC base units. */
	budget: bigint;
	seniority?: Seniority;
}): Promise<GigPlan> {
	const seniority = input.seniority ?? input.criteria.seniority;
	const budgetUsdc = Math.floor(fromBaseUnits(input.budget));
	const counts = splitBudget(budgetUsdc, seniority, input.criteria);
	const briefs = await complete({
		system: prompt("system"),
		prompt: prompt("gig-briefs", {
			title: input.title,
			seniority,
			location: place(input.criteria),
			mustHave: input.criteria.mustHave.map((c) => c.label).join("; "),
			dealBreakers: input.criteria.dealBreakers.map((c) => c.label).join("; ") || "none",
			budget: budgetUsdc,
			sourcing: `${counts.sourcing} profiles × ${usd(counts.sourcingBounty)}`,
			screening: `${counts.screenings} calls × ${usd(counts.screeningBounty)}${
				counts.languageChecks
					? `, plus ${counts.languageChecks} × ${usd(counts.languageBounty)} ${requiredLanguage(input.criteria)?.name} language check for the finalist`
					: ""
			}`,
			reference: counts.references
				? `${counts.references} × ${usd(counts.referenceBounty)}`
				: "none (doesn't fit the budget)",
			reserve: usd(counts.reserve),
		}),
		schema: BriefsOutput,
		schemaName: "gig_briefs",
		offline: () => offlineBriefs(input, counts),
	});
	const language = requiredLanguage(input.criteria);
	// Numbers are code's job: the plan line is always computed, whatever the model wrote.
	const rationale = planRationale(input.criteria, counts);

	const base = (usdc: number) => BigInt(usdc) * BigInt(USDC_UNIT);
	const gigs: PlannedGig[] = [];
	if (counts.sourcing > 0) {
		gigs.push({
			taskType: "SOURCING",
			title: `Find up to ${counts.sourcing} ${input.title} candidates`,
			brief: briefs.sourcing,
			bounty: base(counts.sourcingBounty),
			maxDeliverables: counts.sourcing,
			exclusive: false,
			when: "now",
		});
	}
	for (let i = 1; i <= counts.screenings; i++) {
		gigs.push({
			taskType: "SCREENING_CALL",
			title: `Screening call with shortlisted candidate #${i}`,
			brief: briefs.screening,
			bounty: base(counts.screeningBounty),
			maxDeliverables: 1,
			exclusive: true,
			when: "after_sourcing",
		});
	}
	for (let i = 1; i <= counts.languageChecks; i++) {
		gigs.push({
			taskType: "SCREENING_CALL",
			variant: "language",
			title:
				counts.languageChecks > 1
					? `${language?.name} language check (${language?.level}) for finalist #${i}`
					: `${language?.name} language check (${language?.level}) for the finalist`,
			brief: languageBrief(input.criteria),
			bounty: base(counts.languageBounty),
			maxDeliverables: 1,
			exclusive: true,
			when: "after_screening",
		});
	}
	for (let i = 1; i <= counts.references; i++) {
		gigs.push({
			taskType: "REFERENCE_CHECK",
			title:
				counts.references > 1 ? `Reference check for finalist #${i}` : "Reference check for the finalist",
			brief: briefs.reference,
			bounty: base(counts.referenceBounty),
			maxDeliverables: 1,
			exclusive: true,
			when: "after_screening",
		});
	}
	const committed = gigs.reduce((sum, g) => sum + g.bounty * BigInt(g.maxDeliverables), 0n);
	return { gigs, rationale, committed, reserve: input.budget - committed };
}
