/**
 * Gig use-cases (docs/agent-gigs.md): recruiters browse, claim and deliver; the company follows its agent's
 * activity and decides on the shortlist. The agent's own actions live in src/agent-runner.
 */
import { createHash } from "node:crypto";
import {
	type AgentActivity,
	DeliverableReview,
	type DeliverableView,
	explorerTxUrl,
	fromBaseUnits,
	type GigDeliverRequest,
	type GigDeliverResponse,
	type GigListRequest,
	type GigView,
	type RoleDecideRequest,
	type RoleDecideResponse,
	type ScriptQuestion,
	type ShortlistItem,
	solscanTxUrl,
	type UnsignedTx,
} from "@scout/shared";
import { type Address, address } from "@solana/kit";
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import type { z } from "zod";
import { canClaimGig, gigRequirements } from "../agent/gigs/index.ts";
import { confirmationOf } from "../agent-runner/confirmations.ts";
import { db, schema } from "../db/index.ts";
import { publish } from "../events.ts";
import { badRequest, forbidden, HttpError, notFound } from "../http.ts";
import { refreshGig } from "../indexer/gigs.ts";
import { demoAvatar } from "../lib/avatars.ts";
import { candidateHash, toHex } from "../lib/candidate-hash.ts";
import { anonymizedSummary, canSeeCandidate, gigCandidate } from "../lib/gig-privacy.ts";
import { splitBounty } from "../lib/money.ts";
import { recruiterProfile } from "../lib/recruiter-profile.ts";
import { submissionPayout } from "../lib/views.ts";
import { recordingEvidence } from "../recall/service.ts";
import { scoutChainInfo } from "../solana/chain.ts";
import { gatekeeperOf, isHosted } from "../solana/gatekeeper.ts";
import { attestOutcomeIx, claimTaskIx, registerScoutIx, submitDeliverableIx } from "../solana/scout.ts";
import { buildUnsignedTx } from "../solana/tx.ts";
import { loadRole } from "./roles.ts";
import { requireContactable } from "./screening.ts";
import {
	findDuplicate,
	onchainAccounts,
	openDeliverablesOfCandidate,
	payoutLabel,
	termsOf,
} from "./submissions.ts";

type GigRow = typeof schema.gigs.$inferSelect;
type RoleRow = typeof schema.roles.$inferSelect;
type SubRow = typeof schema.submissions.$inferSelect;

const usdc = (base: bigint) =>
	`${fromBaseUnits(base).toLocaleString("en-US", { maximumFractionDigits: 2 })} USDC`;
const sha256 = (data: string) => new Uint8Array(createHash("sha256").update(data).digest());
const ZERO_HASH = new Uint8Array(32);

// ---- Activity log ------------------------------------------------------------------

export async function logActivity(
	roleId: string,
	kind: AgentActivity["kind"],
	message: string,
	refs: {
		gigId?: string | null;
		deliverableId?: string | null;
		signature?: string | null;
		data?: Record<string, unknown>;
	} = {},
) {
	// The agent re-derives state every pass: don't repeat the same timeline line back to back.
	if (kind !== "COMPANY_MESSAGE" && kind !== "AGENT_MESSAGE") {
		const recent = await db
			.select()
			.from(schema.agentActivity)
			.where(eq(schema.agentActivity.roleId, roleId))
			.orderBy(desc(schema.agentActivity.createdAt))
			.limit(15);
		const same = recent.find((r) => r.kind === kind && r.message === message);
		if (same) return same;
	}
	const [row] = await db
		.insert(schema.agentActivity)
		.values({
			roleId,
			kind,
			message,
			gigId: refs.gigId ?? null,
			deliverableId: refs.deliverableId ?? null,
			signature: refs.signature ?? null,
			data: refs.data ?? null,
		})
		.returning();
	publish({ type: "agent.activity", roleId, gigId: refs.gigId ?? undefined, message });
	return row;
}

export async function setAgentStatus(roleId: string, status: string) {
	await db.update(schema.roles).set({ agentStatus: status }).where(eq(schema.roles.id, roleId));
}

// ---- Views -----------------------------------------------------------------------------

type GigContext = {
	gig: GigRow;
	role: RoleRow;
	companyName: string;
	claimant: { wallet: string; displayName: string; avatarUrl: string | null; timeZone: string | null } | null;
	about: SubRow | null;
	/** From the candidate's confirmation page (Intl time zone). */
	candidateTimeZone: string | null;
	/** The one-slot task paying the claimant's show-up fee, if any. */
	feeGig: GigRow | null;
};

type Viewer = { wallet: string | null; profile: Awaited<ReturnType<typeof recruiterProfile>> | null };

/** The agent's gigRequirements for a gig, as the board shows them. */
export function requirementsOf(gig: GigRow, role: RoleRow) {
	return gigRequirements({
		taskType: gig.type,
		variant: (gig.variant ?? undefined) as "standard" | "language" | undefined,
		criteria: role.criteria,
	});
}

