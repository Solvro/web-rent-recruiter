/**
 * Deterministic stand-ins for every LLM call. Used when no API key is configured and as the
 * fallback when a provider fails, so the product keeps working without a network.
 */
import type { Criteria, Criterion } from "@scout/shared";
import { normalizeCriteria } from "./criteria.ts";
import { allCriteria, type KindedCriterion, type Verdict } from "./scoring.ts";

// ---- Draft criteria from a job description --------------------------------

const BULLET = /^\s*(?:[-*•▪◦]|\d+[.)])\s+(.*)$/;
const MUST_HEADING =
	/(requirement|must|you have|you bring|looking for|qualification|what you need|about you|we expect)/i;
const NICE_HEADING = /(nice to have|nice-to-have|bonus|plus|preferred|great if|extra points)/i;
const OTHER_HEADING = /(we offer|benefits|perks|about us|responsibilit|what you.ll do|your role|the team)/i;

const CITIES = [
	"Warsaw",
	"Kraków",
	"Krakow",
	"Wrocław",
	"Wroclaw",
	"Gdańsk",
	"Gdansk",
	"Poznań",
	"Berlin",
	"London",
	"Amsterdam",
	"Lisbon",
	"Paris",
	"Prague",
	"Barcelona",
	"Europe",
	"EU",
	"CET",
	"Poland",
];
const LANGUAGES = ["English", "Polish", "German", "French", "Spanish", "Dutch", "Ukrainian"];

