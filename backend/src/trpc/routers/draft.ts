/**
 * Watch the agent read a job description. Mounted in appRouter as `draft`. Same result as `roles.draft`, but the
 * understanding streams in field by field so the new-role page can assemble the job post live.
 */
import { DraftRoleRequest, type DraftStreamEvent } from "@scout/shared";
import { streamDraftRole } from "../../agent/draft-stream.ts";
import { suggestBudget } from "../../agent/index.ts";
import { withJdLanguages } from "../../lib/jd-languages.ts";
import { MINUTE, rateLimit } from "../../lib/rate-limit.ts";
import { publicProcedure, router } from "../init.ts";

export const draftRouter = router({
	stream: publicProcedure.input(DraftRoleRequest).subscription(async function* ({ ctx, input, signal }) {
		// Public and one LLM call per subscription: same cap as roles.draft.
		rateLimit(`draft:${ctx.ip}`, 20, 10 * MINUTE, "job descriptions");
		for await (const event of streamDraftRole(input.jobDescription, { signal })) {
			if (event.type !== "draft") {
				yield event satisfies DraftStreamEvent;
				continue;
			}
			yield { type: "status", text: "Pricing the work…" } satisfies DraftStreamEvent;
			const { source } = event;
			// Same as roles.draft: JD languages with a level ("Fluent English (C1)") always reach the criteria.
			const draft = { ...event.draft, criteria: withJdLanguages(input.jobDescription, event.draft.criteria) };
			const budget = await suggestBudget(draft.criteria, { title: draft.title });
			yield {
				type: "result",
				source,
				response: {
					...draft,
					suggestedBounty: budget.bounty.toString(),
					suggestedMaxCandidates: budget.maxCandidates,
					rationale: budget.rationale,
				},
			} satisfies DraftStreamEvent;
		}
	}),
});
