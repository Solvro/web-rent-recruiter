import type { Criteria } from "@scout/shared";
import { describe, expect, it } from "vitest";
import { BOUNTY_MAX_USDC, CANDIDATES_MIN, computeBudget, rarityFactor } from "./budget.ts";
import { publishTask } from "./index.ts";

const base: Criteria = {
	mustHave: [
		{ id: "rust", label: "3+ years of production Rust", weight: 5 },
		{ id: "solana", label: "Shipped Solana programs", weight: 5 },
		{ id: "tokens", label: "SPL Token and PDAs", weight: 4 },
		{ id: "backend", label: "High-throughput backends", weight: 3 },
		{ id: "english", label: "Fluent English", weight: 3 },
	],
	niceToHave: [{ id: "audits", label: "Security audits", weight: 2 }],
	seniority: "SENIOR",
	location: { mode: "HYBRID", places: ["Warsaw"] },
	salaryRange: null,
	languages: ["English"],
	dealBreakers: [{ id: "visa", label: "Needs visa sponsorship", weight: 5 }],
};

describe("rarityFactor", () => {
	it("is 1.0 for a common remote profile", () => {
		expect(
			rarityFactor({
				...base,
				mustHave: [{ id: "a", label: "TypeScript", weight: 3 }],
				location: { mode: "REMOTE", places: [] },
				dealBreakers: [],
			}),
		).toBe(1);
	});

	it("rises with must-have weight, extra languages, on-site work and deal breakers", () => {
		const common = rarityFactor(base);
		expect(rarityFactor({ ...base, languages: ["English", "Polish"] })).toBeCloseTo(common + 0.1);
		expect(rarityFactor({ ...base, location: { mode: "ONSITE", places: ["Warsaw"] } })).toBeCloseTo(
			common + 0.05,
		);
		expect(
			rarityFactor({ ...base, mustHave: [...base.mustHave, { id: "x", label: "x", weight: 5 }] }),
		).toBeCloseTo(common + 0.1);
	});
});

describe("computeBudget", () => {
	it("gives the demo numbers for a senior hybrid role: 20 USDC x 10", () => {
		const budget = computeBudget(base);
		expect(budget.bountyUsdc).toBe(20);
		expect(budget.bounty).toBe(20_000_000n);
		expect(budget.maxCandidates).toBe(10);
	});

	it("is deterministic and scales with seniority", () => {
		expect(computeBudget(base)).toEqual(computeBudget(base));
		const junior = computeBudget({ ...base, seniority: "JUNIOR" });
		const exec = computeBudget({ ...base, seniority: "EXECUTIVE" });
		expect(junior.bountyUsdc).toBeLessThan(computeBudget(base).bountyUsdc);
		expect(exec.bountyUsdc).toBeGreaterThan(computeBudget(base).bountyUsdc);
		expect(exec.maxCandidates).toBeLessThan(junior.maxCandidates);
	});

	it("rounds to 5 USDC and stays within bounds", () => {
		const heavy: Criteria = {
			...base,
			seniority: "EXECUTIVE",
			mustHave: Array.from({ length: 10 }, (_, i) => ({ id: `m${i}`, label: `m${i}`, weight: 5 })),
			languages: ["English", "German", "French"],
			location: { mode: "ONSITE", places: ["Berlin"] },
		};
		const budget = computeBudget(heavy);
		expect(budget.bountyUsdc % 5).toBe(0);
		expect(budget.bountyUsdc).toBeLessThanOrEqual(BOUNTY_MAX_USDC);
		expect(budget.maxCandidates).toBeGreaterThanOrEqual(CANDIDATES_MIN);
	});
});

describe("publishTask", () => {
	const role = {
		status: "OPEN" as const,
		vaultBalance: 200_000_000n,
		bounty: 20_000_000n,
		maxCandidates: 10,
		acceptedCount: 0,
		pendingCount: 0,
	};
	it("publishes a funded open role", () => expect(publishTask(role).publish).toBe(true));
	it("hides drafts, closed roles, full roles and unfunded roles", () => {
		expect(publishTask({ ...role, status: "DRAFT" }).publish).toBe(false);
		expect(publishTask({ ...role, status: "CLOSED" }).publish).toBe(false);
		expect(publishTask({ ...role, acceptedCount: 6, pendingCount: 4 }).publish).toBe(false);
		expect(publishTask({ ...role, vaultBalance: 40_000_000n, pendingCount: 2 }).publish).toBe(false);
	});
});