/** canClaimGig for a recruiter; the sourcer of a candidate can't take calls about them. */
export function eligibilityOf(
	c: GigContext,
	profile: Awaited<ReturnType<typeof recruiterProfile>>,
): { allowed: boolean; reason: string; needsBond: boolean } {
	return canClaimGig(requirementsOf(c.gig, c.role), profile, {
		taskType: c.gig.type,
		sourcerWallet: c.about?.scoutWallet,
	});
}

async function viewerOf(wallet: string | null): Promise<Viewer> {
	return { wallet, profile: wallet ? await recruiterProfile(wallet).catch(() => null) : null };
}

function gigView(c: GigContext, viewerInput: Viewer | string | null): GigView {
	const viewerCtx: Viewer =
		typeof viewerInput === "object" && viewerInput !== null
			? viewerInput
			: { wallet: viewerInput, profile: null };
	const viewer = viewerCtx.wallet;
	const { gig, role } = c;
	const split = splitBounty(gig.bounty, role.feeBps, 0, gig.holdbackBps);
	// Exclusive gigs name a real person: identity + script only for the claimant and the company.
	const visible = !gig.exclusive || canSeeCandidate(viewer, gig, role.companyWallet);
	const script = visible
		? ((gig.script as { questions?: ScriptQuestion[] } | null)?.questions ?? null)
		: null;
	return {
		id: gig.id,
		roleId: role.id,
		roleTitle: role.title,
		companyName: c.companyName,
		type: gig.type,
		variant: gig.type === "SCREENING_CALL" ? (gig.variant ?? "standard") : null,
		status: gig.status === "POSTING" ? "DRAFT" : gig.status,
		city: role.criteria.location.places[0]?.split(",")[0]?.trim() ?? null,
		remote: role.criteria.location.mode === "REMOTE",
		title: visible ? gig.title : redactedTitle(gig, c.about, role.criteria.seniority),
		brief: visible ? gig.brief : redactedBrief(gig),
		script,
		redacted: !visible,
		candidate: c.about
			? gigCandidate(
					{
						id: c.about.id,
						name: c.about.candidateName,
						profileUrl: c.about.profileUrl,
						notes: c.about.notes,
						card: {
							avatarUrl: c.about.candidateAvatarUrl,
							currentTitle: c.about.candidateTitle,
							currentCompany: c.about.candidateCompany,
							location: c.about.candidateLocation,
						},
					},
					visible,
					role.criteria.seniority,
				)
			: null,
		bounty: gig.bounty.toString(),
		payout: { now: split.now.toString(), later: split.later.toString() },
		maxDeliverables: gig.maxDeliverables,
		acceptedCount: gig.acceptedCount,
		pendingCount: gig.pendingCount,
		slotsLeft: Math.max(0, gig.maxDeliverables - gig.acceptedCount - gig.pendingCount),
		exclusive: gig.exclusive,
		claimant: c.claimant,
		claimedByMe: Boolean(viewer && gig.claimantWallet === viewer),
		taskAddress: gig.taskAddress,
		createdAt: gig.createdAt.toISOString(),
		requirements: (() => {
			const r = requirementsOf(gig, role);
			return {
				minAccepted: r.minTrust?.minAccepted ?? 0,
				minRate: r.minTrust?.minAcceptanceRate ?? 0,
				windowDays: r.minTrust?.windowDays ?? 90,
				skills: r.requiredSkills,
				summary: r.summary,
			};
		})(),
		eligibility: viewerCtx.profile ? eligibilityOf(c, viewerCtx.profile) : null,
		priceHistory: gig.priceHistory,
		post: {
			title: role.title,
			companyDescriptor: c.companyName,
			location: role.criteria.location.places.length ? role.criteria.location.places.join(", ") : null,
			workMode: role.criteria.location.mode,
			seniority: role.criteria.seniority,
			salaryRange: role.criteria.salaryRange,
			mustHave: role.criteria.mustHave.map((x) => x.label),
			niceToHave: role.criteria.niceToHave.map((x) => x.label),
			dealBreakers: role.criteria.dealBreakers.map((x) => x.label),
			languages: role.criteria.languages,
			summary: role.summary,
		},
		...(gig.type !== "SOURCING"
			? {
					claimedAt: gig.claimedAt?.toISOString() ?? null,
					noShows: gig.noShows,
					candidateTimeZone: visible ? c.candidateTimeZone : null,
					recruiterTimeZone: c.claimant?.timeZone ?? null,
					reported: gig.reported,
					showUpFee:
						gig.showUpFee && viewer && viewer === gig.claimantWallet
							? {
									amount: gig.showUpFee.toString(),
									status: (c.feeGig?.acceptedCount ?? 0) > 0 ? ("PAID" as const) : ("OFFERED" as const),
									signature: (c.feeGig?.acceptedCount ?? 0) > 0 ? (c.feeGig?.createTx ?? null) : null,
								}
							: null,
				}
			: {}),
	};
}

