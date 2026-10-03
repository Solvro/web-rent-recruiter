import type { AgentReview } from "@scout/shared";
import { describe, expect, it } from "vitest";
import { identityMismatch } from "../review.ts";
import { applyRecommendationCheck, isNoShow } from "./call-review.ts";
import { agentDecision, canClaimCallGig, noShowPolicy } from "./policy.ts";
import type { CallReview, CallScript } from "./types.ts";

const review = (over: Partial<CallReview> = {}): CallReview => ({
	verdict: "ACCEPT",
	score: 90,
	missing: [],
	reasons: [],
	summaryForCompany: "",
	candidateFit: 85,
	checks: [
		{ questionId: "q1", missing: false, generic: false, contradiction: false, fit: 0.85, quality: 0.9 },
	],
	engine: "offline",
	flags: [],
	confidence: "recorded",
	noShow: false,
	...over,
});
const script: CallScript = {
	kind: "screening",
	candidate: { name: "Karolina Mazurek", profileUrl: "", notes: "" },
	questions: [],
};

describe("screening quality rules", () => {
	it("self-reported calls are paid with a holdback; recorded ones in full", () => {
		expect(agentDecision({ kind: "screening", review: review() }).payout).toBe("full");
		expect(agentDecision({ kind: "screening", review: review({ confidence: "self-reported" }) }).payout).toBe(
			"holdback",
		);
	});

	it("rejects a recommendation that contradicts the answers, escalates a missing one", () => {
		const { verdict, candidateFit, checks, score, missing, reasons } = review({ candidateFit: 20 });
		const base = { verdict, candidateFit, checks, score, missing, reasons };
		expect(applyRecommendationCheck(base, "ADVANCE").verdict).toBe("REJECT");
		expect(applyRecommendationCheck({ ...base, candidateFit: 90 }, "PASS").verdict).toBe("REJECT");
		expect(applyRecommendationCheck({ ...base, candidateFit: 90 }, "ADVANCE").verdict).toBe("ACCEPT");
		expect(applyRecommendationCheck({ ...base, candidateFit: 90 }, undefined).verdict).toBe("ESCALATE");
	});

	it("detects no-shows from recording metadata and rebooks once, then strikes", () => {
		expect(
			isNoShow({ script, recording: { durationSeconds: 1500, speakers: ["Ola", "Karolina Mazurek"] } }),
		).toBeNull();
		expect(isNoShow({ script, recording: { durationSeconds: 1500, speakers: ["Ola"] } })).toMatch(
			/none is the candidate/,
		);
		expect(isNoShow({ script, recording: { durationSeconds: 120, speakers: ["Ola", "Karolina"] } })).toMatch(
			/2 min/,
		);
		expect(
			agentDecision({ kind: "screening", review: review({ noShow: true, reasons: ["no-show"] }) }).action,
		).toBe("reject");
		expect(noShowPolicy(0).action).toBe("rebook");
		expect(noShowPolicy(1)).toEqual({ action: "strike", showUpFeeUsd: 5 });
	});

	it("gates call gigs by reputation and keeps sourcer ≠ screener", () => {
		const good = { wallet: "W1", acceptedLast90d: 12, decidedLast90d: 20 };
		expect(canClaimCallGig({ recruiter: good }).allowed).toBe(true);
		expect(canClaimCallGig({ recruiter: good, sourcerWallet: "W1" }).allowed).toBe(false);
		expect(canClaimCallGig({ recruiter: { ...good, acceptedLast90d: 9 } }).allowed).toBe(false);
		expect(canClaimCallGig({ recruiter: { ...good, decidedLast90d: 30 } }).allowed).toBe(false);
	});

	it("flags a profile slug that doesn't match the name", () => {
		expect(
			identityMismatch("Karolina Mazurek", "https://linkedin.com/in/karolina-mazurek-backend-demo"),
		).toBe(false);
		expect(identityMismatch("Karolina Mazurek", "https://linkedin.com/in/jan-kowalski-123")).toBe(true);
		expect(identityMismatch("Tomasz Brzeziński", "https://linkedin.com/in/tomasz-brzezinski-demo")).toBe(
			false,
		);
		expect(identityMismatch("Karolina Mazurek", "https://linkedin.com/in/ACoAAB12345")).toBe(true);
		expect(identityMismatch("Karolina Mazurek", "https://example.com/karolina")).toBe(false);
	});

	it("an identity mismatch is never auto-accepted", () => {
		const strong: AgentReview = { score: 95, recommendation: "ADVANCE", verdicts: [], summary: "" };
		expect(agentDecision({ kind: "sourcing", review: strong, flags: ["identity-mismatch"] }).action).toBe(
			"escalate",
		);
	});
});

