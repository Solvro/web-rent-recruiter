import { Me, UpsertMeRequest } from "@scout/shared";
import { eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { db, schema } from "../db/index.ts";
import { notFound, requireWallet } from "../http.ts";
import { loadDeployment, usdcBalanceOf } from "../solana/chain.ts";
import { isScoutRegistered } from "../solana/scout.ts";

export const meRoutes: FastifyPluginAsyncZod = async (app) => {
	app.get("/me", { schema: { response: { 200: Me } } }, async (req) => {
		const wallet = requireWallet(req);
		const [acc] = await db.select().from(schema.accounts).where(eq(schema.accounts.wallet, wallet));
		if (!acc) throw notFound("account");
		return toMe(acc);
	});

	app.put("/me", { schema: { body: UpsertMeRequest, response: { 200: Me } } }, async (req) => {
		const wallet = requireWallet(req);
		const values = {
			kind: req.body.kind,
			displayName: req.body.displayName,
			avatarUrl: req.body.avatarUrl ?? null,
			companyName: req.body.kind === "company" ? (req.body.companyName ?? req.body.displayName) : null,
		};
		const [acc] = await db
			.insert(schema.accounts)
			.values({ wallet, ...values })
			.onConflictDoUpdate({ target: schema.accounts.wallet, set: values })
			.returning();
		return toMe(acc);
	});
};

async function toMe(acc: typeof schema.accounts.$inferSelect) {
	const chainReady = loadDeployment() !== null;
	const wallet = acc.wallet as Parameters<typeof usdcBalanceOf>[0];
	const [balance, registered] = chainReady
		? await Promise.all([
				usdcBalanceOf(wallet).catch(() => 0n),
				acc.kind === "scout" ? isScoutRegistered(wallet).catch(() => false) : Promise.resolve(false),
			])
		: [0n, false];
	return {
		wallet: acc.wallet,
		kind: acc.kind,
		displayName: acc.displayName,
		avatarUrl: acc.avatarUrl,
		companyName: acc.companyName,
		scoutRegistered: registered,
		usdcBalance: balance.toString(),
	};
}
