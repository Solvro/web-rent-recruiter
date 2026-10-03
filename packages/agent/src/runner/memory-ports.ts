/**
 * In-memory RoleAgentPorts for the CLI demo and tests, and a reference for Stream B's real
 * implementation. Money follows the on-chain rules: posting a gig reserves bounty × slots,
 * accepting pays a reserved slot, closing a gig releases what's left.
 */
import type { Criteria } from "@scout/shared";
import type {
	CallAnswer,
	CallScript,
	CefrLevel,
	PlannedGig,
	RecordingMeta,
	RecruiterRecommendation,
	ShortlistEntry,
} from "../gigs/types.ts";
import type {
	ActivityKind,
	AgentEvent,
	CandidateView,
	ChangeProposal,
	DecisionRecord,
	Deliverable,
	GigView,
	PortTaskType,
	RoleAgentPorts,
	RoleSnapshot,
	StoredReview,
} from "./ports.ts";

interface MemGig extends GigView {
	brief: string;
	script?: CallScript;
}

export interface MemoryState {
	roleId: string;
	title: string;
	criteria: Criteria;
	deposited: bigint;
	paid: bigint;
	paused: boolean;
	pausedTaskTypes: PortTaskType[];
	gigs: MemGig[];
	candidates: CandidateView[];
	deliverables: (Deliverable & { status: "PENDING" | "ACCEPTED" | "REJECTED" })[];
	reviews: Map<string, StoredReview>;
	decisions: DecisionRecord[];
	activity: { at: string; kind: ActivityKind; message: string }[];
	escalations: { deliverableId?: string; candidateId?: string; question: string }[];
	shortlist: ShortlistEntry[];
	proposals: (ChangeProposal & { proposalId: string })[];
	txCount: number;
}

