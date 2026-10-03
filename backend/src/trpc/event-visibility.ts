/**
 * The events subscription is shared by companies and recruiters. The agent's timeline, its chat with the
 * company and status lines are the company's business (they name candidates), so only the role's company
 * (wallet from connectionParams) gets them; everyone else gets ids and payout amounts only.
 */
import type { LiveEvent } from "@scout/shared";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.ts";

const COMPANY_ONLY = new Set<LiveEvent["type"]>([
	"agent.activity",
	"agent.message",
	"agent.tool",
	"shortlist.updated",
]);
const companyOf = new Map<string, string | null>();

async function roleCompany(roleId: string) {
	if (!companyOf.has(roleId)) {
		const [r] = await db
			.select({ company: schema.roles.companyWallet })
			.from(schema.roles)
			.where(eq(schema.roles.id, roleId));
		companyOf.set(roleId, r?.company ?? null);
	}
	return companyOf.get(roleId) ?? null;
}

export async function visibleEvent(e: LiveEvent, viewer: string | null): Promise<LiveEvent | null> {
	const isCompany = Boolean(viewer && e.roleId && (await roleCompany(e.roleId)) === viewer);
	if (isCompany) return e;
	if (COMPANY_ONLY.has(e.type)) return null;
	const { message: _m, delta: _d, tool: _t, ...rest } = e;
	return rest;
}
