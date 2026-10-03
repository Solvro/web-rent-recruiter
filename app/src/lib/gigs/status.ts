/**
 * roles.status (Stream B): what the agent does now, who it waits on, pipeline counts, one budget snapshot and the
 * next check. Refetched on the role.status live event and polled as a fallback.
 */
import type { RoleStatusView } from "@scout/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { typedClient } from "../trpc";
import { useTransact } from "../use-transact";

export type RoleStatus = RoleStatusView;
export type Waiting = RoleStatusView["waitingOn"][number];

export function useRoleStatus(roleId: string) {
	return useQuery({
		queryKey: ["roles", "status", roleId],
		queryFn: () => typedClient.roles.status.query({ roleId }),
		refetchInterval: 2_000,
	});
}

/** The company's yes/no on a delivery the agent asked about (same procedure as a manual review). */
export function useDecideDelivery() {
	const qc = useQueryClient();
	const { transact } = useTransact();
	return useMutation({
		mutationFn: async (v: { id: string; accept: boolean }) => {
			const { unsignedTx } = await typedClient.submissions.decide.mutate(
				v.accept
					? { id: v.id, decision: "accept" }
					: { id: v.id, decision: "reject", reasonCode: "NOT_MATCHING" },
			);
			if (unsignedTx) await transact(unsignedTx, { pending: "Saving…", success: "Done." });
		},
		onSettled: () => qc.invalidateQueries({ queryKey: ["roles"] }),
	});
}
