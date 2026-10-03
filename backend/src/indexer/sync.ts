/**
 * Applies on-chain state to the DB. Used by:
 * - /tx/submit right after confirmation (snappy UI),
 * - the websocket indexer (events from any client, e.g. someone else calling settle_expired),
 * - the poller (fallback when websocket notifications are missed).
 * Everything here is idempotent.
 */
import { REJECT_REASONS, type RejectReason } from "@scout/shared";
import { type Address, address, type Signature } from "@solana/kit";
import { and, eq, inArray, isNotNull, lt } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { publish } from "../events.ts";
import { schedulePipelineSummary } from "../services/pipeline.ts";
import { reviewInBackground } from "../services/reviews.ts";
import {
	enumName,
	fetchProgramAccount,
	findAta,
	loadDeployment,
	type RoleVaultAccount,
	rpc,
	type SubmissionAccount,
	tokenBalance,
} from "../solana/chain.ts";
import { decodeEvent, loadIdl } from "../solana/idl.ts";

type Ev = { name: string; data: Record<string, unknown> };

export function parseEventsFromLogs(logs: readonly string[]): Ev[] {
	const idl = loadIdl();
	if (!idl) return [];
	const out: Ev[] = [];
	for (const line of logs) {
		const m = line.match(/^Program data: (.+)$/);
		if (!m) continue;
		const ev = decodeEvent(idl, new Uint8Array(Buffer.from(m[1], "base64")));
		if (ev) out.push(ev);
	}
	return out;
}

const reasonFromCode = (code: number): RejectReason =>
	(Object.entries(REJECT_REASONS).find(([, v]) => v === code)?.[0] as RejectReason) ?? "OTHER";

export async function processLogs(signature: string, logs: readonly string[]) {
	const [seen] = await db.select().from(schema.txLog).where(eq(schema.txLog.signature, signature));
	if (seen?.processed) return;
	const events = parseEventsFromLogs(logs);
	const touchedVaults = new Set<string>();
	for (const ev of events) {
		const vault = ev.data.roleVault as string | undefined;
		if (vault) touchedVaults.add(vault);
		await applyEvent(ev, signature);
	}
	for (const v of touchedVaults) await refreshRole(address(v));
	await db
		.insert(schema.txLog)
		.values({ signature, kind: events[0]?.name ?? "unknown", processed: true })
		.onConflictDoUpdate({ target: schema.txLog.signature, set: { processed: true } });
}

/** After /tx/submit: fetch logs for a confirmed signature and apply them. */
export async function processSignature(signature: Signature) {
	for (let attempt = 0; attempt < 5; attempt++) {
		const tx = await rpc
			.getTransaction(signature, {
				commitment: "confirmed",
				maxSupportedTransactionVersion: 0,
				encoding: "json",
			})
			.send();
		if (tx?.meta?.logMessages) return processLogs(signature, tx.meta.logMessages);
		await new Promise((r) => setTimeout(r, 500));
	}
}

async function applyEvent(ev: Ev, signature: string) {
	const d = ev.data;
	switch (ev.name) {
		case "RoleCreated": {
			const [role] = await db
				.update(schema.roles)
				.set({ status: "OPEN", deposited: BigInt(d.initialDeposit as bigint) })
				.where(eq(schema.roles.roleVault, d.roleVault as string))
				.returning({ id: schema.roles.id });
			if (role) publish({ type: "role.updated", roleId: role.id, signature });
			return;
		}
		case "RoleToppedUp": {
			const [role] = await db
				.update(schema.roles)
				.set({ deposited: BigInt(d.totalDeposited as bigint) })
				.where(eq(schema.roles.roleVault, d.roleVault as string))
				.returning({ id: schema.roles.id });
			if (role) publish({ type: "role.updated", roleId: role.id, signature });
			return;
		}
		case "CandidateSubmitted": {
			const [sub] = await db
				.update(schema.submissions)
				.set({
					confirmed: true,
					submitTx: signature,
					reviewDeadline: new Date(Number(d.reviewDeadline) * 1000),
				})
				.where(eq(schema.submissions.onchainAddress, d.submission as string))
				.returning({
					id: schema.submissions.id,
					roleId: schema.submissions.roleId,
					confirmed: schema.submissions.confirmed,
				});
			if (sub) {
				publish({ type: "submission.created", roleId: sub.roleId, submissionId: sub.id, signature });
				reviewInBackground(sub.id);
			}
			return;
		}
		case "SubmissionAccepted": {
			const [sub] = await db
				.update(schema.submissions)
				.set({
					status: "ACCEPTED",
					settlementTx: signature,
					autoSettled: Boolean(d.autoSettled),
					confirmed: true,
				})
				.where(eq(schema.submissions.onchainAddress, d.submission as string))
				.returning({ id: schema.submissions.id, roleId: schema.submissions.roleId });
			if (sub) {
				publish({
					type: "submission.accepted",
					roleId: sub.roleId,
					submissionId: sub.id,
					signature,
					scout: d.scout as string,
					payout: String(d.payout),
				});
			}
			return;
		}
		case "SubmissionRejected": {
			const [sub] = await db
				.update(schema.submissions)
				.set({
					status: "REJECTED",
					rejectReason: reasonFromCode(Number(d.reasonCode)),
					settlementTx: signature,
				})
				.where(eq(schema.submissions.onchainAddress, d.submission as string))
				.returning({ id: schema.submissions.id, roleId: schema.submissions.roleId });
			if (sub) {
				publish({
					type: "submission.rejected",
					roleId: sub.roleId,
					submissionId: sub.id,
					signature,
					scout: d.scout as string,
				});
			}
			return;
		}
		case "RoleClosed": {
			const [role] = await db
				.update(schema.roles)
				.set({ status: "CLOSED" })
				.where(eq(schema.roles.roleVault, d.roleVault as string))
				.returning({ id: schema.roles.id });
			if (role) publish({ type: "role.closed", roleId: role.id, signature });
			return;
		}
	}
}

