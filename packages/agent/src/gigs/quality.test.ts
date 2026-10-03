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
