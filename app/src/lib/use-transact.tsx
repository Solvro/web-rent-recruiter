import type { SubmitTxResponse, UnsignedTx } from "@scout/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { Receipt } from "@/components/receipt";
import { errorData, errorMessage } from "./errors";
import { useTRPCClient } from "./trpc";
import { useWallet } from "./wallet";

/**
 * Confirm an action the backend prepared. The user's account approves it silently,
 * our service covers the fees, and a quiet "Receipt" link is the only trace.
 */
export function useTransact() {
	const wallet = useWallet();
	const client = useTRPCClient();
	const queryClient = useQueryClient();
	const [pending, setPending] = useState(false);

	const transact = useCallback(
		async (
			unsigned: UnsignedTx,
			labels: { pending: string; success: string; receipt?: boolean },
		): Promise<SubmitTxResponse | null> => {
			setPending(true);
			const id = toast.loading(labels.pending);
			try {
				const signedTx = await wallet.signTransaction(unsigned.transaction);
				// Roles reviewed by the company or its own agent: they co-sign later, nothing lands yet.
				if (unsigned.cosigner) {
					await client.tx.submitForCosign.mutate({ signedTx });
					toast.success("Sent. Waiting for the company to approve.", { id });
					await queryClient.invalidateQueries();
					return { signature: "", explorerUrl: "" };
				}
				const res = await client.tx.submit.mutate({ signedTx });
				toast.success(labels.success, {
					id,
					description: labels.receipt ? <Receipt signature={res.signature} /> : undefined,
					// Long enough to reach the Receipt link.
					duration: labels.receipt ? 10_000 : undefined,
				});
				await queryClient.invalidateQueries();
				return res;
			} catch (e) {
				console.error("[transact]", unsigned.summary, errorData(e) ?? e);
				toast.error(errorMessage(e), { id, description: undefined });
				return null;
			} finally {
				setPending(false);
			}
		},
		[wallet, client, queryClient],
	);

	return { transact, pending };
}