/** Re-read RoleVault + vault balance into the roles cache. */
export async function refreshRole(roleVault: Address) {
	const acc = await fetchProgramAccount<RoleVaultAccount>("RoleVault", roleVault);
	if (!acc) return;
	const d = loadDeployment();
	const vaultAta = acc.vaultTokenAccount ?? (d ? await findAta(roleVault, address(d.usdcMint)) : null);
	const remaining = vaultAta ? await tokenBalance(vaultAta) : 0n;
	const next = {
		status: (enumName(acc.status) === "Closed" ? "CLOSED" : "OPEN") as "OPEN" | "CLOSED",
		deposited: BigInt(acc.totalDeposited),
		paid: BigInt(acc.totalPaid),
		remaining,
		acceptedCount: Number(acc.acceptedCount),
		pendingCount: Number(acc.pendingCount),
		feeBps: Number(acc.feeBps),
	};
	const [prev] = await db.select().from(schema.roles).where(eq(schema.roles.roleVault, roleVault));
	if (!prev) return;
	const changed = (Object.keys(next) as (keyof typeof next)[]).some((k) => prev[k] !== next[k]);
	if (!changed) return;
	await db.update(schema.roles).set(next).where(eq(schema.roles.id, prev.id));
	schedulePipelineSummary(prev.id);
	publish({ type: "role.updated", roleId: prev.id });
}

/** Fallback reconciliation for anything the websocket missed. */
export async function pollOnce() {
	if (!loadIdl()) return;
	const roles = await db
		.select({ roleVault: schema.roles.roleVault })
		.from(schema.roles)
		.where(and(inArray(schema.roles.status, ["DRAFT", "OPEN"]), isNotNull(schema.roles.roleVault)));
	for (const r of roles) if (r.roleVault) await refreshRole(address(r.roleVault));

	// Submissions whose status on-chain may have moved without us seeing the event.
	const stale = await db
		.select()
		.from(schema.submissions)
		.where(
			and(
				eq(schema.submissions.status, "PENDING"),
				isNotNull(schema.submissions.onchainAddress),
				lt(schema.submissions.submittedAt, new Date(Date.now() - 10_000)),
			),
		);
	for (const s of stale) {
		if (!s.onchainAddress) continue;
		const acc = await fetchProgramAccount<SubmissionAccount>("Submission", address(s.onchainAddress));
		if (!acc) continue;
		const status = enumName(acc.status).toUpperCase() as "PENDING" | "ACCEPTED" | "REJECTED";
		const wasUnconfirmed = !s.confirmed;
		await db
			.update(schema.submissions)
			.set({
				confirmed: true,
				status,
				reviewDeadline: new Date(Number(acc.reviewDeadline) * 1000),
				rejectReason: status === "REJECTED" ? reasonFromCode(Number(acc.rejectReason)) : null,
			})
			.where(eq(schema.submissions.id, s.id));
		if (wasUnconfirmed) reviewInBackground(s.id);
		if (status !== "PENDING" || wasUnconfirmed)
			publish({ type: "role.updated", roleId: s.roleId, submissionId: s.id });
	}
}
