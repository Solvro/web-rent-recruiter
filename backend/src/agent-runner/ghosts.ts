/**
 * Defense in depth: a deliverable that landed on-chain without going through gigs.deliver (no DB row) is
 * rejected by the agent, so nobody can get paid by settle_expired for something the agent never saw.
 */
import { address } from "@solana/kit";
import { eq } from "drizzle-orm";
import { logActivity } from "../api/gigs.ts";
import { db, schema } from "../db/index.ts";
import { applyConfirmedTx } from "../indexer/apply-tx.ts";
import { agentSigner } from "../solana/chain.ts";
import { rejectIx } from "../solana/scout.ts";
import { sendAsRelayer } from "../solana/tx.ts";

const seen = new Set<string>();

export async function rejectGhostDeliverable(ev: {
	submission: string;
	task: string;
	roleVault: string;
	scout: string;
}) {
	if (seen.has(ev.submission)) return;
	seen.add(ev.submission);
	const [role] = await db.select().from(schema.roles).where(eq(schema.roles.roleVault, ev.roleVault));
	if (!role?.agentManaged) return;
	const agent = await agentSigner();
	const ix = await rejectIx({
		company: address(role.companyWallet),
		scout: address(ev.scout),
		roleVault: address(ev.roleVault),
		task: address(ev.task),
		submission: address(ev.submission),
		authority: agent.address,
		reasonCode: 3, // OTHER
		reasonText: "This delivery didn't come through the gig board.",
	});
	const confirmed = await sendAsRelayer([ix], [agent]);
	await applyConfirmedTx(confirmed);
	await logActivity(
		role.id,
		"DELIVERY_REJECTED",
		"Rejected a delivery that didn't come through the gig board",
		{
			signature: confirmed.signature,
			data: { submission: ev.submission, scout: ev.scout, reason: "no matching delivery on record" },
		},
	);
}
