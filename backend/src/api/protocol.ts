/**
 * Scout as a protocol (packages/shared/src/agent-api.ts): any agent key, or the company itself, can review a
 * role. The hosted agent is just one implementation; it runs on the same ports.
 *
 * Trust: every agent.* call is SIWS-authenticated and must come from the role's on-chain agent (synced from
 * RoleVault.agent). The cosign queue also accepts the company when it reviews itself ("self" mode).
 */
import { createHash } from "node:crypto";
import type {
	AgentConfig,
	AgentDecisionReport,
	AgentDeliverable,
	AgentRegisterGig,
	AgentRoleSnapshot,
	Criteria,
	GigType,
	SetReviewerRequest,
} from "@scout/shared";
import { type Address, address, getTransactionDecoder } from "@solana/kit";
import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { z } from "zod";
import type { StoredReview } from "../agent/runner/ports.ts";
import { canonical, createBackendPorts } from "../agent-runner/backend-ports.ts";
import { preAccept } from "../agent-runner/confirmations.ts";
import { db, schema } from "../db/index.ts";
import { env } from "../env.ts";
import { publish } from "../events.ts";
import { forbidden, HttpError, notFound } from "../http.ts";
import { applyConfirmedTx } from "../indexer/apply-tx.ts";
import { refreshGig } from "../indexer/gigs.ts";
import { processSignature } from "../indexer/sync.ts";
import {
	agentSigner,
	fetchProgramAccount,
	loadDeployment,
	programAddress,
	relayer,
	requireDeployment,
} from "../solana/chain.ts";
import { gatekeeperOf } from "../solana/gatekeeper.ts";
import { requireIdl } from "../solana/idl.ts";
import { buildScoutInstruction, buildUnsignedTx, checkRelayerPolicy, relayUserTx } from "../solana/tx.ts";
import { logActivity } from "./gigs.ts";

// ---- Who reviews a role ---------------------------------------------------------------------

async function loadRoleRow(roleId: string) {
	const [role] = await db.select().from(schema.roles).where(eq(schema.roles.id, roleId));
	if (!role) throw notFound("role");
	return role;
}

/** The caller must be this role's on-chain agent. */
async function requireAgentOf(caller: Address, roleId: string) {
	const role = await loadRoleRow(roleId);
	if (!role.agentPubkey || role.agentPubkey !== caller) {
		throw forbidden("only the role's agent (role_vault.agent) can do this");
	}
	return role;
}

async function roleOfDeliverable(deliverableId: string) {
	const [sub] = await db.select().from(schema.submissions).where(eq(schema.submissions.id, deliverableId));
	if (!sub) throw notFound("deliverable");
	return sub.roleId;
}

// ---- roles.setReviewer (company) ---------------------------------------------------------------

/** set_agent signed by the company: our agent ("scout"), your own key ("custom"), or nobody ("self"). */
export async function setReviewer(caller: Address, input: z.output<typeof SetReviewerRequest>) {
	const role = await loadRoleRow(input.roleId);
	if (role.companyWallet !== caller) throw forbidden("only the role's company can choose its reviewer");
	if (!role.roleVault) throw new HttpError(409, "ROLE_NOT_FUNDED", "fund the role first");
	const agent =
		input.mode === "scout"
			? (await agentSigner()).address
			: input.mode === "custom"
				? address(input.agentPubkey)
				: null;
	const ix = buildScoutInstruction(
		"set_agent",
		{
			agent,
			agentMaxBounty: env.agentMaxBounty,
			agentMaxCommitment: role.deposited > role.remaining ? role.deposited : role.remaining,
		},
		{ payer: (await relayer()).address, company: caller, roleVault: address(role.roleVault) },
	);
	const label =
		input.mode === "scout"
			? "Scout's agent"
			: input.mode === "custom"
				? `your agent ${input.agentPubkey.slice(0, 6)}…`
				: "you (manual review)";
	return { unsignedTx: await buildUnsignedTx([ix], `Let ${label} review "${role.title}"`) };
}

