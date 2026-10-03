/**
 * Applies on-chain state to the DB. Used by:
 * - /tx/submit right after confirmation (snappy UI),
 * - the websocket indexer (events from any client, e.g. someone else calling settle_expired),
 * - the poller (fallback when websocket notifications are missed).
 * Everything here is idempotent.
 */
import { REJECT_REASONS, type RejectReason } from "@scout/shared";
import { type Address, address, type Signature } from "@solana/kit";
import { and, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { rejectGhostDeliverable } from "../agent-runner/ghosts.ts";
import { db, schema } from "../db/index.ts";
import { publish } from "../events.ts";
import { schedulePipelineSummary } from "../services/pipeline.ts";
import { reviewInBackground } from "../services/reviews.ts";
import {
	enumName,
	fetchProgramAccount,
	findAta,
	invalidateCached,
	loadDeployment,
	type RoleVaultAccount,
	rpc,
	type SubmissionAccount,
	tokenBalance,
} from "../solana/chain.ts";
import { decodeEvent, loadIdl } from "../solana/idl.ts";
import { refreshGig } from "./gigs.ts";

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

export const reasonFromCode = (code: number): RejectReason =>
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
				// remaining too: the agent plans from it as soon as the role is OPEN.
				.set({
					status: "OPEN",
					deposited: BigInt(d.initialDeposit as bigint),
					remaining: BigInt(d.initialDeposit as bigint),
				})
				.where(eq(schema.roles.roleVault, d.roleVault as string))
				.returning({ id: schema.roles.id });
			if (role) {
				await budgetRow(
					role.id,
					`Set aside ${usd(BigInt(d.initialDeposit as bigint))} for this role`,
					signature,
				);
				publish({ type: "role.updated", roleId: role.id, signature });
			}
			return;
		}
		case "RoleToppedUp": {
			const [role] = await db
				.update(schema.roles)
				.set({ deposited: BigInt(d.totalDeposited as bigint) })
				.where(eq(schema.roles.roleVault, d.roleVault as string))
				.returning({ id: schema.roles.id });
			if (role) {
				await budgetRow(role.id, `Added ${usd(BigInt(d.amount as bigint))} to the budget`, signature);
				publish({ type: "role.updated", roleId: role.id, signature });
			}
			return;
		}
		case "DeliverableSubmitted":
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
			} else if (ev.name === "DeliverableSubmitted") {
				// Not built by us (no DB row): the agent rejects it.
				void rejectGhostDeliverable({
					submission: d.submission as string,
					task: d.task as string,
					roleVault: d.roleVault as string,
					scout: d.scout as string,
				}).catch((err) => console.warn(`[ghost] ${d.submission}: ${(err as Error).message}`));
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
					payoutNow: BigInt(d.payout as bigint),
					payoutLater: BigInt(d.heldBack as bigint),
					operatorFee: BigInt(d.operatorFee as bigint),
					platformFee: BigInt(d.fee as bigint),
					holdbackDeadline: new Date(Number(d.holdbackDeadline) * 1000),
					// Only from NONE: a later attest/release may already have been applied (apply-tx is faster).
					laterStatus: sql`case when ${schema.submissions.laterStatus} = 'NONE' then ${
						BigInt(d.heldBack as bigint) > 0n ? "HELD" : "NONE"
					} else ${schema.submissions.laterStatus} end`,
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
		case "OutcomeAttested": {
			const outcome = enumName(d.outcome as string) === "Fabricated" ? "FABRICATED" : "ADVANCED";
			const released = BigInt(d.released as bigint);
			const refunded = BigInt(d.refunded as bigint);
			const set: Partial<typeof schema.submissions.$inferInsert> = { outcome };
			if (released > 0n) Object.assign(set, { laterStatus: "RELEASED", laterTx: signature });
			if (refunded > 0n) Object.assign(set, { laterStatus: "REFUNDED", laterTx: signature });
			const [sub] = await db
				.update(schema.submissions)
				.set(set)
				.where(eq(schema.submissions.onchainAddress, d.submission as string))
				.returning({ id: schema.submissions.id, roleId: schema.submissions.roleId });
			invalidateCached(d.scout as string);
			if (sub) {
				publish({
					type: "submission.outcome",
					roleId: sub.roleId,
					submissionId: sub.id,
					signature,
					scout: d.scout as string,
					outcome,
					payout: released.toString(),
				});
			}
			return;
		}
		case "HoldbackReleased": {
			const [sub] = await db
				.update(schema.submissions)
				.set({ laterStatus: "RELEASED", laterTx: signature })
				.where(eq(schema.submissions.onchainAddress, d.submission as string))
				.returning({ id: schema.submissions.id, roleId: schema.submissions.roleId });
			if (sub) {
				publish({
					type: "submission.released",
					roleId: sub.roleId,
					submissionId: sub.id,
					signature,
					scout: d.scout as string,
					payout: String(d.amount),
				});
			}
			return;
		}
		case "TaskCreated":
		case "TaskClaimed":
		case "ClaimReleased":
		case "TaskClosed":
			await refreshGig(d.task as string, signature);
			return;
		case "BondForfeited": {
			const amountForfeited = BigInt(d.amount as bigint);
			// Once per submission (events can be replayed): only the first write counts toward the role.
			const [sub] = await db
				.update(schema.submissions)
				.set({ bondForfeited: amountForfeited })
				.where(
					and(
						eq(schema.submissions.onchainAddress, d.submission as string),
						isNull(schema.submissions.bondForfeited),
					),
				)
				.returning({
					id: schema.submissions.id,
					roleId: schema.submissions.roleId,
					gigId: schema.submissions.gigId,
				});
			if (sub)
				await db
					.update(schema.roles)
					.set({ bondsForfeited: sql`${schema.roles.bondsForfeited} + ${amountForfeited}` })
					.where(eq(schema.roles.id, sub.roleId));
			if (sub) {
				publish({
					type: "gig.updated",
					roleId: sub.roleId,
					submissionId: sub.id,
					gigId: sub.gigId ?? undefined,
					signature,
					message: "bond.forfeited",
				});
			}
			return;
		}
		case "ScoutRegistered":
			invalidateCached(d.scout as string);
			return;
		case "OperatorRegistered":
			invalidateCached(d.operator as string, d.authority as string);
			return;
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
				.set({ status: "CLOSED", refunded: BigInt(d.refunded as bigint) })
				.where(eq(schema.roles.roleVault, d.roleVault as string))
				.returning({ id: schema.roles.id });
			if (role) {
				await budgetRow(
					role.id,
					`Closed the role · ${usd(BigInt(d.refunded as bigint))} back to you`,
					signature,
				);
				publish({ type: "role.closed", roleId: role.id, signature });
			}
			return;
		}
	}
}

