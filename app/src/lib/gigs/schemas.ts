/**
 * Gig contract: the shared schemas from Stream B (packages/shared/src/gigs.ts). The agent thread is
 * AgentActivity itself (COMPANY_MESSAGE / AGENT_MESSAGE / TOOL and the step kinds).
 */
export {
	AgentActivity,
	AgentActivity as ThreadActivity,
	Deliverable,
	DeliverableView,
	GigCandidate,
	GigDeliverResponse,
	type GigType,
	GigView,
	RoleDecideResponse,
	RoleMessageResponse,
	ScriptQuestion,
	ShortlistItem,
	ShortlistItem as ShortlistItemView,
} from "@scout/shared";

import { RoleActivity } from "@scout/shared";
import type { z } from "zod";

export const RoleActivityView = RoleActivity;
export type RoleActivityView = z.infer<typeof RoleActivity>;
