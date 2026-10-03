import {
	BPS_DENOMINATOR,
	CreateRoleRequest,
	CreateSubmissionRequest,
	DecisionRequest,
	DraftRoleRequest,
	explorerTxUrl,
	OutcomeRequest,
	type RoleSummary,
	type SubmissionPayout,
	type SubmissionView,
	TopUpRequest,
	toBaseUnits,
	UpsertMeRequest,
} from "@scout/shared";
export type TransportResponse = { status: number; data: unknown };
export type Transport = (req: {
	method: "GET" | "POST" | "PUT";
	path: string;
	body?: unknown;
	wallet: string | null;
}) => Promise<TransportResponse>;

import { slugify } from "../format";
import { draftRole } from "./agent";
import demo from "./demo-data.json";
import {
	closePreviewOf,
	closeRoleWork,
	ensureGigs,
	gigProcedures,
	logDeposit,
	MockError,
	recentWorkOf,
	recruiterProfile,
	recruiterStanding,
	setSelfSkills,
	startAgent,
} from "./gigs";
import { avatarFor, candidateInfo } from "./people";
import {
	acceptedCount,
	candidateHash,
	db,
	ensureSeeded,
	fakeAddress,
	fakeBase58,
	fakeSignature,
	HOLDBACK_BPS,
	HOLDBACK_WINDOW_SECONDS,
	inFuture,
	type MockRole,
	type MockSubmission,
	mockEvents,
	newId,
	payout,
	pendingCount,
	persist,
	refundLater,
	registerTx,
	releaseLater,
	reviewFor,
	runTx,
	splitFor,
} from "./store";

