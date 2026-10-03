/**
 * Transcript → answers to the agent's script, so the recruiter only reviews and delivers.
 * The answers are what the candidate said, not the model's opinion; the agent judges them later in reviewScreening.
 */
import {
	type RecordingPrefill,
	RecruiterRecommendation,
	type ScriptQuestion,
	type TranscriptLine,
} from "@scout/shared";
import { z } from "zod";
import { complete } from "../agent/llm/index.ts";

const PrefillSchema = z.object({
	answers: z.array(z.object({ questionId: z.string(), answer: z.string() })),
	recommendation: RecruiterRecommendation,
	missing: z.array(z.string()),
});

export function transcriptToText(lines: TranscriptLine[]): string {
	return lines.map((l) => `${l.speaker}: ${l.text}`).join("\n");
}

export async function extractAnswers(input: {
	questions: ScriptQuestion[];
	lines: TranscriptLine[];
	candidateName?: string | null;
}): Promise<RecordingPrefill> {
	const ids = new Set(input.questions.map((q) => q.id));
	const result = await complete({
		schemaName: "screening_prefill",
		system:
			"You turn a recruiter's screening-call transcript into answers for a fixed question script. " +
			"For each question, write 1-3 sentences in third person with the concrete facts the candidate said " +
			"(numbers, names, dates). Never invent facts. If the call didn't cover a question, put its id in `missing` " +
			"and leave it out of `answers`. Then give the recruiter's likely recommendation: ADVANCE if the answers " +
			"meet the must-haves, PASS if a deal breaker came up, otherwise MAYBE.",
		prompt: [
			`Candidate: ${input.candidateName ?? "the candidate"}`,
			"Questions:",
			...input.questions.map((q) => `- ${q.id}: ${q.question}`),
			"",
			"Transcript:",
			transcriptToText(input.lines),
		].join("\n"),
		schema: PrefillSchema,
		offline: () => offlineExtract(input),
		timeoutMs: 30_000,
	});
	const answers = result.answers.filter((a) => ids.has(a.questionId) && a.answer.trim());
	const answered = new Set(answers.map((a) => a.questionId));
	return {
		answers,
		recommendation: result.recommendation,
		missing: input.questions.filter((q) => !answered.has(q.id)).map((q) => q.id),
	};
}

/**
 * No-model fallback: the recruiter speaks first; each recruiter turn followed by candidate turns is one Q/A pair,
 * assigned to the script questions in order (the script is followed in order on the call).
 */
export function offlineExtract(input: {
	questions: ScriptQuestion[];
	lines: TranscriptLine[];
}): z.infer<typeof PrefillSchema> {
	const interviewer = input.lines[0]?.speaker;
	const pairs: string[] = [];
	let current: string[] | null = null;
	for (const line of input.lines) {
		if (line.speaker === interviewer) {
			if (current?.length) pairs.push(current.join(" "));
			current = [];
		} else current?.push(line.text);
	}
	if (current?.length) pairs.push(current.join(" "));
	const substantive = pairs.filter((p) => p.split(/\s+/).length >= 6);
	const answers = input.questions.flatMap((q, i) => {
		const text = substantive[i];
		return text ? [{ questionId: q.id, answer: text }] : [];
	});
	return {
		answers,
		recommendation: answers.length >= Math.ceil(input.questions.length * 0.75) ? "ADVANCE" : "MAYBE",
		missing: input.questions.slice(answers.length).map((q) => q.id),
	};
}
