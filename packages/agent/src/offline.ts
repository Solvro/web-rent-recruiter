/**
 * Deterministic stand-ins for every LLM call. Used when no API key is configured and as the
 * fallback when a provider fails, so the product keeps working without a network.
 */
import type { Criteria, Criterion } from "@scout/shared";
import { normalizeCriteria } from "./criteria.ts";
import { allCriteria, type KindedCriterion, type Verdict } from "./scoring.ts";

// ---- Draft criteria from a job description --------------------------------

const BULLET = /^\s*(?:[-*•▪◦]|\d+[.)])\s+(.*)$/;
/** Headings only count on short, non-bullet lines (a paragraph saying "looking for" isn't one). */
const MUST_HEADING =
	/(requirement|must|you have|you bring|you.ll bring|you will bring|looking for|qualification|what you need|what we need|what you will need|what you.ll need|about you|we expect|skills|profile)/i;
const NICE_HEADING = /(nice to have|nice-to-have|bonus|preferred|great if|extra points|advantage|plus)/i;
const OTHER_HEADING =
	/(we offer|benefits|perks|about us|responsibilit|what you.ll do|what you will do|your role|the team|the role|compensation|about the)/i;
const ROLE_WORD =
	/\b(engineer|developer|manager|designer|lead|specialist|analyst|scientist|director|consultant|architect|recruiter|representative|associate|executive|officer|head|coordinator|administrator|accountant|marketer|writer|researcher|success|sales|support|operations|product|intern)\b/i;

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
	"Portugal",
	"United States",
	"Germany",
	"Spain",
];
const LANGUAGES = [
	"English",
	"Polish",
	"German",
	"French",
	"Spanish",
	"Italian",
	"Dutch",
	"Ukrainian",
	"Czech",
	"Portuguese",
	"Romanian",
	"Swedish",
	"Danish",
	"Norwegian",
	"Finnish",
	"Hungarian",
	"Turkish",
];
const SOFT =
	/\b(communicat\w*|passion\w*|motivated|care|caring|flexib\w*|attitude|team player|energetic|listening|curious|curiosity|ownership|self-starter|degree)\b/i;

