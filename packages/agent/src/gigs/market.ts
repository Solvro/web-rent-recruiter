/**
 * Gig pricing and requirements. Deterministic: the agent explains the numbers in its thread,
 * it doesn't invent them. Bases are the CEE supply targets from docs/research/market-rates.md.
 *
 *   price = base × tier (sourcing only) × market × urgency, rounded to $1; never below the floor
 *   (base × tier, CEE), and an open gig is never lowered.
 *
 * Sourcing is paid when the candidate confirms interest (the agent's ADVANCE only pre-accepts),
 * with an optional bonus when the candidate passes screening. Calls are flat per task.
 */
import type { Criteria } from "@scout/shared";
import { rarityFactor } from "../budget.ts";
import { requiredLanguage } from "./language.ts";
import type { GigType, GigVariant } from "./types.ts";

type Seniority = Criteria["seniority"];
export type Region = "CEE" | "WEST_EU" | "UK" | "US" | "OTHER";
export type Urgency = "normal" | "urgent";

/** Base prices in USDC (CEE supply targets, docs/research/market-rates.md §3). */
export const GIG_PRICES = {
	/** Paid on candidate confirmation; scaled by seniority tier. */
	SOURCING: 12,
	/** Optional bonus to the sourcer when their candidate passes the screening call. */
	SOURCING_SCREEN_BONUS: 15,
	SCREENING_CALL: 40,
	/** SCREENING_CALL variant "language": 15-minute CEFR check. */
	LANGUAGE_CHECK: 15,
	/** SCREENING_CALL variant "tech": a technical screen run by an engineer (premium). */
	TECH_SCREEN: 100,
	REFERENCE_CHECK: 25,
} as const;

/** Seniority/rarity tiers for sourcing: junior 1.0, mid 1.3, senior 1.7, niche/exec 2.5. */
export const SENIORITY_MULTIPLIER: Record<Seniority, number> = {
	JUNIOR: 1,
	MID: 1.3,
	SENIOR: 1.7,
	STAFF: 2.5,
	PRINCIPAL: 2.5,
	EXECUTIVE: 2.5,
};
const TIERS = [1, 1.3, 1.7, 2.5];

/** Market multiplier (candidate market, not recruiter location): CEE 1.0, W. Europe 1.7, US 2.0. */
export const MARKET_MULTIPLIER: Record<Region, number> = { CEE: 1, OTHER: 1, WEST_EU: 1.7, UK: 1.7, US: 2 };

/** Floor price (CEE, normal urgency): base × seniority tier for sourcing; calls are flat. */
export function gigPrice(type: GigType, seniority: Seniority, variant?: GigVariant, rare = false): number {
	if (type === "SOURCING") {
		const tier = SENIORITY_MULTIPLIER[seniority];
		const bumped = rare ? (TIERS.find((t) => t > tier) ?? tier) : tier;
		return Math.round(GIG_PRICES.SOURCING * bumped);
	}
	if (type === "SCREENING_CALL" && variant === "language") return GIG_PRICES.LANGUAGE_CHECK;
	if (type === "SCREENING_CALL" && variant === "tech") return GIG_PRICES.TECH_SCREEN;
	return GIG_PRICES[type];
}

/** Rows for docs/UI: CEE floor prices by seniority. */
export const GIG_PRICE_TABLE = (
	[
		["SOURCING", "SOURCING", undefined],
		["SCREENING_CALL", "SCREENING_CALL", undefined],
		["SCREENING_CALL (variant: language)", "SCREENING_CALL", "language"],
		["SCREENING_CALL (variant: tech)", "SCREENING_CALL", "tech"],
		["REFERENCE_CHECK", "REFERENCE_CHECK", undefined],
	] as const
).map(([gig, type, variant]) => ({
	gig,
	...Object.fromEntries(
		(Object.keys(SENIORITY_MULTIPLIER) as Seniority[]).map((s) => [s, gigPrice(type, s, variant)]),
	),
}));