/** First clause of a bullet, at most ~10 words: "Shipped Solana programs to mainnet (Anchor…)" -> "Shipped Solana programs to mainnet". */
const shortLabel = (text: string) => {
	const clean = text
		.replace(/\s+/g, " ")
		.replace(/[.;:]+$/, "")
		.trim();
	const clause = clean.split(/,|\(| - | – /)[0].trim();
	const words = (clause.split(" ").length >= 3 ? clause : clean).split(" ");
	return words.length > 10 ? `${words.slice(0, 10).join(" ")}…` : words.join(" ");
};

function detectSeniority(text: string): Criteria["seniority"] {
	if (/\b(head of|director|vp|vice president|cto|chief)\b/i.test(text)) return "EXECUTIVE";
	if (/\bprincipal\b/i.test(text)) return "PRINCIPAL";
	if (/\b(staff|lead|founding)\b/i.test(text)) return "STAFF";
	if (/\b(senior|sr\.?)\b/i.test(text)) return "SENIOR";
	if (/\b(junior|jr\.?|intern|graduate)\b/i.test(text)) return "JUNIOR";
	const years = [...text.matchAll(/(\d+)\s*\+?\s*(?:years|yrs)/gi)].map((m) => Number(m[1]));
	const max = years.length ? Math.max(...years) : 0;
	if (max >= 7) return "STAFF";
	if (max >= 5) return "SENIOR";
	return "MID";
}

const SALARY_RANGE =
	/(PLN|EUR|USD|GBP|€|\$|£)?\s*(\d[\d\s,.]*k?)\s*(?:-|–|—|to)\s*(\d[\d\s,.]*k?)\s*(PLN|EUR|USD|GBP|zł|€|\$|£)?([^\n]*)/gi;

function detectSalary(text: string): Criteria["salaryRange"] {
	const num = (s: string) => {
		const k = /k\s*$/i.test(s);
		const n = Number(s.replace(/[^\d.]/g, ""));
		return k ? n * 1000 : n;
	};
	for (const match of text.matchAll(SALARY_RANGE)) {
		const min = num(match[2]);
		const max = num(match[3]);
		if (!min || !max || max < min || max < 1000) continue;
		const symbol = (match[1] ?? match[4] ?? "").toUpperCase();
		const currency =
			{ "€": "EUR", $: "USD", "£": "GBP", ZŁ: "PLN" }[symbol] ?? (symbol.length === 3 ? symbol : "PLN");
		const period = /(month|monthly|\/mo|miesi)/i.test(match[5]) || max < 60000 ? "MONTH" : "YEAR";
		return { min, max, currency, period };
	}
	return null;
}

export function offlineDraftRole(jobDescription: string): {
	title: string;
	summary: string;
	criteria: Criteria;
} {
	const lines = jobDescription.split(/\r?\n/);
	const title =
		lines
			.map((l) => l.replace(/^#+\s*|^(job )?title:\s*/i, "").trim())
			.find((l) => l.length > 0 && l.length < 90) ?? "Open role";

	const must: string[] = [];
	const nice: string[] = [];
	const loose: string[] = [];
	let section: "must" | "nice" | "other" | null = null;
	for (const line of lines) {
		const bullet = line.match(BULLET);
		if (!bullet) {
			if (NICE_HEADING.test(line)) section = "nice";
			else if (MUST_HEADING.test(line)) section = "must";
			else if (OTHER_HEADING.test(line)) section = "other";
			continue;
		}
		const item = bullet[1].trim();
		if (section === "must") must.push(item);
		else if (section === "nice") nice.push(item);
		else if (section === null) loose.push(item);
	}
	const mustItems = (must.length ? must : loose).slice(0, 6);
	const toCriterion = (weightFor: (i: number) => number) => (text: string, i: number) => ({
		id: "",
		label: shortLabel(text),
		weight: weightFor(i),
	});

	const text = jobDescription;
	const mode: Criteria["location"]["mode"] = /\bremote\b/i.test(text)
		? /\bhybrid\b/i.test(text)
			? "HYBRID"
			: "REMOTE"
		: /\bhybrid\b/i.test(text)
			? "HYBRID"
			: "ONSITE";
	const places = CITIES.filter((c) => new RegExp(`\\b${c}\\b`, "i").test(text));
	// Languages from nice-to-have bullets are differentiators, not requirements.
	const required = nice.reduce((acc, item) => acc.replace(item, ""), text);
	const languages = LANGUAGES.filter((l) => new RegExp(`\\b${l}\\b`, "i").test(required));
	const dealBreakers: Criterion[] = [];
	if (
		/(no visa sponsorship|unable to sponsor|cannot sponsor|can't sponsor|without sponsorship)/i.test(text)
	) {
		dealBreakers.push({ id: "", label: "Needs visa sponsorship", weight: 5 });
	}

	const criteria = normalizeCriteria({
		mustHave: mustItems.map(toCriterion((i) => (i < 2 ? 5 : i < 4 ? 4 : 3))),
		niceToHave: nice.slice(0, 5).map(toCriterion(() => 2)),
		seniority: detectSeniority(`${title}\n${text}`),
		location: { mode, places: [...new Set(places)] },
		salaryRange: detectSalary(text),
		languages: languages.length ? languages : ["English"],
		dealBreakers,
	});
	const top = criteria.mustHave.slice(0, 2).map((c) => c.label.toLowerCase());
	const summary = `${title} (${criteria.seniority.toLowerCase()}, ${mode.toLowerCase()}${
		places.length ? `, ${places.slice(0, 2).join("/")}` : ""
	}). Strong fits bring ${top.length ? top.join(" and ") : "the core skills listed in the description"}.`;
	return { title, summary, criteria };
}

// ---- Review a candidate ---------------------------------------------------

const STOPWORDS = new Set(
	"a an as at by in is of on or to be we the and for with from that this have has are was were you your our their years year experience experienced strong solid good great deep proven knowledge working work ability able skills skill plus least using based within into level understanding professional hands".split(
		" ",
	),
);
const NEGATIONS = /\b(no|not|never|without|lacks?|lacking|doesn'?t|don'?t|isn'?t|hasn'?t|zero|none)\b/i;

const stem = (word: string) => word.slice(0, 5);
/** Loose match so "need" finds "needs" and "programs" finds "program". */
const sameWord = (noteWord: string, wanted: string) =>
	noteWord.startsWith(stem(wanted)) || (noteWord.length >= 4 && wanted.startsWith(noteWord));
const tokens = (text: string) =>
	text
		.toLowerCase()
		.replace(/[^a-z0-9+#.\s/-]/g, " ")
		.split(/[\s/]+/)
		.map((w) => w.replace(/^[.-]+|[.-]+$/g, ""))
		.filter((w) => w.length >= 2 && !STOPWORDS.has(w) && !/^\d+\+?$/.test(w));

function yearsCheck(label: string, notes: string): "MET" | "PARTIAL" | null {
	const want = label.match(/(\d+)\s*\+?\s*(?:years|yrs)/i);
	if (!want) return null;
	const have = [...notes.matchAll(/(\d+)\s*\+?\s*(?:years|yrs)/gi)].map((m) => Number(m[1]));
	if (!have.length) return null;
	return Math.max(...have) >= Number(want[1]) ? "MET" : "PARTIAL";
}

function judge(c: KindedCriterion, notes: string): Verdict {
	const words = notes.toLowerCase().split(/\s+/);
	const wanted = [...new Set(tokens(c.label))];
	let found = 0;
	let negated = 0;
	for (const w of wanted) {
		const idx = words.findIndex((n) => sameWord(n.replace(/[^a-z0-9+#-]/g, ""), w));
		if (idx === -1) continue;
		found++;
		if (NEGATIONS.test(words.slice(Math.max(0, idx - 5), idx).join(" "))) negated++;
	}
	const ratio = wanted.length ? found / wanted.length : 0;
	const years = yearsCheck(c.label, notes);
	const label = c.label.toLowerCase();

	if (c.kind === "dealBreaker") {
		if (negated > 0)
			return { criterionId: c.id, verdict: "NOT_MET", reasoning: "Notes say this doesn't apply." };
		if (ratio >= 0.75)
			return { criterionId: c.id, verdict: "MET", reasoning: `Notes indicate "${label}" applies.` };
		return { criterionId: c.id, verdict: "UNKNOWN", reasoning: "The notes don't mention this." };
	}
	if (negated > 0 && negated >= found / 2)
		return { criterionId: c.id, verdict: "NOT_MET", reasoning: `Notes explicitly rule out ${label}.` };
	if (years === "PARTIAL")
		return { criterionId: c.id, verdict: "PARTIAL", reasoning: "Fewer years of experience than asked." };
	if (ratio >= 0.6 || years === "MET")
		return { criterionId: c.id, verdict: "MET", reasoning: `Notes cover ${label}.` };
	if (ratio >= 0.3)
		return {
			criterionId: c.id,
			verdict: "PARTIAL",
			reasoning: `Some evidence for ${label}, not conclusive.`,
		};
	return { criterionId: c.id, verdict: "UNKNOWN", reasoning: "The notes don't mention this." };
}

export function offlineVerdicts(criteria: Criteria, notes: string): Verdict[] {
	return allCriteria(criteria).map((c) => judge(c, notes));
}

export function offlineReviewSummary(criteria: Criteria, verdicts: Verdict[]): string {
	const label = new Map(allCriteria(criteria).map((c) => [c.id, c.label]));
	const must = new Set(criteria.mustHave.map((c) => c.id));
	const strongest = verdicts.find((v) => must.has(v.criterionId) && v.verdict === "MET");
	const open = verdicts.find((v) => must.has(v.criterionId) && v.verdict !== "MET");
	const parts = [
		strongest
			? `Strongest point: ${label.get(strongest.criterionId)}.`
			: "No must-have is clearly covered by the notes.",
		open ? `Ask in a first call about: ${label.get(open.criterionId)}.` : "All must-haves look covered.",
	];
	return parts.join(" ");
}

// ---- Text for budget and pipeline -----------------------------------------

export function offlineBudgetRationale(input: {
	title: string;
	seniority: string;
	rarity: number;
	bountyUsdc: number;
	maxCandidates: number;
}): string {
	const total = input.bountyUsdc * input.maxCandidates;
	const rarityText =
		input.rarity >= 1.3
			? "a hard-to-find profile"
			: input.rarity >= 1.1
				? "a moderately rare profile"
				: "a common profile";
	return `${input.title} is a ${input.seniority.toLowerCase()} role and ${rarityText}, so ${input.bountyUsdc} USDC per qualified, interested candidate pays a scout fairly for sourcing, outreach and a first conversation. The full budget of ${total} USDC for ${input.maxCandidates} candidates is a fraction of a typical agency fee of around 20% of annual salary, and you only pay for candidates you accept. You can fund part of it now and top up once the first candidates arrive.`;
}

export function offlinePipelineSummary(input: {
	title: string;
	bountyUsdc: number;
	remainingUsdc: number;
	maxCandidates: number;
	acceptedCount: number;
	pendingCount: number;
	rejectedCount: number;
	coverable: number;
	averageScore: number | null;
}): string {
	const openSlots = input.maxCandidates - input.acceptedCount;
	const status = `${input.title}: ${input.acceptedCount} accepted, ${input.pendingCount} awaiting your review and ${input.rejectedCount} rejected, with ${input.remainingUsdc} USDC left in the budget.`;
	const reviewed = input.acceptedCount + input.rejectedCount;
	let suggestion: string;
	if (input.coverable < Math.min(openSlots, input.pendingCount + 1)) {
		suggestion = `The remaining budget covers only ${input.coverable} more accepted candidate${input.coverable === 1 ? "" : "s"}; top up to keep scouts submitting.`;
	} else if (reviewed >= 3 && input.rejectedCount / reviewed > 0.6) {
		suggestion =
			"Most candidates are being rejected, so consider loosening a must-have or clarifying the criteria for scouts.";
	} else if (input.averageScore !== null && input.averageScore < 50) {
		suggestion =
			"Recent candidates score low against the criteria; consider clarifying the must-haves for scouts.";
	} else if (input.pendingCount > 0) {
		suggestion =
			"Review pending candidates before their window closes, or they are accepted and paid automatically.";
	} else {
		suggestion = "The pipeline looks healthy; keep going.";
	}
	return `${status} ${suggestion}`;
}