/** The bullet's main point, at most ~10 words. Skips an exclamation intro ("We've got clients…!"). */
const shortLabel = (text: string) => {
	const sentences = text
		.replace(/\s+/g, " ")
		.trim()
		.split(/(?<=[.!?])\s+/)
		.filter(Boolean);
	const main = sentences.find((x) => !x.endsWith("!")) ?? sentences[0] ?? text;
	let clean = main.replace(/[.;:!]+$/, "").trim();
	const colon = clean.indexOf(":");
	if (colon > 0 && clean.slice(0, colon).split(" ").length >= 3) clean = clean.slice(0, colon);
	// "X, Y or Z at a SaaS company" is one requirement: keep the list instead of cutting at the comma.
	const list = /,[^,]*\bor\b/.test(clean) && clean.split(" ").length <= 16;
	const clause = list ? clean : clean.split(/,|\(| - | – /)[0].trim();
	const words = (clause.split(" ").length >= 3 ? clause : clean).split(" ");
	const max = list ? 16 : 10;
	return words.length > max ? `${words.slice(0, max).join(" ")}…` : words.join(" ");
};

const LEVELS: [Criteria["seniority"], RegExp][] = [
	["EXECUTIVE", /\b(head of|director|vp|vice president|cto|ceo|coo|chief)\b/i],
	["PRINCIPAL", /\bprincipal\b/i],
	["STAFF", /\b(staff|lead|founding)\b/i],
	["SENIOR", /\b(senior|sr\.?)\b/i],
	["JUNIOR", /\b(junior|jr\.?|intern|internship|graduate|entry[- ]level|trainee)\b/i],
];

/** Seniority from the TITLE first (duties like "lead design reviews" don't make a role staff), then years. */
function detectSeniority(title: string, requirements: string): Criteria["seniority"] {
	for (const [level, re] of LEVELS) if (re.test(title)) return level;
	const years = [...requirements.matchAll(/(\d+)\s*\+?\s*(?:years|yrs)/gi)].map((m) => Number(m[1]));
	const max = years.length ? Math.max(...years) : 0;
	if (max >= 8) return "STAFF";
	if (max >= 5) return "SENIOR";
	if (max >= 2) return "MID";
	return years.length ? "JUNIOR" : "MID";
}

/** "Insider One - Customer Success Manager (Warsaw, Poland)" → title + company. */
/** Words that start a sentence but never name a company. */
const NOT_COMPANY =
	/^(we|our|you|your|the|this|it|they|about|join|at|in|as|a|an|remote|hybrid|location|locations)$/i;

/** "Insider One - Customer Success Manager (Warsaw, Poland)" → title + company. Never a place. */
export function titleAndCompany(text: string): { title: string; company: string | null } {
	const first =
		text
			.split(/\r?\n/)
			.map((l) => l.replace(/^#+\s*|^(job )?title:\s*/i, "").trim())
			.find((l) => l.length > 0 && l.length < 140) ?? "Open role";
	const isPlace = (inner: string) =>
		/\b(remote|hybrid|on-?site|anywhere|worldwide|emea|europe|eu)\b/i.test(inner) ||
		CITIES.some((c) => new RegExp(`\\b${c}\\b`, "i").test(inner));
	// "(Remote - United States, Portugal)" / "(Warsaw, Poland)": a location, not part of the title.
	const stripPlace = (p: string) =>
		p.replace(/\s*\(([^()]*)\)\s*$/, (m, inner: string) => (isPlace(inner) ? "" : m)).trim();
	// "Data Engineer (Analytics Platform), Remote, EU": trailing comma parts that are places go too.
	const commaParts = stripPlace(first).split(/,\s*/);
	while (commaParts.length > 1 && isPlace(commaParts.at(-1) ?? "")) commaParts.pop();
	const header = commaParts.join(", ");
	const parts = header
		.split(/\s+[-–—|]\s+|\s+at\s+/)
		.map((p) => stripPlace(p.trim()))
		.filter(Boolean);
	const titleIdx = parts.findIndex((p) => ROLE_WORD.test(p));
	let title = parts[titleIdx >= 0 ? titleIdx : 0] ?? first;
	const rest = parts.filter((_, i) => i !== titleIdx && !isPlace(parts[i] ?? ""));
	// The company is the header part the body talks about most ("Northwind Pay is …"), else a name
	// the body introduces ("At Northwind Freight we…", "Fakturo is …", "We're Wisła Labs").
	const body = text.split(/\r?\n/).slice(1).join("\n");
	const mentions = (p: string) => body.split(p).length - 1;
	const valid = (p: string | undefined): p is string =>
		Boolean(p) &&
		!isPlace(p as string) &&
		!NOT_COMPANY.test((p as string).split(" ")[0] ?? "") &&
		!ROLE_WORD.test(p as string);
	const candidates = rest.filter((p) => valid(p) && p.split(" ").length <= 4 && /^[\p{Lu}0-9]/u.test(p));
	const NAME = "(\\p{Lu}[\\p{L}\\p{N}&.'’-]*(?:\\s+\\p{Lu}[\\p{L}\\p{N}&.'’-]*){0,3})";
	const fromBody = [
		new RegExp(`(?:^|\\s)(?:At|Join|We're|We are|We’re)\\s+${NAME}`, "u"),
		new RegExp(
			`(?:^|[\\n.!?]\\s*)${NAME}\\s+(?:is|builds|makes|helps|runs|powers|moves|was founded|has been)(?=\\s)`,
			"u",
		),
	]
		.map((re) => body.match(re)?.[1]?.trim())
		.find(valid);
	const company =
		[...candidates].sort(
			(a, b) => mentions(b) - mentions(a) || candidates.indexOf(b) - candidates.indexOf(a),
		)[0] ??
		fromBody ??
		null;
	// "Senior Software Engineer - Go & Rust, Blockchain Infrastructure — QuickNode": keep the specialization.
	const specialization = rest.find((p) => p !== company && !ROLE_WORD.test(p) && /,|&|\b(and)\b/.test(p));
	if (specialization && title.split(" ").length <= 4) title = `${title} (${specialization})`;
	return { title: title || "Open role", company };
}

/**
 * Languages the role requires, with a CEFR level when the text implies one: "Fluent Polish and
 * English" → Polish (C1), English. Languages that are only "an advantage" are left out. A
 * non-English language comes first (that's the one the language check is for).
 */
export function detectLanguages(text: string): string[] {
	const found = new Map<string, string | null>();
	for (const clause of text.split(/[\n.;()]+/)) {
		if (/\b(advantage|nice to have|bonus|plus|preferred)\b/i.test(clause)) continue;
		for (const lang of LANGUAGES) {
			if (!new RegExp(`\\b${lang}\\b`, "i").test(clause)) continue;
			const explicit = text
				.match(new RegExp(`\\b${lang}\\b\\s*\\(?\\s*([ABC][12])\\b`, "i"))?.[1]
				?.toUpperCase();
			const level =
				explicit ??
				(/\bnative\b/i.test(clause)
					? "C2"
					: /\b(fluent|fluency|excellent|strong|professional|business|proficient|advanced)\b/i.test(clause)
						? "C1"
						: null);
			if (!found.has(lang) || (level && !found.get(lang))) found.set(lang, level);
		}
	}
	const entries = [...found.entries()];
	const nonEnglish = entries.filter(([l]) => l !== "English");
	const english = entries.find(([l]) => l === "English");
	const label = ([l, level]: [string, string | null]) =>
		level && (l !== "English" || !nonEnglish.length) ? `${l} (${level})` : l;
	const out = [...nonEnglish.map(label), ...(english ? [label(english)] : [])];
	return out.length ? out : ["English"];
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

const isLanguageBullet = (item: string) =>
	LANGUAGES.some((l) => new RegExp(`\\b${l}\\b`, "i").test(item)) &&
	!/\b(experience|years|built|worked)\b/i.test(item.replace(/communication skills/i, ""));

export function offlineDraftRole(jobDescription: string): {
	title: string;
	company: string | null;
	summary: string;
	criteria: Criteria;
} {
	const lines = jobDescription.split(/\r?\n/);
	const { title, company } = titleAndCompany(jobDescription);

	const must: string[] = [];
	const nice: string[] = [];
	let section: "must" | "nice" | "other" | null = null;
	for (const line of lines) {
		// "Nice to have: TypeScript SDKs, open-source work." on one line.
		const inline = line.match(
			/^\s*(nice to have|nice-to-have|bonus|preferred|requirements?|must have)\s*:\s*(.+)$/i,
		);
		if (inline) {
			const items = inline[2]
				.split(/,|;|\band\b(?=[^,]*$)/)
				.map((x) => x.replace(/\.$/, "").trim())
				.filter((x) => x.length > 2);
			(NICE_HEADING.test(inline[1]) ? nice : must).push(...items);
			continue;
		}
		const bullet = line.match(BULLET);
		if (!bullet) {
			const heading = line.trim();
			if (!heading || heading.length > 60) continue;
			if (NICE_HEADING.test(heading)) section = "nice";
			else if (MUST_HEADING.test(heading)) section = "must";
			else if (OTHER_HEADING.test(heading)) section = "other";
			continue;
		}
		const item = bullet[1].trim();
		// Only the requirement sections feed criteria; duties never become must-haves.
		if (section === "must") must.push(item);
		else if (section === "nice") nice.push(item);
	}
	// Every requirement bullet is kept: hard ones as must-haves (up to 6), soft or extra ones as
	// nice-to-haves, language bullets as the role's languages.
	const hard = must.filter((m) => !isLanguageBullet(m) && !SOFT.test(m));
	const soft = must.filter((m) => !isLanguageBullet(m) && SOFT.test(m));
	// Soft bullets are still explicit requirements: when there are few hard ones, they're must-haves too.
	const promoted = soft.slice(0, Math.max(0, 3 - hard.length));
	const mustItems = [...hard.slice(0, 6), ...promoted];
	const niceItems = [
		...hard.slice(6),
		...soft.slice(promoted.length),
		...nice.filter((n) => !isLanguageBullet(n)),
	].slice(0, 8);
	const toCriterion = (weightFor: (i: number) => number) => (text: string, i: number) => ({
		id: "",
		label: shortLabel(text),
		weight: weightFor(i),
	});

	const text = jobDescription;
	const mode: Criteria["location"]["mode"] = /\bhybrid\b/i.test(text)
		? "HYBRID"
		: /\bremote\b/i.test(text)
			? "REMOTE"
			: "ONSITE";
	const places = CITIES.filter((c) => new RegExp(`\\b${c}\\b`, "i").test(text));
	const requirementsText = must.join("\n");
	const languages = detectLanguages(requirementsText || text);
	const dealBreakers: Criterion[] = [];
	if (
		/(no visa sponsorship|unable to sponsor|cannot sponsor|can't sponsor|without sponsorship)/i.test(text)
	) {
		dealBreakers.push({ id: "", label: "Needs visa sponsorship", weight: 5 });
	}

	const criteria = normalizeCriteria({
		mustHave: mustItems.map(toCriterion((i) => (i < 2 ? 5 : i < 4 ? 4 : 3))),
		niceToHave: niceItems.map(toCriterion(() => 2)),
		seniority: detectSeniority(title, requirementsText),
		location: { mode, places: [...new Set(places)] },
		salaryRange: detectSalary(text),
		languages,
		dealBreakers,
	});
	const top = criteria.mustHave.slice(0, 2).map((c) => c.label.charAt(0).toLowerCase() + c.label.slice(1));
	const where = places.length ? `, ${places.slice(0, 2).join("/")}` : "";
	const summary = `${title}${company ? ` at ${company}` : ""} (${criteria.seniority.toLowerCase()}, ${mode.toLowerCase()}${where}). Strong fits bring ${top.length ? top.join(" and ") : "the requirements listed in the posting"}.`;
	return { title, company, summary, criteria };
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
