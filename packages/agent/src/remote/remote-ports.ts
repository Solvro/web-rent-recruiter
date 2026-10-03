/**
 * RoleAgentPorts for a self-hosted agent: chain state read directly, off-chain metadata and
 * payloads from the platform's agent API, and every money action built and signed here with the
 * agent's own key (create_task, accept_submission, reject_submission).
 */
import { createHash } from "node:crypto";
import type { AgentDeliverable, AgentRoleSnapshot } from "@scout/shared";
import {
	getAcceptSubmissionInstruction,
	getCreateTaskInstructionAsync,
	getRejectSubmissionInstruction,
	TaskType as OnchainTaskType,
	Status,
} from "@scout/shared/program";
import { type Address, address } from "@solana/kit";
import { gigRequirements } from "../gigs/market.ts";
import type { GigType } from "../gigs/types.ts";
import type {
	AgentEvent,
	CandidateView,
	DecisionRecord,
	Deliverable,
	GigView,
	RoleAgentPorts,
	RoleSnapshot,
	StoredReview,
} from "../runner/ports.ts";
import type { AgentApi } from "./api.ts";
import {
	availableBudget,
	type ChainContext,
	payerSigner,
	readRoleVault,
	readSubmission,
	readTasks,
	scoutAccounts,
	sendAgentTx,
	tokenBalance,
} from "./chain.ts";

const ONCHAIN_TYPE: Record<GigType, OnchainTaskType> = {
	SOURCING: OnchainTaskType.Sourcing,
	SCREENING_CALL: OnchainTaskType.ScreeningCall,
	REFERENCE_CHECK: OnchainTaskType.ReferenceCheck,
};
const GIG_TYPE: Record<OnchainTaskType, GigType> = {
	[OnchainTaskType.Sourcing]: "SOURCING",
	[OnchainTaskType.ScreeningCall]: "SCREENING_CALL",
	[OnchainTaskType.ReferenceCheck]: "REFERENCE_CHECK",
};
/** Program caps: holdback ≤ 5000 bps, bond ≤ 2000 bps. */
const SOURCING_BOND_BPS = 1000;

/** Stable JSON so the same brief always hashes the same (brief_hash / review_hash on-chain). */
export function canonical(v: unknown): string {
	if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
	if (typeof v === "bigint") return JSON.stringify(v.toString());
	if (v && typeof v === "object")
		return `{${Object.keys(v as object)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
			.join(",")}}`;
	return JSON.stringify(v ?? null);
}
export const sha256 = (s: string) => new Uint8Array(createHash("sha256").update(s).digest());

/** The agent's Deliverable from the API's envelope (payload fields are the agent's own shape). */
export function toDeliverable(d: AgentDeliverable): Deliverable {
	return {
		...(d.payload as object),
		id: d.id,
		gigId: d.gigId,
		kind: d.kind,
		recruiter: d.recruiter,
		submittedAt: d.submittedAt,
		...(d.updatedAt ? { updatedAt: d.updatedAt } : {}),
	} as Deliverable;
}

export interface RemotePortsOptions {
	api: AgentApi;
	chain: ChainContext;
	roleId: string;
	roleVault: Address;
	onEvent?: (event: AgentEvent) => void;
}

