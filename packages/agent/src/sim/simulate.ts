/**
 * Monte Carlo of one role, day by day: sourcing deliveries from a mixed recruiter population,
 * follow-up questions, candidate confirmation, screening calls with cancellations / no-shows /
 * lazy notes, fake candidates played by actors, a reference + language check for the finalist,
 * repricing of cold gigs and the replanning ladder when the pipeline runs dry. Every money and
 * gating decision goes through the agent's real deterministic code (splitBudget, agentDecision,
 * pickForScreening, decideCall, noShowPolicy, repriceRule, replanStep, recommend) — only the
 * world around it is random. A model with stated assumptions, not proof.
 */
import type { AgentReview, Criteria } from "@scout/shared";
import {
	agentDecision,
	decideCall,
	noShowPolicy,
	type PipelineState,
	POLICY,
	pickForScreening,
	replanStep,
	repriceRule,
	splitBudget,
} from "../gigs/index.ts";
import type { CallReview, QuestionCheck } from "../gigs/types.ts";
import { recommend } from "../scoring.ts";
import {
	beta,
	clamp,
	normal,
	pick,
	poisson,
	type RecruiterKind,
	type Rng,
	rng,
	type SimParams,
} from "./model.ts";

export const SIM_CRITERIA: Criteria = {
	mustHave: [
		{ id: "rust-3-years", label: "3+ years of production Rust", weight: 5 },
		{ id: "solana-mainnet-programs", label: "Shipped Solana programs to mainnet", weight: 5 },
		{ id: "spl-token-pdas", label: "SPL Token / Token-2022 and PDAs", weight: 4 },
	],
	niceToHave: [{ id: "security-audits", label: "Security audit experience", weight: 2 }],
	seniority: "SENIOR",
	location: { mode: "HYBRID", places: ["Warsaw"] },
	salaryRange: { min: 30000, max: 38000, currency: "PLN", period: "MONTH" },
	languages: ["English (C1)"],
	dealBreakers: [{ id: "needs-visa-sponsorship", label: "Needs visa sponsorship", weight: 5 }],
};

type Stage =
	| "follow-up"
	| "awaiting-confirmation"
	| "awaiting-company"
	| "sourced"
	| "screening"
	| "passed"
	| "failed"
	| "dropped";

interface Candidate {
	id: string;
	sourcer: RecruiterKind;
	vouched: boolean;
	fake: boolean;
	injected: boolean;
	quality: number;
	interested: boolean;
	review: AgentReview;
	stage: Stage;
	noShows: number;
}

interface Call {
	candidate: Candidate;
	day: number;
	reschedules: number;
	selfScreened: boolean;
}

export interface RunResult {
	success: boolean;
	failure: "none" | "budget" | "time";
	daysToShortlist: number | null;
	spent: number;
	shortlist: number;
	qualifiedOnShortlist: number;
	fakesOnShortlist: number;
	paidToFakes: number;
	noShowCost: number;
	noShows: number;
	cancellations: number;
	/** Escalations that interrupt the company (delivery "now"). */
	escalationsNow: number;
	/** Escalations batched into the daily digest. */
	escalationsDigest: number;
	followUps: number;
	bondsForfeited: number;
	screeningsPaid: number;
	priceRaises: number;
	replanSteps: string[];
	finalSourcingBounty: number;
	pHire: number;
}

const CHECKS = 8;
const checks = (diligent: boolean, r: Rng): QuestionCheck[] =>
	Array.from({ length: CHECKS }, (_, i) => {
		const missing = !diligent && i < 6;
		return {
			questionId: `q${i}`,
			missing,
			generic: false,
			contradiction: false,
			fit: 0.6,
			quality: missing ? 0 : clamp(0.78 + normal(r, 0, 0.06), 0.6, 1),
		};
	});

/** The screener's work goes through the agent's real call-review decision and policy gate. */
function screenerPaid(diligent: boolean, r: Rng): boolean {
	const decided = decideCall({ recommendation: "ADVANCE" }, checks(diligent, r), diligent ? 0.9 : 0.2);
	const review = { ...decided, summaryForCompany: "", engine: "offline", flags: [] } as unknown as CallReview;
	return agentDecision({ kind: "screening", review }).action === "accept";
}

