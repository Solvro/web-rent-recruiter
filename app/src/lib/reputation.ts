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

export function skillName(tag: string) {
	if (tag === "screening-calls") return "Screening calls";
	return skillLabel(tag) ?? tag;
}
