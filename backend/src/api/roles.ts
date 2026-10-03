/**
 * Role use-cases. Shared by the tRPC router (src/trpc) and the deprecated REST routes (src/routes).
 * Errors are HttpError with an app code; both transports map them.
 */
import type {
	CreateRoleRequest,
	CreateRoleResponse,
	DraftRoleRequest,
	DraftRoleResponse,
	RoleDetail,
	RoleSummary,
	TaskView,
	TopUpRequest,
	UnsignedTx,
} from "@scout/shared";
import { type AgentReview, DEFAULT_FEE_BPS, fromBaseUnits } from "@scout/shared";
import { type Address, address } from "@solana/kit";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { z } from "zod";
import { draftRole as agentDraftRole, publishTask, suggestBudget } from "../agent/index.ts";
import { db, schema } from "../db/index.ts";
import { env } from "../env.ts";
import { badRequest, forbidden, HttpError, notFound } from "../http.ts";
import { newRoleSalt } from "../lib/candidate-hash.ts";
import { withJdLanguages } from "../lib/jd-languages.ts";
import { roleDetail, roleSummary, submissionView, taskView } from "../lib/views.ts";
import { currentPipelineSummary } from "../services/pipeline.ts";
import {
	agentSigner,
	fetchProgramAccount,
	findConfigPda,
	findRoleVaultPda,
	requireDeployment,
	rpc,
} from "../solana/chain.ts";
import { reviewerMode } from "../solana/gatekeeper.ts";
import { closeRoleIx, createRoleIx, topUpIx } from "../solana/scout.ts";
import { buildUnsignedTx } from "../solana/tx.ts";

const usdc = (base: bigint) =>
	`${fromBaseUnits(base).toLocaleString("en-US", { maximumFractionDigits: 2 })} USDC`;

export async function loadRole(id: string) {
	const [row] = await db
		.select({
			role: schema.roles,
			companyName: schema.accounts.companyName,
			displayName: schema.accounts.displayName,
		})
		.from(schema.roles)
		.innerJoin(schema.accounts, eq(schema.accounts.wallet, schema.roles.companyWallet))
		.where(eq(schema.roles.id, id));
	if (!row) throw notFound("role");
	return { role: row.role, companyName: row.companyName ?? row.displayName };
}

async function requireCompany(wallet: Address) {
	const [acc] = await db.select().from(schema.accounts).where(eq(schema.accounts.wallet, wallet));
	if (acc?.kind !== "company") throw forbidden("company account required (PUT /me with kind=company)");
	return acc;
}

/**
 * Next u64 role id whose RoleVault PDA is still free on-chain. The DB sequence restarts when the DB is reset
 * (seed --reset, fresh volume) but the chain remembers, so on a collision jump the sequence to epoch-ms.
 */
async function allocateRoleId(company: Address): Promise<number> {
	for (let attempt = 0; attempt < 5; attempt++) {
		const { rows } = await db.execute<{ id: string }>(
			sql`select nextval(pg_get_serial_sequence('roles', 'onchainRoleId')) as id`,
		);
		const id = Number(rows[0]?.id);
		const res = await rpc
			.getAccountInfo(await findRoleVaultPda(company, id), { encoding: "base64", commitment: "confirmed" })
			.send();
		if (!res.value) return id;
		await db.execute(
			sql`select setval(pg_get_serial_sequence('roles', 'onchainRoleId'), greatest(${id + 1}, (extract(epoch from now()) * 1000)::bigint))`,
		);
	}
	throw new HttpError(503, "ROLE_ID_UNAVAILABLE", "could not allocate a free on-chain role id");
}

async function currentFeeBps(): Promise<number> {
	try {
		const cfg = await fetchProgramAccount<{ feeBps: number }>("Config", await findConfigPda());
		return cfg ? Number(cfg.feeBps) : DEFAULT_FEE_BPS;
	} catch {
		return DEFAULT_FEE_BPS;
	}
}