// ---- Cosign queue (gatekeeper is an external agent or the company) -----------------------------

/**
 * Recruiter signed a claim/deliver whose gatekeeper isn't our agent: check it and park it for the gatekeeper.
 * The recruiter (caller) must have signed; only claim_task / submit_deliverable on one role are accepted.
 */
export async function submitForCosign(caller: Address, signedTx: string) {
	const tx = getTransactionDecoder().decode(Buffer.from(signedTx, "base64"));
	const { getCompiledTransactionMessageDecoder } = await import("@solana/kit");
	const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
	if (msg.version !== 0) throw new HttpError(400, "RELAYER_POLICY", "only v0 transactions");
	const violation = checkRelayerPolicy(msg, {
		relayer: (await relayer()).address,
		programId: programAddress(),
		idl: requireIdl(),
		usdcMint: loadDeployment()?.usdcMint,
	});
	if (violation) throw new HttpError(400, "RELAYER_POLICY", violation);
	if (!(caller in tx.signatures && tx.signatures[caller as keyof typeof tx.signatures])) {
		throw new HttpError(400, "RELAYER_POLICY", "sign the transaction with your wallet first");
	}
	// Find which role/gig it is for: the Task account of the claim/deliver instruction.
	const idl = requireIdl();
	let kind: "claim" | "deliver" | null = null;
	let taskAddress: string | null = null;
	for (const ix of msg.instructions) {
		if (msg.staticAccounts[ix.programAddressIndex] !== programAddress()) continue;
		const data = Array.from(ix.data ?? []);
		const def = idl.instructions.find((d) => d.discriminator.every((b, j) => data[j] === b));
		if (!def || (def.name !== "claim_task" && def.name !== "submit_deliverable")) continue;
		kind = def.name === "claim_task" ? "claim" : "deliver";
		const pos = def.accounts.findIndex((a) => a.name === "task");
		taskAddress = msg.staticAccounts[ix.accountIndices?.[pos] ?? -1] ?? null;
	}
	if (!kind || !taskAddress) throw new HttpError(400, "RELAYER_POLICY", "not a claim or delivery");
	const [gig] = await db.select().from(schema.gigs).where(eq(schema.gigs.taskAddress, taskAddress));
	if (!gig) throw notFound("gig");
	const role = await loadRoleRow(gig.roleId);
	const gatekeeper = gatekeeperOf(role);
	if (!(gatekeeper in tx.signatures))
		throw new HttpError(400, "RELAYER_POLICY", "the gatekeeper isn't a signer");
	const [submission] =
		kind === "deliver"
			? await db
					.select({ id: schema.submissions.id })
					.from(schema.submissions)
					.where(
						and(
							eq(schema.submissions.gigId, gig.id),
							eq(schema.submissions.scoutWallet, caller),
							eq(schema.submissions.confirmed, false),
						),
					)
					.orderBy(desc(schema.submissions.submittedAt))
					.limit(1)
			: [];
	const [row] = await db
		.insert(schema.pendingCosigns)
		.values({
			roleId: role.id,
			gigId: gig.id,
			submissionId: submission?.id ?? null,
			kind,
			gatekeeper,
			transaction: signedTx,
			summary: kind === "claim" ? `Take "${gig.title}"` : `Delivery for "${gig.title}"`,
		})
		.returning();
	await logActivity(
		role.id,
		"NOTE",
		`${kind === "claim" ? "A claim" : "A delivery"} for "${gig.title}" is waiting for your reviewer's signature`,
		{
			gigId: gig.id,
		},
	);
	publish({ type: "gig.updated", roleId: role.id, gigId: gig.id, message: "cosign.pending" });
	return { pendingId: row.id };
}

async function requireGatekeeper(caller: Address, roleId: string) {
	const role = await loadRoleRow(roleId);
	if (gatekeeperOf(role) !== caller)
		throw forbidden("only this role's gatekeeper (its agent, or the company) can co-sign");
	return role;
}

