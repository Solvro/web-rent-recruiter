/**
 * Drives each agent-run role (docs/agent-gigs.md). The decisions are Stream C's role agent
 * (src/agent/runner: createRoleAgent → runStep / chat / advanceRole); this module only decides WHEN to wake
 * it and wires its ports (backend-ports.ts) and stream to the DB and live events.
 *
 * Durable by construction: all state lives in the DB, so after a restart the periodic tick picks up whatever
 * is due (unreviewed deliverables, an unplanned funded role, …). One job per role at a time.
 *
 * Also a keeper for permissionless protocol steps: settle deliverables nobody reviewed in time (silence =
 * acceptance) and release held-back payouts after their window.
 */
import type { ModelMessage } from "ai";
import { and, asc, eq, gt, inArray, isNotNull, lt, ne, sql } from "drizzle-orm";
import { type AgentEvent, createRoleAgent, type RoleAgentPorts } from "../agent/runner/index.ts";
import { logActivity, setAgentStatus, setCurrentDetail, setCurrentWork } from "../api/gigs.ts";
import { emitStatusIfChanged } from "../api/status.ts";
import { release, settle } from "../api/submissions.ts";
import { db, schema } from "../db/index.ts";
import { env } from "../env.ts";
import { type LiveEvent, publish, subscribe } from "../events.ts";
import { agentSigner } from "../solana/chain.ts";
import { isHosted } from "../solana/gatekeeper.ts";
import { createBackendPorts } from "./backend-ports.ts";
import { expireConfirmations } from "./confirmations.ts";

type Job =
	| { kind: "step"; reason: string }
	| { kind: "chat"; messageId: string; text: string }
	| { kind: "debug"; resolve: (lines: string[]) => void; reject: (err: unknown) => void };

type Log = { info: (m: string) => void; warn: (m: string) => void };

const queues = new Map<string, { jobs: Job[]; running: boolean }>();
/** Fingerprint of the role state at the last autonomous step: don't wake the LLM when nothing changed. */
const lastSeen = new Map<string, string>();
const lastError = new Map<string, number>();
let log: Log = { info: console.log, warn: console.warn };

/** "agent" = C's LLM tool loop (falls back to deterministic without a model); "deterministic" = advanceRole. */
/** DEMO_FAST=1 → deterministic steps (< 5 s): policy + Jev scoring; the LLM only answers chat. */
const stepMode = () =>
	process.env.AGENT_STEP_MODE === "deterministic" || process.env.DEMO_FAST === "1"
		? "deterministic"
		: "agent";

function enqueue(roleId: string, job: Job) {
	let q = queues.get(roleId);
	if (!q) {
		q = { jobs: [], running: false };
		queues.set(roleId, q);
	}
	// Coalesce autonomous steps: one queued step is enough.
	if (job.kind === "step" && q.jobs.some((j) => j.kind === "step")) return;
	q.jobs.push(job);
	void drain(roleId);
}

async function drain(roleId: string) {
	const q = queues.get(roleId);
	if (!q || q.running) return;
	q.running = true;
	try {
		for (let job = q.jobs.shift(); job; job = q.jobs.shift()) {
			try {
				await runJob(roleId, job);
			} catch (err) {
				if (job.kind === "debug") job.reject(err);
				await reportError(roleId, err);
			}
		}
	} finally {
		q.running = false;
	}
}

async function reportError(roleId: string, err: unknown) {
	const message = (err as Error)?.message ?? String(err);
	log.warn(`[agent-runner] ${roleId}: ${message}`);
	// At most one timeline error per role per minute.
	if (Date.now() - (lastError.get(roleId) ?? 0) < 60_000) return;
	lastError.set(roleId, Date.now());
	await logActivity(
		roleId,
		"ERROR",
		`Your agent hit a problem and will retry: ${message.slice(0, 200)}`,
	).catch(() => {});
}

// ---- Jobs -------------------------------------------------------------------------------

const TOOL_WORDS: Record<string, string> = {
	getStatus: "Checking the pipeline",
	reviewDeliverable: "Reviewing a delivery",
	decide: "Paying a recruiter",
	bookScreening: "Booking a screening call",
	bookReference: "Booking a reference check",
	buildShortlist: "Building your shortlist",
	postInitialGigs: "Posting gigs",
	postExtraSourcing: "Posting more sourcing",
	adjustCriteria: "Updating the criteria",
	setGigsPaused: "Pausing gigs",
	explainDecision: "Looking up a decision",
};
const workingOn = (roleId: string, toolName?: string) =>
	setCurrentWork(roleId, toolName ? (TOOL_WORDS[toolName] ?? "Working") : "Thinking");

