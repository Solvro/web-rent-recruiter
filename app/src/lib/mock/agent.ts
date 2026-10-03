/**
 * Deterministic stand-in for the backend AI agent, so the demo is clickable offline.
 * The real agent lives in backend/src/agent and returns the same shapes.
 */
import type { AgentReview, Criteria, Criterion } from "@scout/shared";
import { toBaseUnits } from "@scout/shared";

type Skill = { id: string; label: string; re: RegExp };

const SKILLS: Skill[] = [
	{ id: "typescript", label: "TypeScript in production", re: /typescript|\bts\b/i },
	{ id: "node", label: "Node.js backend services", re: /node(\.js)?|nestjs|fastify|express/i },
	{ id: "react", label: "React on the frontend", re: /\breact\b|next\.js/i },
	{ id: "postgres", label: "PostgreSQL and data modelling", re: /postgres|sql\b|database/i },
	{ id: "payments", label: "Payments or fintech domain", re: /payment|fintech|billing|ledger|stripe/i },
	{
		id: "distributed",
		label: "Distributed systems at scale",
		re: /distributed|microservice|kafka|event[- ]driven|high[- ]throughput/i,
	},
	{ id: "cloud", label: "Cloud infrastructure (AWS/GCP)", re: /\baws\b|gcp|google cloud|azure|terraform/i },
	{ id: "k8s", label: "Kubernetes and containers", re: /kubernetes|k8s|docker/i },
	{ id: "rust", label: "Rust", re: /\brust\b/i },
	{ id: "solana", label: "Solana / on-chain programs", re: /solana|anchor|smart contract|web3/i },
	{ id: "python", label: "Python", re: /python|django|fastapi/i },
	{ id: "go", label: "Go", re: /\bgolang\b|\bgo\b(?! to)/i },
	{ id: "figma", label: "Product design in Figma", re: /figma|prototyp/i },
	{ id: "design-systems", label: "Design systems", re: /design system/i },
	{ id: "research", label: "User research", re: /user research|usability|interview/i },
	{ id: "ml", label: "Machine learning in production", re: /machine learning|\bml\b|llm|pytorch/i },
	{
		id: "data",
		label: "Data pipelines (Spark/dbt/Airflow)",
		re: /spark|dbt|airflow|data pipeline|data warehouse/i,
	},
	{
		id: "mentoring",
		label: "Mentoring and technical leadership",
		re: /mentor|lead(ing)? (a )?team|tech lead|leadership/i,
	},
	{ id: "testing", label: "Automated testing culture", re: /testing|tdd|unit test|integration test/i },
	{
		id: "startup",
		label: "Early-stage startup experience",
		re: /startup|early[- ]stage|seed|series a|founding/i,
	},
];

const LANGUAGES: [string, RegExp][] = [
	["English", /english/i],
	["Polish", /polish|polski/i],
	["German", /german|deutsch/i],
	["French", /french/i],
	["Spanish", /spanish/i],
];

const CITIES = ["Warsaw", "Kraków", "Wrocław", "Gdańsk", "Berlin", "London", "Amsterdam", "Lisbon", "Prague"];

function seniorityOf(text: string): Criteria["seniority"] {
	if (/\b(cto|vp|head of|director)\b/i.test(text)) return "EXECUTIVE";
	if (/principal/i.test(text)) return "PRINCIPAL";
	if (/staff|lead\b/i.test(text)) return "STAFF";
	if (/senior|sr\.?\b|5\+ years|6\+ years|7\+ years/i.test(text)) return "SENIOR";
	if (/junior|intern|graduate|entry/i.test(text)) return "JUNIOR";
	return "MID";
}

