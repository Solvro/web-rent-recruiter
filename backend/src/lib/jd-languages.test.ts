import { readFileSync } from "node:fs";
import type { Criteria } from "@scout/shared";
import { describe, expect, it } from "vitest";
import { requiredLanguage, splitBudget } from "../agent/index.ts";
import { languagesFromJd, withJdLanguages } from "./jd-languages.ts";

const jd = readFileSync(new URL("../agent/fixtures/demo-jd-senior-backend-ts.txt", import.meta.url), "utf8");
const base: Criteria = {
	mustHave: [{ id: "rust", label: "3+ years of production Rust", weight: 5 }],
	niceToHave: [],
	dealBreakers: [],
	seniority: "SENIOR",
	location: { mode: "HYBRID", places: ["Warsaw"] },
	salaryRange: null,
	languages: [],
};

describe("JD languages", () => {
	it("reads 'Fluent English (C1)' from the demo JD", () => {
		expect(languagesFromJd(jd)).toEqual(["English (C1)"]);
	});

	it("restores a language the draft dropped, or the level it lost", () => {
		expect(withJdLanguages(jd, base).languages).toEqual(["English (C1)"]);
		expect(withJdLanguages(jd, { ...base, languages: ["English"] }).languages).toEqual(["English (C1)"]);
		expect(withJdLanguages(jd, { ...base, languages: ["English (C2)"] }).languages).toEqual(["English (C2)"]);
	});

	it("so the demo JD always gets a language check", () => {
		const criteria = withJdLanguages(jd, base);
		expect(requiredLanguage(criteria)).toEqual({ name: "English", level: "C1" });
		expect(splitBudget(750, "SENIOR", criteria).languageChecks).toBeGreaterThan(0);
	});
});
