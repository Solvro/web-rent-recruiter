import { readFileSync } from "node:fs";
import { type AgentReview, Criteria } from "@scout/shared";
import { describe, expect, it } from "vitest";
import { buildEscalationDigest } from "./escalation.ts";
import { canClaimGig, gigRequirements, priceForRole, priceGig, regionOf, repriceRule } from "./market.ts";
import { type PipelineState, replanStep } from "./replan.ts";

const role = JSON.parse(
	readFileSync(new URL("../fixtures/demo-role-senior-backend-ts.json", import.meta.url), "utf-8"),
) as { criteria: unknown };
const rust = Criteria.parse(role.criteria);

describe("priceGig", () => {
	it("prices the Rust/Solana demo role at CEE market rates", () => {
		expect(regionOf(rust)).toBe("CEE");
		expect(priceForRole(rust, "SOURCING").usd).toBe(25); // $20 senior floor × 1.25 premium
		expect(priceForRole(rust, "SCREENING_CALL").usd).toBe(40);
		expect(priceForRole(rust, "SCREENING_CALL", "language").usd).toBe(15);
		expect(priceForRole(rust, "SCREENING_CALL", "tech").usd).toBe(100);
		expect(priceForRole(rust, "REFERENCE_CHECK").usd).toBe(25);
	});

	it("applies tier, rarity, market and urgency, and never goes under the floor", () => {
		expect(priceGig({ taskType: "SOURCING", seniority: "JUNIOR" }).usd).toBe(15); // $12 × 1.25 premium
		expect(priceGig({ taskType: "SOURCING", seniority: "SENIOR", rarity: 1.4 }).usd).toBe(38); // niche tier $30 × 1.25
		expect(priceGig({ taskType: "SCREENING_CALL", seniority: "SENIOR", region: "US" }).usd).toBe(80);
		expect(
			priceGig({ taskType: "SCREENING_CALL", seniority: "SENIOR", region: "WEST_EU", urgency: "urgent" }).usd,
		).toBe(85);
		// The last screening filled in 1 h at $50: the next starts 10% lower, but not under $40.
		expect(
			priceGig({ taskType: "SCREENING_CALL", seniority: "SENIOR", fill: { lastBounty: 50, hoursToFill: 1 } })
				.usd,
		).toBe(45);
		expect(
			priceGig({ taskType: "SCREENING_CALL", seniority: "SENIOR", fill: { lastBounty: 42, hoursToFill: 1 } })
				.usd,
		).toBe(40);
	});
});

describe("repriceRule", () => {
	const gig = { taskType: "SCREENING_CALL" as const, bounty: 40, maxDeliverables: 1, acceptedCount: 0 };
	const base = { gig, claims: 0, deliveries: 0, maxBounty: 80, budgetAvailable: 200 };

	it("raises an unclaimed screening by 25% after 6 h and says why", () => {
		expect(repriceRule({ ...base, hoursOpen: 3 }).action).toBe("keep");
		expect(repriceRule({ ...base, hoursOpen: 6 })).toEqual({
			action: "raise",
			bounty: 50,
			reason: "Raised the screening price to $50 — nobody took it in 6 h.",
		});
	});

	it("raises 15% when claimed but not delivered, capped by max bounty and budget, never lowers", () => {
		expect(repriceRule({ ...base, claims: 1, hoursOpen: 8 }).bounty).toBe(46);
		expect(repriceRule({ ...base, hoursOpen: 8, maxBounty: 44 }).bounty).toBe(44);
		expect(repriceRule({ ...base, hoursOpen: 8, maxBounty: 40 }).action).toBe("keep");
		expect(repriceRule({ ...base, hoursOpen: 8, budgetAvailable: 3 }).bounty).toBe(43);
		expect(repriceRule({ ...base, hoursOpen: 8, deliveries: 1 }).action).toBe("keep");
	});
});

describe("repriceRule for large sourcing gigs (sim finding)", () => {
	const big = { taskType: "SOURCING" as const, bounty: 20, maxDeliverables: 30, acceptedCount: 0 };
	const base = { gig: big, claims: 5, maxBounty: 40, budgetAvailable: 600 };

	it("keeps a 30-slot gig getting 3 profiles a day (on pace to fill in ~10 days)", () => {
		for (const day of [1, 2, 3, 5]) {
			expect(repriceRule({ ...base, hoursOpen: day * 24, deliveries: 3 * day }).action).toBe("keep");
		}
	});

	it("raises a sourcing gig that's well behind pace, at most once per 48 h", () => {
		expect(repriceRule({ ...base, hoursOpen: 48, deliveries: 1 })).toMatchObject({
			action: "raise",
			bounty: 23,
		});
		expect(repriceRule({ ...base, hoursOpen: 72, deliveries: 1, hoursSinceLastRaise: 24 }).action).toBe(
			"keep",
		);
		expect(repriceRule({ ...base, hoursOpen: 96, deliveries: 1, hoursSinceLastRaise: 48 }).action).toBe(
			"raise",
		);
	});

	it("at normal supply, 21 days of hourly checks raise at most once", () => {
		let bounty = 20;
		let lastRaise: number | undefined;
		let raises = 0;
		for (let h = 1; h <= 21 * 24; h++) {
			const r = repriceRule({
				...base,
				gig: { ...big, bounty },
				hoursOpen: h,
				deliveries: Math.floor((3 * h) / 24),
				...(lastRaise !== undefined ? { hoursSinceLastRaise: h - lastRaise } : {}),
			});
			if (r.action === "raise") {
				raises++;
				bounty = r.bounty;
				lastRaise = h;
			}
		}
		expect(raises).toBeLessThanOrEqual(1);
	});
});