export const PRICING = {
	/** Rarity ≥ this makes a profile "rare": sourcing moves up one seniority tier. */
	rareProfile: 1.3,
	/**
	 * Sourcing is priced this much above the CEE market target: at market rate supply is too slow to
	 * shortlist 3 in 21 days reliably (sim: 85% → 91–93% at ×1.25; recruitment-realism.md §3).
	 */
	sourcingPremium: 1.25,
	urgencyMultiplier: { normal: 1, urgent: 1.25 } as Record<Urgency, number>,
	/** Repricing: hours open before a raise, per gig type. */
	raiseAfterHours: { SOURCING: 24, SCREENING_CALL: 6, REFERENCE_CHECK: 12 } as Record<GigType, number>,
	/** Raise step: +25% when nobody engaged, +15% when claimed/partly delivered but not filled. */
	raiseStepCold: 0.25,
	raiseStepWarm: 0.15,
	/** Sourcing counts as unfilled if fewer than this share of slots got deliveries. */
	/** Sourcing is expected to fill in this many days; "behind" is under half that pace. */
	sourcingTargetDays: 7,
	sourcingBehindShare: 0.5,
	/** Minimum gap between two raises of the same gig (hours); defaults to raiseAfterHours. */
	minHoursBetweenRaises: { SOURCING: 48, SCREENING_CALL: 6, REFERENCE_CHECK: 12 } as Record<GigType, number>,
	/** A gig that filled within this many hours lets the next one of its type start 10% lower (not below the floor). */
	fastFillHours: { SOURCING: 8, SCREENING_CALL: 2, REFERENCE_CHECK: 4 } as Record<GigType, number>,
	fastFillDiscount: 0.1,
} as const;

const REGION_PLACES: [Region, RegExp][] = [
	["US", /\b(usa?|united states|new york|san francisco|sf|nyc|boston|seattle|austin|remote \(us\))\b/i],
	["UK", /\b(uk|united kingdom|london|manchester|edinburgh)\b/i],
	[
		"WEST_EU",
		/\b(germany|berlin|munich|amsterdam|netherlands|paris|france|zurich|switzerland|dach|stockholm|copenhagen|dublin)\b/i,
	],
	[
		"CEE",
		/\b(poland|warsaw|krak[oó]w|wroc[lł]aw|gda[nń]sk|prague|czech|budapest|bucharest|vilnius|riga|tallinn|cee)\b/i,
	],
];

/** Region from the criteria's location places (CEE when unknown). */
export function regionOf(criteria: Criteria): Region {
	const text = criteria.location.places.join(" ");
	for (const [region, re] of REGION_PLACES) if (re.test(text)) return region;
	return criteria.location.places.length ? "OTHER" : "CEE";
}

export interface PriceInput {
	taskType: GigType;
	variant?: GigVariant;
	seniority: Seniority;
	/** rarityFactor(criteria); 1 = common profile. */
	rarity?: number;
	region?: Region;
	urgency?: Urgency;
	/** How the last gig of this type in the role filled: lets the next one start lower if it went fast. */
	fill?: { lastBounty: number; hoursToFill: number };
}

export interface PriceQuote {
	/** USDC, whole dollars. */
	usd: number;
	floor: number;
	/** One line for the agent thread: how the price was built. */
	explanation: string;
}

