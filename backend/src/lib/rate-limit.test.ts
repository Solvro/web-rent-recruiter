import { describe, expect, it } from "vitest";
import { rateLimit } from "./rate-limit.ts";

describe("rateLimit", () => {
	it("allows up to the limit, then 429", () => {
		for (let i = 0; i < 3; i++) rateLimit("t1", 3, 60_000);
		expect(() => rateLimit("t1", 3, 60_000)).toThrow(/Too many/);
	});
	it("keys are independent", () => {
		for (let i = 0; i < 3; i++) rateLimit("a", 3, 60_000);
		expect(() => rateLimit("b", 3, 60_000)).not.toThrow();
	});
});