/**
 * Wraps the ports so every call the agent makes becomes a short "thinking" line in the cockpit
 * (roles.status.now.detail): "Scoring Karolina against 6 must-haves", "Posting the screening call"…
 */
function narrated(roleId: string, ports: RoleAgentPorts): RoleAgentPorts {
	const say = (text: string) => {
		setCurrentDetail(roleId, text);
		statusSoon(roleId);
	};
	const first = (n?: string | null) => (n ?? "the candidate").split(" ")[0];
	let mustHaves = 0;
	return {
		...ports,
		async getRole() {
			say("Checking the pipeline and the budget");
			const r = await ports.getRole();
			mustHaves = r.criteria.mustHave.length;
			return r;
		},
		async listPendingDeliverables() {
			say("Looking for new deliveries");
			return ports.listPendingDeliverables();
		},
		async getDeliverable(id) {
			const d = await ports.getDeliverable(id);
			if (d)
				say(
					d.kind === "sourcing"
						? `Scoring ${first((d as { candidate?: { name?: string } }).candidate?.name)} against ${mustHaves || "the"} must-haves`
						: `Reading ${d.recruiter.displayName}'s ${d.kind} notes`,
				);
			return d;
		},
		async acceptDeliverable(id, reason) {
			say("Signing the decision on-chain");
			return ports.acceptDeliverable(id, reason);
		},
		async rejectDeliverable(id, reason) {
			say("Signing the decision on-chain");
			return ports.rejectDeliverable(id, reason);
		},
		async postGig(gig) {
			say(`Posting "${gig.title}"`);
			return ports.postGig(gig);
		},
		async saveShortlist(entries) {
			say("Building your shortlist");
			return ports.saveShortlist(entries);
		},
	};
}

async function runJob(roleId: string, job: Job) {
	workingOn(roleId);
	void emitStatusIfChanged(roleId);
	try {
		await runJobInner(roleId, job);
	} finally {
		setCurrentWork(roleId, null);
		void emitStatusIfChanged(roleId);
	}
}

async function runJobInner(roleId: string, job: Job) {
	if (job.kind === "chat") return runChat(roleId, job.messageId, job.text);
	// Autonomous steps can take tens of seconds with a model: show the company what the agent is doing.
	const onStepEvent = (e: AgentEvent) => {
		if (e.type === "tool-result") {
			const out = e.output as { message?: string; error?: string } | undefined;
			publish({
				type: "agent.tool",
				roleId,
				tool: { name: e.toolName, summary: out?.message ?? out?.error ?? e.toolName },
			});
		} else if (e.type === "tool-call") {
			workingOn(roleId, e.toolName);
			publish({
				type: "agent.tool",
				roleId,
				tool: { name: e.toolName, summary: TOOL_WORDS[e.toolName] ?? "working…" },
			});
		}
	};
	const agent = createRoleAgent(narrated(roleId, createBackendPorts(roleId, onStepEvent)));
	if (job.kind === "debug") {
		const lines = await agent.advanceRole();
		job.resolve(lines);
	} else if (stepMode() === "deterministic") {
		await agent.advanceRole();
	} else {
		await agent.runStep();
	}
	lastSeen.set(roleId, await fingerprint(roleId));
	await refreshStatus(roleId);
}

/** A company message: stream the reply and tool calls, persist them so the thread reloads. */
async function runChat(roleId: string, messageId: string, text: string) {
	let streamed = "";
	const toolNames = new Map<string, string>();
	const onEvent = (e: AgentEvent) => {
		switch (e.type) {
			case "text-delta":
				streamed += e.text;
				publish({ type: "agent.message", roleId, delta: e.text });
				return;
			case "tool-call":
				toolNames.set(e.toolCallId, e.toolName);
				workingOn(roleId, e.toolName);
				return;
			case "tool-result": {
				const out = e.output as { ok?: boolean; message?: string; error?: string } | undefined;
				const summary = out?.message ?? out?.error ?? `${e.toolName} done`;
				void persistTool(roleId, e.toolName, summary, messageId);
				return;
			}
			case "tool-error":
				void persistTool(roleId, e.toolName, `failed: ${e.error}`, messageId);
				return;
			case "error":
				log.warn(`[agent-runner] chat ${roleId}: ${e.message}`);
				return;
		}
	};
	const agent = createRoleAgent(narrated(roleId, createBackendPorts(roleId, onEvent)));
	// roles.message only enqueues after checking the caller is the role's company (requireRoleOwner).
	const result = await agent.chat(text, await history(roleId, messageId), { verifiedCompany: true });
	const reply = (result.text || streamed).trim() || "Done.";
	const row = await logActivity(roleId, "AGENT_MESSAGE", reply, {
		data: { replyTo: messageId, mode: result.mode },
	});
	publish({ type: "agent.message", roleId, final: true, message: reply, activityId: row.id });
	lastSeen.delete(roleId); // the chat may have changed things: let the next tick look again
	await refreshStatus(roleId);
}