async function reviewsFor(submissionIds: string[]) {
	if (!submissionIds.length) return new Map<string, AgentReview>();
	const rows = await db
		.select()
		.from(schema.agentReviews)
		.where(inArray(schema.agentReviews.submissionId, submissionIds));
	return new Map(rows.map((r) => [r.submissionId, r.review]));
}

export async function draftRole(
	input: z.output<typeof DraftRoleRequest>,
): Promise<z.output<typeof DraftRoleResponse>> {
	const raw = await agentDraftRole(input.jobDescription);
	// "Fluent English (C1)" in the JD must survive the draft: it's what books the language check.
	const draft = { ...raw, criteria: withJdLanguages(input.jobDescription, raw.criteria) };
	const budget = await suggestBudget(draft.criteria, { title: draft.title });
	return {
		...draft,
		suggestedBounty: budget.bounty.toString(),
		suggestedMaxCandidates: budget.maxCandidates,
		rationale: budget.rationale,
	};
}

export async function createRole(
	wallet: Address,
	b: z.output<typeof CreateRoleRequest>,
): Promise<z.output<typeof CreateRoleResponse>> {
	await requireCompany(wallet);
	requireDeployment();
	const deposit = BigInt(b.deposit);
	if (deposit <= 0n) throw badRequest("the budget must be positive");
	const holdbackBps = b.holdbackBps ?? env.holdbackBps;
	const hosted = (b.reviewer?.mode ?? "scout") === "scout";
	const holdbackWindowSeconds = Math.max(
		b.holdbackWindowSeconds ?? env.holdbackWindowSeconds,
		hosted ? env.minHoldbackWindowSeconds : 0,
	);
	const reviewWindowSeconds = Math.max(b.reviewWindowSeconds, hosted ? env.minReviewWindowSeconds : 0);
	const claimTimeoutSeconds = b.claimTimeoutSeconds ?? env.claimTimeoutSeconds;
	// The company hires an agent: its key is role.agent and spends the budget on gigs. Scout's by default.
	const reviewer = b.reviewer ?? { mode: "scout" as const };
	const agent =
		reviewer.mode === "scout"
			? (await agentSigner()).address
			: reviewer.mode === "custom"
				? address(reviewer.agentPubkey)
				: null;

	const onchainRoleId = await allocateRoleId(wallet);
	const [role] = await db
		.insert(schema.roles)
		.values({
			onchainRoleId,
			companyWallet: wallet,
			title: b.title,
			summary: b.summary,
			jobDescription: b.jobDescription,
			criteria: b.criteria,
			roleSalt: newRoleSalt(),
			taskType: b.taskType,
			bounty: b.bounty ? BigInt(b.bounty) : 0n,
			maxCandidates: b.maxCandidates ?? 0,
			reviewWindowSeconds,
			feeBps: await currentFeeBps(),
			holdbackBps,
			holdbackWindowSeconds,
			autoAccept: b.autoAccept ?? null,
			agentManaged: true,
			agentPubkey: agent,
			agentStatus:
				reviewer.mode === "scout"
					? "Waiting for the budget to land"
					: reviewer.mode === "custom"
						? "Run by your own agent"
						: "You review this role",
			status: "DRAFT",
		})
		.returning();

	const { ix, roleVault } = await createRoleIx({
		company: wallet,
		roleId: BigInt(role.onchainRoleId),
		agent,
		reviewWindowSeconds,
		claimTimeoutSeconds,
		holdbackWindowSeconds,
		initialDeposit: deposit,
		agentMaxBounty: env.agentMaxBounty,
		agentMaxCommitment: deposit,
	});
	await db.update(schema.roles).set({ roleVault }).where(eq(schema.roles.id, role.id));
	const unsignedTx = await buildUnsignedTx(
		[ix],
		`Give your agent a ${usdc(deposit)} budget for "${b.title}"`,
	);
	return { roleId: role.id, unsignedTx };
}

