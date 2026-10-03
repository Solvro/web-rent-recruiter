/**
 * Backend implementation of the role agent's ports (canonical interface: src/agent/runner/ports.ts, Stream C).
 * DB reads, on-chain effects signed by the agent key as role.agent (relayer pays), timeline rows + live events.
 *
 * Candidates: a candidate is an ACCEPTED sourcing deliverable; its id is that submission's id. Screening and
 * reference deliverables point at it via submissions.aboutCandidateId.
 *
 * C's actions log every step themselves (ports.log), so the effect ports below don't add timeline rows.
 */
import { createHash } from "node:crypto";
import type { AgentActivity, AgentReview, GigType, ScriptQuestion } from "@scout/shared";
import { type Address, address } from "@solana/kit";
import { and, desc, eq, inArray, isNotNull, isNull, max } from "drizzle-orm";
import type {
	ActivityKind,
	AgentEvent,
	CandidateStage,
	CandidateView,
	DecisionRecord,
	Deliverable,
	RoleAgentPorts,
	RoleSnapshot,
	StoredReview,
} from "../agent/runner/ports.ts";
import { logActivity } from "../api/gigs.ts";
import { repriceGig } from "../api/loop.ts";
import { onchainAccounts } from "../api/submissions.ts";
import { db, schema } from "../db/index.ts";
import { env } from "../env.ts";
import { publish } from "../events.ts";
import { applyConfirmedTx } from "../indexer/apply-tx.ts";
import { availableBudget } from "../lib/views.ts";
import { recordingMeta } from "../recall/service.ts";
import { agentSigner, fetchProgramAccount, type RoleVaultAccount } from "../solana/chain.ts";
import { acceptIx, createTaskIx, rejectIx } from "../solana/scout.ts";
import { sendAsRelayer } from "../solana/tx.ts";
import { confirmationKind, preAccept } from "./confirmations.ts";
import { decisionLine, humanize } from "./narrate.ts";

type SubRow = typeof schema.submissions.$inferSelect;
type OnchainGigType = "SOURCING" | "SCREENING_CALL" | "REFERENCE_CHECK";
type GigRow = typeof schema.gigs.$inferSelect;

const KIND: Record<ActivityKind, AgentActivity["kind"]> = {
	plan: "PLANNED",
	gig_posted: "GIG_POSTED",
	review: "REVIEWED",
	accepted: "DELIVERY_ACCEPTED",
	rejected: "DELIVERY_REJECTED",
	escalated: "ESCALATED",
	booked: "GIG_POSTED",
	criteria_changed: "CRITERIA_UPDATED",
	gigs_paused: "PAUSED",
	gigs_resumed: "RESUMED",
	shortlist: "SHORTLISTED",
	note: "NOTE",
	repriced: "REPRICED",
	replan: "REPLANNED",
};

/** Stable JSON so the same brief always hashes the same (brief_hash on-chain). */
export function canonical(v: unknown): string {
	if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
	if (v && typeof v === "object")
		return `{${Object.keys(v)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
			.join(",")}}`;
	return JSON.stringify(v ?? null, (_, x) => (typeof x === "bigint" ? x.toString() : x));
}

const KIND_OF: Record<GigType, Deliverable["kind"]> = {
	SOURCING: "sourcing",
	SCREENING_CALL: "screening",
	REFERENCE_CHECK: "reference",
};

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

