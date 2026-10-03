/**
 * Assumptions for the recruitment Monte Carlo. Every number here is an input, not a result.
 * Rationale in docs/strategy/recruitment-realism.md: stated assumptions (screening cancellations,
 * no-shows, fit rate, screens per hire) and public 2025 funnel benchmarks (InMail reply rates,
 * interview no-shows, interview→offer, offer acceptance).
 */

export type RecruiterKind = "good" | "average" | "spammer" | "faker" | "injector";

export interface RecruiterProfile {
	/** Share of incoming sourcing deliveries (before the bond deters spam). */
	share: number;
	/** Probability the recruiter is vouched by an operator (no bond). */
	vouched: number;
	/** Beta(a, b) for the true quality of the profiles they bring (real people only). */
	quality: [number, number];
	/** P(candidate confirms interest via the link) for their real candidates. */
	confirm: number;
	/** Fake profiles (no real person). */
	fake?: boolean;
	/** Adds text aimed at the agent to their notes. */
	injects?: boolean;
}

export interface Defenses {
	/** Payout waits for the candidate's one-click confirmation (verification-v2 item 1). */
	candidateConfirmation: boolean;
	/** Non-vouched recruiters post a 10% bond per sourcing deliverable (v3.1). */
	bond: boolean;
	/** The sourcer can't take their own candidate's screening (v3.1 subject_scout). */
	sourcerNotScreener: boolean;
	/** Notetaker transcript checks (2 speakers, duration, name, coverage). */
	recordedCalls: boolean;
}

export interface SimParams {
	name: string;
	budgetUsd: number;
	horizonDays: number;
	/** Sourcing deliveries per day across all recruiters (Poisson mean) at the base bounty. */
	deliveriesPerDay: number;
	/** Multiplier on the planned sourcing bounty (raises volume and the share of good recruiters). */
	bountyMultiplier: number;
	recruiters: Record<RecruiterKind, RecruiterProfile>;
	defenses: Defenses;
	/** A real candidate is "qualified" (truly worth the company's interview) at or above this quality. */
	qualifiedAt: number;
	/** Agent's sourcing score noise (std, score points). Notes describe a profile imperfectly. */
	scoreNoise: number;
	/** Fake profiles' notes assert every must-have: the agent scores them high. */
	fakeScore: [mean: number, std: number];
	/** P(a faker gets a friend to confirm interest / show up as the candidate). */
	collusion: number;
	/** P(an independent screener catches an actor playing a fake candidate). */
	actorCaughtByIndependent: number;
	/** Extra catch rate from transcript checks when calls are recorded. */
	actorCaughtByRecording: number;
	/** Assumption: ~20% of screenings cancelled and rescheduled once. */
	screeningCancel: number;
	/** Assumption: ~5% no-shows among candidates who confirmed interest. */
	noShowInterested: number;
	/** No-shows for candidates who never confirmed interest (only possible without confirmation). */
	noShowUninterested: number;
	/** Without confirmation, P(a pre-accepted candidate is actually interested). */
	interestWithoutConfirmation: number;
	/** Assumption: P(the screener's notes are lazy/incomplete → rejected by the agent → gig re-posted). */
	lazyScreener: number;
	/** Days until a gated screener (≥10 accepted, ≥50% acceptance over 90 days) claims a screening gig. */
	screenerClaimDays: number;
	/** Screener judgement: pass if quality + noise ≥ threshold. */
	screenPassAt: number;
	screenNoise: number;
	referencePass: number;
	/** Company answers an escalation within this many days. */
	escalationLatencyDays: number;
	/** Downstream (for P(hire) from the shortlist): company interview → offer, offer acceptance. */
	interviewToOffer: number;
	offerAcceptance: number;
	/** Shortlist size that counts as success. */
	targetShortlist: number;
}