async function persistTool(roleId: string, name: string, summary: string, messageId: string) {
	const row = await logActivity(roleId, "TOOL", summary, { data: { tool: name, replyTo: messageId } });
	publish({ type: "agent.tool", roleId, tool: { name, summary }, activityId: row.id });
}

/** Prior company ↔ agent turns as plain chat history (tool details stay on the timeline). */
async function history(roleId: string, excludeMessageId: string): Promise<ModelMessage[]> {
	const rows = await db
		.select()
		.from(schema.agentActivity)
		.where(
			and(
				eq(schema.agentActivity.roleId, roleId),
				inArray(schema.agentActivity.kind, ["COMPANY_MESSAGE", "AGENT_MESSAGE"]),
			),
		)
		.orderBy(asc(schema.agentActivity.createdAt));
	return rows
		.filter((r) => r.id !== excludeMessageId)
		.slice(-20)
		.map((r) =>
			r.kind === "COMPANY_MESSAGE"
				? { role: "user" as const, content: r.message }
				: { role: "assistant" as const, content: r.message },
		);
}

// ---- When to wake the agent ---------------------------------------------------------------

/** Changes when there's something new for the agent to look at. */
async function fingerprint(roleId: string) {
	const gigs = await db
		.select({ id: schema.gigs.id, status: schema.gigs.status, accepted: schema.gigs.acceptedCount })
		.from(schema.gigs)
		.where(eq(schema.gigs.roleId, roleId));
	const subs = await db
		.select({
			id: schema.submissions.id,
			status: schema.submissions.status,
			reviewed: schema.submissions.agentReview,
			updatedAt: schema.submissions.updatedAt,
		})
		.from(schema.submissions)
		.where(and(eq(schema.submissions.roleId, roleId), eq(schema.submissions.confirmed, true)));
	const [role] = await db
		.select({
			status: schema.roles.status,
			paused: schema.roles.agentPaused,
			criteria: schema.roles.criteria,
			remaining: schema.roles.remaining,
		})
		.from(schema.roles)
		.where(eq(schema.roles.id, roleId));
	return JSON.stringify([
		role?.status,
		role?.paused,
		role?.remaining.toString(),
		gigs.map((g) => `${g.id}:${g.status}:${g.accepted}`).sort(),
		subs.map((s) => `${s.id}:${s.status}:${s.reviewed ? 1 : 0}:${s.updatedAt?.getTime() ?? 0}`).sort(),
		JSON.stringify(role?.criteria ?? null).length,
	]);
}

/** Roles our hosted agent runs: role.agent is our key (a company's own agent or manual review is skipped). */
async function agentRoles() {
	const ours = await agentSigner().catch(() => null);
	if (!ours) return [];
	return (
		db
			.select({ id: schema.roles.id, paused: schema.roles.agentPaused })
			.from(schema.roles)
			// remaining > 0: don't wake the agent before the vault balance is synced (it would plan with $0).
			.where(
				and(
					eq(schema.roles.agentManaged, true),
					eq(schema.roles.agentPubkey, ours.address),
					eq(schema.roles.status, "OPEN"),
					gt(schema.roles.remaining, 0n),
				),
			)
	);
}

async function tick() {
	for (const role of await agentRoles()) {
		// Time alone can make a stage "slow" (cockpit expectedBy): recompute it each tick (coalesced, cheap).
		statusSoon(role.id);
		if (role.paused) continue;
		const fp = await fingerprint(role.id);
		if (fp !== lastSeen.get(role.id)) enqueue(role.id, { kind: "step", reason: "state changed" });
	}
	await keeper();
}

