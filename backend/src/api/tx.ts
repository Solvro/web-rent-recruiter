/** Relayed transactions (tRPC + deprecated REST). */

import { explorerTxUrl, type SubmitTxRequest, type SubmitTxResponse } from "@scout/shared";
import type { z } from "zod";
import { applyConfirmedTx } from "../indexer/apply-tx.ts";
import { relayUserTx } from "../solana/tx.ts";
import { onRelayed } from "./review.ts";

export async function submitTx(
	input: z.output<typeof SubmitTxRequest>,
	caller?: string,
): Promise<SubmitTxResponse> {
	const confirmed = await relayUserTx(input.signedTx, caller);
	// Reflect the new state in the very next query (the indexer reconciles later).
	await applyConfirmedTx(confirmed).catch((err) =>
		console.warn(`[tx] apply ${confirmed.signature}: ${(err as Error).message}`),
	);
	await onRelayed(input.signedTx, confirmed.signature).catch((err) =>
		console.warn(`[tx] after ${confirmed.signature}: ${(err as Error).message}`),
	);
	return { signature: confirmed.signature, explorerUrl: explorerTxUrl(confirmed.signature) };
}
