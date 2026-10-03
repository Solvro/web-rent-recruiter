/**
 * The company's candidates (Stream B: roles.candidates / roles.candidate / roles.payments, candidates.update /
 * addNote / deleteNote / remove). Shapes come from @scout/shared (candidates.ts).
 */
import type { CallDetail, CandidateDetail, CandidateRow, CandidateStage } from "@scout/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { typedClient } from "../trpc";
import { useTransact } from "../use-transact";

export type { CallDetail, CandidateDetail, CandidateRow, CandidateStage };

export function useCandidates(roleId: string) {
	return useQuery({
		queryKey: ["roles", "candidates", roleId],
		queryFn: () => typedClient.roles.candidates.query({ roleId }),
		refetchInterval: 4_000,
	});
}

export function useCandidate(roleId: string, candidateId: string | null) {
	return useQuery({
		queryKey: ["roles", "candidate", roleId, candidateId],
		queryFn: () => typedClient.roles.candidate.query({ roleId, candidateId: candidateId ?? "" }),
		enabled: !!candidateId,
		refetchInterval: 4_000,
	});
}

export function usePayments(roleId: string, enabled: boolean) {
	return useQuery({
		queryKey: ["roles", "payments", roleId],
		queryFn: () => typedClient.roles.payments.query({ roleId }),
		enabled,
	});
}

/** Accept / pass over the agent, or pass-and-hide. Money-moving changes come back as a tx to sign. */
export function useCandidateAction(candidateId: string) {
	const qc = useQueryClient();
	const { transact } = useTransact();
	return useMutation({
		mutationFn: async (action: "accept" | "pass" | "remove") => {
			const res =
				action === "remove"
					? await typedClient.candidates.remove.mutate({ candidateId })
					: await typedClient.candidates.update.mutate({ candidateId, stageOverride: action });
			if (res.unsignedTx)
				await transact(res.unsignedTx, {
					pending: "Saving…",
					success: action === "accept" ? "Accepted." : action === "pass" ? "Passed." : "Removed.",
				});
		},
		onSettled: () => qc.invalidateQueries({ queryKey: ["roles"] }),
	});
}

export function useCandidateNotes(roleId: string, candidateId: string) {
	const qc = useQueryClient();
	const key = ["roles", "candidate", roleId, candidateId];
	const add = useMutation({
		mutationFn: (text: string) => typedClient.candidates.addNote.mutate({ candidateId, text }),
		onSettled: () => qc.invalidateQueries({ queryKey: key }),
	});
	const remove = useMutation({
		mutationFn: (noteId: string) => typedClient.candidates.deleteNote.mutate({ noteId }),
		onSettled: () => qc.invalidateQueries({ queryKey: key }),
	});
	return { add, remove };
}

export const STAGE_LABEL: Record<CandidateStage, string> = {
	REVIEWING: "Agent is reviewing",
	CONFIRMING: "Waiting for their yes",
	REJECTED: "Not accepted",
	ACCEPTED: "Confirmed",
	IN_CALLS: "In calls",
	SHORTLISTED: "Shortlisted",
	INVITED: "Invited",
	ATTENDED: "Interviewed",
	PASSED: "Passed",
};
