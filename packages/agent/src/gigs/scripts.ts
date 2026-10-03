/**
 * Question scripts for screening and reference calls. Code decides which questions exist
 * (stable ids tied to criteria); the LLM only words them. Offline templates keep it working.
 */
import type { AgentReview, Criteria, Criterion } from "@scout/shared";
import { z } from "zod";
import { complete } from "../llm/index.ts";
import { prompt } from "../prompts.ts";
import { untrusted } from "../untrusted.ts";
import type { CallScript, ScriptCandidate, ScriptQuestion } from "./types.ts";

export const SCREENING_MIN_QUESTIONS = 6;
export const SCREENING_MAX_QUESTIONS = 8;
const MAX_MUST_HAVE_QUESTIONS = 5;
const MAX_DEAL_BREAKER_QUESTIONS = 2;

interface Slot {
	id: string;
	kind: "mustHave" | "niceToHave" | "dealBreaker" | "motivation" | "logistics" | "reference";
	label: string;
	criterionId?: string;
	/** What the sourcing review already knows, so the question can dig where it's thin. */
	known?: string;
}

const Worded = z.object({
	questions: z.array(z.object({ id: z.string(), question: z.string(), whatGoodLooksLike: z.string() })),
});

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

function templateQuestion(slot: Slot, name: string): Omit<ScriptQuestion, "id" | "criterionId"> {
	const label = lower(slot.label);
	switch (slot.kind) {
		case "mustHave":
		case "niceToHave":
			return {
				question: `Tell me about a recent project where you used ${label}. What did you build, and what part was yours?`,
				whatGoodLooksLike: `A specific project with ${label}: what was built, the candidate's own role, scale or numbers, and the outcome.`,
			};
		case "dealBreaker":
			return {
				question: `Quick check, does this apply to you: ${label}?`,
				whatGoodLooksLike: `A clear yes or no in the candidate's words, with any detail that matters (dates, conditions).`,
			};
		case "motivation":
			return {
				question: `Why are you open to a move now, and what would make this role a clear yes for you?`,
				whatGoodLooksLike: `A concrete reason to move and what they want next, in their own words, not "new challenges".`,
			};
		case "logistics":
			return {
				question: `What's your notice period, and what compensation range are you looking for?`,
				whatGoodLooksLike: `A notice period in weeks or months and a salary range with currency and contract type.`,
			};
		case "reference":
			return referenceTemplate(slot, name);
	}
}

function referenceTemplate(slot: Slot, name: string): Omit<ScriptQuestion, "id" | "criterionId"> {
	const label = lower(slot.label);
	switch (slot.id) {
		case "ref-relationship":
			return {
				question: `How do you know ${name}, for how long, and what was your working relationship?`,
				whatGoodLooksLike:
					"Company, period, and whether they managed, were managed by or worked alongside the candidate.",
			};
		case "ref-strength":
			return {
				question: `Can you give an example of ${name}'s work on ${label}?`,
				whatGoodLooksLike: `A specific piece of work involving ${label}, with what the candidate personally did and the result.`,
			};
		case "ref-verify":
			return {
				question: `${name} mentioned ${label}. Can you confirm that, and what was their part in it?`,
				whatGoodLooksLike:
					"Confirms or corrects the claim with details only someone who was there would know.",
			};
		case "ref-growth":
			return {
				question: `Where did ${name} need the most support, and how did they handle feedback?`,
				whatGoodLooksLike: "A real development area with an example, not a disguised strength.",
			};
		default:
			return {
				question: `Would you hire or work with ${name} again? Why or why not?`,
				whatGoodLooksLike: "A clear answer with a reason; hesitation or qualifiers are worth noting.",
			};
	}
}

const unclear = (review: AgentReview | undefined, id: string) => {
	const verdict = review?.verdicts.find((v) => v.criterionId === id)?.verdict;
	return verdict === "UNKNOWN" || verdict === "PARTIAL";
};

function knownFrom(review: AgentReview | undefined, id: string): string | undefined {
	const v = review?.verdicts.find((x) => x.criterionId === id);
	return v ? `${v.verdict}: ${v.reasoning}` : undefined;
}

