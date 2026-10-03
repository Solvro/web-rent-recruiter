/**
 * One-click fixes the API offers on waiting items (RoleStatusView.waitingOn[].actions). Each id maps to one
 * procedure; the UI renders whatever the API sends.
 */
import type { WaitingAction } from "@scout/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { errorMessage } from "../errors";
import { formatMoney } from "../format";
import { typedClient } from "../trpc";
import { useTransact } from "../use-transact";

const REJECTING = /reject|no\b|pass|don.t/i;

export function useWaitingAction(roleId: string) {
	const qc = useQueryClient();
	const { transact } = useTransact();
	return useMutation({
		mutationFn: async ({ action, reason }: { action: WaitingAction; reason?: string }) => {
			const api = typedClient;
			switch (action.id) {
				case "raise_price":
					return api.roles.raiseGigPrice.mutate({ gigId: action.gigId ?? "", bounty: action.bounty ?? "0" });
				case "loosen_requirement":
					return api.roles.loosenRequirement.mutate({ roleId, criterionId: action.criterionId ?? "" });
				case "resend_confirmation":
					return api.candidate.resendConfirmation.mutate({ deliverableId: action.deliverableId ?? "" });
				case "acknowledge":
					return api.roles.ackEscalation.mutate({ roleId, activityId: action.activityId ?? "" });
				case "decide": {
					const reject = REJECTING.test(action.label);
					const { unsignedTx } = await api.deliverables.decide.mutate({
						id: action.deliverableId ?? "",
						decision: reject ? "reject" : "accept",
						reasonText: reason ?? (reject ? "Not for this role" : "Accepted by the company"),
					});
					if (unsignedTx) await transact(unsignedTx, { pending: "Saving…", success: "Done." });
					return;
				}
				case "invite":
				case "pass":
				case "attended": {
					const candidateId = action.candidateId ?? action.deliverableId ?? "";
					const released = action.id === "attended" ? await heldParts(roleId, candidateId) : null;
					const { unsignedTx } = await api.roles.decide.mutate({ roleId, candidateId, decision: action.id });
					if (unsignedTx)
						await transact(unsignedTx, {
							pending: action.id === "attended" ? "Releasing the held parts…" : "Saving…",
							success: released ? `Released: ${released}` : "Done.",
							receipt: action.id === "attended",
						});
					else toast(action.id === "invite" ? "Invited. Tell me when they come to the interview." : "Done.");
					return;
				}
				case "report_candidate": {
					const res = await api.roles.reportCandidate.mutate({
						roleId,
						candidateId: action.candidateId ?? action.deliverableId ?? "",
						reason: reason ?? "Reported by the company",
					});
					if (res.unsignedTx) await transact(res.unsignedTx, { pending: "Reporting…", success: "Reported." });
					return;
				}
				case "dismiss_report":
					return api.roles.dismissReport.mutate({
						roleId,
						candidateId: action.candidateId ?? action.deliverableId ?? "",
					});
			}
		},
		onError: (e) => toast.error(errorMessage(e)),
		onSettled: () => qc.invalidateQueries({ queryKey: ["roles"] }),
	});
}

/** "Lucía $6.75 · Ola $15.79": what each recruiter still has held for this candidate (released on attendance). */
async function heldParts(roleId: string, candidateId: string) {
	try {
		const c = await typedClient.roles.candidate.query({ roleId, candidateId });
		const by = new Map<string, bigint>();
		for (const p of c.payments)
			if (p.laterStatus === "HELD") by.set(p.recruiter, (by.get(p.recruiter) ?? 0n) + BigInt(p.later));
		return by.size
			? [...by].map(([who, amt]) => `${who.split(" ")[0]} ${formatMoney(amt)}`).join(" · ")
			: null;
	} catch {
		return null;
	}
}
