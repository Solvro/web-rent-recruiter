import { describe, expect, it } from "vitest";
import { canSeeCandidate, gigCandidate } from "./gig-privacy.ts";

const karolina = {
	id: "sub-1",
	name: "Karolina Mazurek",
	profileUrl: "https://linkedin.com/in/karolina-mazurek-backend-demo",
	notes: "7 years as a backend engineer, the last 3 in TypeScript at a Warsaw logistics scale-up.",
	card: {
		avatarUrl: "/avatars/karolina-mazurek.webp",
		currentTitle: "Senior Backend Engineer",
		currentCompany: "Fleetline (logistics scale-up)",
		location: "Warsaw, Poland",
	},
};
const COMPANY = "Company111111111111111111111111111111111111";
const CLAIMANT = "Claimant11111111111111111111111111111111111";
const OTHER = "Other111111111111111111111111111111111111111";

describe("gig candidate privacy", () => {
	it("only the claimant and the company see who the candidate is", () => {
		const gig = { claimantWallet: CLAIMANT };
		expect(canSeeCandidate(CLAIMANT, gig, COMPANY)).toBe(true);
		expect(canSeeCandidate(COMPANY, gig, COMPANY)).toBe(true);
		expect(canSeeCandidate(OTHER, gig, COMPANY)).toBe(false);
		expect(canSeeCandidate(null, gig, COMPANY)).toBe(false);
		expect(canSeeCandidate(OTHER, { claimantWallet: null }, COMPANY)).toBe(false);
	});

	it("redacted view carries no identifying data", () => {
		const v = gigCandidate(karolina, false, "SENIOR");
		expect(v).toEqual({
			redacted: true,
			summary: { headline: "Senior backend engineer · 7 yrs", city: "Warsaw", seniority: "SENIOR" },
			id: null,
			name: null,
			profileUrl: null,
			card: null,
		});
		const json = JSON.stringify(v);
		for (const secret of ["Karolina", "Mazurek", "linkedin", "Fleetline", "avatars"])
			expect(json).not.toContain(secret);
	});

	it("full view for the claimant", () => {
		const v = gigCandidate(karolina, true, "SENIOR");
		expect(v.redacted).toBe(false);
		expect(v.name).toBe("Karolina Mazurek");
		expect(v.card?.currentCompany).toContain("Fleetline");
	});
});