export function priceGig(input: PriceInput): PriceQuote {
	const rare = (input.rarity ?? 1) >= PRICING.rareProfile;
	const floor = gigPrice(input.taskType, input.seniority, input.variant, rare);
	const factors: [string, number][] = [
		["sourcing premium", input.taskType === "SOURCING" ? PRICING.sourcingPremium : 1],
		[`${input.region ?? "CEE"} market`, MARKET_MULTIPLIER[input.region ?? "CEE"]],
		["urgent", PRICING.urgencyMultiplier[input.urgency ?? "normal"]],
	];
	const tierNote =
		input.taskType === "SOURCING" ? [`${input.seniority.toLowerCase()}${rare ? " + rare" : ""} tier`] : [];
	const computed = Math.max(floor, Math.round(factors.reduce((p, [, m]) => p * m, floor)));
	const applied = [...tierNote, ...factors.filter(([, m]) => m !== 1).map(([name, m]) => `${name} ×${m}`)];
	let usd = computed;
	if (input.fill) {
		const fast = input.fill.hoursToFill <= PRICING.fastFillHours[input.taskType];
		if (fast) {
			// The last one went fast: start 10% under it (never under the floor).
			usd = Math.max(floor, Math.round(input.fill.lastBounty * (1 - PRICING.fastFillDiscount)));
			applied.push(`last one filled in ${input.fill.hoursToFill} h at $${input.fill.lastBounty}`);
		} else if (input.fill.lastBounty > computed) {
			// The last one needed a raise: start where the market was.
			usd = input.fill.lastBounty;
			applied.push(`last one needed $${input.fill.lastBounty}`);
		}
	}
	return {
		usd,
		floor,
		explanation: `$${usd} (floor $${floor}${applied.length ? `; ${applied.join(", ")}` : ""})`,
	};
}

/** Convenience: the quote for a role's criteria. */
export function priceForRole(
	criteria: Criteria,
	taskType: GigType,
	variant?: GigVariant,
	extra: Pick<PriceInput, "urgency" | "fill"> = {},
): PriceQuote {
	return priceGig({
		taskType,
		variant,
		seniority: criteria.seniority,
		rarity: rarityFactor(criteria),
		region: regionOf(criteria),
		...extra,
	});
}

const TYPE_LABEL: Record<GigType, string> = {
	SOURCING: "sourcing",
	SCREENING_CALL: "screening",
	REFERENCE_CHECK: "reference-check",
};

export interface RepriceInput {
	gig: {
		taskType: GigType;
		variant?: GigVariant;
		bounty: number;
		maxDeliverables: number;
		acceptedCount: number;
	};
	hoursOpen: number;
	/** Recruiters who claimed it (exclusive gigs) or started on it. */
	claims: number;
	deliveries: number;
	/** The company's cap per deliverable for this role (agent_max_bounty), USDC. */
	maxBounty: number;
	/** Budget not yet promised to anything, USDC. */
	budgetAvailable: number;
	/** Hours since the last price change of this gig (omit if never repriced). */
	hoursSinceLastRaise?: number;
}

/** Deliveries a sourcing gig should have by now if it fills in sourcingTargetDays. */
export function expectedSourcingDeliveries(maxDeliverables: number, hoursOpen: number): number {
	return (maxDeliverables * hoursOpen) / (PRICING.sourcingTargetDays * 24);
}

/**
 * Raise an open gig that isn't moving (sourcing: under half the pace that fills it in a week; calls:
 * no delivery) after raiseAfterHours and at most once per minHoursBetweenRaises: +25% if nobody engaged, +15% if it
 * was claimed or partly delivered but isn't filling. Capped by the role's max bounty and by the
 * budget for the remaining slots. Never lowers an open gig.
 */
