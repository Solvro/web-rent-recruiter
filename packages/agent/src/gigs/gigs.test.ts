import type { AgentReview, Criteria } from "@scout/shared";
import { describe, expect, it } from "vitest";
import { decideCall } from "./call-review.ts";
import { requiredLanguage } from "./language.ts";
import { splitBudget } from "./plan.ts";
import { agentDecision, pickForScreening } from "./policy.ts";
import { referenceSlots, screeningSlots } from "./scripts.ts";
import { overallScore } from "./shortlist.ts";
import type { CallDeliverable, CallReview, QuestionCheck } from "./types.ts";

const criteria: Criteria = {
	mustHave: [
		{ id: "ts", label: "TypeScript backend", weight: 5 },
		{ id: "prod", label: "5+ years in production", weight: 4 },
		{ id: "rt", label: "Real-time systems", weight: 4 },
		{ id: "api", label: "Customer-facing APIs", weight: 4 },
		{ id: "en", label: "Fluent English", weight: 3 },
	],
	niceToHave: [{ id: "edge", label: "Edge compute", weight: 2 }],
	seniority: "SENIOR",
	location: { mode: "HYBRID", places: ["Warsaw"] },
	salaryRange: null,
	languages: ["English"],
	dealBreakers: [
		{ id: "fe", label: "Pure frontend background", weight: 5 },
		{ id: "office", label: "Not open to office days", weight: 4 },
	],
};

describe("splitBudget", () => {
	it("splits $300 senior: 5 × $25 sourcing (market + 25%), 2 × $40 screening, 1 × $25 reference", () => {
		expect(splitBudget(300, "SENIOR", criteria)).toEqual({
			sourcingBounty: 25,
			sourcing: 5,
			screeningBounty: 40,
			screenings: 2,
			referenceBounty: 25,
			references: 1,
			languageBounty: 0,
			languageChecks: 0,
			reserve: 70,
		});
	});

	it("adds one $15 language check for the finalist when the role names a language level ($750 demo)", () => {
		const withEnglish = { ...criteria, languages: ["English (C1)"] };
		expect(splitBudget(750, "SENIOR", withEnglish)).toMatchObject({
			sourcingBounty: 25,
			sourcing: 17,
			screenings: 3,
			references: 1,
			languageBounty: 15,
			languageChecks: 1,
			reserve: 165,
		});
	});

	it("drops the reference, then screenings, on small budgets and keeps a reserve", () => {
		const small = splitBudget(220, "SENIOR", criteria);
		expect(small.screenings).toBe(1);
		expect(small.references).toBe(0);
		expect(small.sourcing).toBeGreaterThanOrEqual(5);
		const tiny = splitBudget(60, "SENIOR", criteria);
		expect(tiny.screenings + tiny.references).toBe(0);
		for (const b of [small, tiny]) expect(b.reserve).toBeGreaterThanOrEqual(0);
	});

	it("caps sourcing at 30 and adds screenings on large budgets, never overspending", () => {
		const big = splitBudget(2000, "SENIOR", criteria);
		expect(big.sourcing).toBe(30);
		expect(big.screenings).toBe(5);
		expect(big.references).toBe(2);
		const committed =
			big.sourcing * big.sourcingBounty +
			big.screenings * big.screeningBounty +
			big.references * big.referenceBounty;
		expect(committed + big.reserve).toBe(2000);
	});
});

const check = (questionId: string, over: Partial<QuestionCheck> = {}): QuestionCheck => ({
	questionId,
	missing: false,
	generic: false,
	contradiction: false,
	fit: 0.8,
	quality: 0.95,
	...over,
});
const deliverable = { recommendation: "ADVANCE" } as CallDeliverable;
const ids = ["q1", "q2", "q3", "q4", "q5", "q6"];

