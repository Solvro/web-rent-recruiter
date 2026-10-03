/**
 * One-click fixes the API offers on waiting items (RoleStatusView.waitingOn[].actions). Each id maps to one
 * procedure; the UI renders whatever the API sends.
 */
import type { WaitingAction } from "@scout/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { errorMessage } from "../errors";
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
					const { unsignedTx } = await api.roles.decide.mutate({
						roleId,
						candidateId: action.deliverableId ?? "",
						decision: action.id,
					});
					if (unsignedTx)
						await transact(unsignedTx, {
							pending: "Saving…",
							success: "Done.",
							receipt: action.id === "attended",
						});
					return;
				}
				case "report_candidate": {
					const res = await api.roles.reportCandidate.mutate({
						roleId,
						candidateId: action.deliverableId ?? "",
						reason: reason ?? "Reported by the company",
					});
					if (res.unsignedTx) await transact(res.unsignedTx, { pending: "Reporting…", success: "Reported." });
					return;
				}
				case "dismiss_report":
					return api.roles.dismissReport.mutate({ roleId, candidateId: action.deliverableId ?? "" });
			}
		},
		onError: (e) => toast.error(errorMessage(e)),
		onSettled: () => qc.invalidateQueries({ queryKey: ["roles"] }),
	});
}
