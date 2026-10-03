/**
 * Who checks the work (Scout agent, the company's own agent, or the company by hand), the company's review queue
 * and recruiters' appeals. Stream B's procedures: roles.reviewer / setReviewer / reviewQueue, deliverables.decide,
 * submissions.appeal / decideAppeal.
 */
import type { CompanyDeliverable, ReviewerMode } from "@scout/shared";
import { useQuery } from "@tanstack/react-query";
import type { z } from "zod";
import { typedClient } from "../trpc";

export type ReviewerModeValue = z.infer<typeof ReviewerMode>;
export type ReviewItem = z.infer<typeof CompanyDeliverable>;

/** On-record categories; the company's own words go to the recruiter. */
export const REJECT_REASONS = [
	{ code: "NOT_MATCHING", label: "Not a match" },
	{ code: "NOT_INTERESTED", label: "Not interested" },
	{ code: "ALREADY_IN_PIPELINE", label: "Already in our pipeline" },
	{ code: "OTHER", label: "Other" },
] as const;
export type RejectCode = (typeof REJECT_REASONS)[number]["code"];

export function useReviewer(roleId: string) {
	return useQuery({
		queryKey: ["roles", "reviewer", roleId],
		queryFn: () => typedClient.roles.reviewer.query({ roleId }),
	});
}

export function useReviewQueue(roleId: string, enabled: boolean) {
	return useQuery({
		queryKey: ["roles", "reviewQueue", roleId],
		queryFn: () => typedClient.roles.reviewQueue.query({ roleId }),
		enabled,
		refetchInterval: 3_000,
	});
}

export const reviewApi = {
	setReviewer: (roleId: string, mode: ReviewerModeValue, agentPubkey?: string) =>
		typedClient.roles.setReviewer.mutate(
			mode === "custom" ? { roleId, mode, agentPubkey: agentPubkey ?? "" } : { roleId, mode },
		),
	decide: (id: string, decision: "accept" | "reject", reasonText: string, reasonCode?: RejectCode) =>
		typedClient.deliverables.decide.mutate({ id, decision, reasonText, reasonCode }),
	appeal: (id: string, reason: string) => typedClient.submissions.appeal.mutate({ id, reason }),
	decideAppeal: (id: string, decision: "overturn" | "uphold", note?: string) =>
		typedClient.submissions.decideAppeal.mutate({ id, decision, note }),
};
