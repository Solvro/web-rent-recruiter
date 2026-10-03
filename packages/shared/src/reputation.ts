/** Recruiter skills & reputation (no imports from other contract files: avoids init cycles). */
import { z } from "zod";

// ---- Recruiter skills & reputation ------------------------------------------------------

export const RecruiterSkill = z.object({
	skill: z.string(),
	/** self-declared, verified by an operator, earned from accepted gigs, or seeded demo history. */
	source: z.enum(["self", "operator", "earned", "seeded"]),
	verifiedBy: z.string().nullable(),
	count: z.number().int().optional(),
});
export const RecruiterReputation = z.object({
	/** 0–100: Wilson lower bound of acceptance × (1 + ½·advanced rate) − ¼·flags, 90-day half-life. */
	score: z.number().int(),
	byType: z.object({
		SOURCING: z.number().int(),
		SCREENING_CALL: z.number().int(),
		REFERENCE_CHECK: z.number().int(),
	}),
	/** Part of these numbers is seeded demo history (shown as such). */
	seededHistory: z.boolean(),
});
export const SetSkillsRequest = z.object({ skills: z.array(z.string().min(2).max(40)).max(30) });
/** An operator (signed in as its authority) verifies a skill of a recruiter it vouched for. */
export const VerifySkillRequest = z.object({
	wallet: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
	skill: z.string().min(2).max(40),
});