/** Titles/briefs of exclusive gigs name the candidate: non-claimants get "Screening call · Senior backend engineer · Warsaw". */
function redactedTitle(gig: GigRow, about: SubRow | null, seniority: string | null) {
	const kind =
		gig.type === "SCREENING_CALL"
			? gig.variant === "language"
				? "Language check"
				: "Screening call"
			: gig.type === "REFERENCE_CHECK"
				? "Reference check"
				: "Gig";
	if (!about) return kind;
	const s = anonymizedSummary(
		{
			id: about.id,
			name: about.candidateName,
			profileUrl: about.profileUrl,
			notes: about.notes,
			card: {
				avatarUrl: null,
				currentTitle: about.candidateTitle,
				currentCompany: null,
				location: about.candidateLocation,
			},
		},
		seniority,
	);
	return [kind, s.headline.split(" · ")[0], s.city].filter(Boolean).join(" · ");
}
const redactedBrief = (gig: GigRow) =>
	gig.type === "SCREENING_CALL"
		? "Run a 30-minute call with the candidate following the agent's question script, then deliver an answer to every question and your recommendation. Take the gig to see who the candidate is and the script."
		: "Call one reference the candidate provides and answer the agent's questions. Take the gig to see who the candidate is and the questions.";

async function gigContexts(gigs: GigRow[]): Promise<GigContext[]> {
	if (!gigs.length) return [];
	const roleIds = [...new Set(gigs.map((g) => g.roleId))];
	const roles = await db
		.select({
			role: schema.roles,
			companyName: schema.accounts.companyName,
			displayName: schema.accounts.displayName,
		})
		.from(schema.roles)
		.innerJoin(schema.accounts, eq(schema.accounts.wallet, schema.roles.companyWallet))
		.where(inArray(schema.roles.id, roleIds));
	const byRole = new Map(roles.map((r) => [r.role.id, r]));
	const claimantWallets = gigs.flatMap((g) => (g.claimantWallet ? [g.claimantWallet] : []));
	const claimants = claimantWallets.length
		? await db.select().from(schema.accounts).where(inArray(schema.accounts.wallet, claimantWallets))
		: [];
	const aboutIds = gigs.flatMap((g) => (g.aboutCandidateId ? [g.aboutCandidateId] : []));
	const abouts = aboutIds.length
		? await db.select().from(schema.submissions).where(inArray(schema.submissions.id, aboutIds))
		: [];
	const confirmations = aboutIds.length
		? await db
				.select()
				.from(schema.candidateConfirmations)
				.where(inArray(schema.candidateConfirmations.submissionId, aboutIds))
		: [];
	const feeGigs = await db
		.select()
		.from(schema.gigs)
		.where(
			and(
				eq(schema.gigs.purpose, "show_up_fee"),
				inArray(
					schema.gigs.aboutGigId,
					gigs.map((g) => g.id),
				),
			),
		);
	return gigs.flatMap((gig) => {
		const r = byRole.get(gig.roleId);
		if (!r) return [];
		const cl = claimants.find((a) => a.wallet === gig.claimantWallet);
		return [
			{
				gig,
				role: r.role,
				companyName: r.companyName ?? r.displayName,
				claimant: gig.claimantWallet
					? {
							wallet: gig.claimantWallet,
							displayName: cl?.displayName ?? "Recruiter",
							avatarUrl: cl?.avatarUrl ?? null,
							timeZone: cl?.timeZone ?? null,
						}
					: null,
				about: abouts.find((s) => s.id === gig.aboutCandidateId) ?? null,
				candidateTimeZone:
					(
						(confirmations.find((x) => x.submissionId === gig.aboutCandidateId)?.answers ?? {}) as {
							timeZone?: string;
						}
					).timeZone ?? null,
				feeGig: feeGigs.find((f) => f.aboutGigId === gig.id) ?? null,
			},
		];
	});
}

export async function loadGig(id: string): Promise<GigContext> {
	const [gig] = await db.select().from(schema.gigs).where(eq(schema.gigs.id, id));
	if (!gig) throw notFound("gig");
	const [ctx] = await gigContexts([gig]);
	if (!ctx) throw notFound("gig");
	return ctx;
}