describe("decideCall", () => {
	it("accepts specific, complete answers", () => {
		const r = decideCall(
			deliverable,
			ids.map((id) => check(id)),
			0.9,
		);
		expect(r.verdict).toBe("ACCEPT");
		expect(r.score).toBe(95);
		expect(r.missing).toEqual([]);
	});

	it("rejects empty or generic notes, even with an ADVANCE recommendation", () => {
		const lazy = ids.map((id, i) =>
			i < 3 ? check(id, { missing: true, quality: 0, fit: 0 }) : check(id, { generic: true, quality: 0.35 }),
		);
		const r = decideCall(deliverable, lazy, 0.1);
		expect(r.verdict).toBe("REJECT");
		expect(r.missing).toEqual(["q1", "q2", "q3"]);
		expect(r.reasons.join(" ")).toMatch(/no candidate-specific facts/);
		expect(r.reasons.join(" ")).toMatch(/recommendation \(ADVANCE\)/);
	});

	it("rejects two contradictions and escalates one", () => {
		const two = ids.map((id, i) => check(id, { contradiction: i < 2 }));
		expect(decideCall(deliverable, two, 0.9).verdict).toBe("REJECT");
		const one = ids.map((id, i) => check(id, { contradiction: i === 0 }));
		expect(decideCall(deliverable, one, 0.9).verdict).toBe("ESCALATE");
	});

	it("escalates good notes whose recommendation doesn't match them", () => {
		expect(
			decideCall(
				deliverable,
				ids.map((id) => check(id)),
				0.2,
			).verdict,
		).toBe("ESCALATE");
	});
});

const sourcing = (score: number, recommendation: AgentReview["recommendation"]): AgentReview => ({
	score,
	recommendation,
	verdicts: [],
	summary: "",
});
const call = (verdict: CallReview["verdict"], candidateFit = 80): CallReview => ({
	verdict,
	score: 90,
	missing: [],
	reasons: [verdict],
	summaryForCompany: "",
	candidateFit,
	checks: [],
	engine: "offline",
	flags: [],
	confidence: "recorded",
	noShow: false,
});

describe("agentDecision", () => {
	it("pre-accepts ADVANCE, follows up on 60-74 once, digests 55-59, rejects below", () => {
		expect(agentDecision({ kind: "sourcing", review: sourcing(96, "ADVANCE") }).action).toBe("accept");
		const unclear = {
			...sourcing(74, "MAYBE"),
			verdicts: [{ criterionId: "rt", verdict: "UNKNOWN" as const, reasoning: "Not mentioned." }],
		};
		const maybe = agentDecision({
			kind: "sourcing",
			review: unclear,
			criteria,
			notes: "Backend dev, 6 years.",
		});
		expect(maybe.action).toBe("follow_up");
		expect(maybe.question).toMatch(/Real-time systems/);
		// The note already covers it: no follow-up, the company decides in the digest.
		expect(
			agentDecision({
				kind: "sourcing",
				review: unclear,
				criteria,
				notes: "Built real-time systems at Uber.",
			}),
		).toMatchObject({ action: "escalate", delivery: "digest" });
		// The review couldn't be done properly: a person decides, never keyword guesses.
		expect(agentDecision({ kind: "sourcing", review: sourcing(96, "ADVANCE"), degraded: true }).action).toBe(
			"escalate",
		);
		expect(agentDecision({ kind: "sourcing", review: sourcing(74, "MAYBE"), followUps: 1 })).toMatchObject({
			action: "escalate",
			delivery: "digest",
		});
		expect(agentDecision({ kind: "sourcing", review: sourcing(57, "MAYBE") })).toMatchObject({
			action: "escalate",
			delivery: "digest",
		});
		expect(agentDecision({ kind: "sourcing", review: sourcing(51, "MAYBE") }).action).toBe("reject");
		expect(agentDecision({ kind: "sourcing", review: sourcing(27, "PASS") }).action).toBe("reject");
	});

	it("maps call verdicts one to one", () => {
		expect(agentDecision({ kind: "screening", review: call("ACCEPT") }).action).toBe("accept");
		expect(agentDecision({ kind: "reference", review: call("REJECT") }).action).toBe("reject");
		expect(agentDecision({ kind: "screening", review: call("ESCALATE") }).action).toBe("escalate");
	});
});

describe("pickForScreening", () => {
	const c = (id: string, score: number) => ({
		id,
		review: sourcing(score, score >= 75 ? "ADVANCE" : "MAYBE"),
	});
	it("picks ADVANCE candidates best first, within free slots", () => {
		expect(pickForScreening([c("a", 80), c("b", 96), c("c", 62)]).map((x) => x.id)).toEqual(["b", "a"]);
		expect(pickForScreening([c("a", 80), c("b", 96)], 2).map((x) => x.id)).toEqual(["b"]);
	});
	it("never screens below ADVANCE (MAYBE candidates go to the company first)", () => {
		expect(pickForScreening([c("a", 74), c("b", 61)])).toEqual([]);
		expect(pickForScreening([c("a", 74)], 1)).toEqual([]);
	});
});

