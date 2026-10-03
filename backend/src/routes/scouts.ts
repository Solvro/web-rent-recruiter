import { Pubkey, RegisterScoutResponse, ScoutPublicProfile } from "@scout/shared";
import { address } from "@solana/kit";
import { and, desc, eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { HttpError, notFound, requireWallet } from "../http.ts";
import {
	fetchProgramAccount,
	findScoutProfilePda,
	loadDeployment,
	type ScoutProfileAccount,
} from "../solana/chain.ts";
import { isScoutRegistered, registerScoutIx } from "../solana/scout.ts";
import { buildUnsignedTx } from "../solana/tx.ts";

export const scoutRoutes: FastifyPluginAsyncZod = async (app) => {
	app.post("/scouts/register", { schema: { response: { 200: RegisterScoutResponse } } }, async (req) => {
		const wallet = requireWallet(req);
		if (await isScoutRegistered(wallet))
			throw new HttpError(409, "ALREADY_REGISTERED", "scout already registered");
		return {
			unsignedTx: await buildUnsignedTx([await registerScoutIx(wallet)], "Create your public scout profile"),
		};
	});

	app.get(
		"/scouts/:pubkey",
		{ schema: { params: z.object({ pubkey: Pubkey }), response: { 200: ScoutPublicProfile } } },
		async (req) => {
			const wallet = req.params.pubkey;
			const [acc] = await db.select().from(schema.accounts).where(eq(schema.accounts.wallet, wallet));
			if (!acc) throw notFound("scout");

			let profileAddress: string | null = null;
			let onchain: ScoutProfileAccount | null = null;
			if (loadDeployment()) {
				const pda = await findScoutProfilePda(address(wallet));
				onchain = await fetchProgramAccount<ScoutProfileAccount>("ScoutProfile", pda).catch(() => null);
				if (onchain) profileAddress = pda;
			}
			const recent = await db
				.select({
					id: schema.submissions.id,
					status: schema.submissions.status,
					submittedAt: schema.submissions.submittedAt,
					roleTitle: schema.roles.title,
				})
				.from(schema.submissions)
				.innerJoin(schema.roles, eq(schema.roles.id, schema.submissions.roleId))
				.where(and(eq(schema.submissions.scoutWallet, wallet), eq(schema.submissions.confirmed, true)))
				.orderBy(desc(schema.submissions.submittedAt))
				.limit(10);

			// Off-chain fallback only when the profile isn't on-chain yet (e.g. seeded demo scouts).
			const fallback = {
				submitted: recent.length,
				accepted: recent.filter((r) => r.status === "ACCEPTED").length,
				rejected: recent.filter((r) => r.status === "REJECTED").length,
				totalEarned: "0",
			};
			return {
				wallet,
				displayName: acc.displayName,
				avatarUrl: acc.avatarUrl,
				reputation: onchain
					? {
							submitted: Number(onchain.submitted),
							accepted: Number(onchain.accepted),
							rejected: Number(onchain.rejected),
							totalEarned: onchain.totalEarned.toString(),
						}
					: fallback,
				profileAddress,
				recent: recent.map((r) => ({ ...r, submittedAt: r.submittedAt.toISOString() })),
			};
		},
	);
};