export function repriceRule(input: RepriceInput): {
	action: "raise" | "keep";
	bounty: number;
	reason: string;
} {
	const { gig } = input;
	const keep = (reason: string) => ({ action: "keep" as const, bounty: gig.bounty, reason });
	const label = gig.variant === "language" ? "language-check" : TYPE_LABEL[gig.taskType];
	const after = PRICING.raiseAfterHours[gig.taskType];
	if (input.hoursOpen < after)
		return keep(`Open ${input.hoursOpen} h; reviewing the price after ${after} h.`);
	const slotsLeft = gig.maxDeliverables - gig.acceptedCount;
	if (slotsLeft <= 0) return keep("Filled.");
	const gap = PRICING.minHoursBetweenRaises[gig.taskType];
	if (input.hoursSinceLastRaise !== undefined && input.hoursSinceLastRaise < gap)
		return keep(`Raised ${Math.round(input.hoursSinceLastRaise)} h ago; giving it ${gap} h.`);
	// Sourcing: compare with the pace that fills the gig in a week, not with a fixed share, so a
	// 30-slot gig getting 3 profiles a day isn't "stuck". Calls: any delivery means it's moving.
	const filling =
		gig.taskType === "SOURCING"
			? input.deliveries >=
				PRICING.sourcingBehindShare * expectedSourcingDeliveries(gig.maxDeliverables, input.hoursOpen)
			: input.deliveries > 0;
	if (filling) return keep(`The ${label} gig is filling at $${gig.bounty}.`);
	const cold = input.claims === 0 && input.deliveries === 0;
	const step = cold ? PRICING.raiseStepCold : PRICING.raiseStepWarm;
	const byBudget = Math.floor(gig.bounty + input.budgetAvailable / slotsLeft);
	const target = Math.min(Math.ceil(gig.bounty * (1 + step)), input.maxBounty, byBudget);
	if (target <= gig.bounty) {
		return keep(
			`The ${label} gig hasn't moved in ${Math.round(input.hoursOpen)} h, but $${gig.bounty} is already at the ${
				input.maxBounty <= gig.bounty ? "role's maximum" : "budget limit"
			}.`,
		);
	}
	const why = cold
		? `nobody took it in ${Math.round(input.hoursOpen)} h`
		: `it was claimed but not ${gig.taskType === "SOURCING" ? "filling" : "delivered"} in ${Math.round(input.hoursOpen)} h`;
	return { action: "raise", bounty: target, reason: `Raised the ${label} price to $${target} — ${why}.` };
}

// ---- Requirements -------------------------------------------------------------

export interface TrustRequirement {
	/** Accepted deliverables needed in the window (of `ofType` when set). */
	minAccepted: number;
	minAcceptanceRate: number;
	windowDays: number;
	ofType?: GigType;
}

export interface GigRequirements {
	/** null: open to anyone (sourcing; unvouched recruiters post a bond instead). */
	minTrust: TrustRequirement | null;
	/** Unvouched recruiters must post a refundable bond (sourcing). */
	bondForUnvouched: boolean;
	/** The claimer needs at least one of these skills. Empty: no skill requirement. */
	requiredSkills: string[];
	/** Ranked first on the gig board when present. */
	preferredSkills: string[];
	/** Plain-language summary for the gig card. */
	summary: string;
}

const SKILL_KEYWORDS: [string, RegExp][] = [
	["engineer:rust", /\brust\b/i],
	["engineer:solana", /\b(solana|anchor)\b/i],
	["engineer:typescript", /\b(typescript|node(\.js)?|nestjs)\b/i],
	["engineer:python", /\b(python|django|fastapi)\b/i],
	["engineer:go", /\b(golang|go)\b/],
	["engineer:java", /\b(java|kotlin|jvm)\b/i],
	["engineer:frontend", /\b(react|frontend|front-end|vue|angular)\b/i],
	["engineer:data", /\b(data engineer|spark|airflow|dbt|ml|machine learning)\b/i],
	["engineer:devops", /\b(kubernetes|devops|sre|terraform)\b/i],
	["design:product", /\b(product design|figma|ux)\b/i],
];

/** Skill tags implied by the criteria, most important must-have first. */
export function roleSkills(criteria: Criteria): string[] {
	const text = [...criteria.mustHave, ...criteria.niceToHave].map((c) => c.label);
	const found: string[] = [];
	for (const label of text)
		for (const [tag, re] of SKILL_KEYWORDS) if (re.test(label) && !found.includes(tag)) found.push(tag);
	return found;
}

const roleFamily = (skills: string[]) =>
	skills[0]?.startsWith("design:")
		? "family:design"
		: skills.length
			? "family:engineering"
			: "family:general";

/**
 * Who may claim a gig. Sourcing is open (bond for unvouched recruiters) and prefers the role
 * family; screening needs the elite rule (≥10 accepted, ≥50% over 90 days) and a
 * matching tech skill or "tech-screener"; a language check needs a C2/native speaker; a reference
 * check needs 3 accepted screenings.
 */