function salaryOf(text: string): Criteria["salaryRange"] {
	const m = text.match(
		/(\d{1,3}(?:[ ,.]?\d{3})*|\d+)\s*(k)?\s*[-–]\s*(\d{1,3}(?:[ ,.]?\d{3})*|\d+)\s*(k)?\s*(PLN|EUR|USD|€|\$|zł)/i,
	);
	if (!m) return null;
	const num = (s: string, k?: string) => Number(s.replace(/[ ,.]/g, "")) * (k ? 1000 : 1);
	const currency = { "€": "EUR", $: "USD", zł: "PLN" }[m[5]] ?? m[5].toUpperCase();
	const min = num(m[1], m[2] ?? m[4]);
	const max = num(m[3], m[4]);
	return { min, max, currency, period: max < 60000 ? "MONTH" : "YEAR" };
}

export function draftRole(jobDescription: string) {
	const lines = jobDescription
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	const title = (lines[0] ?? "New role").replace(/^(job title|role|position)\s*:\s*/i, "").slice(0, 80);
	const matched = SKILLS.filter((s) => s.re.test(jobDescription));
	const fallback: Skill[] = [
		{ id: "relevant-experience", label: "3+ years in a similar role", re: /experience/i },
		{ id: "ownership", label: "Owns problems end to end", re: /ownership|end[- ]to[- ]end/i },
	];
	const pool = matched.length >= 2 ? matched : [...matched, ...fallback];
	const mustHave: Criterion[] = pool
		.slice(0, 4)
		.map((s, i) => ({ id: s.id, label: s.label, weight: [5, 4, 4, 3][i] }));
	const niceToHave: Criterion[] = pool.slice(4, 8).map((s) => ({ id: s.id, label: s.label, weight: 2 }));

	const remote = /remote/i.test(jobDescription);
	const hybrid = /hybrid/i.test(jobDescription);
	const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
	const places = CITIES.filter((c) => fold(jobDescription).includes(fold(c)));
	const mode = remote && !hybrid ? "REMOTE" : hybrid ? "HYBRID" : "ONSITE";
	const languages = LANGUAGES.filter(([, re]) => re.test(jobDescription)).map(([l]) => l);
	if (languages.length === 0) languages.push("English");

	const dealBreakers: Criterion[] =
		mode === "REMOTE"
			? [{ id: "timezone", label: "Can't overlap 4h with CET working hours", weight: 5 }]
			: [
					{
						id: "location",
						label: `Can't work ${mode === "HYBRID" ? "hybrid" : "on-site"} in ${places[0] ?? "the office city"}`,
						weight: 5,
					},
				];
	if (/visa|work permit|right to work/i.test(jobDescription))
		dealBreakers.push({ id: "work-permit", label: "Needs visa sponsorship", weight: 5 });

	const criteria: Criteria = {
		mustHave,
		niceToHave,
		seniority: seniorityOf(jobDescription),
		location: { mode, places },
		salaryRange: salaryOf(jobDescription),
		languages,
		dealBreakers,
	};

	const base = { JUNIOR: 10, MID: 15, SENIOR: 20, STAFF: 30, PRINCIPAL: 40, EXECUTIVE: 60 }[
		criteria.seniority
	];
	const rare = matched.some((s) => ["rust", "solana", "ml"].includes(s.id));
	const bounty = base + (rare ? 5 : 0);
	const maxCandidates = ["STAFF", "PRINCIPAL", "EXECUTIVE"].includes(criteria.seniority) ? 8 : 10;
	const summary = `${criteria.seniority.toLowerCase()} hire, ${mode.toLowerCase()}${places.length ? ` (${places.join(", ")})` : ""}. Core stack: ${mustHave.map((c) => c.label).join(", ")}.`;
	const rationale = `${criteria.seniority[0]}${criteria.seniority.slice(1).toLowerCase()} profiles with ${mustHave
		.slice(0, 2)
		.map((c) => c.label.split(" ")[0])
		.join(
			" and ",
		)} are ${rare ? "scarce, so the bounty is set above the usual rate" : "reachable through a scout's network"}. ${bounty} USDC per qualified, interested candidate is about 1% of a typical agency fee for this level. Ten candidates usually yield one or two hires; start with that and top up once you see quality.`;

	return {
		title,
		summary: summary[0].toUpperCase() + summary.slice(1),
		criteria,
		suggestedBounty: toBaseUnits(bounty).toString(),
		suggestedMaxCandidates: maxCandidates,
		rationale,
	};
}

