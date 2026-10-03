/**
 * Scout's recruiting agent. Everything that decides money or a ranking (bounty, candidate count,
 * score, recommendation) is computed in code; the LLM only extracts criteria, judges evidence per
 * criterion and writes explanations. A human makes every final decision.
 */
import { type AgentReview, Criteria, fromBaseUnits } from "@scout/shared";
import { z } from "zod";
import { computeBudget } from "./budget.ts";
import { normalizeCriteria } from "./criteria.ts";
import { complete } from "./llm/index.ts";
import { offlineBudgetRationale, offlineDraftRole, offlinePipelineSummary } from "./offline.ts";
import { prompt } from "./prompts.ts";
import { reviewSubmissionDetailed } from "./review.ts";

export { providerLabel } from "./llm/index.ts";
export type { ReviewDetails, ReviewEngine } from "./review.ts";
export { defaultReviewEngine, reviewSubmissionDetailed } from "./review.ts";

const DraftOutput = z.object({ title: z.string(), summary: z.string(), criteria: Criteria });
const RationaleOutput = z.object({ rationale: z.string() });
const SummaryOutput = z.object({ summary: z.string() });

const usdc = (base: bigint) => fromBaseUnits(base).toLocaleString("en-US", { maximumFractionDigits: 2 });

export async function draftRole(
	jobDescription: string,
): Promise<{ title: string; summary: string; criteria: Criteria }> {
	const draft = await complete({
		system: prompt("system"),
		prompt: prompt("draft-role", { jobDescription }),
		schema: DraftOutput,
		schemaName: "role_draft",
		offline: () => offlineDraftRole(jobDescription),
	});
	return { ...draft, criteria: normalizeCriteria(draft.criteria) };
}

export async function suggestBudget(
	criteria: Criteria,
	context: { title?: string } = {},
): Promise<{ bounty: bigint; maxCandidates: number; rationale: string }> {
	const numbers = computeBudget(criteria);
	const title = context.title ?? "This role";
	const { rationale } = await complete({
		system: prompt("system"),
		prompt: prompt("budget-rationale", {
			title,
			seniority: criteria.seniority,
			mustHave: criteria.mustHave.map((c) => c.label).join("; ") || "none listed",
			location: [criteria.location.mode, ...criteria.location.places].join(", "),
			languages: criteria.languages.join(", ") || "English",
			salary: criteria.salaryRange
				? `${criteria.salaryRange.min}-${criteria.salaryRange.max} ${criteria.salaryRange.currency} per ${criteria.salaryRange.period.toLowerCase()}`
				: "not stated",
			rarity: numbers.rarity.toFixed(2),
			bounty: numbers.bountyUsdc,
			maxCandidates: numbers.maxCandidates,
			total: numbers.bountyUsdc * numbers.maxCandidates,
		}),
		schema: RationaleOutput,
		schemaName: "budget_rationale",
		offline: () => ({
			rationale: offlineBudgetRationale({ title, seniority: criteria.seniority, ...numbers }),
		}),
	});
	return { bounty: numbers.bounty, maxCandidates: numbers.maxCandidates, rationale };
}

/** Scores a scout's candidate. Engine per REVIEW_ENGINE (default: Jev), see review.ts. */
export async function reviewSubmission(
	criteria: Criteria,
	candidate: { name: string; profileUrl: string; notes: string },
): Promise<AgentReview> {
	return (await reviewSubmissionDetailed(criteria, candidate)).review;
}

export interface PipelineInput {
	title: string;
	bounty: bigint;
	deposited: bigint;
	paid: bigint;
	remaining: bigint;
	maxCandidates: number;
	acceptedCount: number;
	pendingCount: number;
	rejectedCount: number;
	recentReviews: AgentReview[];
}

export async function pipelineSummary(input: PipelineInput): Promise<string> {
	const coverable = input.bounty > 0n ? Number(input.remaining / input.bounty) : 0;
	const scores = input.recentReviews.map((r) => r.score);
	const averageScore = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
	const { summary } = await complete({
		system: prompt("system"),
		prompt: prompt("pipeline-summary", {
			title: input.title,
			bounty: usdc(input.bounty),
			deposited: usdc(input.deposited),
			paid: usdc(input.paid),
			remaining: usdc(input.remaining),
			maxCandidates: input.maxCandidates,
			acceptedCount: input.acceptedCount,
			pendingCount: input.pendingCount,
			rejectedCount: input.rejectedCount,
			coverable,
			reviews: input.recentReviews.map((r) => `${r.score} ${r.recommendation}`).join(", ") || "none yet",
		}),
		schema: SummaryOutput,
		schemaName: "pipeline_summary",
		offline: () => ({
			summary: offlinePipelineSummary({
				...input,
				bountyUsdc: fromBaseUnits(input.bounty),
				remainingUsdc: fromBaseUnits(input.remaining),
				coverable,
				averageScore,
			}),
		}),
	});
	return summary;
}

/**
 * Whether a role's task should be visible to scouts: open, with the on-chain vault holding at
 * least one bounty and slots left. Pure; the caller supplies on-chain numbers.
 */
export function publishTask(role: {
	status: "DRAFT" | "OPEN" | "CLOSED";
	vaultBalance: bigint;
	bounty: bigint;
	maxCandidates: number;
	acceptedCount: number;
	pendingCount: number;
}): { publish: boolean; reason: string } {
	if (role.status === "CLOSED") return { publish: false, reason: "Role is closed." };
	if (role.status === "DRAFT") return { publish: false, reason: "Vault not funded on-chain yet." };
	if (role.acceptedCount + role.pendingCount >= role.maxCandidates)
		return { publish: false, reason: "All candidate slots are taken." };
	if (role.vaultBalance < role.bounty * BigInt(role.pendingCount + 1))
		return { publish: false, reason: "Budget is used up; top up to reopen." };
	return { publish: true, reason: "Funded and open for scouts." };
}

export type { BudgetNumbers } from "./budget.ts";
export { computeBudget, rarityFactor } from "./budget.ts";
export { computeScore, recommend } from "./scoring.ts";