/** The role agent's stored review (C's StoredReview) as the recruiter/company-facing DeliverableReview. */
function toDeliverableReview(sub: SubRow, preAccepted = false): DeliverableReview | null {
	const r = sub.agentReview as {
		decision?: { action: string; reason: string };
		call?: { reasons?: string[]; summaryForCompany?: string };
		sourcing?: DeliverableReview["candidateReview"];
		rejectReason?: string;
		reviewedAt?: string;
	} | null;
	const decided = sub.status !== "PENDING";
	// Whoever decided (our agent, a company's own agent, the company), a decided deliverable always shows why.
	if (!r?.decision && !decided) return null;
	// The agent saves its review just before signing: until the decision lands on-chain (or is handed to the
	// company), the recruiter sees "the agent is checking your work".
	// A follow-up question is shown right away: the recruiter has to answer it.
	if (
		!decided &&
		!(r as { escalatedAt?: string }).escalatedAt &&
		!preAccepted &&
		r?.decision?.action !== "follow_up"
	)
		return null;
	const companyReason = (r as { companyDecision?: { reason?: string } } | null)?.companyDecision?.reason;
	const first =
		sub.status === "REJECTED"
			? (sub.rejectText ?? r?.rejectReason)
			: sub.status === "ACCEPTED"
				? companyReason
				: null;
	const question = (r?.decision as { question?: string } | undefined)?.question;
	const reasons = [
		first ?? r?.decision?.reason,
		...(r?.decision?.action === "follow_up" && question ? [question] : []),
		...(r?.call?.reasons ?? []),
	].filter((x, i, all): x is string => Boolean(x) && all.indexOf(x) === i);
	const fromAction = (
		{ accept: "ACCEPT", reject: "REJECT", escalate: "ESCALATE", follow_up: "FOLLOW_UP" } as Record<
			string,
			DeliverableReview["verdict"]
		>
	)[r?.decision?.action ?? ""];
	return {
		verdict:
			sub.status === "ACCEPTED"
				? "ACCEPT"
				: sub.status === "REJECTED"
					? "REJECT"
					: (fromAction ?? "ESCALATE"),
		reasons,
		// A company's own agent stores its own review JSON: show the candidate review only if it fits our shape.
		candidateReview: DeliverableReview.shape.candidateReview.safeParse(r?.sourcing ?? null).data ?? null,
		reviewedAt: r?.reviewedAt ?? sub.submittedAt.toISOString(),
	};
}

export function deliverableView(
	sub: SubRow,
	gig: GigRow,
	role: RoleRow,
	confirmation: typeof schema.candidateConfirmations.$inferSelect | null = null,
): DeliverableView {
	const deliverable =
		sub.deliverableType && sub.deliverableType !== "SOURCING"
			? (sub.payload as DeliverableView["deliverable"])
			: {
					type: "SOURCING" as const,
					name: sub.candidateName,
					profileUrl: sub.profileUrl,
					notes: sub.notes,
					consent: true as const,
					candidate: {
						avatarUrl: sub.candidateAvatarUrl,
						currentTitle: sub.candidateTitle,
						currentCompany: sub.candidateCompany,
						location: sub.candidateLocation,
					},
				};
	return {
		id: sub.id,
		gigId: gig.id,
		gigType: gig.type,
		gigTitle: gig.title,
		roleId: role.id,
		roleTitle: role.title,
		status: sub.status,
		review: toDeliverableReview(sub, Boolean(confirmation)),
		deliverable,
		payout: submissionPayout(sub, termsOf(role, gig)),
		submittedAt: sub.submittedAt.toISOString(),
		settlementTx: sub.settlementTx,
		confirmation: confirmation
			? {
					status:
						confirmation.status === "PENDING" && confirmation.expiresAt < new Date()
							? "EXPIRED"
							: confirmation.status,
					// A call check's link goes to the candidate's sourcer, never to the recruiter who claims the call.
					url: confirmation.status === "PENDING" && confirmation.kind !== "call" ? confirmation.link : null,
					expiresAt: confirmation.expiresAt.toISOString(),
					respondedAt: confirmation.respondedAt?.toISOString() ?? null,
				}
			: null,
		...(sub.followUps.length ? { followUps: sub.followUps } : {}),
		appeal: sub.appeal ?? null,
	};
}

// ---- Recruiter: browse, claim, deliver -----------------------------------------------

export async function listGigs(
	viewer: string | null,
	input: z.output<typeof GigListRequest>,
): Promise<GigView[]> {
	const filters = [
		input?.includeClosed ? isNotNull(schema.gigs.taskAddress) : eq(schema.gigs.status, "OPEN"),
		isNull(schema.gigs.purpose),
		...(input?.roleId ? [eq(schema.gigs.roleId, input.roleId)] : []),
		...(input?.type ? [eq(schema.gigs.type, input.type)] : []),
	];
	const gigs = await db
		.select()
		.from(schema.gigs)
		.where(and(...filters))
		.orderBy(desc(schema.gigs.createdAt));
	const v = await viewerOf(viewer);
	return (await gigContexts(gigs)).map((c) => gigView(c, v));
}

export async function getGig(viewer: string | null, id: string): Promise<GigView> {
	return gigView(await loadGig(id), await viewerOf(viewer));
}

function requireOpen(c: GigContext) {
	if (c.gig.status !== "OPEN" || !c.gig.taskAddress || !c.role.roleVault) {
		throw new HttpError(409, "NO_OPEN_GIG", "This gig isn't open.");
	}
	return { roleVault: address(c.role.roleVault), task: address(c.gig.taskAddress) };
}

