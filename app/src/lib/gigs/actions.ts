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
		mutationFn: async ({
			action,
			reason,
			decision,
		}: {
			action: WaitingAction;
			reason?: string;
			/** "decide" only: the company's choice, when the API offers one generic "Decide". */
			decision?: "accept" | "reject";
		}) => {
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
					const reject = decision ? decision === "reject" : REJECTING.test(action.label);
					const { unsignedTx } = await api.deliverables.decide.mutate({
						id: action.deliverableId ?? "",
						decision: reject ? "reject" : "accept",
						reasonText: reason ?? (reject ? "Not for this role" : "Accepted by the company"),
					});
					if (unsignedTx) await transact(unsignedTx, { pending: "Saving…", success: "Done." });
					return;
				}
				case "approve_proposal":
				case "decline_proposal":
					return api.roles.decideProposal.mutate({
						roleId,
						proposalId: action.proposalId ?? "",
						approve: action.id === "approve_proposal",
					});
				case "invite":
				case "pass":
				case "no_show":
				case "attended": {
					const candidateId = action.candidateId ?? action.deliverableId ?? "";
					const { unsignedTx, releases } = await api.roles.decide.mutate({
						roleId,
						candidateId,
						decision: action.id,
					});
					const released = releases?.length
						? releases.map((x) => `${x.recruiter.split(" ")[0]} ${formatMoney(x.amount)}`).join(" · ")
						: null;
					if (unsignedTx)
						await transact(unsignedTx, {
							pending:
								action.id === "attended"
									? "Releasing the held parts…"
									: action.id === "no_show"
										? "Returning the held parts to your budget…"
										: "Saving…",
							success: released
								? `Released: ${released}`
								: action.id === "no_show"
									? "Noted. The held parts went back to your budget."
									: "Done.",
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
