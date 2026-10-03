/**
 * Screening quality: candidate no-shows (one reschedule, then the gig closes; a show-up fee when the notetaker
 * proves the recruiter was there), "this candidate may be fake" reports, and the do-not-contact list.
 */
import { createHash } from "node:crypto";
import type { NoShowResponse, UnsignedTx } from "@scout/shared";
import { address } from "@solana/kit";
import { and, eq, isNull } from "drizzle-orm";
import type { z } from "zod";
import { canonical } from "../agent-runner/backend-ports.ts";
import { db, schema } from "../db/index.ts";
import { env } from "../env.ts";
import { publish } from "../events.ts";
import { HttpError, notFound } from "../http.ts";
import { normalizeProfileUrl, toHex } from "../lib/candidate-hash.ts";
import { availableBudget } from "../lib/views.ts";
import { status as recordingStatus } from "../recall/service.ts";
import {
	agentSigner,
	fetchProgramAccount,
	invalidateCached,
	type RoleVaultAccount,
	scoutChainInfo,
} from "../solana/chain.ts";
import { isHosted } from "../solana/gatekeeper.ts";
import {
	acceptIx,
	closeTaskIx,
	createTaskIx,
	registerScoutIx,
	submitDeliverableIx,
} from "../solana/scout.ts";
import { buildUnsignedTx, sendAsRelayer } from "../solana/tx.ts";
import { loadGig, logActivity, requireRoleOwner } from "./gigs.ts";
import { attestOutcome, decide } from "./submissions.ts";

const DAY_MS = 86_400_000;
const first = (name: string | null | undefined) => (name ?? "The candidate").split(" ")[0] ?? "The candidate";
const usd = (base: bigint) => `$${(Number(base) / 1e6).toFixed(2).replace(/\.00$/, "")}`;

/** Unsalted key of a person across roles (normalized profile URL). */
export const profileKey = (profileUrl: string) =>
	createHash("sha256").update(normalizeProfileUrl(profileUrl)).digest("hex");

/** deliver: nobody delivers a person a company confirmed as fake. */
export async function requireContactable(profileUrl: string) {
	const [flag] = await db
		.select({ id: schema.candidateFlags.id })
		.from(schema.candidateFlags)
		.where(
			and(
				eq(schema.candidateFlags.profileKey, profileKey(profileUrl)),
				eq(schema.candidateFlags.kind, "FABRICATED"),
			),
		)
		.limit(1);
	if (flag) {
		throw new HttpError(
			409,
			"DO_NOT_CONTACT",
			"This person was reported as a fake candidate and can't be submitted.",
		);
	}
}

async function flag(
	kind: "FABRICATED" | "NO_SHOW" | "REPORTED",
	sub: { id: string; profileUrl: string; roleId: string },
	by: string,
	reason: string,
	gigId: string | null = null,
) {
	await db.insert(schema.candidateFlags).values({
		profileKey: profileKey(sub.profileUrl),
		kind,
		roleId: sub.roleId,
		submissionId: sub.id,
		gigId,
		byWallet: by,
		reason,
	});
}

/** Our agent takes the task off-chain too (best effort: a task with a delivery in review stays open). */
async function closeOnchain(
	role: { agentPubkey: string | null; roleVault: string | null },
	taskAddress: string | null,
) {
	if (!taskAddress || !role.roleVault || !(await isHosted(role))) return;
	const agent = await agentSigner();
	await sendAsRelayer(
		[await closeTaskIx(agent.address, address(role.roleVault), address(taskAddress))],
		[agent],
	).catch((err) => console.warn(`[screening] close_task ${taskAddress}: ${(err as Error).message}`));
}

// ---- No-shows -------------------------------------------------------------------------------------

/** The notetaker was in the meeting: the recruiter showed up (the candidate didn't). */
async function notetakerWasThere(wallet: string, gigId: string) {
	const rec = await recordingStatus(wallet, gigId).catch(() => null);
	return Boolean(rec && ["in_call", "recording", "processing", "done"].includes(rec.status));
}