const ok = (data: unknown, status = 200): TransportResponse => ({ status, data });
const fail = (status: number, error: string, message: string, extra: object = {}): TransportResponse => ({
	status,
	data: { error, message, ...extra },
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const s = (n: bigint) => n.toString();

/** The role's first deposit: on signing, the role opens and the agent takes over. Used by create and roles.fund. */
function fundTx(role: MockRole, company: NonNullable<ReturnType<typeof db.profiles.get>>) {
	const deposit = role.intendedDeposit ?? 0n;
	return registerTx(`Publish ${role.title} with a ${Number(deposit) / 1e6} budget`, (signature) => {
		company.balance -= deposit;
		role.deposited = deposit;
		role.balance = deposit;
		role.status = "OPEN";
		mockEvents.emit({ type: "RoleCreated", roleId: role.id });
		// Funded: the agent takes over (mock/gigs.ts).
		void ensureGigs().then(() => {
			logDeposit(role.id, deposit, signature);
			startAgent(role.id);
		});
	});
}

/** roles.fund / discardDraft / closePreview, in the shared shapes. */
Object.assign(gigProcedures, {
	"roles.fund": ({ wallet, input }: { wallet: string | null; input: Record<string, unknown> }) => {
		const role = db.roles.get(String(input.id));
		const company = wallet ? db.profiles.get(wallet) : null;
		if (!role || !company || role.companyWallet !== wallet)
			throw new MockError(404, "NOT_FOUND", "Role not found");
		if (role.status !== "DRAFT") return { unsignedTx: null, alreadyFunded: true };
		if ((role.intendedDeposit ?? 0n) > company.balance)
			throw new MockError(400, "INSUFFICIENT_FUNDS", "Not enough balance for this amount");
		return { unsignedTx: fundTx(role, company), alreadyFunded: false };
	},
	"roles.discardDraft": ({ wallet, input }: { wallet: string | null; input: Record<string, unknown> }) => {
		const role = db.roles.get(String(input.id));
		if (!role || role.companyWallet !== wallet || role.status !== "DRAFT")
			throw new MockError(409, "NOT_DRAFT", "Only a role that never started can be discarded.");
		db.roles.delete(role.id);
		persist();
		return { ok: true };
	},
	"roles.closePreview": ({ input }: { input: Record<string, unknown> }) => closePreviewOf(String(input.id)),
});

function roleSummary(r: MockRole): RoleSummary {
	const pending = pendingCount(r.id);
	const reserved = r.bounty * BigInt(pending) + r.heldBack;
	return {
		id: r.id,
		onchainRoleId: r.onchainRoleId,
		roleVault: r.roleVault,
		title: r.title,
		summary: r.summary,
		companyName: r.companyName,
		status: r.status,
		taskType: r.taskType,
		bounty: s(r.bounty),
		feeBps: r.feeBps,
		maxCandidates: r.maxCandidates,
		acceptedCount: acceptedCount(r.id),
		pendingCount: pending,
		reviewWindowSeconds: r.reviewWindowSeconds,
		holdbackBps: r.holdbackBps,
		holdbackWindowSeconds: r.holdbackWindowSeconds,
		budget: {
			deposited: s(r.deposited),
			paid: s(r.paid),
			spent: s(r.paid + r.heldBack),
			refunded: r.refunded !== undefined ? s(r.refunded) : undefined,
			remaining: s(r.balance),
			available: s(r.balance > reserved ? r.balance - reserved : 0n),
			heldBack: s(r.heldBack),
		},
		intendedDeposit: r.intendedDeposit !== undefined ? s(r.intendedDeposit) : undefined,
		createdAt: r.createdAt,
	};
}

function payoutView(sub: MockSubmission): SubmissionPayout | null {
	if (sub.status === "REJECTED") return null;
	const split = sub.split ?? splitFor(sub);
	if (!split) return null;
	return {
		now: s(split.now),
		later: s(split.later),
		operatorFee: s(split.operatorFee),
		platformFee: s(split.platformFee),
		laterReleasesAt: sub.laterReleasesAt,
		outcome: sub.outcome,
		laterStatus: sub.status === "PENDING" ? (split.later > 0n ? "HELD" : "NONE") : sub.laterStatus,
	};
}

function submissionView(sub: MockSubmission, withReview = true): SubmissionView {
	const scout = db.profiles.get(sub.scoutWallet);
	return {
		id: sub.id,
		roleId: sub.roleId,
		roleTitle: db.roles.get(sub.roleId)?.title ?? "Closed role",
		candidateName: sub.candidateName,
		candidate: candidateInfo(sub.candidateName),
		profileUrl: sub.profileUrl,
		notes: sub.notes,
		candidateHash: sub.candidateHash,
		onchainAddress: sub.onchainAddress,
		scout: {
			wallet: sub.scoutWallet,
			displayName: scout?.displayName ?? "Scout",
			avatarUrl: scout?.avatarUrl ?? avatarFor(scout?.displayName ?? ""),
		},
		status: sub.status,
		rejectReason: sub.rejectReason,
		submittedAt: sub.submittedAt,
		reviewDeadline: sub.reviewDeadline,
		settlementTx: sub.settlementTx,
		review: withReview ? sub.review : null,
		payout: payoutView(sub),
	};
}

function pipelineSummary(r: MockRole) {
	const subs = [...db.submissions.values()].filter((x) => x.roleId === r.id);
	if (subs.length === 0)
		return "No candidates yet. Scouts usually submit within the first day; if nothing arrives in 48 hours, consider raising the price or loosening a must-have.";
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

/** Recruiters' one-line bios (me.upsert bio), kept per tab like the rest of the mock; demo people have one. */
const BIO_KEY = "scout.mock-bios.v1";
const SEEDED_BIOS: Record<string, string> = {
	"Ola Wiśniewska":
		"Tech recruiter in Kraków. Eight years hiring backend and protocol engineers for startups.",
	"Lucía Fernández": "Sourcer in Madrid, new to Scout. I find engineers in Spain and Latin America.",
	"Andreea Popescu": "Bucharest-based recruiter for engineering teams across Europe.",
};
function bios(): Record<string, string> {
	try {
		return JSON.parse(sessionStorage.getItem(BIO_KEY) ?? "{}") as Record<string, string>;
	} catch {
		return {};
	}
}
function setBio(wallet: string, bio: string) {
	try {
		sessionStorage.setItem(BIO_KEY, JSON.stringify({ ...bios(), [wallet]: bio.trim() }));
	} catch {
		// private mode
	}
}
function bioOf(wallet: string, name: string) {
	const own = bios()[wallet];
	return own !== undefined ? own || null : (SEEDED_BIOS[name] ?? null);
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
		operator: p.operator,
		slug: slugify(p.displayName),
		usdcBalance: s(p.balance),
		earned: s(p.earned),
		bio: bioOf(p.wallet, p.displayName),
		...(recruiterStanding(p.wallet)
			? { skills: recruiterStanding(p.wallet)?.skills, reputation: recruiterStanding(p.wallet)?.score }
			: {}),
	};
}

/** A stable stand-in for the recruiter's on-chain reputation account (same address on every read). */
const profileAddresses = new Map<string, string>();
function profileAddressOf(wallet: string) {
	if (!profileAddresses.has(wallet)) profileAddresses.set(wallet, fakeAddress());
	return profileAddresses.get(wallet) ?? null;
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
			if (req.bio !== undefined) setBio(wallet, req.bio);
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
				operator: existing?.operator ?? null,
				advanced: existing?.advanced ?? 0,
				flagged: existing?.flagged ?? 0,
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
			const scripted = demo.roles.find((r) => r.jobDescription.trim() === jobDescription.trim());
			if (scripted)
				return ok({
					title: scripted.title,
					summary: `${scripted.locationLabel}. ${scripted.salaryLabel}.`,
					criteria: scripted.criteria,
					suggestedBounty: toBaseUnits(scripted.bountyUsd).toString(),
					suggestedMaxCandidates: scripted.maxCandidates,
					rationale: `Senior real-time TypeScript engineers in Warsaw are reachable through a recruiter's network, but rarely apply on their own. For comparison, an agency usually charges 15–25% of a year's salary for one hire. Ten candidates usually lead to one or two hires.`,
				});
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
				return fail(400, "INSUFFICIENT_FUNDS", "Not enough balance for this amount");
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
				bounty: BigInt(req.bounty ?? toBaseUnits(5)),
				feeBps: 1000,
				maxCandidates: req.maxCandidates ?? 20,
				reviewWindowSeconds: req.reviewWindowSeconds,
				taskType: req.taskType,
				holdbackBps: req.holdbackBps ?? HOLDBACK_BPS,
				holdbackWindowSeconds: req.holdbackWindowSeconds ?? HOLDBACK_WINDOW_SECONDS,
				heldBack: 0n,
				deposited: 0n,
				paid: 0n,
				balance: 0n,
				salt: fakeBase58(16),
				createdAt: new Date().toISOString(),
				intendedDeposit: deposit,
			};
			db.roles.set(id, role);
			return ok({ roleId: id, unsignedTx: fundTx(role, company) });
		},
	],
	[
		"GET",
		"/roles",
		({ wallet }) =>
			ok(
				[...db.roles.values()]
					.filter((r) => r.companyWallet === wallet)
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
			if (amount > company.balance)
				return fail(400, "INSUFFICIENT_FUNDS", "Not enough balance for this amount");
			return ok({
				unsignedTx: registerTx(`Add ${Number(amount) / 1e6} to ${r.title}`, (signature) => {
					company.balance -= amount;
					r.deposited += amount;
					r.balance += amount;
					logDeposit(r.id, amount, signature, true);
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
				unsignedTx: registerTx(
					`Close ${r.title} and return ${Number(r.balance - r.heldBack) / 1e6}`,
					(signature) => {
						// Held parts stay until the interview outcome; everything else comes back.
						const refund = r.balance - r.heldBack;
						company.balance += refund;
						r.balance -= refund;
						r.refunded = refund;
						r.status = "CLOSED";
						closeRoleWork(r.id, refund, signature);
						mockEvents.emit({ type: "RoleClosed", roleId: r.id });
					},
				),
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
			if (r.taskType === "SCREENING_CALL" && !req.screeningNotes)
				return fail(400, "SCREENING_CALL", "Add your call notes.");
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
					screeningNotes: req.screeningNotes,
					outcome: "NONE",
					laterStatus: "NONE",
					laterReleasesAt: null,
					split: null,
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
		"POST",
		"/roles/:id/submissions/check",
		async ({ params, body }) => {
			const r = db.roles.get(params.id);
			const url = (body as { profileUrl?: string })?.profileUrl;
			if (!r || !url) return ok({ duplicate: false });
			const hash = await candidateHash(r.salt, url);
			const first = [...db.submissions.values()].find((x) => x.roleId === r.id && x.candidateHash === hash);
			return ok(first ? { duplicate: true, firstSubmittedAt: first.submittedAt } : { duplicate: false });
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
				sub.review = reviewFor(role.criteria, {
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
				return fail(409, "REVIEW_WINDOW_EXPIRED", "Time to respond has passed.");
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
		"/submissions/:id/outcome",
		({ params, body }) => {
			const sub = db.submissions.get(params.id);
			if (!sub) return fail(404, "NOT_FOUND", "Submission not found");
			if (sub.status !== "ACCEPTED") return fail(409, "NOT_ACCEPTED", "Accept the candidate first.");
			if (sub.laterStatus === "NONE") return fail(409, "NOTHING_HELD_BACK", "Nothing is held back.");
			if (sub.laterStatus !== "HELD" || sub.outcome !== "NONE")
				return fail(409, "OUTCOME_ALREADY_SET", "This was already confirmed.");
			const { outcome } = OutcomeRequest.parse(body);
			if (
				outcome === "fabricated" &&
				sub.laterReleasesAt &&
				new Date(sub.laterReleasesAt).getTime() <= Date.now()
			)
				return fail(409, "HOLDBACK_WINDOW_EXPIRED", "Too late to report a problem.");
			return ok({
				unsignedTx: registerTx(`Confirm outcome for ${sub.candidateName}`, (sig) =>
					outcome === "advanced" ? releaseLater(sub, sig, true) : refundLater(sub, sig),
				),
			});
		},
	],
	[
		"POST",
		"/submissions/:id/release",
		async ({ params }) => {
			const sub = db.submissions.get(params.id);
			if (!sub) return fail(404, "NOT_FOUND", "Submission not found");
			if (sub.laterStatus !== "HELD") return fail(409, "NOTHING_HELD_BACK", "Nothing is held back.");
			if (!sub.laterReleasesAt || new Date(sub.laterReleasesAt).getTime() > Date.now())
				return fail(409, "HOLDBACK_WINDOW_OPEN", "Not yet.");
			await sleep(700);
			const signature = fakeSignature();
			releaseLater(sub, signature, false);
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
		"PUT",
		"/me/skills",
		({ wallet, body }) => {
			if (!wallet) return fail(401, "UNAUTHORIZED", "Log in first");
			const { skills } = body as { skills: string[] };
			setSelfSkills(wallet, Array.isArray(skills) ? skills : []);
			const m = me(wallet);
			return m ? ok(m) : fail(404, "NOT_FOUND", "No profile yet");
		},
	],
	[
		"GET",
		"/scouts/:pubkey",
		({ params }) => {
			// Accepts a wallet or a /r/<name-slug> slug.
			const p =
				db.profiles.get(params.pubkey) ??
				[...db.profiles.values()].find((x) => x.kind === "scout" && slugify(x.displayName) === params.pubkey);
			if (p?.kind !== "scout") return fail(404, "NOT_FOUND", "Scout not found");
			const subs = [...db.submissions.values()]
				.filter((x) => x.scoutWallet === p.wallet)
				.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
			return ok({
				wallet: p.wallet,
				displayName: p.displayName,
				slug: slugify(p.displayName),
				avatarUrl: p.avatarUrl ?? avatarFor(p.displayName),
				reputation: {
					submitted: subs.length,
					accepted: recruiterProfile(p.wallet).stats.ALL?.accepted ?? 0,
					rejected:
						(recruiterProfile(p.wallet).stats.ALL?.decided ?? 0) -
						(recruiterProfile(p.wallet).stats.ALL?.accepted ?? 0),
					totalEarned: s(p.earned),
					advanced: p.advanced,
					flagged: p.flagged,
				},
				profileAddress: profileAddressOf(p.wallet),
				operator: p.operator,
				skills: recruiterStanding(p.wallet)?.skills,
				score: recruiterStanding(p.wallet)?.score,
				bio: bioOf(p.wallet, p.displayName),
				recent: [
					...recentWorkOf(p.wallet),
					...subs.slice(0, 8).map((x) => ({
						id: x.id,
						status: x.status,
						submittedAt: x.submittedAt,
						roleTitle: db.roles.get(x.roleId)?.title ?? "Role",
					})),
				]
					.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))
					.slice(0, 8),
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
			if (!signature) return fail(400, "UNKNOWN_TX", "This request expired. Please try again.");
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
	// Profiles and Me read the gig store (reputation, skills): load it first.
	await ensureGigs();
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
