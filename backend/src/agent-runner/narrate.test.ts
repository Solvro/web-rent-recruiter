import { describe, expect, it } from "vitest";
import { humanize } from "./narrate.ts";

describe("humanize", () => {
	it("drops raw verdict tokens and starts with a capital", () => {
		expect(humanize("screening notes for Karolina: ACCEPT 96/100")).toBe(
			"Screening notes for Karolina: accept 96/100",
		);
		expect(humanize("Scored 59 (MAYBE); borderline")).toBe("Scored 59 (borderline); borderline");
		expect(humanize("Scored 20 (PASS)")).toBe("Scored 20 (not a fit)");
	});
});