/** Permissionless protocol steps nobody else will take in a demo: settle late reviews, release holdbacks. */
async function keeper() {
	const now = new Date();
	await expireConfirmations().catch((err) => log.warn(`[keeper] confirmations: ${(err as Error).message}`));
	const due = await db
		.select({ id: schema.submissions.id })
		.from(schema.submissions)
		.innerJoin(schema.roles, eq(schema.roles.id, schema.submissions.roleId))
		.where(
			and(
				eq(schema.roles.agentManaged, true),
				eq(schema.submissions.confirmed, true),
				eq(schema.submissions.status, "PENDING"),
				isNotNull(schema.submissions.gigId),
				// Sourcing and unrecorded calls never settle by silence: the candidate-confirmation timer rejects them
				// first (and the backstop below pays them once confirmed).
				ne(schema.submissions.deliverableType, "SOURCING"),
				sql`coalesce(${schema.submissions.payload}->>'evidence', '') <> 'self-reported'`,
				lt(schema.submissions.reviewDeadline, now),
			),
		)
		.limit(5);
	for (const s of due)
		await settle(s.id).catch((err) => log.warn(`[keeper] settle ${s.id}: ${(err as Error).message}`));
	// Backstop for self-hosted agents: a candidate confirmed but their agent didn't pay by the deadline → we settle
	// as the task's confirmation_attestor (settle() checks the Task names our key).
	const confirmedDue = await db
		.select({ id: schema.submissions.id })
		.from(schema.submissions)
		.innerJoin(
			schema.candidateConfirmations,
			eq(schema.candidateConfirmations.submissionId, schema.submissions.id),
		)
		.where(
			and(
				eq(schema.submissions.confirmed, true),
				eq(schema.submissions.status, "PENDING"),
				eq(schema.candidateConfirmations.status, "YES"),
				lt(schema.submissions.reviewDeadline, now),
			),
		)
		.limit(5);
	for (const s of confirmedDue)
		await settle(s.id).catch((err) => {
			// The DB deadline is set when the delivery is built, a few seconds before the chain's: just retry.
			if (!/ReviewWindowOpen/.test((err as Error).message))
				log.warn(`[keeper] settle confirmed ${s.id}: ${(err as Error).message}`);
		});
	const held = await db
		.select({ id: schema.submissions.id })
		.from(schema.submissions)
		.innerJoin(schema.roles, eq(schema.roles.id, schema.submissions.roleId))
		.where(
			and(
				eq(schema.roles.agentManaged, true),
				eq(schema.submissions.laterStatus, "HELD"),
				eq(schema.submissions.outcome, "NONE"),
				lt(schema.submissions.holdbackDeadline, now),
			),
		)
		.limit(5);
	for (const s of held)
		await release(s.id).catch((err) => log.warn(`[keeper] release ${s.id}: ${(err as Error).message}`));
}

/** Timeline row when a recruiter delivers (once per deliverable). */
async function noteDelivery(e: LiveEvent) {
	if (!e.submissionId || !e.roleId) return;
	const [row] = await db
		.select({ sub: schema.submissions, gig: schema.gigs, scout: schema.accounts })
		.from(schema.submissions)
		.innerJoin(schema.gigs, eq(schema.gigs.id, schema.submissions.gigId))
		.leftJoin(schema.accounts, eq(schema.accounts.wallet, schema.submissions.scoutWallet))
		.where(eq(schema.submissions.id, e.submissionId));
	// Show-up fees are logged when offered; their delivery isn't recruiting work.
	if (!row || row.gig.purpose) return;
	const [seen] = await db
		.select({ id: schema.agentActivity.id })
		.from(schema.agentActivity)
		.where(
			and(
				eq(schema.agentActivity.deliverableId, row.sub.id),
				eq(schema.agentActivity.kind, "DELIVERY_RECEIVED"),
			),
		);
	if (seen) return;
	const who = row.scout?.displayName ?? "A recruiter";
	const what =
		row.gig.type === "SOURCING"
			? `${who} sourced ${row.sub.candidateName}`
			: `${who} sent the ${row.gig.type === "SCREENING_CALL" ? "screening" : "reference"} notes for ${row.sub.candidateName}`;
	await logActivity(e.roleId, "DELIVERY_RECEIVED", what, {
		gigId: row.gig.id,
		deliverableId: row.sub.id,
		signature: row.sub.submitTx,
	});
}

// ---- Status line ----------------------------------------------------------------------------

