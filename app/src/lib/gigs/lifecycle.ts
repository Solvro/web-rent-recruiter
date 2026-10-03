/**
 * A role's money lifecycle beyond the agent: fund a role whose first deposit never landed, discard it, and see
 * what closing returns before closing (Stream B: roles.fund / discardDraft / closePreview).
 */
import { useQuery } from "@tanstack/react-query";
import { typedClient } from "../trpc";

export const lifecycleApi = {
	fund: (id: string) => typedClient.roles.fund.mutate({ id }),
	discardDraft: (id: string) => typedClient.roles.discardDraft.mutate({ id }),
};

export function useClosePreview(id: string, enabled: boolean) {
	return useQuery({
		queryKey: ["roles", "closePreview", id],
		queryFn: () => typedClient.roles.closePreview.query({ id }),
		enabled,
		retry: false,
	});
}