/** Deterministic question slots for a screening call: 6-8, must-haves first (unclear ones first). */
export function screeningSlots(criteria: Criteria, review?: AgentReview): Slot[] {
	const byPriority = (list: Criterion[]) =>
		[...list].sort(
			(a, b) => Number(unclear(review, b.id)) - Number(unclear(review, a.id)) || b.weight - a.weight,
		);
	const slot =
		(kind: Slot["kind"]) =>
		(c: Criterion): Slot => ({
			id: `q-${c.id}`,
			kind,
			label: c.label,
			criterionId: c.id,
			known: knownFrom(review, c.id),
		});
	const slots: Slot[] = [
		...byPriority(criteria.mustHave).slice(0, MAX_MUST_HAVE_QUESTIONS).map(slot("mustHave")),
		...criteria.dealBreakers.slice(0, MAX_DEAL_BREAKER_QUESTIONS).map(slot("dealBreaker")),
		{ id: "q-motivation", kind: "motivation", label: "Motivation to move" },
	];
	for (const nice of byPriority(criteria.niceToHave)) {
		if (slots.length >= SCREENING_MIN_QUESTIONS - 1) break;
		slots.push(slot("niceToHave")(nice));
	}
	if (slots.length < SCREENING_MAX_QUESTIONS) {
		slots.push({ id: "q-logistics", kind: "logistics", label: "Notice period and compensation" });
	}
	return slots.slice(0, SCREENING_MAX_QUESTIONS);
}

/** Five reference questions; strength/verify are tied to the top two must-haves. */
export function referenceSlots(criteria: Criteria): Slot[] {
	const [first, second] = [...criteria.mustHave].sort((a, b) => b.weight - a.weight);
	return [
		{ id: "ref-relationship", kind: "reference", label: "Working relationship" },
		{
			id: "ref-strength",
			kind: "reference",
			label: first?.label ?? "their core skills",
			criterionId: first?.id,
		},
		{
			id: "ref-verify",
			kind: "reference",
			label: second?.label ?? first?.label ?? "their main project",
			criterionId: second?.id ?? first?.id,
		},
		{ id: "ref-growth", kind: "reference", label: "Development areas" },
		{ id: "ref-rehire", kind: "reference", label: "Would hire again" },
	];
}

async function wordScript(
	kind: CallScript["kind"],
	slots: Slot[],
	criteria: Criteria,
	candidate: ScriptCandidate,
): Promise<CallScript> {
	const templates = new Map(slots.map((s) => [s.id, templateQuestion(s, candidate.name)]));
	const wording = (id: string) => templates.get(id) ?? { question: "", whatGoodLooksLike: "" };
	const worded = await complete({
		system: prompt("system"),
		prompt: prompt(kind === "screening" ? "screening-script" : "reference-script", {
			name: candidate.name,
			seniority: criteria.seniority.toLowerCase(),
			notes: untrusted("candidate_notes", candidate.notes),
			slots: slots
				.map((s) => `${s.id} | ${s.kind} | ${s.label}${s.known ? ` | known: ${s.known}` : ""}`)
				.join("\n"),
		}),
		schema: Worded,
		schemaName: `${kind}_script`,
		offline: () => ({ questions: slots.map((s) => ({ id: s.id, ...wording(s.id) })) }),
	});
	const byId = new Map(worded.questions.map((q) => [q.id, q]));
	return {
		kind,
		candidate: { name: candidate.name, profileUrl: candidate.profileUrl, notes: candidate.notes },
		questions: slots.map((s) => {
			const q = byId.get(s.id) ?? wording(s.id);
			return {
				id: s.id,
				question: q.question.trim(),
				whatGoodLooksLike: q.whatGoodLooksLike.trim(),
				...(s.criterionId ? { criterionId: s.criterionId } : {}),
			};
		}),
	};
}

export function screeningScript(input: {
	criteria: Criteria;
	candidate: ScriptCandidate & { review?: AgentReview };
}): Promise<CallScript> {
	return wordScript(
		"screening",
		screeningSlots(input.criteria, input.candidate.review),
		input.criteria,
		input.candidate,
	);
}

export function referenceScript(input: {
	criteria: Criteria;
	candidate: ScriptCandidate;
}): Promise<CallScript> {
	return wordScript("reference", referenceSlots(input.criteria), input.criteria, input.candidate);
}
