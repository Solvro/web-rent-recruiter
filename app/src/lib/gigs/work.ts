/**
 * One deliverable of the signed-in recruiter, in full (the "My work" detail page): what they sent, the agent's
 * review, the call transcript, the payout, and Edit / Withdraw while the agent hasn't decided.
 * Procedures from Stream B: gigs.work({ deliverableId }), gigs.edit({ deliverableId, note }), gigs.withdraw({ deliverableId }).
 */
import { type DeliverableView, GigWorkView } from "@scout/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { typedClient } from "../trpc";
import { useWallet } from "../wallet";

export { GigWorkView };
export type WorkKind = GigWorkView["kind"];

/** Language checks are screening calls with the "language" variant; never guess from the title. */
export function kindOfWork(d: DeliverableView): WorkKind {
	if (d.gigType === "SOURCING") return "sourcing";
	if (d.gigType === "REFERENCE_CHECK") return "reference";
	if (d.gigVariant === "language") return "language";
	if (d.deliverable.type === "SCREENING_CALL" && d.deliverable.assessedLevel) return "language";
	return "screening";
}

export function useWork(deliverableId: string) {
	const { address } = useWallet();
	return useQuery({
		queryKey: ["gigs", "work", deliverableId],
		queryFn: async () => typedClient.gigs.work.query({ deliverableId }),
		enabled: !!address,
		retry: false,
		refetchInterval: (q) => (q.state.data?.work.status === "PENDING" ? 2_000 : 10_000),
	});
}

export function useEditWork(deliverableId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (note: string) => typedClient.gigs.edit.mutate({ deliverableId, note }),
		onSettled: () => qc.invalidateQueries({ queryKey: ["gigs"] }),
	});
}

export function useWithdrawWork(deliverableId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: () => typedClient.gigs.withdraw.mutate({ deliverableId }),
		onSettled: () => qc.invalidateQueries({ queryKey: ["gigs"] }),
	});
}
