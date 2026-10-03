/**
 * Keeping the company in the loop: one-click fixes for a stage that's slower than expected (raise a gig's price,
 * loosen a must-have, re-send a candidate's confirmation link). The cockpit (status.ts) proposes them.
 */
import { createHash, randomBytes } from "node:crypto";
import { address } from "@solana/kit";
import { and, eq, isNull } from "drizzle-orm";
import { adjustCriteria } from "../agent/index.ts";
import { createBackendPorts } from "../agent-runner/backend-ports.ts";
import { db, schema } from "../db/index.ts";
import { env } from "../env.ts";
import { publish } from "../events.ts";
import { forbidden, HttpError, notFound } from "../http.ts";
import { applyConfirmedTx } from "../indexer/apply-tx.ts";
import { availableBudget, nextTaskId } from "../lib/views.ts";
import {
	agentSigner,
	fetchProgramAccount,
	invalidateCached,
	type RoleVaultAccount,
} from "../solana/chain.ts";
import { isHosted } from "../solana/gatekeeper.ts";
import { closeTaskIx, createTaskIx } from "../solana/scout.ts";
import { sendAsRelayer } from "../solana/tx.ts";
import { logActivity, requireRoleOwner } from "./gigs.ts";

const usd = (base: bigint) => `$${(Number(base) / 1e6).toFixed(2).replace(/\.00$/, "")}`;

/**
 * Our agent closes the task and reposts the remaining slots at `bounty`, in one transaction. The gig gets a new
 * row (new task); the old one is CLOSED and the price history carries over. Raises only, within the agent's
 * per-gig cap and the available budget; not while a delivery is in review or a recruiter holds the gig.
 */
