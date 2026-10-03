/** @deprecated REST transport; the app uses tRPC (src/trpc). Kept for scripts. */
import { Me, UpsertMeRequest } from "@scout/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { getMe, upsertMe } from "../api/me.ts";
import { requireWallet } from "../http.ts";

export const meRoutes: FastifyPluginAsyncZod = async (app) => {
	app.get("/me", { schema: { response: { 200: Me } } }, async (req) => getMe(await requireWallet(req)));
	app.put("/me", { schema: { body: UpsertMeRequest, response: { 200: Me } } }, async (req) =>
		upsertMe(await requireWallet(req), req.body),
	);
};
