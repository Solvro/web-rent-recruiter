/**
 * Plain words for the agent's gig requirements (GigView.requirements / eligibility): skill tags become names,
 * and "can't take it" reasons say what is missing.
 */
import type { GigView } from "./gigs/schemas";

const LANGS: Record<string, string> = {
	en: "English",
	de: "German",
	pl: "Polish",
	es: "Spanish",
	fr: "French",
	ro: "Romanian",
};

const TECH: Record<string, string> = { typescript: "TypeScript", javascript: "JavaScript", go: "Go" };

export function skillLabel(tag: string): string | null {
	const [kind, a, b] = tag.split(":");
	if (kind === "family") return null;
	if (kind === "tech-screener") return "Tech screener";
	if (kind === "engineer" && a) return `${TECH[a] ?? `${a[0]?.toUpperCase()}${a.slice(1)}`} engineer`;
	if (kind === "design" && a) return `${a[0]?.toUpperCase()}${a.slice(1)} designer`;
	if (kind === "lang" && a) {
		const name = LANGS[a] ?? a.toUpperCase();
		return b === "native" ? `Native ${name}` : `${name} ${b?.toUpperCase() ?? ""}`.trim();
	}
	return tag;
}

/** Small chips for the card: experience needed, and the skills (any one of them). */
export function requirementChips(req: GigView["requirements"]): string[] {
	const chips: string[] = [];
	if (req.minAccepted > 0)
		chips.push(
			/screening calls/i.test(req.summary)
				? `${req.minAccepted}+ accepted screenings`
				: `${req.minAccepted}+ accepted gigs`,
		);
	if (req.minRate > 0) chips.push(`${Math.round(req.minRate * 100)}%+ accepted`);
	const skills = req.skills.map(skillLabel).filter((s): s is string => !!s);
	if (skills.length) chips.push(skills.join(" or "));
	return chips;
}

/** "You qualify" or what is missing, for the signed-in recruiter. */
export function eligibilityLine(e: NonNullable<GigView["eligibility"]>): string {
	if (e.allowed) return e.needsBond ? "You qualify · small deposit, returned when accepted" : "You qualify";
	const r = e.reason;
	const count = r.match(/Needs (\d+) accepted (screening calls|gigs) in \d+ days \(has (\d+)\)/);
	if (count)
		return `Needs ${Number(count[1]) - Number(count[3])} more accepted ${count[2] === "gigs" ? "gigs" : "screenings"}`;
	const skills = r.match(/Needs one of: (.*)\.$/);
	if (skills)
		return `For ${skills[1].split(", ").map(skillLabel).filter(Boolean).join(" or ").toLowerCase()}s only`;
	const rate = r.match(/Acceptance rate (\d+)% is below (\d+)%/);
	if (rate) return `Needs ${rate[2]}% of your work accepted (now ${rate[1]}%)`;
	if (/sourced a candidate/i.test(r)) return "You found this candidate, so someone else runs the calls";
	return r;
}
