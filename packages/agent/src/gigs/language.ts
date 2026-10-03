/**
 * Language checks: a short call in the language the role requires, judged on the CEFR scale.
 * The script is deterministic (no LLM): five prompts that let a native-speaking recruiter hear
 * the candidate's range from small talk up to explaining their own work.
 */
import type { Criteria } from "@scout/shared";
import type { CallScript, CefrLevel, ScriptCandidate, ScriptQuestion } from "./types.ts";

const LEVEL = /\b([ABC][12])\b/i;
const NATIVE = /\b(native|mother tongue)\b/i;
const FLUENT = /\b(fluent|business|professional|full professional)\b/i;

/**
 * The language the role wants checked, with its CEFR level. Reads `criteria.languages`
 * ("German", "German (C1)", "Fluent German"), defaulting to B2. Plain "English" is assumed for
 * every role and not checked; English with an explicit level ("English (C1)") is.
 */
export function requiredLanguage(criteria: Criteria): { name: string; level: CefrLevel } | null {
	for (const raw of criteria.languages) {
		const name = raw
			.replace(/\(.*?\)/g, "")
			.replace(LEVEL, "")
			.replace(/\b(native|fluent|business|professional|full|level|mother tongue)\b/gi, "")
			.replace(/[^\p{L}\s-]/gu, "")
			.trim();
		const explicit = raw.match(LEVEL)?.[1]?.toUpperCase() as CefrLevel | undefined;
		if (!name || (/^english$/i.test(name) && !explicit)) continue;
		const level: CefrLevel = explicit ?? (NATIVE.test(raw) ? "C2" : FLUENT.test(raw) ? "C1" : "B2");
		return { name: name.charAt(0).toUpperCase() + name.slice(1), level };
	}
	return null;
}

/** What a passing answer sounds like at each level, for the rubric. */
const RUBRIC: Record<CefrLevel, string> = {
	A1: "Understandable words and memorized phrases.",
	A2: "Short, simple sentences about familiar things; the meaning gets across.",
	B1: "Connected, simple speech about their own experience; can keep going despite gaps.",
	B2: "Fluent, spontaneous answers on work topics; errors don't get in the way of meaning.",
	C1: "Precise and fluent on complex topics, with good structure; rare errors they correct themselves.",
	C2: "Effortless and nuanced, close to a native speaker.",
};

/** Five prompts, easiest first. The recruiter runs the call in the target language. */
export function languageScript(input: {
	language: string;
	level: CefrLevel;
	criteria?: Criteria;
	candidate: ScriptCandidate;
}): CallScript {
	const { language, level } = input;
	const bar = RUBRIC[level];
	const questions: ScriptQuestion[] = [
		{
			id: "lang-intro",
			question: `(In ${language}) Could you introduce yourself and tell me what you do today?`,
			whatGoodLooksLike: `A natural self-introduction in ${language}. For ${level}: ${bar}`,
		},
		{
			id: "lang-project",
			question: `Could you describe a recent project you're proud of, and what your own part in it was?`,
			whatGoodLooksLike: `A connected story with past tenses and some detail (what, why, result). For ${level}: ${bar}`,
		},
		{
			id: "lang-explain",
			question: `Could you explain something from your own work, something you built or rely on every day, to someone non-technical?`,
			whatGoodLooksLike: `A clear explanation that reformulates when needed, not just jargon. For ${level}: ${bar}`,
		},
		{
			id: "lang-scenario",
			question: `Imagine a colleague disagrees with your technical decision in a meeting. How would you respond?`,
			whatGoodLooksLike: `Handles a hypothetical (conditionals, polite disagreement) without switching to English. For ${level}: ${bar}`,
		},
		{
			id: "lang-question",
			question: `What would you like to know about the role or the team?`,
			whatGoodLooksLike: `Forms their own questions and follows the answer. For ${level}: ${bar}`,
		},
	];
	return {
		kind: "language",
		language: { name: language, level },
		candidate: {
			name: input.candidate.name,
			profileUrl: input.candidate.profileUrl,
			notes: input.candidate.notes,
		},
		questions,
	};
}