export async function noShow(wallet: string, gigId: string): Promise<z.output<typeof NoShowResponse>> {
	const { gig, role, about } = await loadGig(gigId);
	if (gig.type === "SOURCING") throw new HttpError(409, "NOT_A_CALL", "Only calls can have a no-show.");
	if (gig.claimantWallet !== wallet)
		throw new HttpError(403, "NOT_CLAIMANT", "Only the recruiter who took the gig.");
	if (gig.status !== "OPEN") throw new HttpError(409, "NO_OPEN_GIG", "This gig isn't open.");
	const who = first(about?.candidateName);
	const noShows = gig.noShows + 1;

	// Show-up fee, once per gig, from the role budget: only with the notetaker's proof and a hosted agent to pay it.
	let showUpFee = gig.showUpFee;
	if (showUpFee === null && (await notetakerWasThere(wallet, gig.id)) && (await isHosted(role))) {
		const fee = env.showUpFee < gig.bounty ? env.showUpFee : gig.bounty / 4n;
		if (fee > 0n && availableBudget(role) >= fee) showUpFee = fee;
	}

	const now = new Date();
	const closing = noShows >= 2;
	await db
		.update(schema.gigs)
		.set({
			noShows,
			showUpFee,
			// The 24 h to hold the call restart from the reschedule.
			...(closing ? { status: "CLOSED" as const } : { claimedAt: now }),
		})
		.where(eq(schema.gigs.id, gig.id));
	if (closing) {
		if (about) await flag("NO_SHOW", about, wallet, "Missed the call twice", gig.id);
		await logActivity(role.id, "NOTE", `${who} missed the call twice, so I stopped this call`, {
			gigId: gig.id,
			data: { reasons: ["The recruiter isn't penalised for it."] },
		});
		await closeOnchain(role, gig.taskAddress);
	} else {
		await logActivity(role.id, "NOTE", `${who} didn't join the call. Rescheduling once (24 h)`, {
			gigId: gig.id,
		});
	}
	if (showUpFee !== null && gig.showUpFee === null) {
		await logActivity(
			role.id,
			"NOTE",
			`Offered the recruiter a ${usd(showUpFee)} show-up fee (the notetaker was in the call)`,
			{
				gigId: gig.id,
			},
		);
	}
	publish({ type: "gig.updated", roleId: role.id, gigId: gig.id, scout: wallet, message: "gig.no_show" });
	return {
		noShows,
		status: closing ? "CLOSED" : "OPEN",
		deadline: new Date((closing ? (gig.claimedAt ?? now) : now).getTime() + DAY_MS).toISOString(),
		showUpFee: showUpFee !== null ? { amount: showUpFee.toString() } : null,
	};
}

/**
 * One signature claims the show-up fee: our agent posts a one-slot task for the fee, the recruiter delivers to it
 * and the agent accepts, all in one transaction (atomic; nothing is posted if the recruiter never signs).
 */
