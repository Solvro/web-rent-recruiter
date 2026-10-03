import type { Criteria } from "@scout/shared";
import { describe, expect, it } from "vitest";
import { normalizeCriteria, slugify } from "./criteria.ts";
import { offlineDraftRole, offlineVerdicts } from "./offline.ts";
import { computeScore, normalizeVerdicts, recommend, type Verdict } from "./scoring.ts";

const criteria: Criteria = {
	mustHave: [
		{ id: "rust", label: "Production Rust", weight: 5 },
		{ id: "solana", label: "Solana programs on mainnet", weight: 5 },
	],
	niceToHave: [{ id: "audits", label: "Security audits", weight: 2 }],
	seniority: "SENIOR",
	location: { mode: "REMOTE", places: [] },
	salaryRange: null,
	languages: ["English"],
	dealBreakers: [{ id: "visa", label: "Needs visa sponsorship", weight: 5 }],
};

const v = (criterionId: string, verdict: Verdict["verdict"]): Verdict => ({
	criterionId,
	verdict,
	reasoning: "",
});

describe("computeScore", () => {
	it("is 100 when everything is met and no deal breaker applies", () => {
		expect(
			computeScore(criteria, [
				v("rust", "MET"),
				v("solana", "MET"),
				v("audits", "MET"),
				v("visa", "NOT_MET"),
			]),
		).toBe(100);
	});

	it("weights must-haves double: missing a must-have hurts more than a nice-to-have", () => {
		const missingMust = computeScore(criteria, [
			v("rust", "NOT_MET"),
			v("solana", "MET"),
			v("audits", "MET"),
		]);
		const missingNice = computeScore(criteria, [
			v("rust", "MET"),
			v("solana", "MET"),
			v("audits", "NOT_MET"),
		]);
		expect(missingMust).toBe(Math.round((100 * (10 + 2)) / 22));
		expect(missingNice).toBe(Math.round((100 * 20) / 22));
		expect(missingMust).toBeLessThan(missingNice);
	});

	it("caps at 30 when a deal breaker applies and subtracts 10 for a partial one", () => {
		const all = [v("rust", "MET"), v("solana", "MET"), v("audits", "MET")];
		expect(computeScore(criteria, [...all, v("visa", "MET")])).toBe(30);
		expect(computeScore(criteria, [...all, v("visa", "PARTIAL")])).toBe(90);
	});

	it("treats missing verdicts as UNKNOWN (30% credit)", () => {
		expect(computeScore(criteria, [])).toBe(30);
	});
});

describe("recommend", () => {
	it("uses 75 / 50 thresholds", () => {
		expect(recommend(75)).toBe("ADVANCE");
		expect(recommend(74)).toBe("MAYBE");
		expect(recommend(50)).toBe("MAYBE");
		expect(recommend(49)).toBe("PASS");
	});
});

describe("normalizeVerdicts", () => {
	it("returns one verdict per criterion in order, dropping unknown ids", () => {
		const out = normalizeVerdicts(criteria, [v("visa", "NOT_MET"), v("bogus", "MET"), v("rust", "MET")]);
		expect(out.map((x) => [x.criterionId, x.verdict])).toEqual([
			["rust", "MET"],
			["solana", "UNKNOWN"],
			["audits", "UNKNOWN"],
			["visa", "NOT_MET"],
		]);
	});
});

describe("criteria ids", () => {
	it("slugifies and dedupes", () => {
		expect(slugify("5+ years of production Rust")).toBe("5plus-years-of-production-rust");
		const out = normalizeCriteria({
			...criteria,
			mustHave: [
				{ id: "", label: "Rust", weight: 9 },
				{ id: "rust", label: "Rust again", weight: 0 },
			],
		});
		expect(out.mustHave.map((c) => [c.id, c.weight])).toEqual([
			["rust", 5],
			["rust-2", 1],
		]);
	});
});

describe("offline heuristics", () => {
	it("drafts criteria from a bulleted job description", () => {
		const draft = offlineDraftRole(
			"Senior Backend Engineer\nRemote in Europe. We cannot sponsor visas.\nRequirements\n- 5+ years of Go\n- PostgreSQL in production\nNice to have\n- Kubernetes\nSalary: 20 000 - 26 000 PLN / month",
		);
		expect(draft.title).toBe("Senior Backend Engineer");
		expect(draft.criteria.seniority).toBe("SENIOR");
		expect(draft.criteria.location.mode).toBe("REMOTE");
		expect(draft.criteria.mustHave.map((c) => c.label)).toEqual([
			"5+ years of Go",
			"PostgreSQL in production",
		]);
		expect(draft.criteria.niceToHave.map((c) => c.label)).toEqual(["Kubernetes"]);
		expect(draft.criteria.dealBreakers.map((c) => c.label)).toEqual(["Needs visa sponsorship"]);
		expect(draft.criteria.salaryRange).toEqual({ min: 20000, max: 26000, currency: "PLN", period: "MONTH" });
	});

	it("reads negations and years from notes", () => {
		const verdicts = offlineVerdicts(
			criteria,
			"Four years of production Rust. No Solana programs on mainnet yet. Would need visa sponsorship.",
		);
		const by = Object.fromEntries(verdicts.map((x) => [x.criterionId, x.verdict]));
		expect(by.rust).toBe("MET");
		expect(by.solana).toBe("NOT_MET");
		expect(by.visa).toBe("MET");
	});
});
