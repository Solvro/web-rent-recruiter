import { createHash } from "node:crypto";
/**
 * Builders for every Scout program instruction. Account addresses are derived here once and passed by IDL name,
 * so the program can name/order its accounts freely as long as names come from this vocabulary. Optional IDL
 * accounts that are left undefined are filled with the program ID (Anchor's "None").
 *
 * Program model (docs/agent-gigs.md): RoleVault holds the budget; the agent (role.agent) posts Tasks (gigs);
 * recruiters claim exclusive tasks and submit deliverables (Submission under the Task).
 */
import type { GigType } from "@scout/shared";
import { type Address, address, type Instruction } from "@solana/kit";
import {
	findAta,
	findConfigPda,
	findRoleVaultPda,
	findSubmissionPda,
	findTaskPda,
	relayer,
	requireDeployment,
	scoutChainInfo,
} from "./chain.ts";
import { buildScoutInstruction } from "./tx.ts";

type Ctx = {
	company?: Address;
	scout?: Address;
	roleVault?: Address;
	task?: Address;
	submission?: Address;
	authority?: Address;
	/** Resolve the scout's operator accounts (accept / settle / attest need them exactly when one is set). */
	withOperator?: boolean;
};

async function accountsFor(ctx: Ctx): Promise<Record<string, Address | undefined>> {
	const d = requireDeployment();
	const mint = address(d.usdcMint);
	const payer = (await relayer()).address;
	const roleVaultAta = ctx.roleVault ? await findAta(ctx.roleVault, mint) : undefined;
	const companyAta = ctx.company ? await findAta(ctx.company, mint) : undefined;
	const scoutAta = ctx.scout ? await findAta(ctx.scout, mint) : undefined;
	const info = ctx.scout ? await scoutChainInfo(ctx.scout) : undefined;
	const operator = ctx.withOperator ? info?.operator : null;
	return {
		payer,
		config: d.config ? address(d.config) : await findConfigPda(),
		mint,
		usdcMint: mint,
		treasuryTokenAccount: address(d.treasuryTokenAccount),
		company: ctx.company,
		companyTokenAccount: companyAta,
		scout: ctx.scout,
		scoutTokenAccount: scoutAta,
		scoutProfile: info?.profileAddress,
		roleVault: ctx.roleVault,
		vaultTokenAccount: roleVaultAta,
		task: ctx.task,
		submission: ctx.submission,
		authority: ctx.authority,
		operator: operator?.address,
		operatorTokenAccount: operator?.tokenAccount,
		/** v3.2: rent of a closed (rejected) Submission goes back to its payer of record: the relayer. */
		rentPayer: payer,
	};
}

export const TASK_TYPE: Record<GigType, string> = {
	SOURCING: "Sourcing",
	SCREENING_CALL: "ScreeningCall",
	REFERENCE_CHECK: "ReferenceCheck",
};

// ---- Roles ---------------------------------------------------------------------

export async function createRoleIx(p: {
	company: Address;
	roleId: bigint;
	agent: Address | null;
	reviewWindowSeconds: number;
	claimTimeoutSeconds: number;
	holdbackWindowSeconds: number;
	initialDeposit: bigint;
	/** v3.2: the most the agent may put on one gig, and in total across open gigs. */
	agentMaxBounty: bigint;
	agentMaxCommitment: bigint;
}): Promise<{ ix: Instruction; roleVault: Address }> {
	const roleVault = await findRoleVaultPda(p.company, p.roleId);
	const ix = buildScoutInstruction(
		"create_role",
		{
			roleId: p.roleId,
			agent: p.agent,
			reviewWindowSeconds: BigInt(p.reviewWindowSeconds),
			claimTimeoutSeconds: BigInt(p.claimTimeoutSeconds),
			holdbackWindowSeconds: BigInt(p.holdbackWindowSeconds),
			initialDeposit: p.initialDeposit,
			agentMaxBounty: p.agentMaxBounty,
			agentMaxCommitment: p.agentMaxCommitment,
		},
		await accountsFor({ company: p.company, roleVault }),
	);
	return { ix, roleVault };
}

export async function topUpIx(company: Address, roleVault: Address, amount: bigint) {
	return buildScoutInstruction("top_up", { amount }, await accountsFor({ company, roleVault }));
}

export async function closeRoleIx(company: Address, roleVault: Address) {
	return buildScoutInstruction("close_role", {}, await accountsFor({ company, roleVault }));
}

// ---- Tasks (gigs) ----------------------------------------------------------------