export function createRemotePorts(opts: RemotePortsOptions): RoleAgentPorts & {
	/** The last snapshot from the API (refreshed by getRole). */
	lastMeta(): AgentRoleSnapshot | null;
	/** Settles sourcing deliverables whose candidate confirmed (accept_submission, signed by the agent). */
	settleConfirmed(): Promise<string[]>;
} {
	const { api, chain, roleId, roleVault } = opts;
	let meta: AgentRoleSnapshot | null = null;
	const deliverables = new Map<string, AgentDeliverable>();

	const remember = (d: AgentDeliverable | null) => {
		if (d) deliverables.set(d.id, d);
		return d;
	};
	const envelope = async (id: string) =>
		deliverables.get(id) ?? remember(await api.call("agent.deliverable", { deliverableId: id }));

	async function acceptOnChain(d: AgentDeliverable, reason: string): Promise<string> {
		const vault = await readRoleVault(chain, roleVault);
		const scout = await scoutAccounts(chain, address(d.scout));
		const review = await api.call("agent.review.get", { deliverableId: d.id });
		const ix = getAcceptSubmissionInstruction({
			payer: payerSigner(chain),
			authority: chain.agent,
			config: address(chain.config.config),
			roleVault,
			task: address(d.task),
			submission: address(d.submission),
			scoutProfile: scout.profile,
			vaultTokenAccount: vault.vaultTokenAccount,
			scoutTokenAccount: scout.tokenAccount,
			treasuryTokenAccount: address(chain.config.treasuryTokenAccount),
			...(scout.operator
				? { operator: scout.operator, operatorTokenAccount: scout.operatorTokenAccount }
				: {}),
			mint: address(chain.config.usdcMint),
			tokenProgram: address(chain.config.tokenProgram),
			reviewHash: sha256(canonical({ review, reason })),
		});
		const signature = await sendAgentTx(chain, [ix]);
		await api.call("agent.decision", { deliverableId: d.id, action: "accept", reason, signature });
		return signature;
	}

	const ports: ReturnType<typeof createRemotePorts> = {
		lastMeta: () => meta,

		async getRole(): Promise<RoleSnapshot> {
			meta = await api.call("agent.role", { roleId });
			const vault = await readRoleVault(chain, roleVault);
			const [tasks, balance] = await Promise.all([
				readTasks(chain, roleVault, vault.taskCount),
				tokenBalance(chain, vault.vaultTokenAccount),
			]);
			const byAddress = new Map(tasks.map((t) => [t.address as string, t]));
			const known = new Set(meta.gigs.map((g) => g.taskAddress));
			const gigs: GigView[] = meta.gigs.flatMap((g) => {
				const task = g.taskAddress ? byAddress.get(g.taskAddress) : undefined;
				if (!task) return [];
				const closed = task.status === Status.Closed;
				return [
					{
						gigId: g.gigId,
						taskType: GIG_TYPE[task.taskType],
						...(g.variant !== "standard" ? { variant: g.variant } : {}),
						title: g.title,
						bounty: task.bounty,
						maxDeliverables: task.maxDeliverables,
						acceptedCount: task.acceptedCount,
						pendingCount: task.pendingCount,
						status: closed ? "CLOSED" : g.status === "PAUSED" ? "PAUSED" : "OPEN",
						...(g.candidateId ? { candidateId: g.candidateId } : {}),
						...(g.postedAt ? { postedAt: g.postedAt } : {}),
						...(g.lastRepricedAt ? { lastRepricedAt: g.lastRepricedAt } : {}),
						claims: g.claims,
						deliveries: g.deliveries,
					},
				];
			});
			// Tasks the company created itself still count against the budget and the plan.
			for (const t of tasks) {
				if (known.has(t.address)) continue;
				gigs.push({
					gigId: `task:${t.taskId}`,
					taskType: GIG_TYPE[t.taskType],
					title: `Task #${t.taskId}`,
					bounty: t.bounty,
					maxDeliverables: t.maxDeliverables,
					acceptedCount: t.acceptedCount,
					pendingCount: t.pendingCount,
					status: t.status === Status.Closed ? "CLOSED" : "OPEN",
				});
			}
			return {
				roleId,
				title: meta.title,
				criteria: meta.criteria,
				budget: {
					deposited: vault.totalDeposited,
					paid: vault.totalPaid,
					available: availableBudget(vault, balance),
				},
				gigs,
				candidates: meta.candidates as unknown as CandidateView[],
				paused: meta.paused || vault.status === Status.Closed,
				pausedTaskTypes: meta.pausedTaskTypes,
				maxBounty: vault.agentMaxBounty,
			};
		},

		async listPendingDeliverables() {
			const all = await api.call("agent.deliverables", { roleId });
			for (const d of all) remember(d);
			return all.filter((d) => d.stage === "pending").map(toDeliverable);
		},

		async getDeliverable(id) {
			const d = await envelope(id);
			return d ? toDeliverable(d) : null;
		},

		async postGig(gig) {
			const vault = await readRoleVault(chain, roleVault);
			const role = meta ?? (await api.call("agent.role", { roleId }));
			const taskId = vault.taskCount;
			const script = gig.script ?? null;
			const variant = gig.variant ?? (script?.kind === "language" ? "language" : "standard");
			const req = gigRequirements({ taskType: gig.taskType, variant, criteria: role.criteria });
			const candidate = role.candidates.find((c) => c.id === gig.candidateId) as
				| { sourcer?: string }
				| undefined;
			const create = await getCreateTaskInstructionAsync({
				payer: payerSigner(chain),
				authority: chain.agent,
				roleVault,
				vaultTokenAccount: vault.vaultTokenAccount,
				taskId,
				taskType: ONCHAIN_TYPE[gig.taskType],
				bounty: gig.bounty,
				maxDeliverables: gig.maxDeliverables,
				exclusive: gig.exclusive,
				briefHash: sha256(canonical({ title: gig.title, brief: gig.brief, script })),
				holdbackBps: role.holdbackBps,
				subjectScout: candidate?.sourcer ? address(candidate.sourcer) : null,
				minAccepted: req.minTrust?.minAccepted ?? 0,
				minAcceptRateBps: Math.round((req.minTrust?.minAcceptanceRate ?? 0) * 10_000),
				bondBps: req.bondForUnvouched ? SOURCING_BOND_BPS : 0,
				// Sourcing: the platform may settle a confirmed candidate at expiry if the agent is offline.
				confirmationAttestor:
					gig.taskType === "SOURCING" && chain.config.confirmationAttestor
						? address(chain.config.confirmationAttestor)
						: null,
			});
			const taskAddress = create.accounts[3]?.address as Address; // payer, authority, roleVault, task
			const signature = await sendAgentTx(chain, [create]);
			const { gigId } = await api.call("agent.gig.register", {
				roleId,
				taskAddress,
				signature,
				gig: {
					taskType: gig.taskType,
					variant,
					title: gig.title,
					brief: gig.brief,
					script: script as unknown as Record<string, unknown> | null,
					bounty: gig.bounty.toString(),
					maxDeliverables: gig.maxDeliverables,
					exclusive: gig.exclusive,
					when: gig.when,
					candidateId: gig.candidateId ?? null,
				},
			});
			return { gigId, signature };
		},

		async setGigStatus(gigIds, status) {
			await api.call("agent.gig.setStatus", { roleId, gigIds, status });
		},
		async setTaskTypePaused(types, paused) {
			await api.call("agent.gig.pauseTypes", { roleId, taskTypes: types, paused });
		},

		async saveReview(review) {
			await api.call("agent.review.save", {
				deliverableId: review.deliverableId,
				review: review as unknown as Record<string, unknown>,
			});
		},
		async getReview(deliverableId) {
			const r = await api.call("agent.review.get", { deliverableId });
			const stored = r as unknown as StoredReview | null;
			return stored?.decision ? stored : null;
		},

		async acceptDeliverable(id, reason) {
			const d = await envelope(id);
			if (!d) throw new Error(`deliverable ${id} not found`);
			// Sourcing: pre-accept only; paid when the candidate confirms (see settleConfirmed).
			if (d.kind === "sourcing" && d.stage === "pending") {
				await api.call("agent.decision", {
					deliverableId: id,
					action: "pre_accept",
					reason,
					signature: null,
				});
				return { signature: "" };
			}
			return { signature: await acceptOnChain(d, reason) };
		},

		async rejectDeliverable(id, reason) {
			const d = await envelope(id);
			if (!d) throw new Error(`deliverable ${id} not found`);
			const sub = await readSubmission(chain, address(d.submission));
			if (!sub) throw new Error(`submission ${d.submission} not on-chain`);
			const scout = await scoutAccounts(chain, address(d.scout));
			const ix = getRejectSubmissionInstruction({
				payer: payerSigner(chain),
				authority: chain.agent,
				roleVault,
				task: address(d.task),
				submission: address(d.submission),
				rentPayer: sub.rentPayer,
				scoutProfile: scout.profile,
				reasonCode: d.kind === "sourcing" ? 0 : 3,
				reasonHash: sha256(canonical({ reason })),
			});
			const signature = await sendAgentTx(chain, [ix]);
			await api.call("agent.decision", { deliverableId: id, action: "reject", reason, signature });
			return { signature };
		},

		async escalate(input) {
			await api.call("agent.escalate", {
				roleId,
				deliverableId: input.deliverableId ?? null,
				candidateId: input.candidateId ?? null,
				question: input.question,
				delivery: input.delivery ?? "now",
			});
		},
		async askRecruiter(deliverableId, question) {
			await api.call("agent.askRecruiter", { deliverableId, question });
		},
		async updateCriteria(criteria, note) {
			await api.call("agent.criteria", { roleId, criteria, note });
		},
		async saveShortlist(entries) {
			await api.call("agent.shortlist", { roleId, entries: entries as unknown as Record<string, unknown>[] });
		},
		async getDecisionLog(filter) {
			const rows = await api.call("agent.decisionLog", {
				roleId,
				candidateName: filter.candidateName ?? null,
				deliverableId: filter.deliverableId ?? null,
				limit: filter.limit ?? 50,
			});
			return rows as unknown as DecisionRecord[];
		},
		async listSourcingReviews() {
			return (await api.call("agent.sourcingReviews", { roleId })) as never;
		},
		async log(entry) {
			await api.call("agent.log", {
				roleId,
				kind: entry.kind,
				message: entry.message,
				data: (entry.data as Record<string, unknown> | undefined) ?? null,
			});
		},
		...(opts.onEvent ? { onEvent: opts.onEvent } : {}),

		async settleConfirmed() {
			// The agent settles confirmed candidates itself, always. A platform confirmation attestor
			// (create_task.confirmation_attestor) is only a backstop for when the agent is offline.
			const all = await api.call("agent.deliverables", { roleId });
			const done: string[] = [];
			for (const d of all.filter((x) => x.stage === "candidate_confirmed")) {
				remember(d);
				const signature = await acceptOnChain(d, "The candidate confirmed interest.");
				done.push(`Paid the sourcer for ${d.id} (candidate confirmed): ${signature}`);
			}
			return done;
		},
	};
	return ports;
}
