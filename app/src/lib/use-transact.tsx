import type { SubmitTxResponse, UnsignedTx } from "@scout/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { ExplorerLink } from "@/components/explorer-link";
import { ApiError, api, errorMessage } from "./api";
import { useWallet } from "./wallet";

/**
 * Sign a backend-built transaction with the user's wallet, hand it to the relayer
 * (which pays the fee), and confirm with a toast that links to the explorer.
 */
export function useTransact() {
	const wallet = useWallet();
	const queryClient = useQueryClient();
	const [pending, setPending] = useState(false);

	const transact = useCallback(
		async (unsigned: UnsignedTx, success: string): Promise<SubmitTxResponse | null> => {
			setPending(true);
			const id = toast.loading(unsigned.summary, { description: "Confirming…" });
			try {
				const signedTx = await wallet.signTransaction(unsigned.transaction);
				const res = await api.submitTx({ signedTx });
				toast.success(success, { id, description: <ExplorerLink signature={res.signature} /> });
				await queryClient.invalidateQueries();
				return res;
			} catch (e) {
				console.error("[transact]", unsigned.summary, e instanceof ApiError ? e.data : e);
				toast.error(errorMessage(e), { id, description: undefined });
				return null;
			} finally {
				setPending(false);
			}
		},
		[wallet, queryClient],
	);

	return { transact, pending };
}
