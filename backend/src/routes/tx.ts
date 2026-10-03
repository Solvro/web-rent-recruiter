/** @deprecated REST transport; the app uses tRPC (src/trpc). Kept for scripts. */
import { SubmitTxRequest, SubmitTxResponse } from "@scout/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { submitTx } from "../api/tx.ts";
import { subscribe } from "../events.ts";

export const txRoutes: FastifyPluginAsyncZod = async (app) => {
	app.post("/tx/submit", { schema: { body: SubmitTxRequest, response: { 200: SubmitTxResponse } } }, (req) =>
		submitTx(req.body),
	);

	/** Server-sent events: role/submission updates from the indexer. Superseded by the tRPC `events` subscription. */
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