async function refreshStatus(roleId: string) {
	const [role] = await db.select().from(schema.roles).where(eq(schema.roles.id, roleId));
	if (!role) return;
	const gigs = await db.select().from(schema.gigs).where(eq(schema.gigs.roleId, roleId));
	const pending = await db
		.select({ id: schema.submissions.id })
		.from(schema.submissions)
		.where(
			and(
				eq(schema.submissions.roleId, roleId),
				eq(schema.submissions.confirmed, true),
				eq(schema.submissions.status, "PENDING"),
			),
		);
	const shortlist = await db.select().from(schema.shortlist).where(eq(schema.shortlist.roleId, roleId));
	const openOf = (t: string) =>
		gigs.filter((g) => g.type === t && g.status === "OPEN" && g.acceptedCount < g.maxDeliverables);
	const sourcing = gigs.filter((g) => g.type === "SOURCING");
	const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
	let line: string;
	if (role.status === "DRAFT") line = "Waiting for the budget to land";
	else if (role.agentPaused) line = "Your agent is paused";
	else if (shortlist.some((s) => s.decision === "INVITED"))
		line = `Interviews: ${plural(shortlist.filter((s) => s.decision === "INVITED").length, "candidate")} invited`;
	else if (shortlist.some((s) => s.decision === "ATTENDED"))
		line = `${plural(shortlist.filter((s) => s.decision === "ATTENDED").length, "candidate")} interviewed`;
	else if (shortlist.some((s) => s.decision === "NONE"))
		line = `Shortlist ready: ${plural(shortlist.filter((s) => s.decision === "NONE").length, "candidate")} for you`;
	else if (openOf("REFERENCE_CHECK").length) line = "Your agent is checking references";
	else if (openOf("SCREENING_CALL").length)
		line = `Your agent is screening ${plural(openOf("SCREENING_CALL").length, "candidate")}`;
	else if (pending.length) line = `Your agent is checking ${plural(pending.length, "delivery")}`;
	else if (sourcing.length)
		line = `Your agent is sourcing: ${plural(
			sourcing.reduce((n, g) => n + g.acceptedCount, 0),
			"profile",
		)} accepted so far`;
	else line = "Your agent is planning the search";
	if (line !== role.agentStatus) {
		await setAgentStatus(roleId, line);
		publish({ type: "role.updated", roleId, message: line });
	}
}

// ---- Public API ------------------------------------------------------------------------------

/** Company → agent. Persisted first (so the thread shows it), then answered in order. */
export async function messageAgent(roleId: string, text: string) {
	const row = await logActivity(roleId, "COMPANY_MESSAGE", text);
	const [role] = await db.select().from(schema.roles).where(eq(schema.roles.id, roleId));
	// Only our hosted agent answers here; a company's own agent reads the thread from agent.decisionLog.
	if (role && (await isHosted(role))) enqueue(roleId, { kind: "chat", messageId: row.id, text });
	return { messageId: row.id };
}

/** Hidden debug action: run one deterministic agent pass now and wait for it. */
export function stepNow(roleId: string): Promise<string[]> {
	return new Promise((resolve, reject) => enqueue(roleId, { kind: "debug", resolve, reject }));
}

export function startAgentRunner(logger: Log) {
	log = logger;
	const unsubscribe = subscribe((e) => {
		if (!e.roleId) return;
		if (e.type === "submission.created") void noteDelivery(e).catch(() => {});
		if (e.type === "role.status" || e.type === "agent.message") return;
		statusSoon(e.roleId);
		if (e.type === "agent.tool" || e.type === "agent.activity") return;
		// Anything happened on an agent role: look at it on the next tick (cheap, coalesced).
		void tickSoon();
	});
	let timer: NodeJS.Timeout | null = setInterval(() => void tickSafe(), env.agentTickMs);
	void tickSafe();
	log.info(`[agent-runner] started (tick ${env.agentTickMs} ms, mode ${stepMode()})`);
	return () => {
		unsubscribe();
		if (timer) clearInterval(timer);
		timer = null;
	};
}

const statusTimers = new Map<string, NodeJS.Timeout>();
/** Coalesce bursts of events into one cockpit recompute per role. */
function statusSoon(roleId: string) {
	if (statusTimers.has(roleId)) return;
	statusTimers.set(
		roleId,
		setTimeout(() => {
			statusTimers.delete(roleId);
			void emitStatusIfChanged(roleId);
		}, 300),
	);
}

let tickScheduled = false;
async function tickSoon() {
	if (tickScheduled) return;
	tickScheduled = true;
	setTimeout(() => {
		tickScheduled = false;
		void tickSafe();
	}, 500);
}

let ticking = false;
async function tickSafe() {
	if (ticking) return;
	ticking = true;
	try {
		await tick();
	} catch (err) {
		log.warn(`[agent-runner] tick: ${(err as Error).message}`);
	} finally {
		ticking = false;
	}
}