export async function claimShowUpFee(wallet: string, gigId: string): Promise<{ unsignedTx: UnsignedTx }> {
	const { gig, role, about, feeGig } = await loadGig(gigId);
	if (gig.claimantWallet !== wallet)
		throw new HttpError(403, "NOT_CLAIMANT", "Only the recruiter who took the gig.");
	if (!gig.showUpFee) throw new HttpError(409, "NO_SHOW_UP_FEE", "There is no show-up fee for this gig.");
	if (feeGig && feeGig.acceptedCount > 0)
		throw new HttpError(409, "ALREADY_PAID", "The show-up fee was already paid.");
	if (!role.roleVault || !(await isHosted(role))) {
		throw new HttpError(409, "NOT_HOSTED", "Only roles run by Scout's agent pay show-up fees automatically.");
	}
	const agent = await agentSigner();
	const roleVault = address(role.roleVault);
	// A previous unsigned attempt is replaced (its task id may be stale now).
	if (feeGig) {
		await db
			.delete(schema.submissions)
			.where(and(eq(schema.submissions.gigId, feeGig.id), eq(schema.submissions.confirmed, false)));
		await db.delete(schema.gigs).where(eq(schema.gigs.id, feeGig.id));
	}
	invalidateCached(roleVault);
	const vault = await fetchProgramAccount<RoleVaultAccount>("RoleVault", roleVault);
	if (!vault) throw notFound("role vault");
	const taskId = Number(vault.taskCount);
	const title = `Show-up fee: ${about?.candidateName ?? "the candidate"} didn't join`;
	const brief = `The notetaker was in the call for "${gig.title}"; the candidate didn't join.`;
	const briefHash = new Uint8Array(
		createHash("sha256")
			.update(canonical({ title, brief, script: null }))
			.digest(),
	);
	const { ix: createIx, task } = await createTaskIx({
		authority: agent.address,
		roleVault,
		taskId,
		type: "SCREENING_CALL",
		bounty: gig.showUpFee,
		maxDeliverables: 1,
		exclusive: false,
		briefHash,
		holdbackBps: 0,
	});
	const deliverableHash = new Uint8Array(createHash("sha256").update(`show-up:${gig.id}:${wallet}`).digest());
	const review = `Show-up fee: the notetaker was in the call for "${gig.title}", the candidate didn't join.`;
	// Call tasks need evidence on-chain: the hash of this note (the notetaker's record backs it).
	const evidenceHash = new Uint8Array(createHash("sha256").update(review).digest());
	const { ix: submitIx, submission } = await submitDeliverableIx({
		scout: address(wallet),
		roleVault,
		task,
		deliverableHash,
		evidenceHash,
		gatekeeper: agent.address,
	});
	const accept = await acceptIx({
		company: address(role.companyWallet),
		scout: address(wallet),
		roleVault,
		task,
		submission,
		authority: agent.address,
		review,
	});
	const [row] = await db
		.insert(schema.gigs)
		.values({
			roleId: role.id,
			onchainTaskId: taskId,
			taskAddress: task,
			type: "SCREENING_CALL",
			title,
			brief,
			briefHash: toHex(briefHash),
			bounty: gig.showUpFee,
			maxDeliverables: 1,
			exclusive: false,
			holdbackBps: 0,
			// Hidden from the board and the agent; OPEN so the indexer keeps its counters.
			status: "OPEN",
			purpose: "show_up_fee",
			aboutGigId: gig.id,
		})
		.returning();
	const info = await scoutChainInfo(address(wallet));
	await db.insert(schema.submissions).values({
		roleId: role.id,
		gigId: row.id,
		deliverableType: "SCREENING_CALL",
		payload: { type: "SHOW_UP_FEE", gigId: gig.id },
		scoutWallet: wallet,
		candidateName: about?.candidateName ?? "Candidate",
		profileUrl: about?.profileUrl ?? "",
		notes: review,
		consent: false,
		candidateHash: toHex(deliverableHash),
		evidenceHash: toHex(evidenceHash),
		operatorFeeBps: info.operator ? Number(info.operator.feeBps) : 0,
		onchainAddress: submission,
		reviewDeadline: new Date(Date.now() + role.reviewWindowSeconds * 1000),
		agentReview: { decision: { action: "accept", reason: review }, reviewedAt: new Date().toISOString() },
	});
	const ixs = [...(info.profile ? [] : [await registerScoutIx(address(wallet))]), createIx, submitIx, accept];
	return {
		unsignedTx: await buildUnsignedTx(ixs, `Get your ${usd(gig.showUpFee)} show-up fee`, {
			gatekeeper: true,
		}),
	};
}

// ---- Fake-candidate reports ------------------------------------------------------------------------

/** A recruiter on a call: "this candidate may be fake". The gig goes on hold; the company decides. */
export async function reportGig(wallet: string, input: { gigId: string; reason: string }) {
	const { gig, role, about } = await loadGig(input.gigId);
	if (gig.type === "SOURCING" || !about)
		throw new HttpError(409, "NOT_A_CALL", "Report a candidate from their call.");
	if (gig.claimantWallet !== wallet)
		throw new HttpError(403, "NOT_CLAIMANT", "Only the recruiter who took the gig.");
	if (gig.reported) return { ok: true };
	await db
		.update(schema.gigs)
		.set({ reported: true, ...(gig.status === "OPEN" ? { status: "PAUSED" as const } : {}) })
		.where(eq(schema.gigs.id, gig.id));
	await flag("REPORTED", about, wallet, input.reason, gig.id);
	const [by] = await db.select().from(schema.accounts).where(eq(schema.accounts.wallet, wallet));
	await logActivity(
		role.id,
		"ESCALATED",
		`${by?.displayName ?? "A recruiter"} reported ${about.candidateName} as possibly fake`,
		{
			gigId: gig.id,
			deliverableId: about.id,
			data: { reasons: [input.reason] },
		},
	);
	publish({ type: "gig.updated", roleId: role.id, gigId: gig.id, message: "gig.reported" });
	return { ok: true };
}

