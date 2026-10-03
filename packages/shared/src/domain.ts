import { z } from "zod";
import { REJECT_REASONS } from "./constants.ts";

/** Base58 Solana address. */
export const Pubkey = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
/** Token amount in base units (6 decimals), as a decimal string so it survives JSON. */
export const BaseUnits = z.string().regex(/^\d+$/);

export const TaskType = z.enum(["SOURCING", "SCREENING_CALL", "REFERENCE_CHECK"]);
export const Seniority = z.enum(["JUNIOR", "MID", "SENIOR", "STAFF", "PRINCIPAL", "EXECUTIVE"]);
export const WorkMode = z.enum(["ONSITE", "HYBRID", "REMOTE"]);

export const Criterion = z.object({
	id: z.string(),
	label: z.string(),
	/** 1 (minor) .. 5 (critical). */
	weight: z.number().int().min(1).max(5),
});
export type Criterion = z.infer<typeof Criterion>;

export const Criteria = z.object({
	mustHave: z.array(Criterion),
	niceToHave: z.array(Criterion),
	seniority: Seniority,
	location: z.object({ mode: WorkMode, places: z.array(z.string()) }),
	salaryRange: z
		.object({ min: z.number(), max: z.number(), currency: z.string(), period: z.enum(["YEAR", "MONTH"]) })
		.nullable(),
	languages: z.array(z.string()),
	dealBreakers: z.array(Criterion),
});
export type Criteria = z.infer<typeof Criteria>;

export const CriterionVerdict = z.object({
	criterionId: z.string(),
	verdict: z.enum(["MET", "PARTIAL", "NOT_MET", "UNKNOWN"]),
	reasoning: z.string(),
});
export const Recommendation = z.enum(["ADVANCE", "MAYBE", "PASS"]);
export const AgentReview = z.object({
	score: z.number().int().min(0).max(100),
	verdicts: z.array(CriterionVerdict),
	recommendation: Recommendation,
	summary: z.string(),
});
export type AgentReview = z.infer<typeof AgentReview>;

export const RoleStatus = z.enum(["DRAFT", "OPEN", "CLOSED"]);
export const SubmissionStatus = z.enum(["PENDING", "ACCEPTED", "REJECTED"]);
export const RejectReason = z.enum(Object.keys(REJECT_REASONS) as [keyof typeof REJECT_REASONS]);
export type RejectReason = z.infer<typeof RejectReason>;
export const Decision = z.enum(["accept", "reject"]);