const usd = (base: bigint) => `$${(Number(base) / 1e6).toFixed(2).replace(/\.00$/, "")}`;
/** A lasting "proof of payment" row in the company's thread for money the company moved. Once per tx. */
async function budgetRow(roleId: string, message: string, signature: string) {
	const [seen] = await db
		.select({ id: schema.agentActivity.id })
		.from(schema.agentActivity)
		.where(and(eq(schema.agentActivity.roleId, roleId), eq(schema.agentActivity.signature, signature)))
		.limit(1);
	if (seen) return;
	const { logActivity } = await import("../api/gigs.ts");
	await logActivity(roleId, "BUDGET", message, { signature });
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
		holdbackWindowSeconds: Number(acc.holdbackWindowSeconds),
		heldBack: BigInt(acc.heldBackTotal),
		committed: BigInt(acc.pendingValue ?? 0n) + BigInt(acc.openCapacity ?? 0n),
		agentPubkey: acc.agent ?? null,
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
	await pollHoldbacks();

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
		if (enumName(acc.status) === "Accepted") {
			// The accept event was missed: take the holdback state from the account (amounts stay projected).
			await syncHoldback(s.id, acc);
		}
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

async function syncHoldback(submissionId: string, acc: SubmissionAccount) {
	const outcome = enumName(acc.outcome);
	await db
		.update(schema.submissions)
		.set({
			holdbackDeadline: acc.holdbackDeadline ? new Date(Number(acc.holdbackDeadline) * 1000) : null,
			outcome: outcome === "Advanced" ? "ADVANCED" : outcome === "Fabricated" ? "FABRICATED" : "NONE",
			...(BigInt(acc.holdbackAmount) > 0n && outcome === "None" ? { laterStatus: "HELD" as const } : {}),
		})
		.where(eq(schema.submissions.id, submissionId));
}

/** Accepted submissions whose held-back part may have been released or attested without us seeing the event. */
export async function pollHoldbacks() {
	const held = await db
		.select()
		.from(schema.submissions)
		.where(and(eq(schema.submissions.laterStatus, "HELD"), isNotNull(schema.submissions.onchainAddress)));
	for (const s of held) {
		if (!s.onchainAddress) continue;
		const acc = await fetchProgramAccount<SubmissionAccount>("Submission", address(s.onchainAddress));
		if (!acc) continue;
		const outcome = enumName(acc.outcome);
		if (outcome === "None" && BigInt(acc.holdbackAmount) > 0n) continue; // still held
		const laterStatus = outcome === "Fabricated" ? "REFUNDED" : "RELEASED";
		await db
			.update(schema.submissions)
			.set({
				laterStatus,
				outcome: outcome === "Advanced" ? "ADVANCED" : outcome === "Fabricated" ? "FABRICATED" : "NONE",
			})
			.where(eq(schema.submissions.id, s.id));
		publish({ type: "role.updated", roleId: s.roleId, submissionId: s.id });
	}
}