export function createMemoryPorts(init: {
	title: string;
	criteria: Criteria;
	deposited: bigint;
	onEvent?: (event: AgentEvent) => void;
	onLog?: (entry: { kind: ActivityKind; message: string }) => void;
}) {
	const state: MemoryState = {
		roleId: "role-1",
		title: init.title,
		criteria: init.criteria,
		deposited: init.deposited,
		paid: 0n,
		paused: false,
		pausedTaskTypes: [],
		gigs: [],
		candidates: [],
		deliverables: [],
		reviews: new Map(),
		decisions: [],
		activity: [],
		escalations: [],
		shortlist: [],
		proposals: [],
		txCount: 0,
	};
	const now = () => new Date().toISOString();
	const tx = () => `sig${++state.txCount}`;
	const promised = () =>
		state.gigs
			.filter((g) => g.status !== "CLOSED")
			.reduce((sum, g) => sum + g.bounty * BigInt(g.maxDeliverables - g.acceptedCount), 0n);
	const gigOf = (d: Deliverable) => state.gigs.find((g) => g.gigId === d.gigId);
	const deliverable = (id: string) => state.deliverables.find((d) => d.id === id);
	const candidateName = (d: Deliverable) =>
		d.kind === "sourcing" ? d.candidate.name : d.script.candidate.name;
	const record = (r: Omit<DecisionRecord, "at">) => state.decisions.push({ at: now(), ...r });

	function settle(id: string, status: "ACCEPTED" | "REJECTED") {
		const d = deliverable(id);
		if (d?.status !== "PENDING") throw new Error(`Deliverable ${id} is not pending`);
		const gig = gigOf(d);
		if (!gig) throw new Error(`Gig ${d.gigId} not found`);
		d.status = status;
		gig.pendingCount--;
		return { d, gig };
	}

	const ports: RoleAgentPorts = {
		async getRole(): Promise<RoleSnapshot> {
			return {
				roleId: state.roleId,
				title: state.title,
				criteria: state.criteria,
				budget: {
					deposited: state.deposited,
					paid: state.paid,
					available: state.deposited - state.paid - promised(),
				},
				gigs: state.gigs.map(({ brief: _b, script: _s, ...g }) => ({ ...g })),
				candidates: state.candidates.map((c) => ({ ...c })),
				paused: state.paused,
				pausedTaskTypes: [...state.pausedTaskTypes],
			};
		},
		async listPendingDeliverables() {
			return state.deliverables.filter((d) => d.status === "PENDING");
		},
		async getDeliverable(id) {
			return deliverable(id) ?? null;
		},
		async postGig(
			gig: Omit<PlannedGig, "taskType"> & {
				taskType: PortTaskType;
				candidateId?: string;
				script?: CallScript;
			},
		) {
			const available = state.deposited - state.paid - promised();
			const cost = gig.bounty * BigInt(gig.maxDeliverables);
			if (cost > available) throw new Error(`Vault can't cover ${cost} (available ${available})`);
			const gigId = `gig-${state.gigs.length + 1}`;
			state.gigs.push({
				gigId,
				taskType: gig.taskType,
				...(gig.variant ? { variant: gig.variant } : {}),
				title: gig.title,
				brief: gig.brief,
				bounty: gig.bounty,
				maxDeliverables: gig.maxDeliverables,
				acceptedCount: 0,
				pendingCount: 0,
				status: "OPEN",
				candidateId: gig.candidateId,
				script: gig.script,
			});
			const candidate = state.candidates.find((c) => c.id === gig.candidateId);
			if (candidate && gig.taskType === "SCREENING_CALL" && gig.variant !== "language")
				candidate.stage = "screening";
			if (candidate && gig.taskType === "REFERENCE_CHECK") candidate.stage = "reference";
			record({
				action: gig.candidateId ? "booked" : "posted",
				reason: gig.title,
				gigId,
				candidateId: gig.candidateId,
			});
			return { gigId, signature: tx() };
		},
		async setGigStatus(gigIds, status) {
			for (const g of state.gigs) if (gigIds.includes(g.gigId)) g.status = status;
			record({ action: status === "PAUSED" ? "paused" : "resumed", reason: gigIds.join(", ") });
		},
		async setTaskTypePaused(types, paused) {
			state.pausedTaskTypes = paused
				? [...new Set([...state.pausedTaskTypes, ...types])]
				: state.pausedTaskTypes.filter((t) => !types.includes(t));
			record({ action: paused ? "paused" : "resumed", reason: types.join(", ") });
		},
		async proposeChange(proposal) {
			const proposalId = `proposal-${state.proposals.length + 1}`;
			state.proposals.push({ ...proposal, proposalId });
			return { proposalId };
		},
		async closeGig(gigId) {
			const gig = state.gigs.find((g) => g.gigId === gigId);
			if (gig) gig.status = "CLOSED";
			return { signature: tx() };
		},
		async getWaitingOn() {
			return [
				...state.escalations.map((e) => ({ who: "you", what: e.question, since: now() })),
				...state.gigs
					.filter((g) => g.status === "OPEN" && g.acceptedCount < g.maxDeliverables)
					.map((g) => ({ who: "recruiters", what: g.title, since: now() })),
			];
		},
		async listSourcingReviews() {
			return [...state.reviews.values()].flatMap((r) => (r.sourcing ? [r.sourcing] : []));
		},
		async saveReview(review) {
			state.reviews.set(review.deliverableId, review);
		},
		async getReview(id) {
			return state.reviews.get(id) ?? null;
		},
		async acceptDeliverable(id, reason) {
			const { d, gig } = settle(id, "ACCEPTED");
			gig.acceptedCount++;
			state.paid += gig.bounty;
			if (gig.acceptedCount >= gig.maxDeliverables) gig.status = "CLOSED";
			const review = state.reviews.get(id);
			if (d.kind === "sourcing") {
				state.candidates.push({
					id: `cand-${state.candidates.length + 1}`,
					name: d.candidate.name,
					profileUrl: d.candidate.profileUrl,
					notes: d.candidate.notes,
					stage: "sourced",
					sourcing: review?.sourcing,
				});
			} else {
				const c = state.candidates.find((x) => x.id === d.candidateId);
				if (c && d.kind === "screening") Object.assign(c, { screening: review?.call, stage: "screened" });
				if (c && d.kind === "reference") Object.assign(c, { reference: review?.call, stage: "referenced" });
				if (c && d.kind === "language") Object.assign(c, { language: review?.call });
			}
			record({
				action: "accept",
				reason,
				deliverableId: id,
				candidateName: candidateName(d),
				gigId: gig.gigId,
			});
			return { signature: tx() };
		},
		async rejectDeliverable(id, reason) {
			const { d, gig } = settle(id, "REJECTED");
			record({
				action: "reject",
				reason,
				deliverableId: id,
				candidateName: candidateName(d),
				gigId: gig.gigId,
			});
			return { signature: tx() };
		},
		async escalate(input) {
			state.escalations.push(input);
			const d = input.deliverableId ? deliverable(input.deliverableId) : undefined;
			record({
				action: "escalate",
				reason: input.question,
				deliverableId: input.deliverableId,
				candidateId: input.candidateId,
				candidateName: d ? candidateName(d) : undefined,
			});
		},
		async updateCriteria(criteria, note) {
			state.criteria = criteria;
			record({ action: "criteria", reason: note });
		},
		async saveShortlist(entries) {
			state.shortlist = entries;
			record({ action: "shortlisted", reason: entries.map((e) => e.name).join(", ") });
		},
		async getDecisionLog({ candidateName: name, deliverableId, limit = 20 }) {
			const needle = name?.toLowerCase();
			return state.decisions
				.filter((r) => (deliverableId ? r.deliverableId === deliverableId : true))
				.filter((r) => (needle ? r.candidateName?.toLowerCase().includes(needle) : true))
				.slice(-limit);
		},
		async log(entry) {
			state.activity.push({ at: now(), kind: entry.kind, message: entry.message });
			init.onLog?.(entry);
		},
		onEvent: init.onEvent,
	};

	/** Simulates a recruiter delivering on a gig. Returns the deliverable id. */
	function deliver(
		gigId: string,
		input:
			| { candidate: { name: string; profileUrl: string; notes: string } }
			| {
					answers?: CallAnswer[];
					recommendation?: RecruiterRecommendation;
					transcript?: string;
					assessedLevel?: CefrLevel;
					recording?: RecordingMeta;
			  },
		recruiter = { wallet: "Recruiter1111111111111111111111111111111111", displayName: "Ola (recruiter)" },
	): string {
		const gig = state.gigs.find((g) => g.gigId === gigId);
		if (gig?.status !== "OPEN") throw new Error(`Gig ${gigId} is not open`);
		const base = {
			id: `del-${state.deliverables.length + 1}`,
			gigId,
			recruiter,
			submittedAt: now(),
			status: "PENDING" as const,
		};
		if ("candidate" in input) {
			state.deliverables.push({ ...base, kind: "sourcing", candidate: input.candidate });
		} else {
			if (!gig.script || !gig.candidateId) throw new Error(`Gig ${gigId} has no script`);
			state.deliverables.push({
				...base,
				kind:
					gig.taskType === "REFERENCE_CHECK"
						? "reference"
						: gig.variant === "language"
							? "language"
							: "screening",
				candidateId: gig.candidateId,
				script: gig.script,
				answers: input.answers ?? [],
				recommendation: input.recommendation,
				transcript: input.transcript,
				assessedLevel: input.assessedLevel,
				recording: input.recording,
			});
		}
		gig.pendingCount++;
		return base.id;
	}

	return { ports, state, deliver };
}
