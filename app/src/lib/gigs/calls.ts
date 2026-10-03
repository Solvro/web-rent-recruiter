/**
 * Call bookkeeping (mock first; asked from Stream B): the candidate didn't join, and "this candidate looks fake".
 */
import { typedClient } from "../trpc";

export const callApi = {
	noShow: (gigId: string) => typedClient.gigs.noShow.mutate({ gigId }),
	claimShowUpFee: (gigId: string) => typedClient.gigs.claimShowUpFee.mutate({ gigId }),
	report: (gigId: string, reason: string) => typedClient.gigs.report.mutate({ gigId, reason }),
	reportCandidate: (roleId: string, candidateId: string, reason: string) =>
		typedClient.roles.reportCandidate.mutate({ roleId, candidateId, reason }),
};

/** Call state on a gig: times the candidate didn't join, and when the recruiter took it. */
export const callStateOf = (g: { noShows?: number; claimedAt?: string | null }) => {
	return { noShows: g.noShows ?? 0, claimedAt: g.claimedAt ?? null };
};

const ZONES: Record<string, string> = {
	warsaw: "Europe/Warsaw",
	kraków: "Europe/Warsaw",
	krakow: "Europe/Warsaw",
	gdańsk: "Europe/Warsaw",
	gdansk: "Europe/Warsaw",
	wrocław: "Europe/Warsaw",
	poznań: "Europe/Warsaw",
	berlin: "Europe/Berlin",
	munich: "Europe/Berlin",
	zürich: "Europe/Zurich",
	zurich: "Europe/Zurich",
	vienna: "Europe/Vienna",
	prague: "Europe/Prague",
	london: "Europe/London",
	lisbon: "Europe/Lisbon",
	madrid: "Europe/Madrid",
	barcelona: "Europe/Madrid",
	bucharest: "Europe/Bucharest",
	kyiv: "Europe/Kyiv",
	"new york": "America/New_York",
	"san francisco": "America/Los_Angeles",
};

/** The candidate's time zone from their city, if we know it. */
export function zoneOf(place: string | null | undefined): string | null {
	if (!place) return null;
	const key = place.toLowerCase();
	return Object.entries(ZONES).find(([city]) => key.includes(city))?.[1] ?? null;
}
