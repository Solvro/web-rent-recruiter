import { explorerTxUrl, SubmitTxRequest, SubmitTxResponse } from "@scout/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { subscribe } from "../events.ts";
import { processSignature } from "../indexer/sync.ts";
import { relayUserTx } from "../solana/tx.ts";

export const txRoutes: FastifyPluginAsyncZod = async (app) => {
	app.post(
		"/tx/submit",
		{ schema: { body: SubmitTxRequest, response: { 200: SubmitTxResponse } } },
		async (req) => {
			const signature = await relayUserTx(req.body.signedTx);
			// Apply events right away so the UI sees the new state on its next fetch (indexer would also catch it).
			await processSignature(signature).catch((err) =>
				req.log.warn(`processSignature: ${(err as Error).message}`),
			);
			return { signature, explorerUrl: explorerTxUrl(signature) };
		},
	);

	/** Server-sent events: role/submission updates from the indexer. */
	app.get("/events", (req, reply) => {
		reply.raw.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
			"access-control-allow-origin": req.headers.origin ?? "*",
		});
		reply.raw.write(": connected\n\n");
		const unsubscribe = subscribe((e) => reply.raw.write(`data: ${JSON.stringify(e)}\n\n`));
		const ping = setInterval(() => reply.raw.write(": ping\n\n"), 25_000);
		req.raw.on("close", () => {
			clearInterval(ping);
			unsubscribe();
		});
		return reply;
	});
};