describe("summaryForCompany", () => {
	it("is one plain sentence of facts, without recommendation tokens or scores", async () => {
		const { readFileSync } = await import("node:fs");
		const { Criteria } = await import("@scout/shared");
		process.env.LLM_PROVIDER = "offline";
		process.env.REVIEW_ENGINE = "offline";
		const { reviewCall } = await import("./call-review.ts");
		const { screeningScript: makeScript } = await import("./scripts.ts");
		const fx = (f: string) => JSON.parse(readFileSync(new URL(`../fixtures/${f}`, import.meta.url), "utf-8"));
		const criteria = Criteria.parse(fx("demo-role-senior-backend-ts.json").criteria);
		const s = await makeScript({ criteria, candidate: fx("demo-candidate-1-strong-karolina.json") });
		const good = await reviewCall({ script: s, ...fx("screening-karolina-good.json") });
		expect(good.summaryForCompany).toBe(
			"6 years of Rust in production; shipped the lending pool and liquidation logic to mainnet in 2024; 1 month notice on B2B.",
		);
		const lazy = await reviewCall({ script: s, ...fx("screening-lazy.json") });
		expect(lazy.summaryForCompany).toBe("Sent back to the recruiter: 8 of 8 answers weren't usable.");
		for (const r of [good, lazy]) expect(r.summaryForCompany).not.toMatch(/ADVANCE|MAYBE|PASS|\/100/);
	});
});

describe("answers under the wrong question", () => {
	const load = async () => {
		const { readFileSync } = await import("node:fs");
		const { Criteria } = await import("@scout/shared");
		process.env.LLM_PROVIDER = "offline";
		process.env.REVIEW_ENGINE = "offline";
		const fx = (f: string) => JSON.parse(readFileSync(new URL(`../fixtures/${f}`, import.meta.url), "utf-8"));
		const { screeningScript: make, referenceScript } = await import("./scripts.ts");
		const criteria = Criteria.parse(fx("demo-role-senior-backend-ts.json").criteria);
		const candidate = fx("demo-candidate-1-strong-karolina.json");
		return {
			fx,
			screening: await make({ criteria, candidate }),
			reference: await referenceScript({ criteria, candidate }),
		};
	};

	it("the real notes pass untouched", async () => {
		const { misplacedAnswers } = await import("./call-review.ts");
		const { fx, screening, reference } = await load();
		for (const [script, file] of [
			[screening, "screening-karolina-good.json"],
			[reference, "reference-karolina.json"],
		] as const) {
			const answers = new Map<string, string>(
				fx(file).answers.map((a: { questionId: string; answer: string }) => [a.questionId, a.answer]),
			);
			expect([...misplacedAnswers(script.questions, answers)]).toEqual([]);
		}
	});

	it("shifted answers (each under the next question) are treated as missing and rejected", async () => {
		const { reviewCall } = await import("./call-review.ts");
		const { fx, screening } = await load();
		const good: { questionId: string; answer: string }[] = fx("screening-karolina-good.json").answers;
		const shifted = good.map((a, i) => ({
			questionId: a.questionId,
			answer: good[(i + 1) % good.length]?.answer ?? "",
		}));
		const review = await reviewCall({ script: screening, recommendation: "ADVANCE", answers: shifted });
		expect(review.verdict).toBe("REJECT");
		expect(review.reasons.join(" ")).toMatch(/belong to a different question/);
	});
});