export async function listCosigns(caller: Address, roleId: string) {
	await requireGatekeeper(caller, roleId);
	const rows = await db
		.select()
		.from(schema.pendingCosigns)
		.where(and(eq(schema.pendingCosigns.roleId, roleId), eq(schema.pendingCosigns.status, "PENDING")))
		.orderBy(schema.pendingCosigns.createdAt);
	return rows.map((r) => ({
		id: r.id,
		roleId: r.roleId,
		gigId: r.gigId,
		kind: r.kind,
		summary: r.summary,
		transaction: r.transaction,
		createdAt: r.createdAt.toISOString(),
	}));
}

export async function submitCosign(caller: Address, input: { id: string; signedTx: string }) {
	const [p] = await db.select().from(schema.pendingCosigns).where(eq(schema.pendingCosigns.id, input.id));
	if (!p || p.status !== "PENDING") throw notFound("pending co-sign");
	await requireGatekeeper(caller, p.roleId);
	// Same message as the recruiter signed: only the gatekeeper's signature may be new.
	const a = getTransactionDecoder().decode(Buffer.from(p.transaction, "base64"));
	const b = getTransactionDecoder().decode(Buffer.from(input.signedTx, "base64"));
	if (Buffer.compare(Buffer.from(a.messageBytes), Buffer.from(b.messageBytes)) !== 0) {
		throw new HttpError(400, "RELAYER_POLICY", "the transaction changed; sign the queued one");
	}
	const confirmed = await relayUserTx(input.signedTx, caller);
	await applyConfirmedTx(confirmed);
	await db
		.update(schema.pendingCosigns)
		.set({ status: "DONE", signature: confirmed.signature })
		.where(eq(schema.pendingCosigns.id, p.id));
	return { ok: true };
}

export async function declineCosign(caller: Address, input: { id: string; reason: string }) {
	const [p] = await db.select().from(schema.pendingCosigns).where(eq(schema.pendingCosigns.id, input.id));
	if (!p || p.status !== "PENDING") throw notFound("pending co-sign");
	await requireGatekeeper(caller, p.roleId);
	await db.update(schema.pendingCosigns).set({ status: "EXPIRED" }).where(eq(schema.pendingCosigns.id, p.id));
	await logActivity(p.roleId, "NOTE", `Declined a ${p.kind}: ${input.reason}`, { gigId: p.gigId });
	publish({ type: "gig.updated", roleId: p.roleId, gigId: p.gigId ?? undefined, message: "cosign.declined" });
	return { ok: true };
}

// ---- agent.* (agent-api.ts) ---------------------------------------------------------------------

export async function agentConfig(): Promise<z.output<typeof AgentConfig>> {
	const d = requireDeployment();
	return {
		apiVersion: 1,
		cluster: env.cluster,
		rpcUrl: env.rpcUrl.replace(/\?.*$/, ""),
		programId: d.programId,
		usdcMint: d.usdcMint,
		tokenProgram: d.tokenProgram ?? "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
		config: d.config,
		treasuryTokenAccount: d.treasuryTokenAccount,
		relayer: (await relayer()).address,
		confirmationAttestor: (await agentSigner().catch(() => null))?.address ?? null,
	};
}

export async function agentRoles(caller: Address) {
	const rows = await db.select().from(schema.roles).where(eq(schema.roles.agentPubkey, caller));
	return rows.map((r) => ({ roleId: r.id, title: r.title, roleVault: r.roleVault, status: r.status }));
}

