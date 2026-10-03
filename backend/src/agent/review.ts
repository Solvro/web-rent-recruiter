/**
 * Candidate review engines. All produce verdicts; the score and recommendation are always
 * computed in code (scoring.ts), so engines only differ in how evidence is judged.
 *
 *   jev     – Jev System One: two Nouls + one evidence Choice per criterion, one request (~0.7 s).
 *   llm     – the configured LLM judges every criterion with written reasoning (~8-10 s).
 *   offline – keyword heuristics, no network.
 *
 * REVIEW_ENGINE picks the first engine; on error it falls through jev → llm → offline.
 */
import { AgentReview, type Criteria, CriterionVerdict } from "@scout/shared";
import { z } from "zod";
import { askJev, type JevAnswer, type JevQuestion, jevKey, noulOf } from "./jev.ts";
import { complete, resolveProviderName } from "./llm/index.ts";
import { offlineReviewSummary, offlineVerdicts } from "./offline.ts";
import { prompt } from "./prompts.ts";
import {
	allCriteria,
	computeScore,
	type KindedCriterion,
	normalizeVerdicts,
	recommend,
	type Verdict,
	type VerdictValue,
} from "./scoring.ts";

export type ReviewEngine = "jev" | "llm" | "offline";
export type Candidate = { name: string; profileUrl: string; notes: string };

export interface ReviewDetails {
	review: AgentReview;
	engine: ReviewEngine;
	latencyMs: number;
	costUsd: number;
	/** Jev only: raw probabilities per criterion id, for debugging and threshold tuning. */
	probabilities?: Record<string, { yes: number; info: number; evidence: string | null; evidenceP: number }>;
	summarySource: "llm" | "template";
}

/** Upper bound on waiting for the LLM-written summary after Jev has answered. */
export const SUMMARY_BUDGET_MS = 3000;

/**
 * Probability → verdict thresholds for Jev.
 * - `yes`  = P(criterion holds) (for deal breakers: P(the disqualifying condition applies)).
 * - `info` = P(the notes say anything about it, positive or negative).
 * MET when yes ≥ 0.75. Otherwise UNKNOWN when info < 0.4 (the notes are silent),
 * NOT_MET when yes ≤ 0.3, and PARTIAL in between (some evidence, not conclusive).
 */
export const JEV_THRESHOLDS = { met: 0.75, notMet: 0.3, info: 0.4, evidence: 0.5 } as const;

export function verdictFromProbabilities(yes: number, info: number): VerdictValue {
	if (yes >= JEV_THRESHOLDS.met) return "MET";
	if (info < JEV_THRESHOLDS.info) return "UNKNOWN";
	if (yes <= JEV_THRESHOLDS.notMet) return "NOT_MET";
	return "PARTIAL";
}

export function defaultReviewEngine(env: NodeJS.ProcessEnv = process.env): ReviewEngine {
	const explicit = env.REVIEW_ENGINE?.toLowerCase();
	if (explicit === "jev" || explicit === "llm" || explicit === "offline") return explicit;
	if (env.JEV_API_KEY) return "jev";
	return resolveProviderName(env) === "offline" ? "offline" : "llm";
}

