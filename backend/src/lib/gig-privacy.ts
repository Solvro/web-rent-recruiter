/**
 * Candidate privacy on gigs: a screening / reference gig names a real person. Until a recruiter takes the gig,
 * everyone but that recruiter and the company sees an anonymized summary, and no script.
 */
import type { GigCandidate } from "@scout/shared";

export type CandidateSource = {
	id: string;
	name: string;
	profileUrl: string;
	notes: string;
	card: {
		avatarUrl: string | null;
		currentTitle: string | null;
		currentCompany: string | null;
		location: string | null;
	};
};

/** Who may see the candidate behind an exclusive gig: its claimant and the role's company. */
export function canSeeCandidate(
	viewer: string | null,
	gig: { claimantWallet: string | null },
	companyWallet: string,
) {
	return Boolean(viewer && (viewer === gig.claimantWallet || viewer === companyWallet));
}

/** "Senior Backend Engineer" + "7 years …" → "Senior backend engineer · 7 yrs" (no employer, no name). */
export function anonymizedSummary(c: CandidateSource, seniority: string | null): GigCandidate["summary"] {
	const title = c.card.currentTitle?.trim();
	const years = c.notes.match(/(\d{1,2})\+?\s*(?:years|yrs|lat)/i)?.[1];
	const base = title ? title.charAt(0).toUpperCase() + title.slice(1).toLowerCase() : "Candidate";
	return {
		headline: years ? `${base} · ${years} yrs` : base,
		city: c.card.location?.split(",")[0]?.trim() || null,
		seniority,
	};
}

export function gigCandidate(c: CandidateSource, visible: boolean, seniority: string | null): GigCandidate {
	const summary = anonymizedSummary(c, seniority);
	return visible
		? { redacted: false, summary, id: c.id, name: c.name, profileUrl: c.profileUrl, card: c.card }
		: { redacted: true, summary, id: null, name: null, profileUrl: null, card: null };
}
