/** Keeps the `gigs` rows in sync with their on-chain Task accounts. */
import { type Address, address } from "@solana/kit";
import { eq } from "drizzle-orm";
import { logActivity } from "../api/gigs.ts";
import { db, schema } from "../db/index.ts";
import { publish } from "../events.ts";
import { enumName, fetchProgramAccount } from "../solana/chain.ts";

export type TaskAccount = {
	roleVault: Address;
	taskId: number;
	bounty: bigint;
	maxDeliverables: number;
	acceptedCount: number;
	pendingCount: number;
	exclusive: boolean;
	claimant: Address | null;
	claimedAt: bigint;
	holdbackBps: number;
	status: string | { __kind: string };
};

/** Re-read a Task into its gig row; publishes gig.updated when something changed. */
export async function refreshGig(task: Address | string, signature?: string) {
	const acc = await fetchProgramAccount<TaskAccount>("Task", address(task));
	if (!acc) return;
	const [prev] = await db.select().from(schema.gigs).where(eq(schema.gigs.taskAddress, task));
	if (!prev || prev.status === "POSTING") return;
	// A filled gig is done even if its Task stays open on-chain (an exclusive call after its one delivery).
	const closed = enumName(acc.status) === "Closed" || Number(acc.acceptedCount) >= prev.maxDeliverables;
	const next = {
		// PAUSED is off-chain only (the agent took the gig off the board): keep it while the Task is open.
		status: closed ? ("CLOSED" as const) : prev.status === "PAUSED" ? ("PAUSED" as const) : ("OPEN" as const),
		acceptedCount: Number(acc.acceptedCount),
		pendingCount: Number(acc.pendingCount),
		claimantWallet: acc.claimant ?? null,
		claimedAt: acc.claimant && acc.claimedAt ? new Date(Number(acc.claimedAt) * 1000) : null,
	};
	const changed =
		prev.status !== next.status ||
		prev.acceptedCount !== next.acceptedCount ||
		prev.pendingCount !== next.pendingCount ||
		prev.claimantWallet !== next.claimantWallet;
	if (!changed) return;
	await db.update(schema.gigs).set(next).where(eq(schema.gigs.id, prev.id));
	if (next.claimantWallet && next.claimantWallet !== prev.claimantWallet) {
		await db
			.insert(schema.claims)
			.values({ gigId: prev.id, wallet: next.claimantWallet, tx: signature ?? null });
		const [who] = await db
			.select({ name: schema.accounts.displayName })
			.from(schema.accounts)
			.where(eq(schema.accounts.wallet, next.claimantWallet));
		await logActivity(prev.roleId, "GIG_CLAIMED", `${who?.name ?? "A recruiter"} took "${prev.title}"`, {
			gigId: prev.id,
			signature: signature ?? null,
		});
	}
	if (!next.claimantWallet && prev.claimantWallet) {
		await db.update(schema.claims).set({ releasedAt: new Date() }).where(eq(schema.claims.gigId, prev.id));
	}
	publish({ type: "gig.updated", roleId: prev.roleId, gigId: prev.id, signature });
}
