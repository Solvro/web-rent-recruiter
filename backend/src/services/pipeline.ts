/**
 * The agent's pipeline summary for a role, kept consistent with the role's state.
 *
 * The summary is stored together with a key of the state it was written for (counters, budget, review count).
 * Readers only get it while that key still matches, so the UI never shows "1 awaiting review" after a reject
 * or an old budget after a top-up. Recompute (an LLM call, several seconds) runs in the background whenever
 * the state changes and announces itself with a `role.updated` event.
 */
import { and, eq } from "drizzle-orm";
import { pipelineSummary } from "../agent/index.ts";
import { db, schema } from "../db/index.ts";
import { publish } from "../events.ts";

type RoleRow = typeof schema.roles.$inferSelect;

async function stateOf(role: RoleRow) {
	const subs = await db
		.select({ status: schema.submissions.status, review: schema.agentReviews.review })
		.from(schema.submissions)
		.leftJoin(schema.agentReviews, eq(schema.agentReviews.submissionId, schema.submissions.id))
		.where(and(eq(schema.submissions.roleId, role.id), eq(schema.submissions.confirmed, true)));
	const rejectedCount = subs.filter((s) => s.status === "REJECTED").length;
	const reviews = subs.flatMap((s) => (s.review ? [s.review] : []));
	const key = [
		role.status,
		role.acceptedCount,
		role.pendingCount,
		rejectedCount,
		role.deposited,
		role.paid,
		role.remaining,
		reviews.length,
	].join(":");
	return { key, rejectedCount, reviews };
}

/** The stored summary if it matches the role's current state, else null (and a recompute is scheduled). */
export async function currentPipelineSummary(role: RoleRow): Promise<string | null> {
	if (role.status === "DRAFT") return null;
	const { key } = await stateOf(role);
	if (role.pipelineSummaryKey === key && role.pipelineSummary) return role.pipelineSummary;
	schedulePipelineSummary(role.id);
	return null;
}

const running = new Map<string, Promise<void>>();
const rerun = new Set<string>();

/** Coalesces bursts: at most one run per role in flight, plus one follow-up if state changed meanwhile. */
export function schedulePipelineSummary(roleId: string) {
	if (running.has(roleId)) {
		rerun.add(roleId);
		return;
	}
	const p = recompute(roleId)
		.catch((err) => console.warn(`[pipeline] ${roleId}: ${(err as Error).message}`))
		.finally(() => {
			running.delete(roleId);
			if (rerun.delete(roleId)) schedulePipelineSummary(roleId);
		});
	running.set(roleId, p);
}

async function recompute(roleId: string) {
	const [role] = await db.select().from(schema.roles).where(eq(schema.roles.id, roleId));
	if (!role || role.status === "DRAFT") return;
	const { key, rejectedCount, reviews } = await stateOf(role);
	if (role.pipelineSummaryKey === key && role.pipelineSummary) return;
	const summary = await pipelineSummary({
		title: role.title,
		bounty: role.bounty,
		deposited: role.deposited,
		paid: role.paid,
		remaining: role.remaining,
		maxCandidates: role.maxCandidates,
		acceptedCount: role.acceptedCount,
		pendingCount: role.pendingCount,
		rejectedCount,
		recentReviews: reviews.slice(-5),
	});
	// Only store if the state didn't move while the LLM was thinking; otherwise the follow-up run handles it.
	const [now] = await db.select().from(schema.roles).where(eq(schema.roles.id, roleId));
	if (!now || (await stateOf(now)).key !== key) {
		rerun.add(roleId);
		return;
	}
	await db
		.update(schema.roles)
		.set({ pipelineSummary: summary, pipelineSummaryKey: key })
		.where(eq(schema.roles.id, roleId));
	publish({ type: "role.updated", roleId });
}
