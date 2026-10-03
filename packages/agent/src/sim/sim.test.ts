import { beforeAll, describe, expect, it } from "vitest";
import { NO_DEFENSES, params } from "./model.ts";
import { runMany, simulateRole } from "./simulate.ts";

beforeAll(() => {
	process.env.LLM_PROVIDER = "offline";
	process.env.REVIEW_ENGINE = "offline";
});

describe("recruitment Monte Carlo", () => {
	it("never spends more than the budget plus forfeited bonds", () => {
		const p = params({ name: "budget", budgetUsd: 300 });
		for (let seed = 1; seed <= 300; seed++) {
			const r = simulateRole(p, seed);
			expect(r.spent).toBeLessThanOrEqual(p.budgetUsd + r.bondsForfeited + 1e-6);
		}
	});

	it("is deterministic for a seed", () => {
		const p = params({ name: "det", budgetUsd: 300 });
		expect(simulateRole(p, 7)).toEqual(simulateRole(p, 7));
	});

	it("the anti-spam defenses cut fake candidates on the shortlist and cost per qualified hire", () => {
		const withDefenses = runMany(params({ name: "on", budgetUsd: 1500 }), 300);
		const without = runMany(params({ name: "off", budgetUsd: 1500, defenses: NO_DEFENSES }), 300);
		expect(withDefenses.fakeLeakRate).toBeLessThan(without.fakeLeakRate / 5);
		expect(withDefenses.spendPerQualified ?? Infinity).toBeLessThan(without.spendPerQualified ?? 0);
	});
});