export async function repriceGig(roleId: string, gigId: string, bounty: bigint, reason: string) {
	const [gig] = await db.select().from(schema.gigs).where(eq(schema.gigs.id, gigId));
	const [role] = await db.select().from(schema.roles).where(eq(schema.roles.id, roleId));
	if (!gig || !role || gig.roleId !== roleId) throw notFound("gig");
	if (!role.roleVault || !gig.taskAddress)
		throw new HttpError(409, "NOT_ON_CHAIN", "The gig isn't on-chain yet.");
	if (!(await isHosted(role)))
		throw new HttpError(409, "NOT_HOSTED", "Only Scout's agent can reprice this role's gigs.");
	if (gig.status !== "OPEN" && gig.status !== "PAUSED")
		throw new HttpError(409, "NO_OPEN_GIG", "This gig isn't open.");
	if (gig.pendingCount > 0)
		throw new HttpError(
			409,
			"GIG_HAS_PENDING",
			"A delivery is in review; raise the price after it's decided.",
		);
	if (gig.claimantWallet) throw new HttpError(409, "GIG_TAKEN", "A recruiter is working on this gig.");
	if (bounty <= gig.bounty)
		throw new HttpError(400, "NOT_A_RAISE", `The price is already ${usd(gig.bounty)}.`);
	if (bounty > env.agentMaxBounty)
		throw new HttpError(
			409,
			"AGENT_CAP_EXCEEDED",
			`Your agent can pay at most ${usd(env.agentMaxBounty)} per gig.`,
		);
	const slots = gig.maxDeliverables - gig.acceptedCount;
	if (slots <= 0) throw new HttpError(409, "GIG_FULL", "This gig is already filled.");
	const extra = (bounty - gig.bounty) * BigInt(slots);
	if (extra > availableBudget(role))
		throw new HttpError(409, "BUDGET_EXCEEDED", `That needs ${usd(extra)} more than the budget has left.`);

	const agent = await agentSigner();
	const roleVault = address(role.roleVault);
	invalidateCached(roleVault);
	const vault = await fetchProgramAccount<RoleVaultAccount>("RoleVault", roleVault);
	if (!vault) throw notFound("role vault");
	const taskId = await nextTaskId(roleId, vault.taskCount);
	const subjectScout = gig.aboutCandidateId
		? ((await db.select().from(schema.submissions).where(eq(schema.submissions.id, gig.aboutCandidateId)))[0]
				?.scoutWallet ?? null)
		: null;
	const sourcing = gig.type === "SOURCING";
	const { ix: createIx, task } = await createTaskIx({
		authority: agent.address,
		roleVault,
		taskId,
		type: gig.type,
		bounty,
		maxDeliverables: slots,
		exclusive: gig.exclusive,
		briefHash: new Uint8Array(Buffer.from(gig.briefHash, "hex")),
		holdbackBps: gig.holdbackBps,
		subjectScout: subjectScout ? address(subjectScout) : null,
		minAccepted: sourcing ? 0 : env.minAcceptedForCalls,
		minAcceptRateBps: sourcing ? 0 : env.minAcceptRateBpsForCalls,
		bondBps: sourcing ? env.sourcingBondBps : 0,
	});
	const closeIx = await closeTaskIx(agent.address, roleVault, address(gig.taskAddress));
	const { id: _id, createdAt: _c, ...rest } = gig;
	const [next] = await db
		.insert(schema.gigs)
		.values({
			...rest,
			onchainTaskId: taskId,
			taskAddress: task,
			bounty,
			maxDeliverables: slots,
			acceptedCount: 0,
			pendingCount: 0,
			claimantWallet: null,
			claimedAt: null,
			status: "POSTING",
			createTx: null,
			priceHistory: [
				...gig.priceHistory,
				{ bounty: bounty.toString(), at: new Date().toISOString(), reason },
			],
		})
		.returning();
	try {
		const confirmed = await sendAsRelayer([closeIx, createIx], [agent]);
		await db.update(schema.gigs).set({ status: "CLOSED" }).where(eq(schema.gigs.id, gig.id));
		await db
			.update(schema.gigs)
			.set({ status: gig.status === "PAUSED" ? "PAUSED" : "OPEN", createTx: confirmed.signature })
			.where(eq(schema.gigs.id, next.id));
		await applyConfirmedTx(confirmed);
		// Say what it costs: same open slots, the difference comes out of the uncommitted budget.
		const line = `${reason.replace(/[.]$/, "")} · same ${slots} open slot${slots === 1 ? "" : "s"}, ${usd(extra)} more from your uncommitted budget`;
		await logActivity(roleId, "REPRICED", line, { gigId: next.id, signature: confirmed.signature });
		publish({ type: "gig.updated", roleId, gigId: next.id, signature: confirmed.signature });
		return { gigId: next.id, signature: confirmed.signature };
	} catch (err) {
		await db.delete(schema.gigs).where(eq(schema.gigs.id, next.id));
		throw err;
	}
}

/** The company's "raise the price" button. */
export async function raiseGigPrice(wallet: string, input: { gigId: string; bounty: string }) {
	const [gig] = await db.select().from(schema.gigs).where(eq(schema.gigs.id, input.gigId));
	if (!gig || gig.purpose) throw notFound("gig");
	await requireRoleOwner(wallet as never, gig.roleId);
	const bounty = BigInt(input.bounty);
	return repriceGig(gig.roleId, gig.id, bounty, `You raised the price of "${gig.title}" to ${usd(bounty)}`);
}

/** The company read the agent's inbox question. */
export async function ackEscalation(wallet: string, input: { roleId: string; activityId: string }) {
	await requireRoleOwner(wallet as never, input.roleId);
	const [a] = await db
		.select()
		.from(schema.agentActivity)
		.where(eq(schema.agentActivity.id, input.activityId));
	if (!a || a.roleId !== input.roleId) throw notFound("question");
	await db
		.update(schema.agentActivity)
		.set({ data: { ...(a.data ?? {}), ackedAt: new Date().toISOString() } })
		.where(eq(schema.agentActivity.id, a.id));
	publish({ type: "role.updated", roleId: input.roleId });
	return { ok: true };
}

