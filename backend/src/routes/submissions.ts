import {
	AgentReview,
	CreateSubmissionRequest,
	CreateSubmissionResponse,
	DecisionRequest,
	DecisionResponse,
	DuplicateCandidateError,
	explorerTxUrl,
	fromBaseUnits,
	REJECT_REASONS,
	SettleResponse,
	SubmissionView,
} from "@scout/shared";
import { type Address, address } from "@solana/kit";
import { and, desc, eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { forbidden, HttpError, notFound, requireWallet } from "../http.ts";
import { processSignature } from "../indexer/sync.ts";
import { candidateHash, toHex } from "../lib/candidate-hash.ts";
import { feeOf, submissionView } from "../lib/views.ts";
import { ensureReview } from "../services/reviews.ts";
import { fetchProgramAccount, findSubmissionPda } from "../solana/chain.ts";
import {
	acceptIx,
	isScoutRegistered,
	registerScoutIx,
	rejectIx,
	settleExpiredIx,
	submitCandidateIx,
} from "../solana/scout.ts";
import { buildUnsignedTx, sendAsRelayer } from "../solana/tx.ts";
import { loadRole } from "./roles.ts";

const IdParams = z.object({ id: z.string().uuid() });
const usdc = (base: bigint) =>
	`${fromBaseUnits(base).toLocaleString("en-US", { maximumFractionDigits: 2 })} USDC`;

async function loadSubmission(id: string) {
	const [row] = await db
		.select({ sub: schema.submissions, role: schema.roles })
		.from(schema.submissions)
		.innerJoin(schema.roles, eq(schema.roles.id, schema.submissions.roleId))
		.where(eq(schema.submissions.id, id));
	if (!row) throw notFound("submission");
	return row;
}

function pendingOnchain(sub: typeof schema.submissions.$inferSelect, role: typeof schema.roles.$inferSelect) {
	if (!sub.confirmed || !sub.onchainAddress || !role.roleVault) {
		throw new HttpError(409, "NOT_ON_CHAIN", "submission is not confirmed on-chain yet");
	}
	if (sub.status !== "PENDING")
		throw new HttpError(409, "ALREADY_DECIDED", `submission is already ${sub.status}`);
	return {
		company: address(role.companyWallet),
		scout: address(sub.scoutWallet),
		roleVault: address(role.roleVault),
		submission: address(sub.onchainAddress),
	};
}

export const submissionRoutes: FastifyPluginAsyncZod = async (app) => {
	app.post(
		"/roles/:id/submissions",
		{
			schema: {
				params: IdParams,
				body: CreateSubmissionRequest,
				response: { 200: CreateSubmissionResponse, 409: DuplicateCandidateError },
			},
		},
		async (req, reply) => {
			const wallet = requireWallet(req);
			const [acc] = await db.select().from(schema.accounts).where(eq(schema.accounts.wallet, wallet));
			if (acc?.kind !== "scout") throw forbidden("scout account required (PUT /me with kind=scout)");
			const { role } = await loadRole(req.params.id);
			if (role.status !== "OPEN") throw new HttpError(409, "ROLE_NOT_OPEN", "role is not open");
			if (!role.roleVault)
				throw new HttpError(409, "ROLE_NOT_FUNDED", "this role's budget is not on-chain (demo data)");
			if (role.acceptedCount + role.pendingCount >= role.maxCandidates) {
				throw new HttpError(409, "ROLE_FULL", "all candidate slots for this role are taken");
			}

			const hash = candidateHash(role.roleSalt, req.body.profileUrl);
			const hashHex = toHex(hash);
			const roleVault = address(role.roleVault);

			// First scout keeps the credit: the Submission PDA is seeded by the hash, so the chain is the judge.
			const [existing] = await db
				.select()
				.from(schema.submissions)
				.where(and(eq(schema.submissions.roleId, role.id), eq(schema.submissions.candidateHash, hashHex)));
			const onchain = await fetchProgramAccount<{ submittedAt: bigint }>(
				"Submission",
				await findSubmissionPda(roleVault, hash),
			).catch(() => null);
			if (existing?.confirmed || onchain) {
				const firstSubmittedAt = onchain
					? new Date(Number(onchain.submittedAt) * 1000)
					: (existing?.submittedAt ?? new Date());
				return reply.status(409).send({
					error: "DUPLICATE_CANDIDATE",
					firstSubmittedAt: firstSubmittedAt.toISOString(),
					message: "This candidate was already submitted for this role. The first scout keeps the credit.",
				});
			}
			// An earlier unsigned attempt (never landed on-chain) is simply replaced.
			if (existing) await db.delete(schema.submissions).where(eq(schema.submissions.id, existing.id));

			const ixs = [];
			if (!(await isScoutRegistered(wallet))) ixs.push(await registerScoutIx(wallet));
			const { ix, submission } = await submitCandidateIx(wallet, roleVault, hash);
			ixs.push(ix);

			const [row] = await db
				.insert(schema.submissions)
				.values({
					roleId: role.id,
					scoutWallet: wallet,
					candidateName: req.body.name,
					profileUrl: req.body.profileUrl,
					notes: req.body.notes,
					consent: req.body.consent,
					candidateHash: hashHex,
					onchainAddress: submission,
					reviewDeadline: new Date(Date.now() + role.reviewWindowSeconds * 1000),
				})
				.returning();
			const payout = role.bounty - feeOf(role.bounty, role.feeBps);
			return {
				submissionId: row.id,
				candidateHash: hashHex,
				unsignedTx: await buildUnsignedTx(
					ixs,
					`Submit ${req.body.name} for "${role.title}" (pays ${usdc(payout)} if accepted)`,
				),
			};
		},
	);

	app.get("/submissions/mine", { schema: { response: { 200: z.array(SubmissionView) } } }, async (req) => {
		const wallet = requireWallet(req);
		const rows = await db
			.select({ sub: schema.submissions, scout: schema.accounts, roleTitle: schema.roles.title })
			.from(schema.submissions)
			.innerJoin(schema.accounts, eq(schema.accounts.wallet, schema.submissions.scoutWallet))
			.innerJoin(schema.roles, eq(schema.roles.id, schema.submissions.roleId))
			.where(and(eq(schema.submissions.scoutWallet, wallet), eq(schema.submissions.confirmed, true)))
			.orderBy(desc(schema.submissions.submittedAt));
		return rows.map((r) => submissionView(r.sub, r.scout, null, r.roleTitle));
	});

	app.post(
		"/submissions/:id/review",
		{ schema: { params: IdParams, response: { 200: AgentReview } } },
		async (req) => {
			const { sub } = await loadSubmission(req.params.id);
			if (!sub.confirmed)
				throw new HttpError(409, "NOT_ON_CHAIN", "submission is not confirmed on-chain yet");
			return ensureReview(sub.id);
		},
	);

	app.post(
		"/submissions/:id/decision",
		{ schema: { params: IdParams, body: DecisionRequest, response: { 200: DecisionResponse } } },
		async (req) => {
			const wallet = requireWallet(req);
			const { sub, role } = await loadSubmission(req.params.id);
			if (role.companyWallet !== wallet) throw forbidden("only the role's company can decide");
			const accounts = pendingOnchain(sub, role);
			if (Date.now() > sub.reviewDeadline.getTime()) {
				throw new HttpError(
					409,
					"REVIEW_WINDOW_EXPIRED",
					"The review window has passed: the candidate is auto-accepted. Settle it via POST /submissions/:id/settle.",
				);
			}
			if (req.body.decision === "accept") {
				const ix = await acceptIx({ ...accounts, authority: wallet as Address });
				const payout = role.bounty - feeOf(role.bounty, role.feeBps);
				return {
					unsignedTx: await buildUnsignedTx(
						[ix],
						`Accept ${sub.candidateName} and pay the scout ${usdc(payout)}`,
					),
				};
			}
			const ix = await rejectIx({ ...accounts, reasonCode: REJECT_REASONS[req.body.reasonCode] });
			return { unsignedTx: await buildUnsignedTx([ix], `Reject ${sub.candidateName}`) };
		},
	);

	app.post(
		"/submissions/:id/settle",
		{ schema: { params: IdParams, response: { 200: SettleResponse } } },
		async (req) => {
			const { sub, role } = await loadSubmission(req.params.id);
			const accounts = pendingOnchain(sub, role);
			if (Date.now() <= sub.reviewDeadline.getTime()) {
				throw new HttpError(
					409,
					"REVIEW_WINDOW_OPEN",
					`auto-accept is possible after ${sub.reviewDeadline.toISOString()}`,
				);
			}
			const signature = await sendAsRelayer([await settleExpiredIx(accounts)]);
			await processSignature(signature);
			return { signature, explorerUrl: explorerTxUrl(signature) };
		},
	);
};
