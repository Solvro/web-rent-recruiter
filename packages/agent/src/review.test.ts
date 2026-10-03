import { describe, expect, it } from "vitest";
import { z } from "zod";
import { resolveProviderName } from "./llm/index.ts";
import { strictSchema } from "./llm/schema.ts";
import { defaultReviewEngine, noteLines, verdictFromProbabilities } from "./review.ts";

describe("verdictFromProbabilities", () => {
	it("maps Jev probabilities with the documented thresholds", () => {
		expect(verdictFromProbabilities(0.98, 0.95)).toBe("MET");
		expect(verdictFromProbabilities(0.75, 0.1)).toBe("MET"); // strong yes wins even if info is low
		expect(verdictFromProbabilities(0.02, 0.93)).toBe("NOT_MET");
		expect(verdictFromProbabilities(0.09, 0.05)).toBe("UNKNOWN"); // notes are silent
		expect(verdictFromProbabilities(0.67, 0.69)).toBe("PARTIAL");
		expect(verdictFromProbabilities(0.31, 0.6)).toBe("PARTIAL");
	});
});

describe("defaultReviewEngine", () => {
	it("prefers REVIEW_ENGINE, then Jev when its key exists, then llm/offline", () => {
		expect(defaultReviewEngine({ REVIEW_ENGINE: "offline", JEV_API_KEY: "k" })).toBe("offline");
		expect(defaultReviewEngine({ JEV_API_KEY: "k" })).toBe("jev");
		expect(defaultReviewEngine({ OPENAI_API_KEY: "k" })).toBe("llm");
		expect(defaultReviewEngine({})).toBe("offline");
	});
});

describe("resolveProviderName", () => {
	it("orders LLM_PROVIDER > openrouter > anthropic > openai > offline", () => {
		const all = { OPENROUTER_API_KEY: "k", ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "k" };
		expect(resolveProviderName({ ...all, LLM_PROVIDER: "openai" })).toBe("openai");
		expect(resolveProviderName(all)).toBe("openrouter");
		expect(resolveProviderName({ ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "k" })).toBe("anthropic");
		expect(resolveProviderName({ OPENAI_API_KEY: "k" })).toBe("openai");
		expect(resolveProviderName({})).toBe("offline");
	});
});

describe("noteLines", () => {
	it("splits notes into sentences without breaking abbreviations or numbers", () => {
		expect(
			noteLines("Spoke on Tuesday. 8 years in Rust, e.g. Anchor. Open to 34-37k PLN.\nAvailable soon"),
		).toEqual([
			"Spoke on Tuesday.",
			"8 years in Rust, e.g. Anchor.",
			"Open to 34-37k PLN.",
			"Available soon",
		]);
	});
});

describe("strictSchema", () => {
	it("requires every property, forbids extras and drops unsupported keywords", () => {
		const schema = strictSchema(
			z.toJSONSchema(z.object({ score: z.number().int().min(0).max(100), note: z.string().nullable() })),
		) as Record<string, unknown>;
		expect(schema.$schema).toBeUndefined();
		expect(schema.additionalProperties).toBe(false);
		expect(schema.required).toEqual(["score", "note"]);
		expect(JSON.stringify(schema)).not.toMatch(/minimum|maximum/);
	});
});
