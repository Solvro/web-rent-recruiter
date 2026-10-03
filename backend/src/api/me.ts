/** Account use-cases (tRPC + deprecated REST). */
import type { Me, UpsertMeRequest } from "@scout/shared";
import { type Address, address } from "@solana/kit";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";
import { db, schema } from "../db/index.ts";
import { HttpError, notFound } from "../http.ts";
import { recruiterProfile, reputationScores } from "../lib/recruiter-profile.ts";
import { uniqueSlug } from "../lib/slug.ts";
import { loadDeployment, scoutChainInfo, usdcBalanceOf } from "../solana/chain.ts";

/** The caller's account, or null if they haven't created a profile yet. */
export async function findMe(wallet: Address): Promise<Me | null> {
	const [acc] = await db.select().from(schema.accounts).where(eq(schema.accounts.wallet, wallet));
	return acc ? toMe(acc) : null;
}

export async function getMe(wallet: Address): Promise<Me> {
	const me = await findMe(wallet);
	if (!me) throw notFound("account");
	return me;
}

const validTimeZone = (tz: string) => {
	try {
		new Intl.DateTimeFormat("en", { timeZone: tz });
		return true;
	} catch {
		return false;
	}
};

export async function upsertMe(wallet: Address, input: z.output<typeof UpsertMeRequest>): Promise<Me> {
	const values = {
		kind: input.kind,
		displayName: input.displayName,
		avatarUrl: input.avatarUrl ?? null,
		companyName: input.kind === "company" ? (input.companyName ?? input.displayName) : null,
		// Keep the stored zone when the client doesn't send one.
		...(input.timeZone && validTimeZone(input.timeZone) ? { timeZone: input.timeZone } : {}),
	};
	const [existing] = await db.select().from(schema.accounts).where(eq(schema.accounts.wallet, wallet));
	// Keep a slug once given (shared links stay valid); create one for new accounts.
	const slug = existing?.slug ?? (await uniqueSlug(db, input.displayName, wallet));
	const [acc] = await db
		.insert(schema.accounts)
		.values({ wallet, slug, ...values })
		.onConflictDoUpdate({ target: schema.accounts.wallet, set: { ...values, slug } })
		.returning();
	return toMe(acc);
}

async function toMe(acc: typeof schema.accounts.$inferSelect) {
	const wallet = address(acc.wallet);
	if (!loadDeployment())
		return { ...profileFields(acc), scoutRegistered: false, usdcBalance: "0", operator: null };
	const [balance, info] = await Promise.all([
		usdcBalanceOf(wallet).catch(() => 0n),
		acc.kind === "scout" ? scoutChainInfo(wallet).catch(() => null) : Promise.resolve(null),
	]);
	const rec = acc.kind === "scout" ? await recruiterProfile(acc.wallet).catch(() => null) : null;
	return {
		...profileFields(acc),
		...(rec
			? {
					skills: rec.details.skills,
					reputation: { ...reputationScores(rec.details.stats), seededHistory: rec.details.seeded },
				}
			: {}),
		scoutRegistered: Boolean(info?.profile),
		usdcBalance: balance.toString(),
		// On-chain ScoutProfile.total_earned: the same number the public profile shows.
		...(acc.kind === "scout" ? { earned: (info?.profile?.totalEarned ?? 0n).toString() } : {}),
		operator: info?.operator ? { name: info.operator.name, feeBps: Number(info.operator.feeBps) } : null,
	};
}

const profileFields = (acc: typeof schema.accounts.$inferSelect) => ({
	wallet: acc.wallet,
	slug: acc.slug ?? acc.wallet,
	kind: acc.kind,
	displayName: acc.displayName,
	avatarUrl: acc.avatarUrl,
	companyName: acc.companyName,
	timeZone: acc.timeZone,
});

/** Self-declared skills (replaces the recruiter's own list; operator-verified and earned ones stay). */
export async function setSkills(wallet: Address, skills: string[]) {
	await db
		.delete(schema.recruiterSkills)
		.where(and(eq(schema.recruiterSkills.wallet, wallet), eq(schema.recruiterSkills.source, "self")));
	const unique = [...new Set(skills.map((s) => s.trim().toLowerCase()).filter(Boolean))];
	if (unique.length)
		await db
			.insert(schema.recruiterSkills)
			.values(unique.map((skill) => ({ wallet, skill, source: "self" as const })));
	return getMe(wallet);
}

/** An operator verifies a skill of a recruiter it vouched for on-chain. Caller = the operator's authority. */
export async function verifySkill(caller: Address, input: { wallet: string; skill: string }) {
	const info = await scoutChainInfo(address(input.wallet));
	if (!info.operator || info.operator.authority !== caller) {
		throw new HttpError(
			403,
			"NOT_THE_OPERATOR",
			"Only the operator that vouched for this recruiter can verify skills.",
		);
	}
	await db
		.insert(schema.recruiterSkills)
		.values({
			wallet: input.wallet,
			skill: input.skill.trim().toLowerCase(),
			source: "operator",
			verifiedBy: info.operator.name,
		})
		.onConflictDoNothing();
	return { ok: true, verifiedBy: info.operator.name };
}