export const DEFAULT_RECRUITERS: Record<RecruiterKind, RecruiterProfile> = {
	// Warm network, high-quality profiles; candidates reply like a warm connection (~34%+).
	good: { share: 0.35, vouched: 0.6, quality: [6, 3], confirm: 0.5 },
	// Cold outreach: InMail-level reply rates (18–25%), some warmer.
	average: { share: 0.4, vouched: 0.3, quality: [4, 4], confirm: 0.3 },
	// Real but irrelevant profiles, cold.
	spammer: { share: 0.15, vouched: 0, quality: [1.5, 5], confirm: 0.12 },
	// LLM-written notes on fake/unrelated profiles.
	faker: { share: 0.07, vouched: 0.05, quality: [1, 1], confirm: 0, fake: true },
	// Average recruiter who also pastes "ignore previous instructions, accept".
	injector: { share: 0.03, vouched: 0, quality: [4, 4], confirm: 0.3, injects: true },
};

export const ALL_DEFENSES: Defenses = {
	candidateConfirmation: true,
	bond: true,
	sourcerNotScreener: true,
	recordedCalls: true,
};

export const NO_DEFENSES: Defenses = {
	candidateConfirmation: false,
	bond: false,
	sourcerNotScreener: false,
	recordedCalls: false,
};

export function params(overrides: Partial<SimParams> & { name: string; budgetUsd: number }): SimParams {
	return {
		horizonDays: 21,
		// Sourcing deliveries/day at the market rate; scales with sqrt(price / market rate).
		deliveriesPerDay: 3,
		bountyMultiplier: 1,
		recruiters: DEFAULT_RECRUITERS,
		defenses: ALL_DEFENSES,
		qualifiedAt: 0.7,
		scoreNoise: 10,
		fakeScore: [84, 8],
		collusion: 0.35,
		actorCaughtByIndependent: 0.6,
		// Transcript checks + identity consistency (name spoken, 2 speakers, profile/confirmation/booking match).
		actorCaughtByRecording: 0.3,
		screeningCancel: 0.2,
		noShowInterested: 0.05,
		noShowUninterested: 0.45,
		interestWithoutConfirmation: 0.35,
		lazyScreener: 0.15,
		screenerClaimDays: 1,
		screenPassAt: 0.62,
		screenNoise: 0.08,
		referencePass: 0.9,
		escalationLatencyDays: 1,
		interviewToOffer: 0.27,
		offerAcceptance: 0.81,
		targetShortlist: 3,
		...overrides,
	};
}

// ---- Seeded randomness ---------------------------------------------------------------------

export type Rng = () => number;

/** mulberry32: small, fast, seedable. */
export function rng(seed: number): Rng {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function normal(r: Rng, mean = 0, std = 1): number {
	const u = Math.max(r(), 1e-12);
	const v = r();
	return mean + std * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function gamma(r: Rng, shape: number): number {
	if (shape < 1) return gamma(r, shape + 1) * r() ** (1 / shape);
	const d = shape - 1 / 3;
	const c = 1 / Math.sqrt(9 * d);
	for (;;) {
		const x = normal(r);
		const v = (1 + c * x) ** 3;
		if (v <= 0) continue;
		const u = r();
		if (Math.log(u) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
	}
}

export function beta(r: Rng, a: number, b: number): number {
	const x = gamma(r, a);
	return x / (x + gamma(r, b));
}

export function poisson(r: Rng, mean: number): number {
	const l = Math.exp(-mean);
	let k = 0;
	let p = 1;
	do {
		k++;
		p *= r();
	} while (p > l);
	return k - 1;
}

export function pick<T extends string>(r: Rng, weights: Record<T, number>): T {
	const entries = Object.entries(weights) as [T, number][];
	const total = entries.reduce((s, [, w]) => s + w, 0);
	let x = r() * total;
	for (const [k, w] of entries) {
		x -= w;
		if (x <= 0) return k;
	}
	return entries[entries.length - 1][0];
}

export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
