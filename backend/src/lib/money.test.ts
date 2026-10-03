import { toBaseUnits } from "@scout/shared";
import { describe, expect, it } from "vitest";
import { splitBounty } from "./money.ts";

describe("splitBounty", () => {
	it("matches the program-interface example (20 USDC, 10% fee, 10% operator, 30% holdback)", () => {
		expect(splitBounty(toBaseUnits(20), 1000, 1000, 3000)).toEqual({
			platformFee: toBaseUnits(2),
			operatorFee: toBaseUnits(1.8),
			later: toBaseUnits(4.86),
			now: toBaseUnits(11.34),
		});
	});

	it("without operator or holdback pays bounty minus fee now", () => {
		expect(splitBounty(toBaseUnits(20), 1000, 0, 0)).toEqual({
			platformFee: toBaseUnits(2),
			operatorFee: 0n,
			later: 0n,
			now: toBaseUnits(18),
		});
	});

	it("rounds down and never loses or creates base units", () => {
		const bounty = 1_000_003n;
		const s = splitBounty(bounty, 1000, 1500, 3333);
		expect(s.platformFee + s.operatorFee + s.later + s.now).toBe(bounty);
	});
});