/** Signed by the company or role.agent. */
export async function createTaskIx(p: {
	authority: Address;
	roleVault: Address;
	taskId: number;
	type: GigType;
	bounty: bigint;
	maxDeliverables: number;
	exclusive: boolean;
	briefHash: Uint8Array;
	holdbackBps: number;
	/** v3.1: the recruiter a call is about (their sourced candidate) — they may not take it (no self-dealing). */
	subjectScout?: Address | null;
	/** v3.1: accepted deliverables a recruiter needs before taking this gig. */
	minAccepted?: number;
	/** v3.2: minimum acceptance rate (bps) for taking this gig. */
	minAcceptRateBps?: number;
	/** v3.1: bond (bps of bounty) an unvouched recruiter posts per deliverable; refunded on accept. */
	bondBps?: number;
	/** v3.3: who may attest candidate confirmation besides role.agent (a self-hosted agent's backstop). */
	confirmationAttestor?: Address | null;
}): Promise<{ ix: Instruction; task: Address }> {
	const task = await findTaskPda(p.roleVault, p.taskId);
	const ix = buildScoutInstruction(
		"create_task",
		{
			taskId: p.taskId,
			taskType: TASK_TYPE[p.type],
			bounty: p.bounty,
			maxDeliverables: p.maxDeliverables,
			exclusive: p.exclusive,
			briefHash: p.briefHash,
			holdbackBps: p.holdbackBps,
			subjectScout: p.subjectScout ?? null,
			minAccepted: p.minAccepted ?? 0,
			minAcceptRateBps: p.minAcceptRateBps ?? 0,
			bondBps: p.bondBps ?? 0,
			// v3.3: null = role.agent attests candidate confirmation at settle time.
			confirmationAttestor: p.confirmationAttestor ?? null,
		},
		await accountsFor({ authority: p.authority, roleVault: p.roleVault, task }),
	);
	return { ix, task };
}

/** v3.2: `gatekeeper` (role.agent) co-signs claims and deliverables; the relayer adds it at tx.submit. */
export async function claimTaskIx(scout: Address, roleVault: Address, task: Address, gatekeeper: Address) {
	return buildScoutInstruction(
		"claim_task",
		{},
		{ ...(await accountsFor({ scout, roleVault, task })), gatekeeper },
	);
}

export async function releaseClaimIx(authority: Address, roleVault: Address, task: Address) {
	return buildScoutInstruction("release_claim", {}, await accountsFor({ authority, roleVault, task }));
}

export async function closeTaskIx(authority: Address, roleVault: Address, task: Address) {
	return buildScoutInstruction("close_task", {}, await accountsFor({ authority, roleVault, task }));
}

// ---- Scouts ------------------------------------------------------------------------

/** Plain registration (no operator vouching: that needs the operator authority's signature). */
export async function registerScoutIx(scout: Address) {
	return buildScoutInstruction("register_scout", {}, await accountsFor({ scout }));
}

export async function isScoutRegistered(scout: Address) {
	return (await scoutChainInfo(scout)).profile !== null;
}

// ---- Deliverables ------------------------------------------------------------------

export async function submitDeliverableIx(p: {
	scout: Address;
	roleVault: Address;
	task: Address;
	deliverableHash: Uint8Array;
	evidenceHash: Uint8Array;
	gatekeeper: Address;
}) {
	const submission = await findSubmissionPda(p.task, p.deliverableHash);
	const ix = buildScoutInstruction(
		"submit_deliverable",
		{ deliverableHash: p.deliverableHash, evidenceHash: p.evidenceHash },
		{
			...(await accountsFor({ scout: p.scout, roleVault: p.roleVault, task: p.task, submission })),
			gatekeeper: p.gatekeeper,
		},
	);
	return { ix, submission };
}

type SubmissionCtx = {
	company: Address;
	scout: Address;
	roleVault: Address;
	task: Address;
	submission: Address;
};

/** sha256 of a UTF-8 text: v3.3 commits the review / reject reason on-chain (the text lives in the DB). */
export const textHash = (text: string) => new Uint8Array(createHash("sha256").update(text, "utf8").digest());

/** authority = company or role.agent. `review` = the summary whose hash goes on-chain (review_hash). */
export async function acceptIx(p: SubmissionCtx & { authority: Address; review: string }) {
	return buildScoutInstruction(
		"accept_submission",
		{ reviewHash: textHash(p.review) },
		await accountsFor({ ...p, withOperator: true }),
	);
}

/** authority = company or role.agent. `reasonText` = what the recruiter is shown (its hash goes on-chain). */
export async function rejectIx(
	p: SubmissionCtx & { authority: Address; reasonCode: number; reasonText: string },
) {
	return buildScoutInstruction(
		"reject_submission",
		{ reasonCode: p.reasonCode, reasonHash: textHash(p.reasonText) },
		await accountsFor(p),
	);
}

/** v3.3: SOURCING needs an attestor signer (role.agent / the task's attestor, or the company); others don't. */
export async function settleExpiredIx(p: SubmissionCtx & { attestor?: Address }) {
	return buildScoutInstruction(
		"settle_expired",
		{},
		{ ...(await accountsFor({ ...p, withOperator: true })), attestor: p.attestor },
	);
}

export async function attestOutcomeIx(
	p: SubmissionCtx & { authority: Address; outcome: "Advanced" | "Fabricated"; reasonCode: number },
) {
	return buildScoutInstruction(
		"attest_outcome",
		{ outcome: p.outcome, reasonCode: p.reasonCode },
		await accountsFor({ ...p, withOperator: true }),
	);
}

export async function releaseHoldbackIx(p: SubmissionCtx) {
	return buildScoutInstruction("release_holdback", {}, await accountsFor(p));
}
