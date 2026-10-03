import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.ts", () => ({ db: {}, schema: {} }));
const { qualityScore, wilsonLower } = await import("./recruiter-profile.ts");

describe("reputation score", () => {
	it("Wilson lower bound rewards volume, not luck", () => {
		expect(wilsonLower(1, 1)).toBeLessThan(wilsonLower(18, 20));
		expect(wilsonLower(0, 0)).toBe(0);
		expect(wilsonLower(10, 10)).toBeGreaterThan(0.7);
	});

	it("advanced candidates add, flags subtract", () => {
		const base = { accepted: 18, decided: 20, advanced: 0, flagged: 0 };
		expect(qualityScore({ ...base, advanced: 9 })).toBeGreaterThan(qualityScore(base));
		expect(qualityScore({ ...base, flagged: 1 })).toBeLessThan(qualityScore(base));
		expect(qualityScore({ accepted: 0, decided: 5, advanced: 0, flagged: 3 })).toBe(0);
	});
});