export function simulateRole(p: SimParams, seed: number): RunResult {
	const r = rng(seed);
	const d = p.defenses;
	const plan = splitBudget(p.budgetUsd, SIM_CRITERIA.seniority, SIM_CRITERIA);
	const marketBounty = plan.sourcingBounty;
	let sourcingBounty = Math.round(marketBounty * p.bountyMultiplier);
	const maxBounty = 2 * marketBounty; // agent_max_bounty default: 2× the floor
	const bondFor = (bounty: number) => (d.bond ? 0.1 * bounty : 0);

	let budget = p.budgetUsd; // grows with forfeited bonds and approved top-ups
	let spent = 0;
	const reservedFinal = plan.referenceBounty + plan.languageBounty; // kept for the finalist
	let finalChecksBooked = false;
	const canSpend = (usd: number) => spent + usd + (finalChecksBooked ? 0 : reservedFinal) <= budget;

	let sourcingSlots = plan.sourcing;
	let screeningSlots = plan.screenings;
	let sourcingFilled = 0; // pre-accepted or paid (holds a slot)
	let sourcingDeliveries = 0; // since the sourcing gig (or its price) last changed
	let sourcingOpenedDay = 0;
	let scoreBoost = 0; // after the company loosens a criterion
	let lastRaiseDay: number | null = null;
	const replanDone: PipelineState["done"] = [];

	// Recruiter mix: the bond deters spammers/fakers; a better price attracts better recruiters.
	const mixWeights = (bounty: number) =>
		Object.fromEntries(
			(Object.keys(p.recruiters) as RecruiterKind[]).map((k) => {
				let w = p.recruiters[k].share;
				if (d.bond && (k === "spammer" || k === "faker")) w *= 0.35;
				if (k === "good") w *= (bounty / marketBounty) ** 0.4;
				return [k, w];
			}),
		) as Record<RecruiterKind, number>;
	// Supply elasticity: deliveries/day scale with the price relative to the market rate.
	const perDay = (bounty: number) => p.deliveriesPerDay * Math.sqrt(bounty / marketBounty);

	const out: RunResult = {
		success: false,
		failure: "time",
		daysToShortlist: null,
		spent: 0,
		shortlist: 0,
		qualifiedOnShortlist: 0,
		fakesOnShortlist: 0,
		paidToFakes: 0,
		noShowCost: 0,
		noShows: 0,
		cancellations: 0,
		escalationsNow: 0,
		escalationsDigest: 0,
		followUps: 0,
		bondsForfeited: 0,
		screeningsPaid: 0,
		priceRaises: 0,
		replanSteps: [],
		finalSourcingBounty: sourcingBounty,
		pHire: 0,
	};

	const candidates: Candidate[] = [];
	const confirmations: { c: Candidate; day: number; yes: boolean }[] = [];
	const companyAnswers: { c: Candidate; day: number }[] = [];
	const followUpAnswers: { c: Candidate; day: number }[] = [];
	const calls: Call[] = [];
	let stalled = false;

	const forfeit = (c: Candidate) => {
		if (d.bond && !c.vouched) {
			budget += bondFor(sourcingBounty);
			out.bondsForfeited += bondFor(sourcingBounty);
		}
	};
	const releaseSlot = (c: Candidate) => {
		c.stage = "dropped";
		sourcingFilled--;
		forfeit(c);
	};
	/** Pays an accepted profile if the budget still allows it; otherwise the agent stops and asks for a top-up. */
	const paySourcing = (c: Candidate) => {
		if (!canSpend(sourcingBounty)) {
			c.stage = "dropped";
			stalled = true;
			return;
		}
		spent += sourcingBounty;
		if (c.fake) out.paidToFakes += sourcingBounty;
		c.stage = "sourced";
	};
	const preAccept = (c: Candidate, day: number) => {
		if (d.candidateConfirmation) {
			c.stage = "awaiting-confirmation";
			const yes = c.fake ? r() < p.collusion : c.interested;
			confirmations.push({ c, day: day + 1 + Math.floor(r() * 3), yes });
		} else paySourcing(c);
	};
	const escalate = (c: Candidate, day: number, delivery: "now" | "digest" | undefined) => {
		if (delivery === "now") out.escalationsNow++;
		else out.escalationsDigest++;
		c.stage = "awaiting-company";
		companyAnswers.push({ c, day: day + p.escalationLatencyDays });
	};
	/** Applies the agent's real sourcing decision. */
	const decideSourcing = (c: Candidate, day: number, followUps: number) => {
		const decision = agentDecision({
			kind: "sourcing",
			review: c.review,
			flags: c.injected ? ["override"] : [],
			followUps,
			criteria: SIM_CRITERIA,
		});
		if (decision.action === "accept") preAccept(c, day);
		else if (decision.action === "follow_up") {
			out.followUps++;
			c.stage = "follow-up";
			followUpAnswers.push({ c, day: day + 1 });
		} else if (decision.action === "escalate") escalate(c, day, decision.delivery);
		else releaseSlot(c);
	};
	/** Per-must-have verdicts so replanStep can spot a blocking criterion (real profiles miss the
	 * Solana-mainnet must-have more often than the others; fake notes claim everything). */
	const verdicts = (c: Candidate): AgentReview["verdicts"] =>
		SIM_CRITERIA.mustHave.map((m, i) => {
			const pMet = c.fake ? 1 : clamp(c.quality + scoreBoost / 100 - (i === 1 ? 0.25 : 0), 0, 1);
			return { criterionId: m.id, verdict: r() < pMet ? "MET" : "NOT_MET", reasoning: "" };
		});
	const score = (c: Candidate, noise: number) =>
		Math.round(
			clamp(
				c.fake
					? normal(r, p.fakeScore[0], p.fakeScore[1])
					: 100 * c.quality + normal(r, 0, noise) + scoreBoost,
				0,
				100,
			),
		);

	for (let day = 0; day < p.horizonDays && !out.success && !stalled; day++) {
		// 1. Sourcing deliveries while the gig has open slots.
		const weights = mixWeights(sourcingBounty);
		const n = poisson(r, perDay(sourcingBounty));
		for (let i = 0; i < n && sourcingFilled < sourcingSlots; i++) {
			const kind = pick(r, weights);
			const prof = p.recruiters[kind];
			const fake = Boolean(prof.fake);
			const c: Candidate = {
				id: `c${candidates.length + 1}`,
				sourcer: kind,
				vouched: r() < prof.vouched,
				fake,
				injected: Boolean(prof.injects),
				quality: fake ? 0 : beta(r, prof.quality[0], prof.quality[1]),
				interested: false,
				review: { score: 0, recommendation: "PASS", verdicts: [], summary: "" },
				stage: "dropped",
				noShows: 0,
			};
			c.interested = !fake && r() < (d.candidateConfirmation ? prof.confirm : p.interestWithoutConfirmation);
			const s = score(c, p.scoreNoise);
			c.review = { score: s, recommendation: recommend(s), verdicts: verdicts(c), summary: "" };
			candidates.push(c);
			sourcingDeliveries++;
			sourcingFilled++;
			decideSourcing(c, day, 0);
		}

		// 2. Follow-up answers: the recruiter adds one data point, the profile is re-scored (less noise).
		for (const f of followUpAnswers.filter((x) => x.day === day)) {
			const s = score(f.c, p.scoreNoise / 2);
			f.c.review = { score: s, recommendation: recommend(s), verdicts: verdicts(f.c), summary: "" };
			decideSourcing(f.c, day, POLICY.maxFollowUps);
		}

		// 3. Company answers escalations (it looks at the profile itself).
		for (const a of companyAnswers.filter((x) => x.day === day)) {
			const ok = a.c.fake ? r() < 0.4 : a.c.quality >= 0.55;
			if (ok) preAccept(a.c, day);
			else releaseSlot(a.c);
		}

		// 4. Candidate confirmations (payout happens only here when confirmation is on).
		for (const cf of confirmations.filter((x) => x.day === day)) {
			if (cf.yes) paySourcing(cf.c);
			else releaseSlot(cf.c);
		}

		// 5. Book screenings with the agent's real picker (≥ 75, max 3 concurrent).
		const ready = candidates.filter((c) => c.stage === "sourced");
		for (const pickC of pickForScreening(ready, calls.length)) {
			const c = candidates.find((x) => x.id === pickC.id) as Candidate;
			if (screeningSlots <= 0) {
				if (!canSpend(plan.screeningBounty)) break;
				screeningSlots++; // one more screening from the reserve
			}
			screeningSlots--;
			c.stage = "screening";
			const selfScreened = !d.sourcerNotScreener && c.sourcer === "faker" && r() < 0.5;
			calls.push({
				candidate: c,
				day: day + p.screenerClaimDays + 1 + Math.floor(r() * 3),
				reschedules: 0,
				selfScreened,
			});
		}

		// 6. Calls happening today.
		for (const call of calls.filter((x) => x.day === day)) {
			calls.splice(calls.indexOf(call), 1);
			const c = call.candidate;
			if (r() < p.screeningCancel && call.reschedules === 0) {
				out.cancellations++;
				calls.push({ ...call, day: day + 2, reschedules: 1 });
				continue;
			}
			const actorShows = c.fake && (call.selfScreened || r() < p.collusion);
			const shows = c.fake ? actorShows : r() >= (c.interested ? p.noShowInterested : p.noShowUninterested);
			if (!shows) {
				out.noShows++;
				const policy = noShowPolicy(c.noShows);
				c.noShows++;
				if (canSpend(policy.showUpFeeUsd)) {
					spent += policy.showUpFeeUsd;
					out.noShowCost += policy.showUpFeeUsd;
				}
				if (policy.action === "rebook" && !c.fake) calls.push({ ...call, day: day + 3, reschedules: 0 });
				else c.stage = "dropped";
				continue;
			}
			// The screener's notes go through the agent's call review; lazy notes are re-posted.
			if (!screenerPaid(r() >= p.lazyScreener, r)) {
				calls.push({ ...call, day: day + 1 });
				continue;
			}
			if (!canSpend(plan.screeningBounty)) {
				stalled = true;
				break;
			}
			spent += plan.screeningBounty;
			out.screeningsPaid++;
			let passed: boolean;
			if (c.fake) {
				const caught = call.selfScreened
					? false
					: r() < p.actorCaughtByIndependent + (d.recordedCalls ? p.actorCaughtByRecording : 0);
				passed = !caught;
			} else {
				passed = c.quality + normal(r, 0, p.screenNoise) >= p.screenPassAt;
			}
			c.stage = passed ? "passed" : "failed";
		}

		// 7. Reference + language check for the first finalist (paid once, reserved up front).
		const shortlist = candidates.filter((c) => c.stage === "passed");
		if (shortlist.length && !finalChecksBooked) {
			finalChecksBooked = true;
			spent += reservedFinal;
		}
		if (shortlist.length >= p.targetShortlist) {
			out.success = true;
			out.failure = "none";
			out.daysToShortlist = day + 1 + 2; // + reference/language turnaround
			break;
		}

		// 8. Repricing: a cold sourcing gig gets more expensive (agent's real repriceRule).
		const hoursOpen = (day + 1 - sourcingOpenedDay) * 24;
		const available = Math.max(0, budget - spent - reservedFinal);
		const reprice = repriceRule({
			gig: {
				taskType: "SOURCING",
				bounty: sourcingBounty,
				maxDeliverables: sourcingSlots,
				acceptedCount: sourcingFilled,
			},
			hoursOpen,
			claims: sourcingDeliveries,
			deliveries: sourcingDeliveries,
			maxBounty,
			budgetAvailable: available,
			hoursSinceLastRaise: lastRaiseDay === null ? undefined : (day + 1 - lastRaiseDay) * 24,
		});
		if (reprice.action === "raise" && sourcingFilled < sourcingSlots) {
			sourcingBounty = reprice.bounty;
			out.priceRaises++;
			lastRaiseDay = day + 1;
		}

		// 9. Replanning ladder when the pipeline runs dry (agent's real replanStep).
		const inFlight =
			candidates.filter((c) =>
				["follow-up", "awaiting-confirmation", "awaiting-company", "sourced", "screening"].includes(c.stage),
			).length + calls.length;
		const step = replanStep({
			criteria: SIM_CRITERIA,
			budgetAvailable: available,
			maxBounty,
			sourcing: {
				bounty: sourcingBounty,
				maxDeliverables: sourcingSlots,
				acceptedCount: sourcingFilled,
				deliveries: sourcingDeliveries,
				claims: sourcingDeliveries,
				hoursOpen,
				exhausted: sourcingFilled >= sourcingSlots,
			},
			screeningBounty: plan.screeningBounty,
			inFlight,
			targetInFlight: plan.screenings,
			// Every sourcing review so far, accepted and rejected.
			reviews: candidates.map((c) => c.review),
			done: replanDone,
		});
		if (step.step !== "none") {
			replanDone.push(step.step);
			out.replanSteps.push(step.step);
			if (step.step === "more_sourcing") {
				sourcingSlots += Number(step.value);
				sourcingOpenedDay = day + 1;
				sourcingDeliveries = 0;
			} else if (step.step === "raise_price") {
				sourcingBounty = Number(step.value);
				out.priceRaises++;
				lastRaiseDay = day + 1;
			} else if (step.step === "loosen_criterion") {
				if (r() < 0.5) scoreBoost += 8; // the company agrees half the time; scores and verdicts rise
			} else if (step.step === "request_top_up") {
				if (r() < 0.6) {
					budget += Number(step.value);
					sourcingSlots += 10;
					sourcingOpenedDay = day + 1;
					sourcingDeliveries = 0;
				} else stalled = true;
			}
		}
	}

	const shortlist = candidates.filter((c) => c.stage === "passed");
	out.spent = Math.round(spent * 100) / 100;
	out.shortlist = shortlist.length;
	out.qualifiedOnShortlist = shortlist.filter((c) => !c.fake && c.quality >= p.qualifiedAt).length;
	out.fakesOnShortlist = shortlist.filter((c) => c.fake).length;
	out.finalSourcingBounty = sourcingBounty;
	if (!out.success) out.failure = stalled ? "budget" : "time";
	// Downstream: each truly qualified shortlisted candidate converts at interview→offer × acceptance;
	// unqualified real ones at a third of that; fakes never.
	const unqualified = shortlist.filter((c) => !c.fake && c.quality < p.qualifiedAt).length;
	const conv = p.interviewToOffer * p.offerAcceptance;
	out.pHire = 1 - (1 - conv) ** out.qualifiedOnShortlist * (1 - conv / 3) ** unqualified;
	return out;
}

