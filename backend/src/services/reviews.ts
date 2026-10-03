import type { AgentReview } from "@scout/shared";
import { eq } from "drizzle-orm";
import { reviewSubmission } from "../agent/index.ts";
import { db, schema } from "../db/index.ts";
import { publish } from "../events.ts";
import { schedulePipelineSummary } from "./pipeline.ts";

const inFlight = new Map<string, Promise<AgentReview>>();

/** Idempotent: returns the stored review, or runs the agent once (concurrent callers share the same run). */
export function ensureReview(submissionId: string): Promise<AgentReview> {
	const running = inFlight.get(submissionId);
	if (running) return running;
	const p = run(submissionId).finally(() => inFlight.delete(submissionId));
	inFlight.set(submissionId, p);
	return p;
}

async function run(submissionId: string): Promise<AgentReview> {
	const [existing] = await db
		.select()
		.from(schema.agentReviews)
		.where(eq(schema.agentReviews.submissionId, submissionId));
	if (existing) return existing.review;

	const [row] = await db
		.select({ sub: schema.submissions, criteria: schema.roles.criteria })
		.from(schema.submissions)
		.innerJoin(schema.roles, eq(schema.roles.id, schema.submissions.roleId))
		.where(eq(schema.submissions.id, submissionId));
	if (!row) throw new Error(`submission ${submissionId} not found`);

	const review = await reviewSubmission(row.criteria, {
		name: row.sub.candidateName,
		profileUrl: row.sub.profileUrl,
		notes: row.sub.notes,
	});
	await db.insert(schema.agentReviews).values({ submissionId, review }).onConflictDoNothing();
	publish({ type: "submission.reviewed", roleId: row.sub.roleId, submissionId });
	schedulePipelineSummary(row.sub.roleId);
	// TODO(autoAccept): if role.autoAccept.enabled && review.score >= threshold, have the delegated agent key sign
	// accept_submission. The program already caps spend at bounty_per_candidate and the vault balance.
	return review;
}

/** Fire-and-forget variant used by the indexer. */
export function reviewInBackground(submissionId: string) {
	(async () => {
		const [row] = await db
			.select({ gigId: schema.submissions.gigId })
			.from(schema.submissions)
			.where(eq(schema.submissions.id, submissionId));
		// Gig deliverables are reviewed by the role's agent (agent-runner), not here.
		if (!row || row.gigId) return;
		await ensureReview(submissionId);
	})().catch((err) => console.error(`[review] ${submissionId}:`, err));
}