export async function claimGig(wallet: Address, id: string): Promise<{ unsignedTx: UnsignedTx }> {
	let c = await loadGig(id);
	// Who holds it is on-chain (a rejection releases it): refresh a possibly stale row first.
	if (c.gig.taskAddress) {
		await refreshGig(c.gig.taskAddress);
		c = await loadGig(id);
	}
	const { roleVault, task } = requireOpen(c);
	if (!c.gig.exclusive) throw new HttpError(409, "CLAIM_NOT_NEEDED", "Anyone can deliver to this gig.");
	if (c.gig.claimantWallet === wallet)
		throw new HttpError(409, "ALREADY_CLAIMED", "You already have this gig.");
	if (c.gig.claimantWallet) throw new HttpError(409, "GIG_TAKEN", "Another recruiter took this gig.");
	await requireRecruiter(wallet);
	// The agent is the on-chain gatekeeper: it only co-signs claims that meet the gig's requirements.
	const ok = eligibilityOf(c, await recruiterProfile(wallet));
	if (!ok.allowed) {
		throw new HttpError(403, "REQUIREMENTS_NOT_MET", ok.reason, {
			requirements: requirementsOf(c.gig, c.role),
		});
	}
	const ixs = [];
	if (!(await scoutChainInfo(wallet)).profile) ixs.push(await registerScoutIx(wallet));
	ixs.push(await claimTaskIx(wallet, roleVault, task, gatekeeperOf(c.role)));
	return { unsignedTx: await buildUnsignedTx(ixs, `Take the gig "${c.gig.title}"`, await gateOpts(c.role)) };
}

/** Our agent co-signs at tx.submit; any other gatekeeper (own agent, the company) co-signs via the queue. */
async function gateOpts(role: { agentPubkey: string | null; companyWallet: string }) {
	return (await isHosted(role)) ? { gatekeeper: true } : { cosigner: gatekeeperOf(role) };
}

async function requireRecruiter(wallet: Address) {
	const [acc] = await db.select().from(schema.accounts).where(eq(schema.accounts.wallet, wallet));
	if (acc?.kind !== "scout") throw forbidden("recruiter account required (me.upsert with kind=scout)");
	return acc;
}

/** Stable JSON (sorted keys) so the same answers always hash the same. */
function canonical(v: unknown): string {
	if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
	if (v && typeof v === "object") {
		return `{${Object.keys(v)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
			.join(",")}}`;
	}
	return JSON.stringify(v);
}