async function candidateGigs(roleId: string, candidateId: string) {
	return db
		.select()
		.from(schema.gigs)
		.where(
			and(
				eq(schema.gigs.roleId, roleId),
				eq(schema.gigs.aboutCandidateId, candidateId),
				isNull(schema.gigs.purpose),
			),
		);
}

/**
 * The company: the candidate is fake. Fabricated on the sourcing deliverable (held part back to the budget, the
 * sourcer flagged), do-not-contact everywhere, their gigs stop.
 */
export async function reportCandidate(
	wallet: string,
	input: { roleId: string; candidateId: string; reason: string },
) {
	const role = await requireRoleOwner(wallet as never, input.roleId);
	const [sub] = await db
		.select()
		.from(schema.submissions)
		.where(eq(schema.submissions.id, input.candidateId));
	if (!sub || sub.roleId !== role.id || sub.deliverableType !== "SOURCING") throw notFound("candidate");
	await flag("FABRICATED", sub, wallet, input.reason);
	await db
		.update(schema.candidateFlags)
		.set({ resolvedAt: new Date() })
		.where(
			and(
				eq(schema.candidateFlags.submissionId, sub.id),
				eq(schema.candidateFlags.kind, "REPORTED"),
				isNull(schema.candidateFlags.resolvedAt),
			),
		);
	await db
		.update(schema.shortlist)
		.set({ decision: "PASSED", decidedAt: new Date() })
		.where(and(eq(schema.shortlist.roleId, role.id), eq(schema.shortlist.candidateId, sub.id)));
	for (const g of await candidateGigs(role.id, sub.id)) {
		if (g.status === "CLOSED") continue;
		await db.update(schema.gigs).set({ status: "CLOSED", reported: false }).where(eq(schema.gigs.id, g.id));
		await closeOnchain(role, g.taskAddress);
	}

	let unsignedTx: UnsignedTx | null = null;
	const text = `Reported as a fake candidate: ${input.reason}`;
	if (sub.status === "ACCEPTED" && sub.laterStatus === "HELD") {
		unsignedTx =
			(
				await attestOutcome(wallet as never, sub.id, { outcome: "fabricated", reasonCode: 0 }).catch(
					() => null,
				)
			)?.unsignedTx ?? null;
	} else if (sub.status === "PENDING") {
		unsignedTx =
			(
				await decide(wallet as never, sub.id, {
					decision: "reject",
					reasonCode: "OTHER",
					reasonText: text,
				}).catch(() => null)
			)?.unsignedTx ?? null;
	}
	await logActivity(
		role.id,
		"ESCALATED",
		`You reported ${sub.candidateName} as fake. They're on the do-not-contact list${unsignedTx ? "; sign to take back the recruiter's held part" : ""}`,
		{ deliverableId: sub.id, data: { reasons: [input.reason] } },
	);
	publish({ type: "shortlist.updated", roleId: role.id, submissionId: sub.id });
	return { ok: true, unsignedTx };
}

/** The company: the report was wrong. The candidate's gigs reopen. */
export async function dismissReport(wallet: string, input: { roleId: string; candidateId: string }) {
	const role = await requireRoleOwner(wallet as never, input.roleId);
	await db
		.update(schema.candidateFlags)
		.set({ resolvedAt: new Date() })
		.where(
			and(
				eq(schema.candidateFlags.submissionId, input.candidateId),
				eq(schema.candidateFlags.kind, "REPORTED"),
				isNull(schema.candidateFlags.resolvedAt),
			),
		);
	for (const g of await candidateGigs(role.id, input.candidateId)) {
		if (!g.reported) continue;
		await db
			.update(schema.gigs)
			.set({ reported: false, ...(g.status === "PAUSED" ? { status: "OPEN" as const } : {}) })
			.where(eq(schema.gigs.id, g.id));
		publish({ type: "gig.updated", roleId: role.id, gigId: g.id, message: "gig.report_dismissed" });
	}
	await logActivity(role.id, "NOTE", "You dismissed the fake-candidate report; the calls continue", {
		deliverableId: input.candidateId,
	});
	return { ok: true };
}