/** Must-have → nice-to-have (the agent's adjustCriteria); pending sourced profiles are scored again. */
export async function loosenRequirement(wallet: string, input: { roleId: string; criterionId: string }) {
	const role = await requireRoleOwner(wallet as never, input.roleId);
	const c = role.criteria.mustHave.find((x) => x.id === input.criterionId);
	if (!c) throw new HttpError(404, "NOT_FOUND", "That isn't one of the must-haves.");
	const ports = createBackendPorts(role.id);
	const r = await adjustCriteria(ports, {
		remove: [c.id],
		add: [{ kind: "niceToHave", label: c.label, weight: Math.max(1, Math.min(5, c.weight - 1)) }],
		note: `You made "${c.label}" a nice-to-have`,
	});
	if (!r.ok) throw new HttpError(409, "CRITERIA_INVALID", r.error ?? "The criteria couldn't be changed.");
	// Undecided sourced profiles (not waiting for the candidate) are reviewed again against the new criteria.
	const pending = await db
		.select({ id: schema.submissions.id })
		.from(schema.submissions)
		.leftJoin(
			schema.candidateConfirmations,
			eq(schema.candidateConfirmations.submissionId, schema.submissions.id),
		)
		.where(
			and(
				eq(schema.submissions.roleId, role.id),
				eq(schema.submissions.status, "PENDING"),
				eq(schema.submissions.deliverableType, "SOURCING"),
				eq(schema.submissions.confirmed, true),
				isNull(schema.candidateConfirmations.submissionId),
			),
		);
	for (const p of pending)
		await db.update(schema.submissions).set({ agentReview: null }).where(eq(schema.submissions.id, p.id));
	publish({ type: "role.updated", roleId: role.id });
	return { ok: true, rescoring: pending.length };
}

/**
 * A new one-time link for a pending candidate confirmation (the old one stops working). The sourcer (or, for a
 * call check, the candidate's sourcer) gets the url; the company triggers it without seeing it.
 */
export async function resendConfirmation(wallet: string, deliverableId: string) {
	const [row] = await db
		.select({ c: schema.candidateConfirmations, sub: schema.submissions, role: schema.roles })
		.from(schema.candidateConfirmations)
		.innerJoin(schema.submissions, eq(schema.submissions.id, schema.candidateConfirmations.submissionId))
		.innerJoin(schema.roles, eq(schema.roles.id, schema.submissions.roleId))
		.where(eq(schema.candidateConfirmations.submissionId, deliverableId));
	if (!row) throw notFound("confirmation");
	const linkHolder =
		row.c.kind === "call" && row.sub.aboutCandidateId
			? ((
					await db
						.select()
						.from(schema.submissions)
						.where(eq(schema.submissions.id, row.sub.aboutCandidateId))
				)[0]?.scoutWallet ?? null)
			: row.sub.scoutWallet;
	const isCompany = row.role.companyWallet === wallet;
	if (!isCompany && wallet !== linkHolder) throw forbidden("only the sourcer or the company");
	if (row.c.status !== "PENDING" || row.c.expiresAt < new Date())
		throw new HttpError(409, "LINK_EXPIRED", "This confirmation isn't pending any more.");
	const token = randomBytes(24).toString("base64url");
	const link = `${env.publicAppUrl}/c/${token}`;
	await db
		.update(schema.candidateConfirmations)
		.set({ tokenHash: createHash("sha256").update(token).digest("hex"), link })
		.where(eq(schema.candidateConfirmations.submissionId, deliverableId));
	await logActivity(row.role.id, "NOTE", `New confirmation link for ${row.sub.candidateName}`, {
		deliverableId,
		gigId: row.sub.gigId,
	});
	publish({
		type: "submission.updated",
		roleId: row.role.id,
		submissionId: deliverableId,
		scout: linkHolder ?? undefined,
		message: "confirmation.resent",
	});
	return { url: wallet === linkHolder ? link : null, expiresAt: row.c.expiresAt.toISOString() };
}
