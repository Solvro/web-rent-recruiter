/** Plain words for a recruiter's per-type quality score (0–100, Wilson lower bound). */
import { skillLabel } from "./gig-access";

export function standing(score: number): "new" | "growing" | "trusted" {
	if (score >= 70) return "trusted";
	if (score >= 40) return "growing";
	return "new";
}

export const TYPE_WORD = {
	SOURCING: "Sourcing",
	SCREENING_CALL: "Screening",
	REFERENCE_CHECK: "References",
} as const;

/** "Verified by Kraków Recruiting Academy" / "5 earned" / nothing (self-declared and demo history stay quiet). */
export function skillSource(s: { skill: string; source: string; verifiedBy: string | null; count?: number }) {
	if (s.source === "operator" && s.verifiedBy) return `Verified by ${s.verifiedBy}`;
	if (s.source === "earned") return `${s.count ?? 0} earned`;
	return null;
}

const EARNED: Record<string, string> = {
	"screening-calls": "Screening calls",
	"gig:sourcing": "Sourcing",
	"gig:screening": "Screening calls",
	"gig:reference": "Reference checks",
	"gig:language": "Language checks",
};

export function skillName(tag: string) {
	return EARNED[tag] ?? skillLabel(tag) ?? tag;
}

/** One chip per skill: an operator's or earned proof wins over the recruiter's own claim. */
export function uniqueSkills<T extends { skill: string; source: string }>(list: T[]): T[] {
	const rank = (s: string) => (s === "operator" ? 0 : s === "earned" ? 1 : 2);
	const best = new Map<string, T>();
	for (const s of list) {
		const prev = best.get(skillName(s.skill));
		if (!prev || rank(s.source) < rank(prev.source)) best.set(skillName(s.skill), s);
	}
	return [...best.values()];
}

/** Skills a recruiter can say they have themselves (the rest are earned or verified by their operator). */
export const SKILL_CHOICES = [
	"engineer:rust",
	"engineer:solana",
	"engineer:typescript",
	"engineer:python",
	"engineer:go",
	"engineer:java",
	"design:product",
	"tech-screener",
	"lang:en:c2",
	"lang:pl:native",
	"lang:de:native",
	"lang:es:native",
	"lang:fr:native",
	"lang:ro:native",
];
