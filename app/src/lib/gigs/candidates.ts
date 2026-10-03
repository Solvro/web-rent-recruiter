/**
 * The company's view of every candidate on a role: a list, and one candidate in full (the recruiter's note, the
 * agent's per-criterion verdicts, every call with answers and transcript, confirmation and payments).
 * Mock first; this shape is the contract asked from Stream B (candidates.list / byId / update / note).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { untypedClient } from "../trpc";

export const CandidateStage = z.enum([
	"PROFILE",
	"CONFIRMED",
	"SCREENED",
	"LANGUAGE",
	"REFERENCE",
	"SHORTLISTED",
	"PASSED",
]);
export type CandidateStage = z.infer<typeof CandidateStage>;

export const RoleCandidate = z.object({
	id: z.string(),
	name: z.string(),
	avatarUrl: z.string().nullable(),
	title: z.string().nullable(),
	location: z.string().nullable(),
	profileUrl: z.string(),
	score: z.number().nullable(),
	stage: CandidateStage,
	sourcedBy: z.object({ wallet: z.string(), displayName: z.string() }),
	updatedAt: z.string(),
});
export type RoleCandidate = z.infer<typeof RoleCandidate>;

const CallItem = z.object({
	question: z.string(),
	answer: z.string(),
	/** The agent's check of this answer. */
	check: z.enum(["ok", "missing", "contradicts"]),
});
export const CandidateCall = z.object({
	kind: z.enum(["SCREENING", "LANGUAGE", "REFERENCE"]),
	deliverableId: z.string(),
	recruiter: z.string(),
	status: z.enum(["PENDING", "ACCEPTED", "REJECTED"]),
	score: z.number().nullable(),
	summary: z.string().nullable(),
	recommendation: z.string().nullable(),
	evidence: z.enum(["recording", "self-reported"]).nullable(),
	/** Self-reported calls: did the candidate confirm the call happened? */
	callConfirmed: z.enum(["PENDING", "YES", "NO"]).nullable(),
	level: z.string().nullable(),
	referee: z.string().nullable(),
	items: z.array(CallItem),
	transcript: z.array(z.object({ speaker: z.string(), text: z.string(), startSec: z.number() })).nullable(),
	recordingUrl: z.string().nullable(),
});
export type CandidateCall = z.infer<typeof CandidateCall>;

export const CandidateDetail = RoleCandidate.extend({
	note: z.string(),
	verdicts: z.array(
		z.object({
			label: z.string(),
			verdict: z.enum(["MET", "PARTIAL", "NOT_MET", "UNKNOWN"]),
			reasoning: z.string(),
		}),
	),
	summary: z.string().nullable(),
	confirmation: z
		.object({ status: z.enum(["PENDING", "YES", "NO", "EXPIRED"]), respondedAt: z.string().nullable() })
		.nullable(),
	calls: z.array(CandidateCall),
	payments: z.array(
		z.object({
			to: z.string(),
			what: z.string(),
			amount: z.string(),
			status: z.enum(["PAID", "HELD", "RELEASED", "REFUNDED"]),
			signature: z.string().nullable(),
		}),
	),
	companyNote: z.string().nullable(),
	decision: z.enum(["NONE", "INVITED", "ATTENDED", "PASSED"]),
});
export type CandidateDetail = z.infer<typeof CandidateDetail>;

export function useCandidates(roleId: string) {
	return useQuery({
		queryKey: ["roles", "candidates", roleId],
		queryFn: async () =>
			z.array(RoleCandidate).parse(await untypedClient.query("candidates.list", { roleId })),
		refetchInterval: 4_000,
	});
}

export function useCandidate(roleId: string, candidateId: string | null) {
	return useQuery({
		queryKey: ["roles", "candidate", roleId, candidateId],
		queryFn: async () =>
			CandidateDetail.parse(await untypedClient.query("candidates.byId", { roleId, candidateId })),
		enabled: !!candidateId,
		refetchInterval: 4_000,
	});
}

export function useCandidateAction(roleId: string, candidateId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (v: { action: "accept" | "pass" | "shortlist" | "remove"; reason?: string }) =>
			untypedClient.mutation("candidates.update", { roleId, candidateId, ...v }),
		onSettled: () => qc.invalidateQueries({ queryKey: ["roles"] }),
	});
}

export function useCandidateNote(roleId: string, candidateId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (note: string) => untypedClient.mutation("candidates.note", { roleId, candidateId, note }),
		onSettled: () => qc.invalidateQueries({ queryKey: ["roles", "candidate", roleId, candidateId] }),
	});
}

export const STAGE_LABEL: Record<CandidateStage, string> = {
	PROFILE: "Profile",
	CONFIRMED: "Confirmed",
	SCREENED: "Screened",
	LANGUAGE: "Language checked",
	REFERENCE: "Reference checked",
	SHORTLISTED: "Shortlisted",
	PASSED: "Passed",
};
