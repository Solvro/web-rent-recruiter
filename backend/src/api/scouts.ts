/** Recruiter (scout) use-cases (tRPC + deprecated REST). */
import type { RegisterScoutResponse, ScoutProfileRequest, ScoutPublicProfile } from "@scout/shared";
import { type Address, address } from "@solana/kit";
import { and, desc, eq } from "drizzle-orm";
import type { z } from "zod";
import { db, schema } from "../db/index.ts";
import { HttpError, notFound } from "../http.ts";
import { recruiterProfile, reputationScores } from "../lib/recruiter-profile.ts";
import { loadDeployment, scoutChainInfo } from "../solana/chain.ts";
import { isScoutRegistered, registerScoutIx } from "../solana/scout.ts";
import { buildUnsignedTx } from "../solana/tx.ts";

export async function registerScout(wallet: Address): Promise<z.output<typeof RegisterScoutResponse>> {
	if (await isScoutRegistered(wallet))
		throw new HttpError(409, "ALREADY_REGISTERED", "scout already registered");
	return {
		unsignedTx: await buildUnsignedTx([await registerScoutIx(wallet)], "Create your public scout profile"),
	};
}

export async function scoutProfile(by: z.output<typeof ScoutProfileRequest>): Promise<ScoutPublicProfile> {
	const [acc] = await db
		.select()
		.from(schema.accounts)
		.where("wallet" in by ? eq(schema.accounts.wallet, by.wallet) : eq(schema.accounts.slug, by.slug));
	if (!acc) throw notFound("scout");
	const wallet = acc.wallet;

	const info = loadDeployment() ? await scoutChainInfo(address(wallet)).catch(() => null) : null;
	const onchain = info?.profile ?? null;
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
		advanced: 0,
		flagged: 0,
	};
	return {
		wallet,
		slug: acc.slug ?? wallet,
		displayName: acc.displayName,
		avatarUrl: acc.avatarUrl,
		reputation: onchain
			? {
					submitted: Number(onchain.submitted),
					accepted: Number(onchain.accepted),
					rejected: Number(onchain.rejected),
					totalEarned: onchain.totalEarned.toString(),
					advanced: Number(onchain.advanced),
					flagged: Number(onchain.flagged),
				}
			: fallback,
		profileAddress: onchain ? (info?.profileAddress ?? null) : null,
		operator: info?.operator ? { name: info.operator.name, feeBps: Number(info.operator.feeBps) } : null,
		...(await (async () => {
			const rec = await recruiterProfile(wallet).catch(() => null);
			return rec
				? {
						skills: rec.details.skills,
						score: { ...reputationScores(rec.details.stats), seededHistory: rec.details.seeded },
					}
				: {};
		})()),
		recent: recent.map((r) => ({ ...r, submittedAt: r.submittedAt.toISOString() })),
	};
}