export async function agentRole(
	caller: Address,
	roleId: string,
): Promise<z.output<typeof AgentRoleSnapshot>> {
	const role = await requireAgentOf(caller, roleId);
	const snap = await createBackendPorts(roleId).getRole();
	const gigs = await db
		.select()
		.from(schema.gigs)
		.where(and(eq(schema.gigs.roleId, roleId), isNull(schema.gigs.purpose)));
	const subs = await db
		.select()
		.from(schema.submissions)
		.where(and(eq(schema.submissions.roleId, roleId), eq(schema.submissions.confirmed, true)));
	const claims = await db
		.select()
		.from(schema.claims)
		.where(
			gigs.length
				? inArray(
						schema.claims.gigId,
						gigs.map((g) => g.id),
					)
				: eq(schema.claims.gigId, "00000000-0000-0000-0000-000000000000"),
		);
	return {
		roleId,
		roleVault: role.roleVault ?? "",
		company: role.companyWallet,
		title: role.title,
		criteria: role.criteria,
		paused: role.agentPaused,
		pausedTaskTypes: role.pausedTaskTypes,
		holdbackBps: role.holdbackBps,
		gigs: gigs.map((g) => ({
			gigId: g.id,
			taskAddress: g.taskAddress,
			onchainTaskId: g.onchainTaskId,
			taskType: g.type,
			variant: (g.variant ?? "standard") as "standard" | "language" | "tech",
			title: g.title,
			status: g.status === "DRAFT" ? "POSTING" : g.status,
			candidateId: g.aboutCandidateId,
			postedAt: g.createdAt.toISOString(),
			lastRepricedAt: g.priceHistory.at(-1)?.at ?? null,
			claims: claims.filter((c) => c.gigId === g.id).length,
			deliveries: subs.filter((s) => s.gigId === g.id).length,
		})),
		candidates: snap.candidates.map((c) => ({
			...JSON.parse(JSON.stringify(c, (_, v) => (typeof v === "bigint" ? v.toString() : v))),
			sourcer: subs.find((s) => s.id === c.id)?.scoutWallet ?? null,
		})),
	};
}

async function toAgentDeliverable(
	sub: typeof schema.submissions.$inferSelect,
): Promise<z.output<typeof AgentDeliverable> | null> {
	const ports = createBackendPorts(sub.roleId);
	const d = await ports.getDeliverable(sub.id);
	const [gig] = sub.gigId ? await db.select().from(schema.gigs).where(eq(schema.gigs.id, sub.gigId)) : [];
	if (!d || !gig?.taskAddress || !sub.onchainAddress) return null;
	const [c] = await db
		.select()
		.from(schema.candidateConfirmations)
		.where(eq(schema.candidateConfirmations.submissionId, sub.id));
	const stage =
		c?.status === "PENDING" ? "pre_accepted" : c?.status === "YES" ? "candidate_confirmed" : "pending";
	const {
		id: _i,
		gigId: _g,
		recruiter,
		submittedAt,
		kind,
		...payload
	} = d as unknown as Record<string, unknown> & {
		recruiter: { wallet: string; displayName: string };
		submittedAt: string;
		kind: AgentDeliverable["kind"];
	};
	return {
		id: sub.id,
		roleId: sub.roleId,
		gigId: gig.id,
		kind,
		stage,
		submission: sub.onchainAddress,
		task: gig.taskAddress,
		scout: sub.scoutWallet,
		recruiter,
		submittedAt,
		updatedAt: sub.updatedAt?.toISOString() ?? null,
		payload: payload as Record<string, unknown>,
	};
}

export async function agentDeliverables(caller: Address, roleId: string) {
	await requireAgentOf(caller, roleId);
	const subs = await db
		.select()
		.from(schema.submissions)
		.where(
			and(
				eq(schema.submissions.roleId, roleId),
				eq(schema.submissions.confirmed, true),
				eq(schema.submissions.status, "PENDING"),
				isNotNull(schema.submissions.gigId),
			),
		)
		.orderBy(schema.submissions.submittedAt);
	return (await Promise.all(subs.map(toAgentDeliverable))).filter(
		(d): d is NonNullable<typeof d> => d !== null,
	);
}