export async function deliver(
	wallet: Address,
	input: z.output<typeof GigDeliverRequest>,
): Promise<z.output<typeof GigDeliverResponse>> {
	let c = await loadGig(input.gigId);
	// Exclusive gigs: the chain decides who holds it (a rejection releases the claim). Don't trust a stale row.
	if (c.gig.exclusive && c.gig.taskAddress) {
		await refreshGig(c.gig.taskAddress);
		c = await loadGig(input.gigId);
	}
	const { roleVault, task } = requireOpen(c);
	const { gig, role } = c;
	const d = input.deliverable;
	if (d.type !== gig.type) throw badRequest(`this gig takes a ${gig.type} deliverable`);
	if (gig.exclusive && gig.claimantWallet !== wallet) {
		throw new HttpError(
			409,
			"NOT_CLAIMANT",
			"Take the gig before delivering (a rejected delivery releases it).",
		);
	}
	if (gig.acceptedCount + gig.pendingCount >= gig.maxDeliverables) {
		// The counters may be a moment behind a decision that just landed (e.g. a rejection): ask the chain.
		await refreshGig(task);
		const [fresh] = await db.select().from(schema.gigs).where(eq(schema.gigs.id, gig.id));
		if (!fresh || fresh.acceptedCount + fresh.pendingCount >= fresh.maxDeliverables)
			throw new HttpError(409, "GIG_FULL", "This gig has all the deliverables it needs.");
	}
	await requireRecruiter(wallet);

	let deliverableHash: Uint8Array;
	let payloadToStore: Record<string, unknown> | null = null;
	let evidenceHash = ZERO_HASH;
	let candidate: {
		name: string;
		profileUrl: string;
		notes: string;
		card: Partial<Record<string, string | null>>;
	};
	if (d.type === "SOURCING") {
		await requireContactable(d.profileUrl);
		deliverableHash = candidateHash(role.roleSalt, d.profileUrl);
		const { existing, firstSubmittedAt } = await findDuplicate(role, deliverableHash);
		if (firstSubmittedAt) {
			throw new HttpError(
				409,
				"DUPLICATE_CANDIDATE",
				"This candidate was already submitted for this role. The first recruiter keeps the credit.",
				{ firstSubmittedAt: firstSubmittedAt.toISOString() },
			);
		}
		if (existing) await db.delete(schema.submissions).where(eq(schema.submissions.id, existing.id));
		candidate = { name: d.name, profileUrl: d.profileUrl, notes: d.notes, card: d.candidate ?? {} };
	} else {
		const questions = (gig.script as { questions?: ScriptQuestion[] } | null)?.questions ?? [];
		const answered = new Set(d.answers.filter((a) => a.answer.trim()).map((a) => a.questionId));
		const missing = questions.filter((q) => !answered.has(q.id)).map((q) => q.id);
		if (missing.length) {
			throw new HttpError(400, "INCOMPLETE_ANSWERS", "Answer every question of the script.", { missing });
		}
		// Evidence comes only from the server-side Recall record when the call was recorded; the client's
		// transcript text is ignored then. Without a recording the evidence is self-reported (needs the
		// candidate's confirmation later).
		const rec = await recordingEvidence(gig.id);
		if (rec && rec.wallet !== wallet) {
			throw new HttpError(409, "RECORDING_NOT_YOURS", "This call was recorded by another recruiter.");
		}
		const stored = {
			...d,
			...(d.type === "SCREENING_CALL"
				? {
						transcript: rec?.transcript ?? d.transcript,
						evidence: rec ? ("recording" as const) : ("self-reported" as const),
					}
				: {}),
		};
		payloadToStore = stored as unknown as Record<string, unknown>;
		const body = canonical({ ...d, transcript: undefined });
		// A rejected attempt closed its Submission; a new attempt (even with the same notes) gets a new hash.
		const [{ attempts }] = await db
			.select({ attempts: count() })
			.from(schema.submissions)
			.where(
				and(
					eq(schema.submissions.gigId, gig.id),
					eq(schema.submissions.scoutWallet, wallet),
					eq(schema.submissions.confirmed, true),
				),
			);
		deliverableHash = sha256(`${gig.id}:${wallet}:${attempts}:${body}`);
		evidenceHash = rec ? new Uint8Array(Buffer.from(rec.transcriptHash, "hex")) : sha256(body);
		const about = c.about;
		candidate = {
			name: about?.candidateName ?? gig.title,
			profileUrl: about?.profileUrl ?? "",
			notes: d.answers.map((a) => a.answer).join("\n"),
			card: {
				avatarUrl: about?.candidateAvatarUrl ?? null,
				currentTitle: about?.candidateTitle ?? null,
				currentCompany: about?.candidateCompany ?? null,
				location: about?.candidateLocation ?? null,
			},
		};
	}

	const info = await scoutChainInfo(wallet);
	const ixs = [];
	if (!info.profile) ixs.push(await registerScoutIx(wallet));
	const { ix, submission } = await submitDeliverableIx({
		scout: wallet,
		roleVault,
		task,
		deliverableHash,
		evidenceHash,
		gatekeeper: gatekeeperOf(role),
	});
	ixs.push(ix);
	const operatorFeeBps = info.operator ? Number(info.operator.feeBps) : 0;

	// A previous unsigned attempt at the same deliverable is replaced.
	await db
		.delete(schema.submissions)
		.where(and(eq(schema.submissions.onchainAddress, submission), eq(schema.submissions.confirmed, false)));
	const [row] = await db
		.insert(schema.submissions)
		.values({
			roleId: role.id,
			gigId: gig.id,
			deliverableType: gig.type,
			payload: d.type === "SOURCING" ? null : payloadToStore,
			aboutCandidateId: gig.aboutCandidateId,
			scoutWallet: wallet,
			candidateName: candidate.name,
			candidateAvatarUrl:
				(candidate.card.avatarUrl as string | null | undefined) ?? demoAvatar(candidate.name),
			candidateTitle: (candidate.card.currentTitle as string | null | undefined) ?? null,
			candidateCompany: (candidate.card.currentCompany as string | null | undefined) ?? null,
			candidateLocation: (candidate.card.location as string | null | undefined) ?? null,
			profileUrl: candidate.profileUrl,
			notes: candidate.notes,
			// The candidate's own confirmation sets this (verification v2); recruiters can't assert it.
			consent: false,
			candidateHash: toHex(deliverableHash),
			evidenceHash: toHex(evidenceHash),
			operatorFeeBps,
			onchainAddress: submission,
			reviewDeadline: new Date(Date.now() + role.reviewWindowSeconds * 1000),
		})
		.returning();
	const label = payoutLabel(termsOf(role, gig), operatorFeeBps);
	const what =
		d.type === "SOURCING"
			? d.name
			: `your ${gig.type === "SCREENING_CALL" ? "call notes" : "reference notes"}`;
	return {
		deliverableId: row.id,
		unsignedTx: await buildUnsignedTx(
			ixs,
			`Send ${what} for "${gig.title}" (${label} if the agent accepts)`,
			await gateOpts(role),
		),
	};
}

/** The recruiter's gigs: ones they hold or delivered to, and every deliverable with its review and payout. */
export async function myGigs(wallet: Address): Promise<{ gigs: GigView[]; deliverables: DeliverableView[] }> {
	const subs = await db
		.select({ sub: schema.submissions, gig: schema.gigs, role: schema.roles })
		.from(schema.submissions)
		.innerJoin(schema.gigs, eq(schema.gigs.id, schema.submissions.gigId))
		.innerJoin(schema.roles, eq(schema.roles.id, schema.submissions.roleId))
		.where(
			and(
				eq(schema.submissions.scoutWallet, wallet),
				eq(schema.submissions.confirmed, true),
				isNull(schema.gigs.purpose),
			),
		)
		.orderBy(desc(schema.submissions.submittedAt));
	const gigIds = new Set(subs.map((s) => s.gig.id));
	const held = await db.select().from(schema.gigs).where(eq(schema.gigs.claimantWallet, wallet));
	for (const g of held) gigIds.add(g.id);
	const gigs = gigIds.size
		? await db
				.select()
				.from(schema.gigs)
				.where(inArray(schema.gigs.id, [...gigIds]))
				.orderBy(desc(schema.gigs.createdAt))
		: [];
	return {
		gigs: await (async () => {
			const v = await viewerOf(wallet);
			return (await gigContexts(gigs)).map((c) => gigView(c, v));
		})(),
		deliverables: await Promise.all(
			subs.map(async (s) => {
				const view = deliverableView(s.sub, s.gig, s.role, await confirmationOf(s.sub.id));
				if (s.sub.deliverableType !== "SOURCING") return view;
				const checks = await callChecksFor(s.sub.id);
				return checks.length ? { ...view, callChecks: checks } : view;
			}),
		),
	};
}