export interface Summary {
	name: string;
	runs: number;
	pSuccess: number;
	pQualifiedShortlist: number;
	failures: Record<RunResult["failure"], number>;
	days: { p10: number; p50: number; p90: number } | null;
	spent: { p50: number; p90: number };
	spendPerQualified: number | null;
	fakeLeakRate: number;
	paidToFakesAvg: number;
	noShowCostAvg: number;
	escalationsNowAvg: number;
	escalationsDigestAvg: number;
	followUpsAvg: number;
	bondsForfeitedAvg: number;
	priceRaisesAvg: number;
	replanShare: Record<string, number>;
	pHireAvg: number;
}

const q = (xs: number[], p: number) => {
	if (!xs.length) return Number.NaN;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);

export function runMany(p: SimParams, runs = 1000, seed = 42): Summary {
	const results = Array.from({ length: runs }, (_, i) => simulateRole(p, seed + i * 7919));
	const ok = results.filter((x) => x.success);
	const qualifiedTotal = results.reduce((s, x) => s + x.qualifiedOnShortlist, 0);
	const shortlistTotal = results.reduce((s, x) => s + x.shortlist, 0);
	const days = ok.map((x) => x.daysToShortlist as number);
	const replanShare: Record<string, number> = {};
	for (const x of results)
		for (const s of new Set(x.replanSteps)) replanShare[s] = (replanShare[s] ?? 0) + 1 / runs;
	return {
		name: p.name,
		runs,
		pSuccess: ok.length / runs,
		pQualifiedShortlist: results.filter((x) => x.qualifiedOnShortlist >= p.targetShortlist).length / runs,
		failures: {
			none: ok.length,
			budget: results.filter((x) => x.failure === "budget").length,
			time: results.filter((x) => x.failure === "time").length,
		},
		days: days.length ? { p10: q(days, 0.1), p50: q(days, 0.5), p90: q(days, 0.9) } : null,
		spent: {
			p50: q(
				results.map((x) => x.spent),
				0.5,
			),
			p90: q(
				results.map((x) => x.spent),
				0.9,
			),
		},
		spendPerQualified: qualifiedTotal ? results.reduce((s, x) => s + x.spent, 0) / qualifiedTotal : null,
		fakeLeakRate: shortlistTotal ? results.reduce((s, x) => s + x.fakesOnShortlist, 0) / shortlistTotal : 0,
		paidToFakesAvg: avg(results.map((x) => x.paidToFakes)),
		noShowCostAvg: avg(results.map((x) => x.noShowCost)),
		escalationsNowAvg: avg(results.map((x) => x.escalationsNow)),
		escalationsDigestAvg: avg(results.map((x) => x.escalationsDigest)),
		followUpsAvg: avg(results.map((x) => x.followUps)),
		bondsForfeitedAvg: avg(results.map((x) => x.bondsForfeited)),
		priceRaisesAvg: avg(results.map((x) => x.priceRaises)),
		replanShare,
		pHireAvg: avg(results.map((x) => x.pHire)),
	};
}