export async function listRoles(wallet: Address): Promise<RoleSummary[]> {
	const rows = await db
		.select({
			role: schema.roles,
			companyName: schema.accounts.companyName,
			displayName: schema.accounts.displayName,
		})
		.from(schema.roles)
		.innerJoin(schema.accounts, eq(schema.accounts.wallet, schema.roles.companyWallet))
		.where(eq(schema.roles.companyWallet, wallet))
		.orderBy(desc(schema.roles.createdAt));
	return rows.map((r) => roleSummary(r.role, r.companyName ?? r.displayName));
}

export async function getRole(id: string): Promise<RoleDetail> {
	const { role, companyName } = await loadRole(id);
	const rows = await db
		.select({ sub: schema.submissions, scout: schema.accounts })
		.from(schema.submissions)
		.innerJoin(schema.accounts, eq(schema.accounts.wallet, schema.submissions.scoutWallet))
		.where(and(eq(schema.submissions.roleId, role.id), eq(schema.submissions.confirmed, true)))
		.orderBy(desc(schema.submissions.submittedAt));
	const reviews = await reviewsFor(rows.map((r) => r.sub.id));
	const pipelineSummary = await currentPipelineSummary(role);
	return {
		...roleDetail(
			role,
			companyName,
			rows.map((r) => submissionView(r.sub, r.scout, reviews.get(r.sub.id) ?? null, role)),
		),
		pipelineSummary,
		reviewer: { mode: await reviewerMode(role), agentPubkey: role.agentPubkey },
	};
}

export async function topUp(
	wallet: Address,
	id: string,
	input: z.output<typeof TopUpRequest>,
): Promise<{ unsignedTx: UnsignedTx }> {
	const { role } = await loadRole(id);
	if (role.companyWallet !== wallet) throw forbidden("only the role's company can top up");
	if (role.status !== "OPEN" || !role.roleVault)
		throw new HttpError(409, "ROLE_NOT_OPEN", "role is not open");
	const amount = BigInt(input.amount);
	if (amount <= 0n) throw badRequest("amount must be positive");
	const ix = await topUpIx(wallet, address(role.roleVault), amount);
	return { unsignedTx: await buildUnsignedTx([ix], `Add ${usdc(amount)} to the "${role.title}" budget`) };
}

export async function closeRole(wallet: Address, id: string): Promise<{ unsignedTx: UnsignedTx }> {
	const { role } = await loadRole(id);
	if (role.companyWallet !== wallet) throw forbidden("only the role's company can close it");
	if (role.status !== "OPEN" || !role.roleVault)
		throw new HttpError(409, "ROLE_NOT_OPEN", "role is not open");
	if (role.pendingCount > 0) {
		throw new HttpError(409, "PENDING_SUBMISSIONS", "accept or reject pending candidates before closing");
	}
	if (role.heldBack > 0n) {
		throw new HttpError(
			409,
			"HOLDBACK_OUTSTANDING",
			"some recruiter payouts are still held back: confirm or report those candidates, or wait for release",
		);
	}
	const ix = await closeRoleIx(wallet, address(role.roleVault));
	return {
		unsignedTx: await buildUnsignedTx([ix], `Close "${role.title}" and withdraw ${usdc(role.remaining)}`),
	};
}

export async function listTasks(): Promise<TaskView[]> {
	const rows = await db
		.select({
			role: schema.roles,
			companyName: schema.accounts.companyName,
			displayName: schema.accounts.displayName,
		})
		.from(schema.roles)
		.innerJoin(schema.accounts, eq(schema.accounts.wallet, schema.roles.companyWallet))
		.where(eq(schema.roles.status, "OPEN"))
		.orderBy(desc(schema.roles.createdAt));
	return rows
		.filter(
			(r) =>
				publishTask({
					status: r.role.status,
					vaultBalance: r.role.remaining,
					bounty: r.role.bounty,
					maxCandidates: r.role.maxCandidates,
					acceptedCount: r.role.acceptedCount,
					pendingCount: r.role.pendingCount,
				}).publish,
		)
		.map((r) => taskView(r.role, r.companyName ?? r.displayName));
}