const STOP = new Set(["with", "and", "the", "for", "in", "on", "of", "a", "an", "to", "or", "can't", "work"]);

function evidence(criterion: Criterion, text: string): "MET" | "PARTIAL" | "NOT_MET" | "UNKNOWN" {
	const skill = SKILLS.find((s) => s.id === criterion.id);
	if (skill) return skill.re.test(text) ? "MET" : "NOT_MET";
	const words = criterion.label
		.toLowerCase()
		.split(/[^a-z0-9+#.]+/)
		.filter((w) => w.length > 2 && !STOP.has(w));
	if (words.length === 0) return "UNKNOWN";
	const hits = words.filter((w) => text.toLowerCase().includes(w)).length;
	if (hits === 0) return text.length < 80 ? "UNKNOWN" : "NOT_MET";
	return hits / words.length >= 0.5 ? "MET" : "PARTIAL";
}

export function reviewCandidate(
	criteria: Criteria,
	candidate: { name: string; profileUrl: string; notes: string },
): AgentReview {
	const text = `${candidate.notes} ${candidate.profileUrl}`;
	const value = { MET: 1, PARTIAL: 0.5, UNKNOWN: 0.3, NOT_MET: 0 };
	const must = new Set(criteria.mustHave.map((c) => c.id));
	let total = 0;
	let got = 0;
	const verdicts: AgentReview["verdicts"] = [];
	for (const c of [...criteria.mustHave, ...criteria.niceToHave]) {
		const v = evidence(c, text);
		const w = c.weight * (must.has(c.id) ? 2 : 1);
		total += w;
		got += w * value[v];
		verdicts.push({
			criterionId: c.id,
			verdict: v,
			reasoning:
				v === "MET"
					? `Notes show direct experience with ${c.label.toLowerCase()}.`
					: v === "PARTIAL"
						? `Some overlap with ${c.label.toLowerCase()}, but depth is unclear.`
						: v === "UNKNOWN"
							? "Not mentioned in the notes; worth asking on the first call."
							: `No evidence of ${c.label.toLowerCase()} in the profile or notes.`,
		});
	}
	let dealBreakerHit = false;
	for (const c of criteria.dealBreakers) {
		const flagged = /relocat|visa|sponsor|not open|only remote|can't|cannot|no overlap/i.test(
			candidate.notes,
		);
		const hit = flagged && evidence(c, candidate.notes) !== "NOT_MET";
		if (hit) dealBreakerHit = true;
		verdicts.push({
			criterionId: c.id,
			// MET on a deal-breaker means the candidate triggers it (same convention as the backend agent).
			verdict: hit ? "MET" : "NOT_MET",
			reasoning: hit
				? "Notes suggest this deal-breaker applies."
				: "Nothing in the notes triggers this deal-breaker.",
		});
	}
	const raw = Math.round((got / Math.max(total, 1)) * 100);
	const score = dealBreakerHit ? Math.min(raw, 30) : raw;
	const recommendation = score >= 75 ? "ADVANCE" : score >= 50 ? "MAYBE" : "PASS";
	const fit = verdicts.slice(0, criteria.mustHave.length + criteria.niceToHave.length);
	const met = fit.filter((v) => v.verdict === "MET").length;
	const summary =
		recommendation === "ADVANCE"
			? `${candidate.name} covers ${met} of ${fit.length} criteria, including the must-haves. Strong fit for a first call.`
			: recommendation === "MAYBE"
				? `${candidate.name} matches part of the brief. Worth a short call to check the gaps.`
				: dealBreakerHit
					? `${candidate.name} hits a deal-breaker for this role.`
					: `${candidate.name} misses key must-haves for this role.`;
	return { score, verdicts, recommendation, summary };
}