export async function agentDeliverable(caller: Address, deliverableId: string) {
	await requireAgentOf(caller, await roleOfDeliverable(deliverableId));
	const [sub] = await db.select().from(schema.submissions).where(eq(schema.submissions.id, deliverableId));
	return sub ? toAgentDeliverable(sub) : null;
}

export async function agentReviewGet(caller: Address, deliverableId: string) {
	const roleId = await roleOfDeliverable(deliverableId);
	await requireAgentOf(caller, roleId);
	const r = await createBackendPorts(roleId).getReview(deliverableId);
	return r ? (r as unknown as Record<string, unknown>) : null;
}

export async function agentReviewSave(
	caller: Address,
	deliverableId: string,
	review: Record<string, unknown>,
) {
	const roleId = await roleOfDeliverable(deliverableId);
	await requireAgentOf(caller, roleId);
	await createBackendPorts(roleId).saveReview({ ...(review as unknown as StoredReview), deliverableId });
	return { ok: true };
}

export async function agentSourcingReviews(caller: Address, roleId: string) {
	await requireAgentOf(caller, roleId);
	const subs = await db
		.select({ review: schema.submissions.agentReview })
		.from(schema.submissions)
		.where(and(eq(schema.submissions.roleId, roleId), eq(schema.submissions.deliverableType, "SOURCING")));
	return subs.flatMap((s) => (s.review ? [s.review] : []));
}

/** After the agent's own create_task confirmed: verify the Task on-chain and register the gig. */
export async function agentRegisterGig(caller: Address, input: z.output<typeof AgentRegisterGig>) {
	const role = await requireAgentOf(caller, input.roleId);
	const task = await fetchProgramAccount<{
		roleVault: string;
		taskId: number;
		briefHash: Uint8Array;
		bounty: bigint;
		maxDeliverables: number;
		exclusive: boolean;
	}>("Task", address(input.taskAddress));
	if (!task || task.roleVault !== role.roleVault)
		throw new HttpError(409, "TASK_NOT_FOUND", "no such Task on this role (not confirmed yet?)");
	const g = input.gig;
	const hash = createHash("sha256")
		.update(canonical({ title: g.title, brief: g.brief, script: g.script }))
		.digest("hex");
	if (Buffer.from(task.briefHash).toString("hex") !== hash) {
		throw new HttpError(409, "BRIEF_MISMATCH", "brief_hash on-chain doesn't match this title/brief/script");
	}
	const [row] = await db
		.insert(schema.gigs)
		.values({
			roleId: role.id,
			onchainTaskId: Number(task.taskId),
			taskAddress: input.taskAddress,
			type: g.taskType,
			variant: g.taskType === "SCREENING_CALL" ? (g.variant === "language" ? "language" : "standard") : null,
			title: g.title,
			brief: g.brief,
			script: g.script,
			briefHash: hash,
			bounty: BigInt(task.bounty),
			maxDeliverables: Number(task.maxDeliverables),
			exclusive: Boolean(task.exclusive),
			holdbackBps: role.holdbackBps,
			status: "OPEN",
			postWhen: g.when,
			aboutCandidateId: g.candidateId,
			createTx: input.signature,
		})
		.onConflictDoNothing()
		.returning();
	if (row) {
		await refreshGig(input.taskAddress, input.signature);
		await logActivity(role.id, "GIG_POSTED", `Posted: ${g.title}`, {
			gigId: row.id,
			signature: input.signature,
		});
		publish({ type: "gig.updated", roleId: role.id, gigId: row.id, signature: input.signature });
	}
	return { gigId: row?.id ?? "" };
}

export async function agentSetGigStatus(
	caller: Address,
	input: { roleId: string; gigIds: string[]; status: "OPEN" | "PAUSED" },
) {
	await requireAgentOf(caller, input.roleId);
	await createBackendPorts(input.roleId).setGigStatus(input.gigIds, input.status);
	return { ok: true };
}

