/**
 * One-off repairs of rows written by older builds, run at startup (idempotent, a few rows at most): replays the
 * on-chain events of affected transactions so the exact amounts land.
 * - accepted call deliverables whose payout was computed from the role-level bounty (0 on agent-run roles);
 * - rejected deliverables whose forfeited bond wasn't recorded apart from the company's deposits.
 */
import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { loadDeployment } from "../solana/chain.ts";
import { processSignature } from "./sync.ts";

/** Demo personas created before bios existed get the same line the seed gives them (only when empty). */
const PERSONA_BIOS: [string, string][] = [
	[
		"Ola Wiśniewska",
		"Tech recruiter in Kraków; I screen Rust and backend engineers and write notes companies can act on.",
	],
	[
		"Lucía Fernández",
		"Sourcer in Valencia; I find senior engineers in the Solana and DeFi community before they hit the job boards.",
	],
	[
		"Andreea Popescu",
		"Recruiter in Bucharest for Java teams and DACH sales roles; fluent in German and English.",
	],
];

export async function runRepairs(log: { info(m: string): void; warn(m: string): void }) {
	// The demo company is "Wisła Labs" (older seeds used a descriptor as its name).
	await db
		.update(schema.accounts)
		.set({ companyName: "Wisła Labs" })
		.where(eq(schema.accounts.companyName, "Seed-stage Solana DeFi startup · Warsaw"));
	for (const [name, bio] of PERSONA_BIOS)
		await db
			.update(schema.accounts)
			.set({ bio })
			.where(and(eq(schema.accounts.displayName, name), isNull(schema.accounts.bio)));
	if (!loadDeployment()) return;
	const rows = await db
		.select({ tx: schema.submissions.settlementTx })
		.from(schema.submissions)
		.where(
			and(
				isNotNull(schema.submissions.settlementTx),
				or(
					and(
						eq(schema.submissions.status, "ACCEPTED"),
						sql`coalesce(${schema.submissions.payoutNow}, 0) = 0`,
					),
					and(eq(schema.submissions.status, "REJECTED"), isNull(schema.submissions.bondForfeited)),
				),
			),
		)
		.limit(200);
	const txs = [...new Set(rows.map((r) => r.tx as string))];
	// Replay even if the indexer marked them processed (that's how the zeros got stuck).
	if (txs.length) await db.delete(schema.txLog).where(inArray(schema.txLog.signature, txs));
	for (const tx of txs)
		await processSignature(tx as never).catch((e) => log.warn(`[repair] ${tx}: ${(e as Error).message}`));
	// Rejections without a bond (calls, vouched recruiters): mark them so they aren't replayed again.
	if (txs.length)
		await db
			.update(schema.submissions)
			.set({ bondForfeited: 0n })
			.where(
				and(
					eq(schema.submissions.status, "REJECTED"),
					isNull(schema.submissions.bondForfeited),
					inArray(schema.submissions.settlementTx, txs),
				),
			);
	if (txs.length) log.info(`[repair] replayed ${txs.length} transactions`);
}