describe("gigRequirements / canClaimGig", () => {
	it("sets trust and skills per gig for the Rust/Solana role", () => {
		expect(gigRequirements({ taskType: "SOURCING", criteria: rust })).toMatchObject({
			minTrust: null,
			bondForUnvouched: true,
		});
		const screen = gigRequirements({ taskType: "SCREENING_CALL", criteria: rust });
		expect(screen.minTrust).toMatchObject({ minAccepted: 10, minAcceptanceRate: 0.5, windowDays: 90 });
		expect(screen.requiredSkills).toEqual(["engineer:rust", "tech-screener"]);
		expect(
			gigRequirements({ taskType: "SCREENING_CALL", variant: "language", criteria: rust }).requiredSkills,
		).toEqual(["lang:en:C2", "lang:en:native"]);
		expect(gigRequirements({ taskType: "REFERENCE_CHECK", criteria: rust }).minTrust).toMatchObject({
			minAccepted: 3,
			ofType: "SCREENING_CALL",
		});
	});

	it("checks a recruiter against them", () => {
		const req = gigRequirements({ taskType: "SCREENING_CALL", criteria: rust });
		const ola = { wallet: "W", skills: ["tech-screener"], stats: { ALL: { accepted: 12, decided: 18 } } };
		expect(canClaimGig(req, ola, { taskType: "SCREENING_CALL" }).allowed).toBe(true);
		expect(canClaimGig(req, { ...ola, skills: [] }, { taskType: "SCREENING_CALL" }).reason).toMatch(
			/engineer:rust/,
		);
		expect(canClaimGig(req, ola, { taskType: "SCREENING_CALL", sourcerWallet: "W" }).allowed).toBe(false);
		const sourcingReq = gigRequirements({ taskType: "SOURCING", criteria: rust });
		expect(canClaimGig(sourcingReq, { wallet: "N", skills: [], stats: {} })).toMatchObject({
			allowed: true,
			needsBond: true,
		});
	});
});

describe("escalation digest", () => {
	it("batches decisions into one message", () => {
		const d = buildEscalationDigest(
			[
				{ candidateName: "Tomasz Brzeziński", question: "Scored 57 (MAYBE); borderline, your call." },
				{ question: "Should I make DeFi experience a nice-to-have?" },
			],
			{ roleTitle: "Senior Rust Engineer", date: "Oct 4" },
		);
		expect(d?.title).toBe("2 decisions for Senior Rust Engineer · Oct 4");
		expect(d?.body).toMatch(/1\. Tomasz Brzeziński: Scored 57/);
		expect(buildEscalationDigest([], { roleTitle: "x" })).toBeNull();
	});
});

describe("replanning ladder", () => {
	const missDefi: AgentReview = {
		score: 40,
		recommendation: "PASS",
		summary: "",
		verdicts: [{ criterionId: "defi-protocols", verdict: "NOT_MET", reasoning: "" }],
	};
	const exhausted = {
		bounty: 20,
		maxDeliverables: 6,
		acceptedCount: 6,
		deliveries: 6,
		claims: 3,
		hoursOpen: 50,
		exhausted: true,
	};
	const dry: PipelineState = {
		criteria: rust,
		budgetAvailable: 200,
		maxBounty: 40,
		sourcing: {
			bounty: 20,
			maxDeliverables: 6,
			acceptedCount: 6,
			deliveries: 6,
			claims: 3,
			hoursOpen: 50,
			exhausted: true,
		},
		screeningBounty: 40,
		inFlight: 0,
		reviews: [missDefi, missDefi, missDefi],
		done: [],
	};

	it("waits only while enough candidates are in flight (target 3), not for any single one", () => {
		expect(replanStep({ ...dry, inFlight: 3 }).step).toBe("none");
		expect(replanStep({ ...dry, inFlight: 1 }).step).toBe("more_sourcing");
	});

	it("climbs: more sourcing → raise price → loosen a criterion → top-up, within budget", () => {
		expect(replanStep(dry)).toMatchObject({ step: "more_sourcing", value: 10, needsCompany: false });
		const open = {
			...exhausted,
			exhausted: false,
			acceptedCount: 0,
			deliveries: 0,
			claims: 0,
		} as PipelineState["sourcing"];
		expect(replanStep({ ...dry, sourcing: open, done: ["more_sourcing"] })).toMatchObject({
			step: "raise_price",
			value: 25,
		});
		expect(replanStep({ ...dry, done: ["more_sourcing", "raise_price"] })).toMatchObject({
			step: "loosen_criterion",
			value: "defi-protocols",
			needsCompany: true,
		});
		expect(replanStep({ ...dry, done: ["more_sourcing", "raise_price", "loosen_criterion"] })).toMatchObject({
			step: "request_top_up",
			value: 240,
		});
		// Not enough budget for 5 more profiles: skip straight to the next rung.
		expect(replanStep({ ...dry, budgetAvailable: 60 }).step).not.toBe("more_sourcing");
	});
});