export async function agentPauseTypes(
	caller: Address,
	input: { roleId: string; taskTypes: GigType[]; paused: boolean },
) {
	await requireAgentOf(caller, input.roleId);
	await createBackendPorts(input.roleId).setTaskTypePaused?.(input.taskTypes, input.paused);
	return { ok: true };
}

/** The agent reports a decision: pre_accept (we send the candidate link) or an accept/reject it signed. */
export async function agentDecision(caller: Address, input: z.output<typeof AgentDecisionReport>) {
	const roleId = await roleOfDeliverable(input.deliverableId);
	await requireAgentOf(caller, roleId);
	if (input.action === "pre_accept") {
		await preAccept(input.deliverableId);
		return { ok: true };
	}
	if (!input.signature)
		throw new HttpError(400, "SIGNATURE_REQUIRED", "report the confirmed transaction signature");
	// What the recruiter is shown (its sha256 is reject_submission.reason_hash).
	if (input.action === "reject")
		await db
			.update(schema.submissions)
			.set({ rejectText: input.reason })
			.where(eq(schema.submissions.id, input.deliverableId));
	await processSignature(input.signature as never);
	await logActivity(
		roleId,
		input.action === "accept" ? "DELIVERY_ACCEPTED" : "DELIVERY_REJECTED",
		`${input.action === "accept" ? "Accepted" : "Rejected"}: ${input.reason}`,
		{ deliverableId: input.deliverableId, signature: input.signature },
	);
	return { ok: true };
}

export async function agentEscalate(
	caller: Address,
	input: {
		roleId: string;
		deliverableId: string | null;
		candidateId: string | null;
		question: string;
		delivery: "now" | "digest";
	},
) {
	await requireAgentOf(caller, input.roleId);
	await createBackendPorts(input.roleId).escalate({
		deliverableId: input.deliverableId ?? undefined,
		candidateId: input.candidateId ?? undefined,
		question: input.question,
		delivery: input.delivery,
	});
	await logActivity(
		input.roleId,
		"ESCALATED",
		input.delivery === "digest"
			? `Added to today's digest: ${input.question}`
			: `Needs your call: ${input.question}`,
		{
			deliverableId: input.deliverableId ?? input.candidateId,
		},
	);
	return { ok: true };
}

export async function agentAskRecruiter(caller: Address, input: { deliverableId: string; question: string }) {
	const roleId = await roleOfDeliverable(input.deliverableId);
	await requireAgentOf(caller, roleId);
	await createBackendPorts(roleId).askRecruiter?.(input.deliverableId, input.question);
	return { ok: true };
}

export async function agentCriteria(
	caller: Address,
	input: { roleId: string; criteria: Criteria; note: string },
) {
	await requireAgentOf(caller, input.roleId);
	await createBackendPorts(input.roleId).updateCriteria(input.criteria, input.note);
	await logActivity(input.roleId, "CRITERIA_UPDATED", input.note);
	return { ok: true };
}

export async function agentShortlist(
	caller: Address,
	input: { roleId: string; entries: Record<string, unknown>[] },
) {
	await requireAgentOf(caller, input.roleId);
	await createBackendPorts(input.roleId).saveShortlist(input.entries as never);
	return { ok: true };
}

export async function agentDecisionLog(
	caller: Address,
	input: { roleId: string; candidateName: string | null; deliverableId: string | null; limit: number },
) {
	await requireAgentOf(caller, input.roleId);
	const rows = await createBackendPorts(input.roleId).getDecisionLog({
		candidateName: input.candidateName ?? undefined,
		deliverableId: input.deliverableId ?? undefined,
		limit: input.limit,
	});
	return rows as unknown as Record<string, unknown>[];
}

export async function agentLog(
	caller: Address,
	input: { roleId: string; kind: string; message: string; data: Record<string, unknown> | null },
) {
	await requireAgentOf(caller, input.roleId);
	await createBackendPorts(input.roleId).log({
		kind: input.kind as never,
		message: input.message,
		data: input.data ?? undefined,
	});
	return { ok: true };
}