/** Self-reported calls about a sourced candidate, waiting for the candidate (shown to the sourcer). */
async function callChecksFor(candidateId: string) {
	const rows = await db
		.select({
			c: schema.candidateConfirmations,
			sub: schema.submissions,
			gig: schema.gigs,
			who: schema.accounts,
		})
		.from(schema.candidateConfirmations)
		.innerJoin(schema.submissions, eq(schema.submissions.id, schema.candidateConfirmations.submissionId))
		.leftJoin(schema.gigs, eq(schema.gigs.id, schema.submissions.gigId))
		.leftJoin(schema.accounts, eq(schema.accounts.wallet, schema.submissions.scoutWallet))
		.where(
			and(
				eq(schema.submissions.aboutCandidateId, candidateId),
				eq(schema.candidateConfirmations.kind, "call"),
			),
		);
	return rows.map(({ c, sub, gig, who }) => {
		const expired = c.status === "PENDING" && c.expiresAt < new Date();
		return {
			deliverableId: sub.id,
			recruiterName: who?.displayName ?? "A recruiter",
			callKind: gig?.variant === "language" ? "language check" : "screening call",
			status: expired ? ("EXPIRED" as const) : c.status,
			url: c.status === "PENDING" && !expired ? c.link : null,
			expiresAt: c.expiresAt.toISOString(),
		};
	});
}

// ---- Company: activity, shortlist, decisions --------------------------------------------

export async function requireRoleOwner(wallet: Address, roleId: string) {
	return requireRoleCompany(wallet, roleId);
}

async function requireRoleCompany(wallet: Address, roleId: string) {
	const { role } = await loadRole(roleId);
	if (role.companyWallet !== wallet) throw forbidden("only the role's company can see this");
	return role;
}

/** The "why" behind a timeline row, from what the agent logged with it. */
function activityDetail(data: Record<string, unknown> | null): string | undefined {
	if (!data) return undefined;
	const decision = data.decision as { reason?: string } | undefined;
	const reasons = Array.isArray(data.reasons) ? (data.reasons as string[]) : [];
	const more = typeof data.more === "string" ? data.more : undefined;
	const parts = [decision?.reason, ...reasons, more].filter(
		(x): x is string => typeof x === "string" && x.length > 0,
	);
	return parts.length ? [...new Set(parts)].join(" · ") : undefined;
}

/** Set by the agent runner while a step runs. */
const working = new Map<string, { what: string; since: Date; detail?: string }>();
export const setCurrentWork = (roleId: string, what: string | null) => {
	const prev = working.get(roleId);
	if (what) working.set(roleId, { what, since: prev?.since ?? new Date(), detail: prev?.detail });
	else working.delete(roleId);
};
/** The current sub-step ("Scoring Karolina against 6 must-haves"), while a step runs. */
export const setCurrentDetail = (roleId: string, detail: string) => {
	const prev = working.get(roleId);
	if (prev) working.set(roleId, { ...prev, detail });
};
export const currentWork = (roleId: string) => working.get(roleId)?.what;
export const currentWorkSince = (roleId: string) => working.get(roleId);

export async function roleActivity(wallet: Address, roleId: string, limit = 200) {
	const role = await requireRoleCompany(wallet, roleId);
	const rows = await db
		.select()
		.from(schema.agentActivity)
		.where(eq(schema.agentActivity.roleId, roleId))
		.orderBy(asc(schema.agentActivity.createdAt))
		.limit(limit);
	const working = currentWork(roleId);
	return {
		...(working ? { working } : {}),
		status:
			role.agentStatus ??
			(role.status === "DRAFT" ? "Waiting for the budget to land" : "Your agent is working"),
		items: rows.map(
			(r): AgentActivity => ({
				id: r.id,
				roleId: r.roleId,
				kind: r.kind as AgentActivity["kind"],
				message: r.message,
				gigId: r.gigId,
				deliverableId: r.deliverableId,
				signature: r.signature,
				explorerUrl: r.signature ? explorerTxUrl(r.signature) : null,
				solscanUrl: r.signature ? solscanTxUrl(r.signature) : null,
				...(activityDetail(r.data) ? { detail: activityDetail(r.data) } : {}),
				createdAt: r.createdAt.toISOString(),
			}),
		),
	};
}

