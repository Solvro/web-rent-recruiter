import {
	type AgentReview,
	CreateRoleRequest,
	CreateRoleResponse,
	DEFAULT_FEE_BPS,
	DraftRoleRequest,
	DraftRoleResponse,
	fromBaseUnits,
	RoleDetail,
	RoleSummary,
	TaskView,
	TopUpRequest,
	TopUpResponse,
	UnsignedTx,
} from "@scout/shared";
import { type Address, address } from "@solana/kit";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { draftRole, publishTask, suggestBudget } from "../agent/index.ts";
import { db, schema } from "../db/index.ts";
import { badRequest, forbidden, HttpError, notFound, requireWallet } from "../http.ts";
import { newRoleSalt } from "../lib/candidate-hash.ts";
import { roleDetail, roleSummary, submissionView, taskView } from "../lib/views.ts";
import { currentPipelineSummary } from "../services/pipeline.ts";
import { fetchProgramAccount, findConfigPda, requireDeployment } from "../solana/chain.ts";
import { closeRoleIx, createRoleIx, topUpIx } from "../solana/scout.ts";
import { buildUnsignedTx } from "../solana/tx.ts";

const IdParams = z.object({ id: z.string().uuid() });
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

export const roleRoutes: FastifyPluginAsyncZod = async (app) => {
	app.post(
		"/roles/draft",
		{ schema: { body: DraftRoleRequest, response: { 200: DraftRoleResponse } } },
		async (req) => {
			const draft = await draftRole(req.body.jobDescription);
			const budget = await suggestBudget(draft.criteria, { title: draft.title });
			return {
				...draft,
				suggestedBounty: budget.bounty.toString(),
				suggestedMaxCandidates: budget.maxCandidates,
				rationale: budget.rationale,
			};
		},
	);

	app.post(
		"/roles",
		{ schema: { body: CreateRoleRequest, response: { 200: CreateRoleResponse } } },
		async (req) => {
			const wallet = requireWallet(req);
			await requireCompany(wallet);
			requireDeployment();
			const b = req.body;
			const bounty = BigInt(b.bounty);
			const deposit = BigInt(b.deposit);
			if (bounty <= 0n) throw badRequest("bounty must be positive");
			if (deposit < bounty) throw badRequest("initial deposit must cover at least one candidate");

			const [role] = await db
				.insert(schema.roles)
				.values({
					companyWallet: wallet,
					title: b.title,
					summary: b.summary,
					jobDescription: b.jobDescription,
					criteria: b.criteria,
					roleSalt: newRoleSalt(),
					taskType: b.taskType,
					bounty,
					maxCandidates: b.maxCandidates,
					reviewWindowSeconds: b.reviewWindowSeconds,
					feeBps: await currentFeeBps(),
					autoAccept: b.autoAccept ?? null,
					status: "DRAFT",
				})
				.returning();

			const { ix, roleVault } = await createRoleIx({
				company: wallet,
				roleId: BigInt(role.onchainRoleId),
				bountyPerCandidate: bounty,
				maxCandidates: b.maxCandidates,
				reviewWindowSeconds: b.reviewWindowSeconds,
				initialDeposit: deposit,
				agent: null, // TODO(autoAccept): delegate to the agent key when autoAccept is enabled
			});
			await db.update(schema.roles).set({ roleVault }).where(eq(schema.roles.id, role.id));
			const unsignedTx = await buildUnsignedTx(
				[ix],
				`Fund "${b.title}" with ${usdc(deposit)} and publish it to scouts`,
			);
			return { roleId: role.id, unsignedTx };
		},
	);

	app.get("/roles", { schema: { response: { 200: z.array(RoleSummary) } } }, async (req) => {
		const wallet = requireWallet(req);
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
	});

	app.get("/roles/:id", { schema: { params: IdParams, response: { 200: RoleDetail } } }, async (req) => {
		const { role, companyName } = await loadRole(req.params.id);
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
				rows.map((r) => submissionView(r.sub, r.scout, reviews.get(r.sub.id) ?? null, role.title)),
			),
			pipelineSummary,
		};
	});

	app.post(
		"/roles/:id/top-up",
		{ schema: { params: IdParams, body: TopUpRequest, response: { 200: TopUpResponse } } },
		async (req) => {
			const wallet = requireWallet(req);
			const { role } = await loadRole(req.params.id);
			if (role.companyWallet !== wallet) throw forbidden("only the role's company can top up");
			if (role.status !== "OPEN" || !role.roleVault)
				throw new HttpError(409, "ROLE_NOT_OPEN", "role is not open");
			const amount = BigInt(req.body.amount);
			if (amount <= 0n) throw badRequest("amount must be positive");
			const ix = await topUpIx(wallet, address(role.roleVault), amount);
			return { unsignedTx: await buildUnsignedTx([ix], `Add ${usdc(amount)} to the "${role.title}" budget`) };
		},
	);

	app.post(
		"/roles/:id/close",
		{ schema: { params: IdParams, response: { 200: z.object({ unsignedTx: UnsignedTx }) } } },
		async (req) => {
			const wallet = requireWallet(req);
			const { role } = await loadRole(req.params.id);
			if (role.companyWallet !== wallet) throw forbidden("only the role's company can close it");
			if (role.status !== "OPEN" || !role.roleVault)
				throw new HttpError(409, "ROLE_NOT_OPEN", "role is not open");
			if (role.pendingCount > 0) {
				throw new HttpError(409, "PENDING_SUBMISSIONS", "accept or reject pending candidates before closing");
			}
			const ix = await closeRoleIx(wallet, address(role.roleVault));
			return {
				unsignedTx: await buildUnsignedTx([ix], `Close "${role.title}" and withdraw ${usdc(role.remaining)}`),
			};
		},
	);

	app.get("/tasks", { schema: { response: { 200: z.array(TaskView) } } }, async () => {
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
	});
};