export function createBackendPorts(roleId: string, onEvent?: (e: AgentEvent) => void): RoleAgentPorts {
	const loadRole = async () => {
		const [role] = await db.select().from(schema.roles).where(eq(schema.roles.id, roleId));
		if (!role) throw new Error(`role ${roleId} not found`);
		return role;
	};

	async function sourcerOf(candidateId: string): Promise<Address | null> {
		const [c] = await db
			.select({ scout: schema.submissions.scoutWallet })
			.from(schema.submissions)
			.where(eq(schema.submissions.id, candidateId));
		return c ? address(c.scout) : null;
	}

	async function loadDeliverable(id: string) {
		const [row] = await db
			.select({ sub: schema.submissions, role: schema.roles, gig: schema.gigs, scout: schema.accounts })
			.from(schema.submissions)
			.innerJoin(schema.roles, eq(schema.roles.id, schema.submissions.roleId))
			.leftJoin(schema.gigs, eq(schema.gigs.id, schema.submissions.gigId))
			.leftJoin(schema.accounts, eq(schema.accounts.wallet, schema.submissions.scoutWallet))
			.where(and(eq(schema.submissions.id, id), eq(schema.submissions.roleId, roleId)));
		return row ?? null;
	}

	async function toDeliverable(
		sub: SubRow,
		gig: GigRow | null,
		scout: { displayName: string } | null,
	): Promise<Deliverable | null> {
		if (!gig) return null;
		const base = {
			id: sub.id,
			gigId: gig.id,
			...(sub.updatedAt ? { updatedAt: sub.updatedAt.toISOString() } : {}),
			recruiter: { wallet: sub.scoutWallet, displayName: scout?.displayName ?? "Recruiter" },
			submittedAt: sub.submittedAt.toISOString(),
		};
		if (gig.type === "SOURCING") {
			return {
				...base,
				kind: "sourcing",
				candidate: { name: sub.candidateName, profileUrl: sub.profileUrl, notes: sub.notes },
			};
		}
		const payload = (sub.payload ?? {}) as Record<string, unknown>;
		const recording = payload.evidence === "self-reported" ? null : await recordingMeta(gig.id);
		const script = gig.script as { questions?: ScriptQuestion[]; candidate?: unknown; kind?: string } | null;
		return {
			...base,
			kind: (gig.variant === "language" ? "language" : KIND_OF[gig.type]) as "screening" | "reference",
			candidateId: sub.aboutCandidateId ?? "",
			script: {
				kind: (gig.variant === "language"
					? "language"
					: gig.type === "SCREENING_CALL"
						? "screening"
						: "reference") as "screening" | "reference",
				candidate: (script?.candidate as { name: string; profileUrl: string; notes: string }) ?? {
					name: sub.candidateName,
					profileUrl: sub.profileUrl,
					notes: "",
				},
				questions: (script?.questions ?? []).map((q) => ({
					id: q.id,
					question: q.question,
					whatGoodLooksLike: q.whatGoodLooksLike,
					...(q.criterionId ? { criterionId: q.criterionId } : {}),
				})),
			},
			answers: (payload.answers as { questionId: string; answer: string }[]) ?? [],
			recommendation: (payload.recommendation as "ADVANCE" | "MAYBE" | "PASS") ?? "MAYBE",
			...(str(payload.transcript) ? { transcript: str(payload.transcript) } : {}),
			...(recording ? { recording } : {}),
		};
	}

	return {
		async getRole(): Promise<RoleSnapshot> {
			const role = await loadRole();
			const gigs = await db
				.select()
				.from(schema.gigs)
				.where(and(eq(schema.gigs.roleId, roleId), isNull(schema.gigs.purpose)));
			const subs = await db
				.select()
				.from(schema.submissions)
				.where(
					and(
						eq(schema.submissions.roleId, roleId),
						eq(schema.submissions.confirmed, true),
						isNotNull(schema.submissions.gigId),
					),
				);
			const shortlist = await db.select().from(schema.shortlist).where(eq(schema.shortlist.roleId, roleId));
			const available = availableBudget(role);

			const stored = (s: SubRow) => s.agentReview as unknown as StoredReview | null;
			const candidates: CandidateView[] = subs
				.filter((s) => s.deliverableType === "SOURCING" && s.status === "ACCEPTED")
				.map((c) => {
					const calls = subs.filter((s) => s.aboutCandidateId === c.id);
					const accepted = (type: GigType) =>
						calls.find((s) => s.deliverableType === type && s.status === "ACCEPTED");
					const screening = accepted("SCREENING_CALL");
					const reference = accepted("REFERENCE_CHECK");
					const gigAbout = (type: GigType) =>
						gigs.some((g) => g.aboutCandidateId === c.id && g.type === type && g.status !== "CLOSED");
					const passed = shortlist.find((x) => x.candidateId === c.id)?.decision === "PASSED";
					const stage: CandidateStage = passed
						? "rejected"
						: reference
							? "referenced"
							: gigAbout("REFERENCE_CHECK")
								? "reference"
								: screening
									? "screened"
									: gigAbout("SCREENING_CALL")
										? "screening"
										: "sourced";
					return {
						id: c.id,
						name: c.candidateName,
						profileUrl: c.profileUrl,
						notes: c.notes,
						stage,
						...(stored(c)?.sourcing ? { sourcing: stored(c)?.sourcing as AgentReview } : {}),
						...(screening && stored(screening)?.call ? { screening: stored(screening)?.call } : {}),
						...(reference && stored(reference)?.call ? { reference: stored(reference)?.call } : {}),
					};
				});
			return {
				roleId,
				title: role.title,
				criteria: role.criteria,
				budget: { deposited: role.deposited, paid: role.paid, available },
				maxBounty: env.agentMaxBounty,
				gigs: gigs
					.filter((g) => g.status !== "DRAFT" && g.status !== "POSTING")
					.map((g) => ({
						gigId: g.id,
						taskType: g.type,
						...(g.type === "SCREENING_CALL" ? { variant: g.variant ?? "standard" } : {}),
						title: g.title,
						bounty: g.bounty,
						maxDeliverables: g.maxDeliverables,
						acceptedCount: g.acceptedCount,
						pendingCount: g.pendingCount,
						status: g.status as "OPEN" | "PAUSED" | "CLOSED",
						...(g.aboutCandidateId ? { candidateId: g.aboutCandidateId } : {}),
					})),
				candidates,
				paused: role.agentPaused,
				pausedTaskTypes: role.pausedTaskTypes as RoleSnapshot["pausedTaskTypes"],
			};
		},

		async listPendingDeliverables() {
			const rows = await db
				.select({ sub: schema.submissions, gig: schema.gigs, scout: schema.accounts })
				.from(schema.submissions)
				.innerJoin(schema.gigs, eq(schema.gigs.id, schema.submissions.gigId))
				.leftJoin(schema.accounts, eq(schema.accounts.wallet, schema.submissions.scoutWallet))
				.where(
					and(
						eq(schema.submissions.roleId, roleId),
						eq(schema.submissions.confirmed, true),
						eq(schema.submissions.status, "PENDING"),
					),
				)
				.orderBy(schema.submissions.submittedAt);
			// Pre-accepted sourcing deliverables wait for the candidate, not for the agent.
			const waiting = new Set(
				(
					await db
						.select({ id: schema.candidateConfirmations.submissionId })
						.from(schema.candidateConfirmations)
						.where(eq(schema.candidateConfirmations.status, "PENDING"))
				).map((c) => c.id),
			);
			const out = await Promise.all(
				rows.filter((r) => !waiting.has(r.sub.id)).map((r) => toDeliverable(r.sub, r.gig, r.scout)),
			);
			return out.filter((d): d is Deliverable => d !== null);
		},

		async getDeliverable(id) {
			const row = await loadDeliverable(id);
			return row ? await toDeliverable(row.sub, row.gig, row.scout) : null;
		},

		async postGig(gig) {
			const role = await loadRole();
			if (!role.roleVault || role.status !== "OPEN") throw new Error("the role's budget isn't on-chain yet");
			const agent = await agentSigner();
			// The program requires task_id == role.task_count.
			const vault = await fetchProgramAccount<RoleVaultAccount>("RoleVault", address(role.roleVault));
			const [{ last }] = await db
				.select({ last: max(schema.gigs.onchainTaskId) })
				.from(schema.gigs)
				.where(eq(schema.gigs.roleId, roleId));
			const taskId = vault ? Number(vault.taskCount) : (last ?? -1) + 1;
			const script = gig.script ?? null;
			// A language check is an ordinary ScreeningCall task on-chain with variant "language".
			const language =
				(gig as { variant?: string }).variant === "language" ||
				(gig.taskType as string) === "LANGUAGE_CHECK" ||
				script?.kind === "language";
			const onchainType: OnchainGigType = language ? "SCREENING_CALL" : (gig.taskType as OnchainGigType);
			const briefHash = new Uint8Array(
				createHash("sha256")
					.update(canonical({ title: gig.title, brief: gig.brief, script }))
					.digest(),
			);
			const { ix, task } = await createTaskIx({
				authority: agent.address,
				roleVault: address(role.roleVault),
				taskId,
				type: onchainType,
				bounty: gig.bounty,
				maxDeliverables: gig.maxDeliverables,
				exclusive: gig.exclusive,
				briefHash,
				holdbackBps: role.holdbackBps,
				// Calls about a sourced candidate: the sourcer can't take them (no self-dealing).
				subjectScout: gig.candidateId ? await sourcerOf(gig.candidateId) : null,
				minAccepted: onchainType === "SOURCING" ? 0 : env.minAcceptedForCalls,
				minAcceptRateBps: onchainType === "SOURCING" ? 0 : env.minAcceptRateBpsForCalls,
				bondBps: onchainType === "SOURCING" ? env.sourcingBondBps : 0,
			});
			const [row] = await db
				.insert(schema.gigs)
				.values({
					roleId,
					onchainTaskId: taskId,
					taskAddress: task,
					type: onchainType,
					title: gig.title,
					brief: gig.brief,
					script: script as unknown as Record<string, unknown> | null,
					briefHash: Buffer.from(briefHash).toString("hex"),
					bounty: gig.bounty,
					maxDeliverables: gig.maxDeliverables,
					exclusive: gig.exclusive,
					holdbackBps: role.holdbackBps,
					status: "POSTING",
					postWhen: gig.when,
					variant: onchainType === "SCREENING_CALL" ? (language ? "language" : "standard") : null,
					aboutCandidateId: gig.candidateId ?? null,
				})
				.returning();
			try {
				const confirmed = await sendAsRelayer([ix], [agent]);
				await db
					.update(schema.gigs)
					.set({ status: "OPEN", createTx: confirmed.signature })
					.where(eq(schema.gigs.id, row.id));
				await applyConfirmedTx(confirmed);
				publish({ type: "gig.updated", roleId, gigId: row.id, signature: confirmed.signature });
				return { gigId: row.id, signature: confirmed.signature };
			} catch (err) {
				await db.delete(schema.gigs).where(eq(schema.gigs.id, row.id));
				throw err;
			}
		},

		/** The company told the agent to stop posting these gig types (it keeps reviewing what's in flight). */
		async setTaskTypePaused(types, paused) {
			const role = await loadRole();
			const next = paused
				? [...new Set([...role.pausedTaskTypes, ...types])]
				: role.pausedTaskTypes.filter((t) => !types.includes(t));
			await db
				.update(schema.roles)
				.set({ pausedTaskTypes: next as OnchainGigType[] })
				.where(eq(schema.roles.id, roleId));
			publish({ type: "role.updated", roleId });
		},

		/** Off-chain only: a PAUSED gig is hidden from the board and refuses deliveries (NO_OPEN_GIG). */
		async setGigStatus(gigIds, status) {
			if (!gigIds.length) return;
			await db
				.update(schema.gigs)
				.set({ status })
				.where(
					and(
						eq(schema.gigs.roleId, roleId),
						inArray(schema.gigs.id, gigIds),
						inArray(schema.gigs.status, ["OPEN", "PAUSED"]),
					),
				);
			for (const gigId of gigIds) publish({ type: "gig.updated", roleId, gigId });
		},

		async saveReview(review) {
			await db
				.update(schema.submissions)
				.set({
					agentReview: { ...review, reviewedAt: new Date().toISOString() } as unknown as Record<
						string,
						unknown
					>,
				})
				.where(and(eq(schema.submissions.id, review.deliverableId), eq(schema.submissions.roleId, roleId)));
			// Keep the candidate score where the company views already read it.
			if (review.sourcing) {
				await db
					.insert(schema.agentReviews)
					.values({ submissionId: review.deliverableId, review: review.sourcing })
					.onConflictDoUpdate({
						target: schema.agentReviews.submissionId,
						set: { review: review.sourcing },
					});
			}
			publish({ type: "submission.reviewed", roleId, submissionId: review.deliverableId });
		},

		async getReview(deliverableId) {
			const row = await loadDeliverable(deliverableId);
			const r = row?.sub.agentReview as unknown as StoredReview | null;
			return r?.decision ? r : null;
		},

		async acceptDeliverable(id, reason) {
			const row = await loadDeliverable(id);
			if (!row) throw new Error(`deliverable ${id} not found`);
			// Verification v2: a sourced candidate is paid only after they confirm interest themselves.
			// signature "" = pre-accepted, waiting for the candidate.
			if (confirmationKind(row.sub, row.gig)) {
				await preAccept(id);
				return { signature: "" };
			}
			const agent = await agentSigner();
			const ix = await acceptIx({
				...onchainAccounts(row.sub, row.role, row.gig),
				authority: agent.address,
				review: reason,
			});
			const confirmed = await sendAsRelayer([ix], [agent]);
			await applyConfirmedTx(confirmed);
			void reason; // shown via C's log row
			return { signature: confirmed.signature };
		},

		async rejectDeliverable(id, reason) {
			const row = await loadDeliverable(id);
			if (!row) throw new Error(`deliverable ${id} not found`);
			const agent = await agentSigner();
			const ix = await rejectIx({
				...onchainAccounts(row.sub, row.role, row.gig),
				authority: agent.address,
				reasonCode: 0,
				reasonText: reason,
			});
			const confirmed = await sendAsRelayer([ix], [agent]);
			// The recruiter sees why.
			const stored = (row.sub.agentReview ?? {}) as Record<string, unknown>;
			await db
				.update(schema.submissions)
				.set({ agentReview: { ...stored, rejectReason: reason }, rejectText: reason })
				.where(eq(schema.submissions.id, id));
			await applyConfirmedTx(confirmed);
			return { signature: confirmed.signature };
		},

		/** The company's inbox is the timeline's ESCALATED rows (C logs them); deliverable stays pending. */
		/** One follow-up question to the recruiter; their answer (gigs.answerFollowUp) triggers a re-review. */
		async askRecruiter(deliverableId, question) {
			const row = await loadDeliverable(deliverableId);
			if (!row) throw new Error(`deliverable ${deliverableId} not found`);
			const followUps = [
				...row.sub.followUps,
				{ question, askedAt: new Date().toISOString(), answer: null, answeredAt: null },
			];
			await db.update(schema.submissions).set({ followUps }).where(eq(schema.submissions.id, deliverableId));
			publish({
				type: "gig.updated",
				roleId,
				gigId: row.sub.gigId ?? undefined,
				submissionId: deliverableId,
				scout: row.sub.scoutWallet,
				message: "followup.asked",
			});
		},

		async escalate(input) {
			// A pending deliverable shows up in the cockpit through its review (escalatedAt). Anything else (a
			// replanning question, a concern about a candidate) goes to the company's inbox until they answer it.
			const [sub] = input.deliverableId
				? await db.select().from(schema.submissions).where(eq(schema.submissions.id, input.deliverableId))
				: [];
			if (sub?.status === "PENDING") {
				publish({ type: "agent.activity", roleId, submissionId: sub.id, message: input.question });
				return;
			}
			await logActivity(roleId, "ESCALATED", input.question, {
				deliverableId: input.deliverableId ?? input.candidateId ?? null,
				data: { inbox: true, delivery: input.delivery ?? "now" },
			});
		},

		/** close_task + create_task at the new price, in one agent-signed tx (api/loop.ts). */
		async repriceGig(gigId, bounty, reason) {
			const { signature } = await repriceGig(roleId, gigId, bounty, reason);
			return { signature };
		},

		async updateCriteria(criteria) {
			await db.update(schema.roles).set({ criteria }).where(eq(schema.roles.id, roleId));
			publish({ type: "role.updated", roleId });
		},

		async saveShortlist(entries) {
			const existing = await db.select().from(schema.shortlist).where(eq(schema.shortlist.roleId, roleId));
			const subs = entries.length
				? await db
						.select({ sub: schema.submissions, scout: schema.accounts })
						.from(schema.submissions)
						.leftJoin(schema.accounts, eq(schema.accounts.wallet, schema.submissions.scoutWallet))
						.where(
							and(
								eq(schema.submissions.roleId, roleId),
								eq(schema.submissions.status, "ACCEPTED"),
								inArray(
									schema.submissions.aboutCandidateId,
									entries.map((e) => e.id),
								),
							),
						)
				: [];
			const callSummary = (candidateId: string, type: GigType) => {
				const r = subs.find((s) => s.sub.aboutCandidateId === candidateId && s.sub.deliverableType === type);
				if (!r) return null;
				const review = r.sub.agentReview as unknown as StoredReview | null;
				const payload = (r.sub.payload ?? {}) as Record<string, unknown>;
				return {
					summary: review?.call?.summaryForCompany ?? r.sub.notes.slice(0, 280),
					recommendation: str(payload.recommendation) ?? "MAYBE",
					recruiter: r.scout?.displayName ?? "Recruiter",
				};
			};
			for (const e of entries) {
				const values = {
					rank: e.rank,
					score: e.overall,
					agentNote: e.summary,
					screening: callSummary(e.id, "SCREENING_CALL"),
					reference: callSummary(e.id, "REFERENCE_CHECK"),
					updatedAt: new Date(),
				};
				await db
					.insert(schema.shortlist)
					.values({ roleId, candidateId: e.id, ...values })
					.onConflictDoUpdate({
						target: [schema.shortlist.roleId, schema.shortlist.candidateId],
						set: values,
					});
			}
			const keep = new Set(entries.map((e) => e.id));
			for (const x of existing) {
				if (keep.has(x.candidateId) || x.decision !== "NONE") continue;
				await db
					.delete(schema.shortlist)
					.where(and(eq(schema.shortlist.roleId, roleId), eq(schema.shortlist.candidateId, x.candidateId)));
			}
			publish({ type: "shortlist.updated", roleId });
		},

		async getDecisionLog(filter) {
			const rows = await db
				.select()
				.from(schema.agentActivity)
				.where(eq(schema.agentActivity.roleId, roleId))
				.orderBy(desc(schema.agentActivity.createdAt))
				.limit(500);
			const want = filter.candidateName?.toLowerCase();
			const out: DecisionRecord[] = [];
			for (const r of rows) {
				const data = (r.data ?? {}) as Record<string, unknown>;
				const decision = data.decision as { action?: DecisionRecord["action"]; reason?: string } | undefined;
				const action: DecisionRecord["action"] | undefined =
					decision?.action ??
					(
						{
							GIG_POSTED: "posted",
							CRITERIA_UPDATED: "criteria",
							PAUSED: "paused",
							RESUMED: "resumed",
							SHORTLISTED: "shortlisted",
						} as Record<string, DecisionRecord["action"]>
					)[r.kind];
				if (!action) continue;
				const deliverableId = str(data.deliverableId) ?? r.deliverableId ?? undefined;
				if (filter.deliverableId && deliverableId !== filter.deliverableId) continue;
				if (
					want &&
					!r.message.toLowerCase().includes(want) &&
					str(data.candidateName)?.toLowerCase() !== want
				)
					continue;
				out.push({
					at: r.createdAt.toISOString(),
					action,
					reason: decision?.reason ?? r.message,
					deliverableId,
					candidateId: str(data.candidateId),
					candidateName: str(data.candidateName),
					gigId: str(data.gigId) ?? r.gigId ?? undefined,
				});
				if (out.length >= (filter.limit ?? 20)) break;
			}
			return out;
		},

		async log({ kind, message, data }) {
			const d = data ?? {};
			// Every agent-signed tx gets its link on the timeline: posted gigs carry the create_task signature.
			if (!str(d.signature) && str(d.gigId) && (kind === "booked" || kind === "gig_posted")) {
				const [g] = await db
					.select({ tx: schema.gigs.createTx })
					.from(schema.gigs)
					.where(eq(schema.gigs.id, str(d.gigId) as string));
				if (g?.tx) d.signature = g.tx;
			}
			// One plain line per decision; the agent's own words become the detail.
			const narrated = await decisionLine(kind, message, d);
			if (narrated && "skip" in narrated) return;
			if (narrated) d.more = humanize(message);
			// The timeline line is one sentence; a longer explanation (e.g. the budget plan) goes to its detail.
			const [line, ...more] = message.split(/(?<=[.!?])\s+(?=[A-Z$])/);
			if (!narrated && more.length && message.length > 120) d.more = more.join(" ");
			await logActivity(
				roleId,
				KIND[kind] ?? "NOTE",
				narrated
					? narrated.line
					: humanize(more.length && message.length > 120 ? (line ?? message) : message),
				{
					gigId: str(d.gigId) ?? null,
					deliverableId: str(d.deliverableId) ?? str(d.candidateId) ?? null,
					signature: str(d.signature) ?? null,
					data: JSON.parse(canonical(d)) as Record<string, unknown>,
				},
			);
		},

		onEvent,
	};
}
