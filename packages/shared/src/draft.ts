/**
 * `draft.stream`: the agent reads a job description and streams what it understood, so the company can watch the
 * job post assemble itself. Ends with one `result` carrying the same payload as `roles.draft`.
 */
import { z } from "zod";
import { DraftRoleResponse } from "./api.ts";

export const DraftStreamEvent = z.discriminatedUnion("type", [
	/** What the agent is doing right now, e.g. "Reading requirements…". */
	z.object({ type: z.literal("status"), text: z.string() }),
	/** The draft so far. Any field may be missing or cut mid-word; the last item of a list may be incomplete. */
	z.object({ type: z.literal("partial"), draft: z.record(z.string(), z.unknown()) }),
	/** Final, validated draft plus the suggested price and rationale. */
	z.object({
		type: z.literal("result"),
		response: DraftRoleResponse,
		source: z.enum(["model", "offline"]),
	}),
]);
export type DraftStreamEvent = z.infer<typeof DraftStreamEvent>;
