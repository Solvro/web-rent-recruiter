import { z } from "zod";
import { complete } from "../llm/index.ts";
import { prompt } from "../prompts.ts";
import { untrusted } from "../untrusted.ts";
import type { ShortlistEntry, ShortlistInput } from "./types.ts";

/** Blend weights for `overall`; missing stages are dropped and the rest renormalized. */
export const SHORTLIST_WEIGHTS = { sourcing: 0.4, screening: 0.4, reference: 0.2 } as const;
export const LANGUAGE_FAIL_CAP = 50;

type Candidate = ShortlistInput["candidates"][number];

/** Deterministic: blend of sourcing score and call candidate-fit; rejected calls don't count as signal. */
export function overallScore(c: Candidate): number {
	const parts: [number, number][] = [[c.sourcing.score, SHORTLIST_WEIGHTS.sourcing]];
	if (c.screening && c.screening.verdict !== "REJECT")
		parts.push([c.screening.candidateFit, SHORTLIST_WEIGHTS.screening]);
	if (c.reference && c.reference.verdict !== "REJECT")
		parts.push([c.reference.candidateFit, SHORTLIST_WEIGHTS.reference]);
	const weight = parts.reduce((s, [, w]) => s + w, 0);
	const overall = Math.round(parts.reduce((s, [v, w]) => s + v * w, 0) / weight);
	// Below the required language level: still listed, but never above a borderline score.
	return c.language?.language && !c.language.language.meetsLevel
		? Math.min(overall, LANGUAGE_FAIL_CAP)
		: overall;
}

const stageOf = (c: Candidate): ShortlistEntry["stage"] =>
	c.reference && c.reference.verdict !== "REJECT"
		? "referenced"
		: c.screening && c.screening.verdict !== "REJECT"
			? "screened"
			: "sourced";
const STAGE_RANK = { referenced: 2, screened: 1, sourced: 0 } as const;

function templateSummary(c: Candidate): string {
	const parts = [c.sourcing.summary];
	if (c.screening && c.screening.verdict !== "REJECT") parts.push(c.screening.summaryForCompany);
	if (c.reference && c.reference.verdict !== "REJECT") parts.push(c.reference.summaryForCompany);
	if (c.language && c.language.verdict !== "REJECT") parts.push(c.language.summaryForCompany);
	return parts.join(" ");
}

const Output = z.object({ entries: z.array(z.object({ id: z.string(), summary: z.string() })) });

/** Ordered by stage reached (referenced > screened > sourced), then overall score. */
export async function shortlist(input: ShortlistInput): Promise<ShortlistEntry[]> {
	const ranked = input.candidates
		.map((c) => ({ c, overall: overallScore(c), stage: stageOf(c) }))
		.sort((a, b) => STAGE_RANK[b.stage] - STAGE_RANK[a.stage] || b.overall - a.overall);
	if (!ranked.length) return [];

	const { entries } = await complete({
		system: prompt("system"),
		prompt: prompt("shortlist", {
			title: input.role.title,
			candidates: untrusted(
				"pipeline_summaries",
				ranked
					.map(({ c }) =>
						[
							`id: ${c.id} (${c.name})`,
							`sourcing: ${c.sourcing.summary}`,
							c.screening ? `screening (${c.screening.verdict}): ${c.screening.summaryForCompany}` : null,
							c.reference ? `reference (${c.reference.verdict}): ${c.reference.summaryForCompany}` : null,
							c.language ? `language check (${c.language.verdict}): ${c.language.summaryForCompany}` : null,
						]
							.filter(Boolean)
							.join("\n"),
					)
					.join("\n\n"),
			),
		}),
		schema: Output,
		schemaName: "shortlist",
		timeoutMs: 20_000,
		fast: true,
		offline: () => ({ entries: ranked.map(({ c }) => ({ id: c.id, summary: templateSummary(c) })) }),
	});
	const byId = new Map(entries.map((e) => [e.id, e.summary]));
	return ranked.map(({ c, overall, stage }, i) => ({
		id: c.id,
		name: c.name,
		rank: i + 1,
		overall,
		stage,
		summary: byId.get(c.id) ?? templateSummary(c),
	}));
}
