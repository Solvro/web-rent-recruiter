/**
 * A role's money lifecycle beyond the agent: fund a role whose first deposit never landed, discard it, and see
 * what closing returns before closing. Stream B's roles.fund / discardDraft / closePreview (untyped until they're
 * in the router; parsed with the shared schemas).
 */
import { ClosePreview, FundRoleResponse } from "@scout/shared";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { untypedClient } from "../trpc";

export const lifecycleApi = {
	fund: async (id: string) => FundRoleResponse.parse(await untypedClient.mutation("roles.fund", { id })),
	discardDraft: async (id: string) =>
		z.object({ ok: z.boolean() }).parse(await untypedClient.mutation("roles.discardDraft", { id })),
};

export function useClosePreview(id: string, enabled: boolean) {
	return useQuery({
		queryKey: ["roles", "closePreview", id],
		queryFn: async () => ClosePreview.parse(await untypedClient.query("roles.closePreview", { id })),
		enabled,
		retry: false,
	});
}