describe("scripts", () => {
	it("screening has 6-8 questions tied to must-haves and deal breakers, with stable ids", () => {
		const slots = screeningSlots(criteria);
		expect(slots.length).toBeGreaterThanOrEqual(6);
		expect(slots.length).toBeLessThanOrEqual(8);
		expect(slots.map((s) => s.id)).toEqual([
			"q-ts",
			"q-prod",
			"q-rt",
			"q-api",
			"q-en",
			"q-fe",
			"q-office",
			"q-motivation",
		]);
	});
	it("asks first about must-haves the sourcing review left unclear", () => {
		const review = {
			...sourcing(80, "ADVANCE"),
			verdicts: [{ criterionId: "api", verdict: "UNKNOWN" as const, reasoning: "" }],
		};
		expect(screeningSlots(criteria, review)[0].id).toBe("q-api");
	});
	it("reference has 5 fixed questions tied to the top must-haves", () => {
		const slots = referenceSlots(criteria);
		expect(slots.map((s) => s.id)).toEqual([
			"ref-relationship",
			"ref-strength",
			"ref-verify",
			"ref-growth",
			"ref-rehire",
		]);
		expect(slots[1].criterionId).toBe("ts");
	});
});

describe("overallScore", () => {
	it("blends sourcing 40 / screening 40 / reference 20 and ignores rejected calls", () => {
		const base = { id: "1", name: "K", sourcing: sourcing(90, "ADVANCE") };
		expect(overallScore(base)).toBe(90);
		expect(overallScore({ ...base, screening: call("ACCEPT", 80) })).toBe(85);
		expect(overallScore({ ...base, screening: call("ACCEPT", 80), reference: call("ACCEPT", 70) })).toBe(82);
		expect(overallScore({ ...base, screening: call("REJECT", 10) })).toBe(90);
	});
});

describe("requiredLanguage", () => {
	const withLanguages = (languages: string[]) => ({ ...criteria, languages });
	it("checks English only with an explicit level, other languages at B2 by default", () => {
		expect(requiredLanguage(withLanguages(["English"]))).toBeNull();
		expect(requiredLanguage(withLanguages(["English (C1)"]))).toEqual({ name: "English", level: "C1" });
		expect(requiredLanguage(withLanguages(["English", "German"]))).toEqual({ name: "German", level: "B2" });
		expect(requiredLanguage(withLanguages(["Fluent German"]))).toEqual({ name: "German", level: "C1" });
	});
});

describe("planRationale", () => {
	it("singular counts, no zero parts, and says what doesn't fit", async () => {
		const { planRationale } = await import("./plan.ts");
		const designer: Criteria = {
			mustHave: [{ id: "b2b", label: "6+ years designing B2B SaaS products", weight: 5 }],
			niceToHave: [],
			seniority: "SENIOR",
			location: { mode: "HYBRID", places: ["Berlin"] },
			salaryRange: null,
			languages: ["German (B1)", "English"],
			dealBreakers: [],
		};
		const counts = splitBudget(400, "SENIOR", designer);
		const line = planRationale(designer, counts);
		expect(line).not.toMatch(/\$0 to|\b0 (reference|screening|profile)/);
		expect(line).not.toMatch(/\b1 screening calls\b/);
		expect(line).toMatch(/German language check/);
		expect(line).toBe(
			"Of the $400 budget, the agent commits $215 to sourcing 5 profiles, $68 to 1 screening call with the best of them and $26 to a German language check for the finalist. $91 stays in reserve to re-post a gig if a candidate drops out. No reference check fits this budget; top it up to add one for the finalist.",
		);
		expect(counts.references).toBe(0);
		const demo = planRationale(
			{ ...criteria, languages: ["English (C1)"] },
			splitBudget(750, "SENIOR", { ...criteria, languages: ["English (C1)"] }),
		);
		expect(demo).toBe(
			"Of the $750 budget, the agent commits $425 to sourcing 17 profiles, $120 to 3 screening calls with the best of them, $15 to an English language check for the finalist and $25 to 1 reference check. $165 stays in reserve to re-post a gig if a candidate drops out.",
		);
	});
});
