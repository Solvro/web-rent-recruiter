import {
	BPS_DENOMINATOR,
	CreateRoleRequest,
	CreateSubmissionRequest,
	DecisionRequest,
	DraftRoleRequest,
	explorerTxUrl,
	type RoleSummary,
	type SubmissionView,
	TopUpRequest,
	UpsertMeRequest,
} from "@scout/shared";
import type { Transport, TransportResponse } from "../api";
import { draftRole, reviewCandidate } from "./agent";
import {
	acceptedCount,
	candidateHash,
	db,
	ensureSeeded,
	fakeAddress,
	fakeBase58,
	fakeSignature,
	inFuture,
	type MockRole,
	type MockSubmission,
	mockEvents,
	newId,
	payout,
	pendingCount,
	persist,
	registerTx,
	runTx,
} from "./store";

const ok = (data: unknown, status = 200): TransportResponse => ({ status, data });
const fail = (status: number, error: string, message: string, extra: object = {}): TransportResponse => ({
	status,
	data: { error, message, ...extra },
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const s = (n: bigint) => n.toString();

function roleSummary(r: MockRole): RoleSummary {
	const pending = pendingCount(r.id);
	const reserved = r.bounty * BigInt(pending);
	return {
		id: r.id,
		onchainRoleId: r.onchainRoleId,
		roleVault: r.roleVault,
		title: r.title,
		summary: r.summary,
		companyName: r.companyName,
		status: r.status,
		taskType: "SOURCING",
		bounty: s(r.bounty),
		feeBps: r.feeBps,
		maxCandidates: r.maxCandidates,
		acceptedCount: acceptedCount(r.id),
		pendingCount: pending,
		reviewWindowSeconds: r.reviewWindowSeconds,
		budget: {
			deposited: s(r.deposited),
			paid: s(r.paid),
			remaining: s(r.balance),
			available: s(r.balance > reserved ? r.balance - reserved : 0n),
		},
		createdAt: r.createdAt,
	};
}

function submissionView(sub: MockSubmission, withReview = true): SubmissionView {
	const scout = db.profiles.get(sub.scoutWallet);
	return {
		id: sub.id,
		roleId: sub.roleId,
		roleTitle: db.roles.get(sub.roleId)?.title ?? "Closed role",
		candidateName: sub.candidateName,
		profileUrl: sub.profileUrl,
		notes: sub.notes,
		candidateHash: sub.candidateHash,
		onchainAddress: sub.onchainAddress,
		scout: {
			wallet: sub.scoutWallet,
			displayName: scout?.displayName ?? "Scout",
			avatarUrl: scout?.avatarUrl ?? null,
		},
		status: sub.status,
		rejectReason: sub.rejectReason,
		submittedAt: sub.submittedAt,
		reviewDeadline: sub.reviewDeadline,
		settlementTx: sub.settlementTx,
		review: withReview ? sub.review : null,
	};
}

function pipelineSummary(r: MockRole) {
	const subs = [...db.submissions.values()].filter((x) => x.roleId === r.id);
	if (subs.length === 0)
		return "No candidates yet. Scouts usually submit within the first day; if nothing arrives in 48 hours, consider raising the bounty or loosening a must-have.";
	const accepted = subs.filter((x) => x.status === "ACCEPTED").length;
	const pending = subs.filter((x) => x.status === "PENDING").length;
	const slots = Number(r.balance / r.bounty) - pending;
	const avg = Math.round(
		subs.reduce((a, x) => a + (x.review?.score ?? 0), 0) / Math.max(1, subs.filter((x) => x.review).length),
	);
	const advice =
		slots <= 2
			? `Budget covers only ${Math.max(0, slots)} more candidate${slots === 1 ? "" : "s"}; top up to keep scouts working on this role.`
			: avg < 55
				? "Average fit is low. Tighten the must-haves or add an example profile to the brief."
				: "Quality is on track. Keep reviewing within the window so scouts get paid fast.";
	return `${subs.length} submitted, ${accepted} accepted, ${pending} waiting for your review. Average agent score ${avg}. ${advice}`;
}

function me(wallet: string) {
	const p = db.profiles.get(wallet);
	if (!p) return null;
	return {
		wallet: p.wallet,
		kind: p.kind,
		displayName: p.displayName,
		avatarUrl: p.avatarUrl,
		companyName: p.companyName,
		scoutRegistered: p.registered,
		usdcBalance: s(p.balance),
	};
}

type Ctx = { wallet: string | null; body: unknown; params: Record<string, string> };
type Route = [
	method: string,
	pattern: string,
	handler: (ctx: Ctx) => Promise<TransportResponse> | TransportResponse,
];

const routes: Route[] = [
	[
		"GET",
		"/me",
		({ wallet }) => {
			const m = wallet ? me(wallet) : null;
			return m ? ok(m) : fail(404, "NOT_FOUND", "No profile yet");
		},
	],
	[
		"PUT",
		"/me",
		({ wallet, body }) => {
			if (!wallet) return fail(401, "UNAUTHORIZED", "Log in first");
			const req = UpsertMeRequest.parse(body);
			const existing = db.profiles.get(wallet);
			db.profiles.set(wallet, {
				wallet,
				kind: req.kind,
				displayName: req.displayName,
				avatarUrl: req.avatarUrl ?? null,
				companyName: req.companyName ?? null,
				registered: existing?.registered ?? false,
				balance: existing?.balance ?? (req.kind === "company" ? 1000_000_000n : 0n),
				earned: existing?.earned ?? 0n,
			});
			return ok(me(wallet));
		},
	],
	[
		"POST",
		"/roles/draft",
		async ({ body }) => {
			const { jobDescription } = DraftRoleRequest.parse(body);
			await sleep(2600);
			return ok(draftRole(jobDescription));
		},
	],
	[
		"POST",
		"/roles",
		({ wallet, body }) => {
			const company = wallet ? db.profiles.get(wallet) : null;
			if (!wallet || !company) return fail(401, "UNAUTHORIZED", "Log in as a company");
			const req = CreateRoleRequest.parse(body);
			const deposit = BigInt(req.deposit);
			if (deposit > company.balance)
				return fail(400, "INSUFFICIENT_FUNDS", "Not enough USDC in your account");
			const id = newId("role");
			const role: MockRole = {
				id,
				onchainRoleId: String(db.nextRoleId++),
				roleVault: fakeAddress(),
				title: req.title,
				summary: req.summary,
				jobDescription: req.jobDescription,
				criteria: req.criteria,
				companyWallet: wallet,
				companyName: company.companyName ?? company.displayName,
				status: "DRAFT",
				bounty: BigInt(req.bounty),
				feeBps: 1000,
				maxCandidates: req.maxCandidates,
				reviewWindowSeconds: req.reviewWindowSeconds,
				deposited: 0n,
				paid: 0n,
				balance: 0n,
				salt: fakeBase58(16),
				createdAt: new Date().toISOString(),
			};
			db.roles.set(id, role);
			const unsignedTx = registerTx(
				`Deposit ${Number(deposit) / 1e6} USDC into the budget for ${req.title}`,
				() => {
					company.balance -= deposit;
					role.deposited = deposit;
					role.balance = deposit;
					role.status = "OPEN";
					mockEvents.emit({ type: "RoleCreated", roleId: id });
				},
			);
			return ok({ roleId: id, unsignedTx });
		},
	],
	[
		"GET",
		"/roles",
		({ wallet }) =>
			ok(
				[...db.roles.values()]
					.filter((r) => r.companyWallet === wallet && r.status !== "DRAFT")
					.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
					.map(roleSummary),
			),
	],
	[
		"GET",
		"/roles/:id",
		({ params }) => {
			const r = db.roles.get(params.id);
			if (!r) return fail(404, "NOT_FOUND", "Role not found");
			const submissions = [...db.submissions.values()]
				.filter((x) => x.roleId === r.id)
				.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))
				.map((x) => submissionView(x));
			return ok({
				...roleSummary(r),
				jobDescription: r.jobDescription,
				criteria: r.criteria,
				submissions,
				pipelineSummary: pipelineSummary(r),
			});
		},
	],
	[
		"POST",
		"/roles/:id/top-up",
		({ wallet, params, body }) => {
			const r = db.roles.get(params.id);
			const company = wallet ? db.profiles.get(wallet) : null;
			if (!r || !company) return fail(404, "NOT_FOUND", "Role not found");
			const amount = BigInt(TopUpRequest.parse(body).amount);
			if (amount > company.balance) return fail(400, "INSUFFICIENT_FUNDS", "Not enough USDC in your account");
			return ok({
				unsignedTx: registerTx(`Add ${Number(amount) / 1e6} USDC to ${r.title}`, () => {
					company.balance -= amount;
					r.deposited += amount;
					r.balance += amount;
					mockEvents.emit({ type: "RoleToppedUp", roleId: r.id });
				}),
			});
		},
	],
	[
		"POST",
		"/roles/:id/close",
		({ wallet, params }) => {
			const r = db.roles.get(params.id);
			const company = wallet ? db.profiles.get(wallet) : null;
			if (!r || !company) return fail(404, "NOT_FOUND", "Role not found");
			if (pendingCount(r.id) > 0)
				return fail(
					409,
					"PENDING_SUBMISSIONS",
					"Accept or reject the pending candidates before closing this role.",
				);
			return ok({
				unsignedTx: registerTx(`Close ${r.title} and return ${Number(r.balance) / 1e6} USDC`, () => {
					company.balance += r.balance;
					r.balance = 0n;
					r.status = "CLOSED";
					mockEvents.emit({ type: "RoleClosed", roleId: r.id });
				}),
			});
		},
	],
	[
		"GET",
		"/tasks",
		() =>
			ok(
				[...db.roles.values()]
					.filter((r) => r.status === "OPEN")
					.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
					.map((r) => {
						const summary = roleSummary(r);
						const byBudget = Number(r.balance / r.bounty) - summary.pendingCount;
						const bySlots = r.maxCandidates - summary.acceptedCount - summary.pendingCount;
						return {
							...summary,
							criteria: r.criteria,
							slotsLeft: Math.max(0, Math.min(byBudget, bySlots)),
							payoutPerCandidate: s(r.bounty - (r.bounty * BigInt(r.feeBps)) / BigInt(BPS_DENOMINATOR)),
						};
					}),
			),
	],
	[
		"POST",
		"/roles/:id/submissions",
		async ({ wallet, params, body }) => {
			const r = db.roles.get(params.id);
			const scout = wallet ? db.profiles.get(wallet) : null;
			if (!r) return fail(404, "NOT_FOUND", "Task not found");
			if (!wallet || !scout || scout.kind !== "scout") return fail(401, "UNAUTHORIZED", "Log in as a scout");
			const req = CreateSubmissionRequest.parse(body);
			const hash = await candidateHash(r.salt, req.profileUrl);
			const existing = [...db.submissions.values()].find(
				(x) => x.roleId === r.id && x.candidateHash === hash,
			);
			if (existing)
				return fail(
					409,
					"DUPLICATE_CANDIDATE",
					"Another scout already submitted this candidate for this role.",
					{
						firstSubmittedAt: existing.submittedAt,
					},
				);
			const id = newId("sub");
			const unsignedTx = registerTx(`Submit ${req.name} for ${r.title}`, () => {
				const sub: MockSubmission = {
					id,
					roleId: r.id,
					candidateName: req.name,
					profileUrl: req.profileUrl,
					notes: req.notes,
					candidateHash: hash,
					onchainAddress: fakeAddress(),
					scoutWallet: wallet,
					status: "PENDING",
					rejectReason: null,
					submittedAt: new Date().toISOString(),
					reviewDeadline: inFuture(r.reviewWindowSeconds),
					settlementTx: null,
					review: null,
				};
				db.submissions.set(id, sub);
				// the real backend bundles register_scout into the first submission
				scout.registered = true;
				mockEvents.emit({ type: "CandidateSubmitted", roleId: r.id, submissionId: id });
			});
			return ok({ submissionId: id, candidateHash: hash, unsignedTx });
		},
	],
	[
		"GET",
		"/submissions/mine",
		({ wallet }) =>
			ok(
				[...db.submissions.values()]
					.filter((x) => x.scoutWallet === wallet)
					.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))
					.map((x) => submissionView(x, false)),
			),
	],
	[
		"POST",
		"/submissions/:id/review",
		async ({ params }) => {
			const sub = db.submissions.get(params.id);
			const role = sub ? db.roles.get(sub.roleId) : null;
			if (!sub || !role) return fail(404, "NOT_FOUND", "Submission not found");
			if (!sub.review) {
				await sleep(2400);
				sub.review = reviewCandidate(role.criteria, {
					name: sub.candidateName,
					profileUrl: sub.profileUrl,
					notes: sub.notes,
				});
			}
			return ok(sub.review);
		},
	],
	[
		"POST",
		"/submissions/:id/decision",
		({ params, body }) => {
			const sub = db.submissions.get(params.id);
			if (!sub) return fail(404, "NOT_FOUND", "Submission not found");
			if (sub.status !== "PENDING") return fail(409, "NOT_PENDING", "This submission was already settled");
			if (new Date(sub.reviewDeadline).getTime() <= Date.now())
				return fail(409, "REVIEW_WINDOW_EXPIRED", "The review window ended. Settle to pay the scout.");
			const req = DecisionRequest.parse(body);
			if (req.decision === "accept")
				return ok({
					unsignedTx: registerTx(`Accept ${sub.candidateName} and pay the scout`, (sig) => payout(sub, sig)),
				});
			return ok({
				unsignedTx: registerTx(`Reject ${sub.candidateName}`, (sig) => {
					sub.status = "REJECTED";
					sub.rejectReason = req.reasonCode;
					sub.settlementTx = sig;
					mockEvents.emit({
						type: "SubmissionRejected",
						roleId: sub.roleId,
						submissionId: sub.id,
						signature: sig,
					});
				}),
			});
		},
	],
	[
		"POST",
		"/submissions/:id/settle",
		async ({ params }) => {
			const sub = db.submissions.get(params.id);
			if (!sub) return fail(404, "NOT_FOUND", "Submission not found");
			if (sub.status !== "PENDING") return fail(409, "NOT_PENDING", "Already settled");
			if (new Date(sub.reviewDeadline).getTime() > Date.now())
				return fail(409, "REVIEW_WINDOW_OPEN", "The review window is still open");
			await sleep(900);
			const signature = fakeSignature();
			payout(sub, signature);
			return ok({ signature, explorerUrl: explorerTxUrl(signature) });
		},
	],
	[
		"POST",
		"/scouts/register",
		({ wallet }) => {
			const p = wallet ? db.profiles.get(wallet) : null;
			if (!p) return fail(401, "UNAUTHORIZED", "Log in first");
			return ok({
				unsignedTx: registerTx("Activate your payout account", () => {
					p.registered = true;
				}),
			});
		},
	],
	[
		"GET",
		"/scouts/:pubkey",
		({ params }) => {
			const p = db.profiles.get(params.pubkey);
			if (p?.kind !== "scout") return fail(404, "NOT_FOUND", "Scout not found");
			const subs = [...db.submissions.values()]
				.filter((x) => x.scoutWallet === p.wallet)
				.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
			return ok({
				wallet: p.wallet,
				displayName: p.displayName,
				avatarUrl: p.avatarUrl,
				reputation: {
					submitted: subs.length,
					accepted: subs.filter((x) => x.status === "ACCEPTED").length,
					rejected: subs.filter((x) => x.status === "REJECTED").length,
					totalEarned: s(p.earned),
				},
				profileAddress: p.registered ? fakeAddress() : null,
				recent: subs.slice(0, 8).map((x) => ({
					id: x.id,
					status: x.status,
					submittedAt: x.submittedAt,
					roleTitle: db.roles.get(x.roleId)?.title ?? "Role",
				})),
			});
		},
	],
	[
		"POST",
		"/tx/submit",
		async ({ body }) => {
			const { signedTx } = body as { signedTx: string };
			await sleep(700);
			const signature = runTx(signedTx);
			if (!signature) return fail(400, "UNKNOWN_TX", "Transaction expired. Please try again.");
			return ok({ signature, explorerUrl: explorerTxUrl(signature) });
		},
	],
];

function match(pattern: string, path: string) {
	const p = pattern.split("/");
	const a = path.split("?")[0].split("/");
	if (p.length !== a.length) return null;
	const params: Record<string, string> = {};
	for (let i = 0; i < p.length; i++) {
		if (p[i].startsWith(":")) params[p[i].slice(1)] = decodeURIComponent(a[i]);
		else if (p[i] !== a[i]) return null;
	}
	return params;
}

export const mockTransport: Transport = async ({ method, path, body, wallet }) => {
	await ensureSeeded();
	await sleep(150);
	for (const [m, pattern, handler] of routes) {
		if (m !== method) continue;
		const params = match(pattern, path);
		if (params) {
			try {
				const res = await handler({ wallet, body, params });
				if (method !== "GET") persist();
				return res;
			} catch (e) {
				return fail(400, "BAD_REQUEST", e instanceof Error ? e.message : "Invalid request");
			}
		}
	}
	return fail(404, "NOT_FOUND", `No mock for ${method} ${path}`);
};
