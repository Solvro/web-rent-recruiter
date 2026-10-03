import type { Deliverable } from "@scout/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { inCents } from "../payout";
import { typedClient } from "../trpc";
import { useWallet } from "../wallet";
import type { GigView, RoleActivityView as RoleActivity } from "./schemas";

const api = typedClient;

/** Open gigs on the board (exclusive ones only while unclaimed or claimed by you). */
export function useGigs() {
	// Public: logged-out visitors browse the board too.
	return useQuery({
		queryKey: ["gigs", "list"],
		queryFn: () => api.gigs.list.query({}),
		refetchInterval: 5_000,
	});
}

export function useGig(id: string) {
	return useQuery({ queryKey: ["gigs", "byId", id], queryFn: () => api.gigs.byId.query({ id }) });
}

/** Everything the recruiter delivered, newest first. Polls while the agent is checking. */
export function useMyWork() {
	const { address } = useWallet();
	return useQuery({
		queryKey: ["gigs", "mine"],
		queryFn: async () => (await api.gigs.mine.query()).deliverables,
		enabled: !!address,
		refetchInterval: (q) => (q.state.data?.some((d) => d.status === "PENDING") ? 1_500 : 8_000),
	});
}

export function useRoleActivity(roleId: string) {
	return useQuery({
		queryKey: ["roles", "activity", roleId],
		queryFn: () => api.roles.activity.query({ roleId }),
		refetchInterval: 2_000,
	});
}

export function useShortlist(roleId: string) {
	return useQuery({
		queryKey: ["roles", "shortlist", roleId],
		queryFn: () => api.roles.shortlist.query({ roleId }),
		refetchInterval: 4_000,
	});
}

/** The notetaker on a call gig (Stream E). Polls while it is joining or recording. */
export function useRecording(gigId: string, enabled: boolean) {
	return useQuery({
		queryKey: ["recall", gigId],
		queryFn: () => api.recall.status.query({ gigId }),
		enabled,
		refetchInterval: (q) => {
			const s = q.state.data?.status;
			return s && s !== "done" && s !== "failed" ? 2_000 : false;
		},
	});
}

export const gigApi = {
	inviteNotetaker: (gigId: string, meetingUrl: string) => api.recall.invite.mutate({ gigId, meetingUrl }),
	stopNotetaker: (gigId: string) => api.recall.stop.mutate({ gigId }),
	claim: (id: string) => api.gigs.claim.mutate({ id }),
	deliver: (gigId: string, deliverable: Deliverable) => api.gigs.deliver.mutate({ gigId, deliverable }),
	decide: (roleId: string, candidateId: string, decision: "invite" | "pass" | "attended") =>
		api.roles.decide.mutate({ roleId, candidateId, decision }),
	message: (roleId: string, text: string) => api.roles.message.mutate({ roleId, text }),
};

/** Post a message to the agent; the thread refreshes immediately so it feels like chat. */
export function useSendMessage(roleId: string) {
	const qc = useQueryClient();
	const key = ["roles", "activity", roleId];
	return useMutation({
		mutationFn: (text: string) => gigApi.message(roleId, text),
		// Show Hanna's message at once; the agent's "Thinking…" follows it until the reply lands.
		onMutate: async (text) => {
			await qc.cancelQueries({ queryKey: key });
			const prev = qc.getQueryData<RoleActivity>(key);
			if (prev)
				qc.setQueryData<RoleActivity>(key, {
					...prev,
					items: [
						...prev.items,
						{
							id: `pending-${Date.now()}`,
							roleId,
							kind: "COMPANY_MESSAGE",
							message: text,
							gigId: null,
							deliverableId: null,
							signature: null,
							explorerUrl: null,
							solscanUrl: null,
							createdAt: new Date().toISOString(),
						},
					],
				});
			return { prev };
		},
		onError: (_e, _t, ctx) => ctx?.prev && qc.setQueryData(key, ctx.prev),
		onSettled: () => qc.invalidateQueries({ queryKey: key }),
	});
}

/** What this recruiter actually receives per accepted deliverable (their operator's cut taken out). */
export function earnFor(gig: Pick<GigView, "payout">, operatorFeeBps = 0) {
	const total = BigInt(gig.payout.now) + BigInt(gig.payout.later);
	return total - (total * BigInt(operatorFeeBps)) / 10_000n;
}

/** The same split for this recruiter: what arrives on acceptance, and what waits for the interview. */
export function splitFor(gig: Pick<GigView, "payout">, operatorFeeBps = 0) {
	const total = earnFor(gig, operatorFeeBps);
	const held = BigInt(gig.payout.later);
	const later = held - (held * BigInt(operatorFeeBps)) / 10_000n;
	return { total, ...inCents(total - later, later) };
}