export function gigRequirements(input: {
	taskType: GigType;
	variant?: GigVariant;
	criteria: Criteria;
	seniority?: Seniority;
}): GigRequirements {
	const skills = roleSkills(input.criteria);
	const family = roleFamily(skills);
	const niche = rarityFactor(input.criteria) >= PRICING.rareProfile;
	if (input.taskType === "SOURCING") {
		return {
			minTrust: null,
			bondForUnvouched: true,
			requiredSkills: [],
			preferredSkills: niche ? [family, ...skills.slice(0, 2)] : [family],
			summary: "Open to all recruiters; new recruiters post a small refundable bond.",
		};
	}
	if (input.taskType === "SCREENING_CALL" && input.variant === "language") {
		const lang = requiredLanguage(input.criteria) ?? { name: "English", level: "C1" as const };
		const code = lang.name.slice(0, 2).toLowerCase();
		return {
			minTrust: { minAccepted: 3, minAcceptanceRate: 0.5, windowDays: 90 },
			bondForUnvouched: false,
			requiredSkills: [`lang:${code}:C2`, `lang:${code}:native`],
			preferredSkills: [],
			summary: `Native or C2 ${lang.name} speakers with 3+ accepted gigs.`,
		};
	}
	if (input.taskType === "SCREENING_CALL") {
		const tech = skills.filter((s) => s.startsWith("engineer:"));
		return {
			minTrust: { minAccepted: 10, minAcceptanceRate: 0.5, windowDays: 90 },
			bondForUnvouched: false,
			requiredSkills: tech.length ? [tech[0] ?? "", "tech-screener"] : [],
			preferredSkills: tech.slice(1),
			summary: tech.length
				? `Recruiters with 10+ accepted gigs (≥50% in 90 days) who are ${tech[0]?.split(":")[1]} engineers or tech screeners.`
				: "Recruiters with 10+ accepted gigs (≥50% in 90 days).",
		};
	}
	return {
		minTrust: { minAccepted: 3, minAcceptanceRate: 0.5, windowDays: 90, ofType: "SCREENING_CALL" },
		bondForUnvouched: false,
		requiredSkills: [],
		preferredSkills: [family],
		summary: "Recruiters with 3+ accepted screening calls.",
	};
}

export interface RecruiterProfile {
	wallet: string;
	skills: string[];
	/** Accepted / decided deliverables in the last 90 days, by gig type (re-match rejections excluded). */
	stats: Partial<Record<GigType | "ALL", { accepted: number; decided: number }>>;
	vouched?: boolean;
}

/** Applies gigRequirements to a recruiter. The sourcer of a candidate can't run calls about them. */
export function canClaimGig(
	req: GigRequirements,
	recruiter: RecruiterProfile,
	context: { sourcerWallet?: string; taskType: GigType } = { taskType: "SOURCING" },
): { allowed: boolean; reason: string; needsBond: boolean } {
	const needsBond = req.bondForUnvouched && !recruiter.vouched;
	if (context.taskType !== "SOURCING" && context.sourcerWallet && context.sourcerWallet === recruiter.wallet)
		return {
			allowed: false,
			needsBond,
			reason: "The recruiter who sourced a candidate can't also run calls about them.",
		};
	if (req.minTrust) {
		const s = recruiter.stats[req.minTrust.ofType ?? "ALL"] ?? { accepted: 0, decided: 0 };
		if (s.accepted < req.minTrust.minAccepted)
			return {
				allowed: false,
				needsBond,
				reason: `Needs ${req.minTrust.minAccepted} accepted ${req.minTrust.ofType ? "screening calls" : "gigs"} in ${req.minTrust.windowDays} days (has ${s.accepted}).`,
			};
		const rate = s.decided ? s.accepted / s.decided : 0;
		if (rate < req.minTrust.minAcceptanceRate)
			return {
				allowed: false,
				needsBond,
				reason: `Acceptance rate ${Math.round(rate * 100)}% is below ${req.minTrust.minAcceptanceRate * 100}%.`,
			};
	}
	if (req.requiredSkills.length && !req.requiredSkills.some((s) => recruiter.skills.includes(s)))
		return { allowed: false, needsBond, reason: `Needs one of: ${req.requiredSkills.join(", ")}.` };
	return { allowed: true, needsBond, reason: needsBond ? "Eligible with a refundable bond." : "Eligible." };
}
