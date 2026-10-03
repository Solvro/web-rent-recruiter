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

const LANGUAGE_WORDS =
	/^(?:fluent|excellent|strong|native|professional|business|written|spoken)?\s*(english|polish|german|french|spanish|italian|dutch|ukrainian|czech|portuguese)\b/i;
const PAST_VERB =
	/^(shipped|built|led|designed|ran|owned|launched|managed|delivered|created|developed|implemented|scaled|migrated|maintained|grew|sold|closed)\s+(.*)$/i;

/** Lowercase a leading common word ("Program security" → "program security"), not names ("Customer Success", "Rust"). */
const softLower = (t: string) => {
	const [first = "", second = ""] = t.split(" ");
	const capitalizedPhrase = /^[A-Z]/.test(second);
	const name =
		/^(Rust|Go|Python|Java|Solana|English|Polish|German|Figma|React|Kubernetes|Salesforce|HubSpot)$/.test(
			first,
		);
	return /^[A-Z][a-z]+$/.test(first) && !capitalizedPhrase && !name ? lower(t) : t;
};

const ADJECTIVE =
	/^(hands-on|solid|strong|deep|proven|professional|excellent|good|great|demonstrated|extensive|previous|prior|relevant)\s+/i;
const FIELD =
	/\b(success|management|sales|consulting|marketing|support|operations|recruiting|finance|accounting|design)\b/i;

/** The thing a requirement is about: "4+ years of production Rust" → "production Rust". */
export function topicOf(label: string, keepParen = false): string {
	let t = label.replace(/…$/, "").trim();
	let paren = t.match(/\s*(\([^)]*\))/)?.[1] ?? "";
	t = t.replace(/\s*\([^)]*\)/g, "").trim();
	const colon = t.indexOf(":");
	if (colon > 0) {
		paren ||= `(${t.slice(colon + 1).trim()})`;
		t = t.slice(0, colon).trim();
	}
	t = t.replace(/^\d+\s*\+?\s*(?:years?|yrs)\s+(?:of\s+|in\s+(?:an?\s+)?)?/i, "");
	t = t.replace(ADJECTIVE, "");
	t = t.replace(
		/^(?:work\s+)?(experience|background|knowledge|familiarity|proficiency)\s+(?:working\s+)?(with|in|of)\s+/i,
		"",
	);
	t = t.replace(/\s+(experience|background)$/i, "");
	t = softLower(t.trim());
	return keepParen && paren ? `${t} ${paren}` : t;
}

/** A natural question a recruiter can read out loud, written from the requirement's shape. */
export function requirementQuestion(label: string): { question: string; whatGoodLooksLike: string } {
	const clean = label.replace(/…$/, "").trim();
	const years = clean.match(/^(\d+)\s*\+?\s*(?:years?|yrs)\b/i);
	const language = clean.match(LANGUAGE_WORDS);
	const verb = clean.match(PAST_VERB);
	const topic = topicOf(clean);
	if (language) {
		const lang = language[1].charAt(0).toUpperCase() + language[1].slice(1).toLowerCase();
		return {
			question: `How do you use ${lang} at work today, for example in meetings, writing or with customers?`,
			whatGoodLooksLike: `Concrete situations where they work in ${lang} and how comfortable they are.`,
		};
	}
	if (years) {
		const preposition = FIELD.test(topic) ? "in" : "with";
		return {
			question: `How long have you worked ${preposition} ${topic}, and what's one piece of that work you're proud of?`,
			whatGoodLooksLike: `At least ${years[1]} years ${preposition} ${topic}, and one specific piece of work with their own part and the result.`,
		};
	}
	if (verb) {
		return {
			question: `Can you tell me about a time you ${verb[1].toLowerCase()} ${topicOf(verb[2] ?? "")}? What was it, and what was your part?`,
			whatGoodLooksLike: `A specific example (what, when, scale) with what the candidate personally did.`,
		};
	}
	if (/\b(skills?|abilit(y|ies)|comfort)\b/i.test(clean)) {
		return {
			question: `Can you give me a concrete example from your work that shows your ${topic}?`,
			whatGoodLooksLike: `A specific situation showing ${topic}, with what they did and the result.`,
		};
	}
	return {
		question: `What's your experience with ${topicOf(clean, true)}? Could you walk me through one concrete example?`,
		whatGoodLooksLike: `A specific example involving ${topic}: what it was, their own part, and the outcome.`,
	};
}

function templateQuestion(slot: Slot, name: string): Omit<ScriptQuestion, "id" | "criterionId"> {
	switch (slot.kind) {
		case "mustHave":
		case "niceToHave":
			return requirementQuestion(slot.label);
		case "dealBreaker":
			return {
				question: `One quick check so I describe you correctly: does "${slot.label}" apply to you?`,
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
	const topic = topicOf(slot.label);
	switch (slot.id) {
		case "ref-relationship":
			return {
				question: `How do you know ${name}, for how long, and what was your working relationship?`,
				whatGoodLooksLike:
					"Company, period, and whether they managed, were managed by or worked alongside the candidate.",
			};
		case "ref-strength":
			return {
				question: `Can you describe a piece of ${name}'s work involving ${topic}, and what they did themselves?`,
				whatGoodLooksLike: `A specific piece of work involving ${topic}, with what the candidate personally did and the result.`,
			};
		case "ref-verify":
			return {
				question: `${name}'s profile mentions “${slot.label}”. Can you confirm that, and what was their part in it?`,
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