export async function roleShortlist(wallet: Address, roleId: string): Promise<ShortlistItem[]> {
	await requireRoleCompany(wallet, roleId);
	const rows = await db
		.select({ item: schema.shortlist, sub: schema.submissions })
		.from(schema.shortlist)
		.innerJoin(schema.submissions, eq(schema.submissions.id, schema.shortlist.candidateId))
		.where(eq(schema.shortlist.roleId, roleId))
		.orderBy(asc(schema.shortlist.rank));
	return rows.map(({ item, sub }) => ({
		candidateId: item.candidateId,
		name: sub.candidateName,
		profileUrl: sub.profileUrl,
		card: {
			avatarUrl: sub.candidateAvatarUrl,
			currentTitle: sub.candidateTitle,
			currentCompany: sub.candidateCompany,
			location: sub.candidateLocation,
		},
		score: item.score,
		agentNote: item.agentNote,
		screening: item.screening ?? null,
		reference: item.reference ?? null,
		decision: item.decision,
		decidedAt: item.decidedAt?.toISOString() ?? null,
	}));
}

/**
 * "Invite to interview" and "Pass" are recorded decisions (nothing paid). "Came to the interview" (attended)
 * attests Advanced on every accepted deliverable about this candidate (sourcing, screening, reference), which
 * releases what is still held back for the recruiters.
 */
export async function roleDecide(
	wallet: Address,
	input: z.output<typeof RoleDecideRequest>,
): Promise<z.output<typeof RoleDecideResponse>> {
	const role = await requireRoleCompany(wallet, input.roleId);
	const where = and(
		eq(schema.shortlist.roleId, role.id),
		eq(schema.shortlist.candidateId, input.candidateId),
	);
	const [item] = await db.select().from(schema.shortlist).where(where);
	if (!item) throw notFound("shortlisted candidate");
	const [candidate] = await db
		.select()
		.from(schema.submissions)
		.where(eq(schema.submissions.id, input.candidateId));
	const name = candidate?.candidateName ?? "the candidate";

	if (input.decision === "invite" || input.decision === "pass") {
		if (item.decision !== "NONE")
			throw new HttpError(409, "ALREADY_DECIDED", `already ${item.decision.toLowerCase()}`);
		const decision = input.decision === "invite" ? "INVITED" : "PASSED";
		await db.update(schema.shortlist).set({ decision, decidedAt: new Date() }).where(where);
		await logActivity(
			role.id,
			"DECISION",
			input.decision === "invite" ? `You invited ${name} to interview` : `You passed on ${name}`,
			{ deliverableId: input.candidateId },
		);
		publish({ type: "shortlist.updated", roleId: role.id });
		return { unsignedTx: null };
	}

	// attended: "Came to the interview"
	if (item.decision === "ATTENDED") throw new HttpError(409, "ALREADY_DECIDED", "already marked as attended");
	if (item.decision !== "INVITED")
		throw new HttpError(409, "NOT_INVITED", "invite the candidate to interview first");
	const open = await openDeliverablesOfCandidate(input.candidateId);
	if (!open.length) {
		await markAttended(role.id, input.candidateId, null);
		return { unsignedTx: null };
	}
	const ixs = await Promise.all(
		open.map(({ sub, gig }) =>
			attestOutcomeIx({
				...onchainAccounts(sub, role, gig),
				authority: wallet,
				outcome: "Advanced",
				reasonCode: 0,
			}),
		),
	);
	const later = open.reduce(
		(n, { sub }) => n + (sub.laterStatus === "HELD" ? (sub.payoutLater ?? 0n) : 0n),
		0n,
	);
	return {
		unsignedTx: await buildUnsignedTx(
			ixs,
			`${name} came to the interview${later > 0n ? `: release ${usdc(later)} to the recruiters` : ""}`,
		),
	};
}

/** Called once the "came to the interview" attest tx is confirmed (apply-tx), or directly when nothing was held. */
export async function markAttended(roleId: string, candidateId: string, signature: string | null) {
	const updated = await db
		.update(schema.shortlist)
		.set({ decision: "ATTENDED", decidedAt: new Date(), decisionTx: signature })
		.where(
			and(
				eq(schema.shortlist.roleId, roleId),
				eq(schema.shortlist.candidateId, candidateId),
				inArray(schema.shortlist.decision, ["NONE", "INVITED"]),
			),
		)
		.returning();
	if (!updated.length) return;
	const [candidate] = await db
		.select()
		.from(schema.submissions)
		.where(eq(schema.submissions.id, candidateId));
	await logActivity(
		roleId,
		"DECISION",
		`${candidate?.candidateName ?? "The candidate"} came to the interview`,
		{
			deliverableId: candidateId,
			signature,
		},
	);
	publish({ type: "shortlist.updated", roleId });
}

/** Sourced candidates of a role with their accepted calls (input for the shortlist). */
export async function candidatesOfRole(roleId: string) {
	return db
		.select()
		.from(schema.submissions)
		.where(
			and(
				eq(schema.submissions.roleId, roleId),
				eq(schema.submissions.confirmed, true),
				or(
					eq(schema.submissions.deliverableType, "SOURCING"),
					isNotNull(schema.submissions.aboutCandidateId),
				),
			),
		);
}