/** Splits notes into sentence-sized lines (l1, l2, …) for the evidence Choice. */
export function noteLines(notes: string): string[] {
	return notes
		.split(/\n+|(?<!\b(?:e\.g|i\.e|etc|vs|approx|incl|Mr|Ms|Dr|Jr|Sr|St)\.)(?<=[.!?])\s+(?=[A-Z0-9"(])/)
		.map((line) => line.trim())
		.filter((line) => line.length > 1)
		.slice(0, 60);
}

function jevQuestions(criteria: KindedCriterion[], lineIds: string[]): Record<string, JevQuestion> {
	const questions: Record<string, JevQuestion> = {};
	const lineOptions = { ...Object.fromEntries(lineIds.map((id) => [id, null])), none: "No line is relevant" };
	for (const c of criteria) {
		questions[`${c.id}__yes`] =
			c.kind === "dealBreaker"
				? {
						type: "noul",
						instructions: `Does this disqualifying condition apply to the candidate: "${c.label}"?`,
						criteria: {
							true: "The notes show the condition applies to the candidate",
							false: "The notes show it does not apply, or say nothing about it",
						},
					}
				: {
						type: "noul",
						instructions: `Does the candidate meet this requirement: "${c.label}"?`,
						criteria: {
							true: "The notes show the candidate fully meets it",
							false:
								"The notes show the candidate does not meet it, meets it only partly, or say nothing about it",
						},
					};
		questions[`${c.id}__info`] = {
			type: "noul",
			instructions: `Do the scout's notes say anything about whether the candidate has "${c.label}"?`,
			criteria: {
				true: "The notes mention it or clearly imply the answer, positive or negative",
				false: "The notes are silent on it",
			},
		};
		questions[`${c.id}__ev`] = {
			type: "choice",
			instructions: `Which line of the scout's notes is the best evidence about "${c.label}"?`,
			criteria: lineOptions,
		};
	}
	return questions;
}

const MAX_QUOTE = 120;
const quote = (line: string) => {
	if (line.length <= MAX_QUOTE) return `"${line}"`;
	const cut = line.slice(0, MAX_QUOTE);
	return `"${cut.slice(0, cut.lastIndexOf(" ")).replace(/[,;:(]+$/, "")}…"`;
};

/** The evidence line Jev picked, quoted; a short template when there is none. */
function jevReasoning(verdict: VerdictValue, evidence: string | null): string {
	if (verdict === "UNKNOWN") return "The notes don't mention this; worth asking in a first call.";
	if (evidence) return quote(evidence);
	return verdict === "MET" ? "Implied by the notes overall." : "Not supported by the notes.";
}

async function jevVerdicts(criteria: Criteria, candidate: Candidate) {
	const kinded = allCriteria(criteria);
	const lines = noteLines(candidate.notes);
	const lineIds = lines.map((_, i) => `l${i + 1}`);
	const state = {
		role: roleContext(criteria),
		candidate: {
			profile: candidate.profileUrl,
			notes: Object.fromEntries(lines.map((line, i) => [lineIds[i], line])),
		},
	};
	const result = await askJev(state, jevQuestions(kinded, lineIds));
	const probabilities: NonNullable<ReviewDetails["probabilities"]> = {};
	const verdicts: Verdict[] = kinded.map((c) => {
		const yes = noulOf(result.answers[`${c.id}__yes`]);
		const info = noulOf(result.answers[`${c.id}__info`]);
		if (yes === null || info === null) throw new Error(`Jev answer missing for ${c.id}`);
		const ev = result.answers[`${c.id}__ev`] as Extract<JevAnswer, { type: "choice" }> | undefined;
		const evidenceId = ev && ev.choice !== "none" ? ev.choice : null;
		const evidenceP = evidenceId ? (ev?.probabilities[evidenceId] ?? 0) : 0;
		const evidence =
			evidenceId && evidenceP >= JEV_THRESHOLDS.evidence
				? (lines[lineIds.indexOf(evidenceId)] ?? null)
				: null;
		probabilities[c.id] = { yes, info, evidence: evidenceId, evidenceP };
		const verdict = verdictFromProbabilities(yes, info);
		return { criterionId: c.id, verdict, reasoning: jevReasoning(verdict, evidence) };
	});
	return { verdicts, probabilities, costUsd: result.costUsd };
}

function roleContext(criteria: Criteria): string {
	const where = [criteria.location.mode.toLowerCase(), ...criteria.location.places].join(", ");
	return `${criteria.seniority.toLowerCase()} role, ${where}; requires ${criteria.languages.join(", ") || "English"}`;
}

const SummaryOutput = z.object({ summary: z.string() });

async function writeSummary(
	criteria: Criteria,
	candidate: Candidate,
	verdicts: Verdict[],
	meter: { costUsd: number },
): Promise<{ summary: string; source: "llm" | "template" }> {
	const template = offlineReviewSummary(criteria, verdicts);
	if (resolveProviderName() === "offline") return { summary: template, source: "template" };
	const kinds = new Map(allCriteria(criteria).map((c) => [c.id, c]));
	let usedTemplate = false;
	const { summary } = await complete({
		system: prompt("system"),
		prompt: prompt("review-summary", {
			verdicts: verdicts
				.map((v) => `${kinds.get(v.criterionId)?.label} | ${kinds.get(v.criterionId)?.kind} | ${v.verdict}`)
				.join("\n"),
			notes: candidate.notes,
		}),
		schema: SummaryOutput,
		schemaName: "review_summary",
		timeoutMs: SUMMARY_BUDGET_MS,
		fast: true,
		meter,
		offline: () => {
			usedTemplate = true;
			return { summary: template };
		},
	});
	return { summary, source: usedTemplate ? "template" : "llm" };
}

const LlmReviewOutput = z.object({ verdicts: z.array(CriterionVerdict), summary: z.string() });

async function llmReview(criteria: Criteria, candidate: Candidate, meter: { costUsd: number }) {
	const list = allCriteria(criteria)
		.map((c) => `${c.id} | ${c.kind} | ${c.weight} | ${c.label}`)
		.join("\n");
	let usedOffline = false;
	const output = await complete({
		system: prompt("system"),
		prompt: prompt("review-submission", { criteria: list, ...candidate }),
		schema: LlmReviewOutput,
		schemaName: "candidate_review",
		meter,
		offline: () => {
			usedOffline = true;
			const verdicts = offlineVerdicts(criteria, candidate.notes);
			return { verdicts, summary: offlineReviewSummary(criteria, verdicts) };
		},
	});
	return { ...output, usedOffline };
}

function finish(criteria: Criteria, verdicts: Verdict[], summary: string): AgentReview {
	const normalized = normalizeVerdicts(criteria, verdicts);
	const score = computeScore(criteria, normalized);
	return AgentReview.parse({ score, verdicts: normalized, recommendation: recommend(score), summary });
}

/** Review with engine, latency, cost and (for Jev) raw probabilities. */
export async function reviewSubmissionDetailed(
	criteria: Criteria,
	candidate: Candidate,
	engine: ReviewEngine = defaultReviewEngine(),
): Promise<ReviewDetails> {
	const started = Date.now();
	const meter = { costUsd: 0 };

	if (engine === "jev" && jevKey()) {
		try {
			const jev = await jevVerdicts(criteria, candidate);
			meter.costUsd += jev.costUsd;
			const { summary, source } = await writeSummary(criteria, candidate, jev.verdicts, meter);
			return {
				review: finish(criteria, jev.verdicts, summary),
				engine: "jev",
				latencyMs: Date.now() - started,
				costUsd: meter.costUsd,
				probabilities: jev.probabilities,
				summarySource: source,
			};
		} catch (error) {
			console.warn(
				"[agent] Jev review failed, falling back to LLM:",
				error instanceof Error ? error.message : error,
			);
		}
	}

	if (engine !== "offline" && resolveProviderName() !== "offline") {
		const output = await llmReview(criteria, candidate, meter);
		return {
			review: finish(criteria, output.verdicts, output.summary),
			engine: output.usedOffline ? "offline" : "llm",
			latencyMs: Date.now() - started,
			costUsd: meter.costUsd,
			summarySource: output.usedOffline ? "template" : "llm",
		};
	}

	const verdicts = offlineVerdicts(criteria, candidate.notes);
	return {
		review: finish(criteria, verdicts, offlineReviewSummary(criteria, verdicts)),
		engine: "offline",
		latencyMs: Date.now() - started,
		costUsd: 0,
		summarySource: "template",
	};
}
