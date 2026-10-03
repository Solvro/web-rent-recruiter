/** @deprecated REST transport; the app uses tRPC (src/trpc). Kept for scripts. */
import { Pubkey, RegisterScoutResponse, ScoutPublicProfile } from "@scout/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { registerScout, scoutProfile } from "../api/scouts.ts";
import { requireWallet } from "../http.ts";

export const scoutRoutes: FastifyPluginAsyncZod = async (app) => {
	app.post("/scouts/register", { schema: { response: { 200: RegisterScoutResponse } } }, async (req) =>
		registerScout(await requireWallet(req)),
	);
	app.get(
		"/scouts/:pubkey",
		// Accepts a wallet or a profile slug.
		{ schema: { params: z.object({ pubkey: z.string() }), response: { 200: ScoutPublicProfile } } },
		(req) =>
			scoutProfile(
				Pubkey.safeParse(req.params.pubkey).success
					? { wallet: req.params.pubkey }
					: { slug: req.params.pubkey },
			),
	);
};
