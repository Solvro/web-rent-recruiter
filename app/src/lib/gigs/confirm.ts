/**
 * Candidate confirmation (docs/strategy/verification-v2.md §1): a sourced profile is paid only after the candidate
 * says yes on a one-time public page (/c/<token>). Schemas and procedures come from Stream B.
 */
import type { CandidateConfirmRequest, CandidateView } from "@scout/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { z } from "zod";
import { typedClient } from "../trpc";

export type CandidateConfirmView = z.infer<typeof CandidateView>;
export type CandidateConfirmInput = z.infer<typeof CandidateConfirmRequest>;

export function useCandidateConfirm(token: string) {
	return useQuery({
		queryKey: ["candidate", token],
		queryFn: () => typedClient.candidate.view.query({ token }),
		retry: false,
	});
}

export function useCandidateRespond() {
	return useMutation({
		mutationFn: (input: CandidateConfirmInput) => typedClient.candidate.confirm.mutate(input),
	});
}
