/**
 * Deterministic stand-in for the backend AI agent, so the demo is clickable offline.
 * The real agent lives in backend/src/agent and returns the same shapes.
 */
import type { AgentReview, Criteria } from "@scout/shared";
import { toBaseUnits } from "@scout/shared";
import { offlineDraftRole, offlineVerdicts } from "../../../../packages/agent/src/offline";
import { computeScore, recommend } from "../../../../packages/agent/src/scoring";
import demo from "./demo-data.json";

/** The draft from the pasted text itself (the backend's offline parser): title, company, requirement bullets. */
export function draftRole(jobDescription: string) {
	const d = offlineDraftRole(jobDescription);
	// The example posting is the demo fixture: use its hand-written criteria, so the demo story lines up.
	const example = demo.roles.find((r) => r.demo);
	const isExample = !!example && jobDescription.trim() === example.jobDescription.trim();
	const criteria = isExample ? (example.criteria as Criteria) : d.criteria;
	if (isExample) {
		d.title = example.title;
		d.company = example.company ?? d.company;
	}
	const base = { JUNIOR: 10, MID: 15, SENIOR: 20, STAFF: 30, PRINCIPAL: 40, EXECUTIVE: 60 }[
		criteria.seniority
	];
	const rare = /\b(rust|solana|anchor|machine learning|ml)\b/i.test(jobDescription);
	const bounty = base + (rare ? 5 : 0);
	const maxCandidates = ["STAFF", "PRINCIPAL", "EXECUTIVE"].includes(criteria.seniority) ? 8 : 10;
	const rationale = `The price follows the seniority and how hard these people are to reach${rare ? " (this skill set is rare)" : ""}. For comparison, an agency usually charges 15–25% of a year's salary for one hire.`;
	return {
		title: d.title,
		company: d.company,
		summary: d.summary,
		criteria,
		suggestedBounty: toBaseUnits(bounty).toString(),
		suggestedMaxCandidates: maxCandidates,
		rationale,
	};
}

const NEGATION = /\b(no|not|never|hasn't|haven't|hasnt|havent|without|isn't|wasn't|lacks?|yet to|zero)\b/i;
const STEM_STOP = new Set([
	"with",
	"and",
	"the",
	"for",
	"years",
	"year",
	"experience",
	"or",
	"of",
	"in",
	"on",
	"a",
	"an",
	"to",
]);
const stems = (t: string) =>
	t
		.toLowerCase()
		.split(/[^a-z0-9+#]+/)
		.filter((w) => w.length > 2 && !STEM_STOP.has(w))
		.map((w) => w.replace(/(ing|ed|es|s)$/, ""));

/** The note's sentence that best covers a criterion, with how many of its words it shares. */
function bestSentence(label: string, notes: string) {
	const want = new Set(stems(label));
	let best = { text: "", hits: 0 };
	for (const sentence of notes.split(/(?<=[.!?;])\s+/)) {
		const have = new Set(stems(sentence));
		const hits = [...want].filter((w) => have.has(w)).length;
		if (hits > best.hits) best = { text: sentence.trim(), hits };
	}
	return { ...best, of: want.size };
}

const quote = (s: string) => `"${s.length > 140 ? `${s.slice(0, 137).trimEnd()}…` : s}"`;

/**
 * Mock review: the backend's offline verdicts, corrected for negation ("hasn't shipped a Solana program" is not
 * a yes), with the evidence quoted instead of the requirement repeated, and a summary from the must-haves.
 */
export function reviewCandidate(
	criteria: Criteria,
	candidate: { name: string; profileUrl: string; notes: string },
): AgentReview {
	const notes = candidate.notes;
	const deal = new Set(criteria.dealBreakers.map((c) => c.id));
	const all = [...criteria.mustHave, ...criteria.niceToHave, ...criteria.dealBreakers];
	const verdicts = offlineVerdicts(criteria, notes).map((v) => {
		const c = all.find((x) => x.id === v.criterionId);
		if (!c) return v;
		const s = bestSentence(c.label, notes);
		const negated = s.hits > 0 && NEGATION.test(s.text);
		if (deal.has(c.id))
			return v.verdict === "MET"
				? { ...v, reasoning: s.text ? `Note: ${quote(s.text)}` : v.reasoning }
				: { ...v, reasoning: "Nothing in the note triggers this." };
		if (negated && (v.verdict === "MET" || v.verdict === "PARTIAL"))
			return { ...v, verdict: "NOT_MET" as const, reasoning: `Note: ${quote(s.text)}` };
		if (v.verdict === "MET" || v.verdict === "PARTIAL")
			return { ...v, reasoning: s.text ? `Note: ${quote(s.text)}` : v.reasoning };
		if (v.verdict === "NOT_MET") return { ...v, reasoning: s.text ? `Note: ${quote(s.text)}` : v.reasoning };
		return { ...v, reasoning: "The note doesn't say; worth asking on a first call." };
	});
	const score = computeScore(criteria, verdicts);
	const mustIds = new Set(criteria.mustHave.map((c) => c.id));
	const must = verdicts.filter((v) => mustIds.has(v.criterionId));
	const missing = must.filter((v) => v.verdict === "NOT_MET");
	const met = must.filter((v) => v.verdict === "MET").length;
	const dealHit = verdicts.some((v) => deal.has(v.criterionId) && v.verdict === "MET");
	let recommendation = recommend(score);
	if (recommendation === "ADVANCE" && missing.length) recommendation = "MAYBE";
	const label = (id: string) => all.find((c) => c.id === id)?.label ?? id;
	const summary = dealHit
		? `${candidate.name} hits a deal-breaker for this role.`
		: met === must.length && must.length > 0
			? `${candidate.name} meets all ${must.length} must-haves.`
			: `${candidate.name} meets ${met} of ${must.length} must-haves${missing.length ? `; missing: ${missing.map((v) => label(v.criterionId)).join(", ")}` : ""}.`;
	return { score, verdicts, recommendation, summary };
}
