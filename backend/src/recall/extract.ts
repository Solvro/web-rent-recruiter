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

const STOP = new Set(
	"a an and are as at be by can could did do does for from had has have how i in is it its me my of on or our so that the their them they this to was we were what when where which who why will with would you your about tell walk us give one".split(
		" ",
	),
);
const words = (t: string) =>
	new Set(
		t
			.toLowerCase()
			.split(/[^a-z0-9ąćęłńóśźż]+/)
			.filter((w) => w.length > 2 && !STOP.has(w)),
	);

/**
 * No-model fallback: each interviewer turn and the other side's reply that follows is one Q/A pair. A script
 * question gets the pair whose interviewer turn shares the most words with it (each pair used once); a question
 * no turn matches stays empty for the recruiter, rather than taking a neighbour's answer.
 */
export function offlineExtract(input: {
	questions: ScriptQuestion[];
	lines: TranscriptLine[];
}): z.infer<typeof PrefillSchema> {
	const interviewer = input.lines[0]?.speaker;
	const pairs: { asked: string; answer: string[] }[] = [];
	for (const line of input.lines) {
		if (line.speaker === interviewer) pairs.push({ asked: line.text, answer: [] });
		else pairs.at(-1)?.answer.push(line.text);
	}
	const usable = pairs
		.map((p) => ({ asked: words(p.asked), answer: p.answer.join(" ") }))
		.filter((p) => p.answer.split(/\s+/).length >= 6);
	// Best match first, so a strong match isn't taken by a weaker question earlier in the script.
	const scored = input.questions.flatMap((q, qi) => {
		const want = words(q.question);
		return usable.map((p, pi) => ({ qi, pi, score: [...want].filter((w) => p.asked.has(w)).length }));
	});
	scored.sort((a, b) => b.score - a.score);
	const byQuestion = new Map<number, number>();
	const usedPair = new Set<number>();
	for (const m of scored) {
		if (m.score < 2 || byQuestion.has(m.qi) || usedPair.has(m.pi)) continue;
		byQuestion.set(m.qi, m.pi);
		usedPair.add(m.pi);
	}
	const answers = input.questions.flatMap((q, qi) => {
		const pi = byQuestion.get(qi);
		const text = pi === undefined ? undefined : usable[pi]?.answer;
		return text ? [{ questionId: q.id, answer: text }] : [];
	});
	const answered = new Set(answers.map((a) => a.questionId));
	return {
		answers,
		recommendation: answers.length >= Math.ceil(input.questions.length * 0.75) ? "ADVANCE" : "MAYBE",
		missing: input.questions.filter((q) => !answered.has(q.id)).map((q) => q.id),
	};
}
