/**
 * Changes the agent proposes from chat: nothing runs until the company clicks Yes in its inbox (cockpit
 * waitingOn → roles.decideProposal). The agent's own action functions run then, with the same ports.
 */
import type { Address } from "@solana/kit";
import { and, eq } from "drizzle-orm";
import { applyProposal } from "../agent/index.ts";
import { createBackendPorts } from "../agent-runner/backend-ports.ts";
import { db, schema } from "../db/index.ts";
import { publish } from "../events.ts";
import { HttpError, notFound } from "../http.ts";
import { logActivity, requireRoleOwner } from "./gigs.ts";

type Kind = (typeof schema.agentProposals.$inferSelect)["kind"];

export async function proposeChange(
	roleId: string,
	p: { kind: Kind; summary: string; input: Record<string, unknown> },
) {
	// One open proposal per kind: a newer one replaces the older.
	await db
		.update(schema.agentProposals)
		.set({ status: "DECLINED", result: "Replaced by a newer proposal", decidedAt: new Date() })
		.where(
			and(
				eq(schema.agentProposals.roleId, roleId),
				eq(schema.agentProposals.kind, p.kind),
				eq(schema.agentProposals.status, "PENDING"),
			),
		);
	const [row] = await db
		.insert(schema.agentProposals)
		.values({ roleId, kind: p.kind, summary: p.summary, input: p.input })
		.returning();
	publish({ type: "role.status", roleId });
	return { proposalId: row.id };
}

export async function pendingProposals(roleId: string) {
	return db
		.select()
		.from(schema.agentProposals)
		.where(and(eq(schema.agentProposals.roleId, roleId), eq(schema.agentProposals.status, "PENDING")));
}

/** The company's Yes / No. Yes runs the change now (it may spend from the budget, within the agent's caps). */
export async function decideProposal(
	wallet: Address,
	input: { roleId: string; proposalId: string; approve: boolean },
) {
	await requireRoleOwner(wallet, input.roleId);
	const [p] = await db
		.select()
		.from(schema.agentProposals)
		.where(eq(schema.agentProposals.id, input.proposalId));
	if (!p || p.roleId !== input.roleId) throw notFound("proposal");
	if (p.status !== "PENDING") throw new HttpError(409, "ALREADY_DECIDED", "This was already answered.");
	if (!input.approve) {
		await db
			.update(schema.agentProposals)
			.set({ status: "DECLINED", decidedAt: new Date() })
			.where(eq(schema.agentProposals.id, p.id));
		await logActivity(input.roleId, "DECISION", `You said no: ${p.summary.replace(/\?$/, "")}`);
		publish({ type: "role.status", roleId: input.roleId });
		return { ok: true, message: "Nothing changed." };
	}
	const ports = createBackendPorts(input.roleId);
	let message: string;
	try {
		const r = await applyProposal(ports, { kind: p.kind, input: p.input });
		if (!r.ok) throw new Error("error" in r ? String(r.error) : "failed");
		message = ("message" in r && r.message) || "Done.";
	} catch (err) {
		await db
			.update(schema.agentProposals)
			.set({ status: "FAILED", result: (err as Error).message, decidedAt: new Date() })
			.where(eq(schema.agentProposals.id, p.id));
		publish({ type: "role.status", roleId: input.roleId });
		throw new HttpError(409, "PROPOSAL_FAILED", `That didn't work: ${(err as Error).message}`);
	}
	await db
		.update(schema.agentProposals)
		.set({ status: "APPROVED", result: message, decidedAt: new Date() })
		.where(eq(schema.agentProposals.id, p.id));
	await logActivity(input.roleId, "DECISION", `You said yes: ${p.summary.replace(/\?$/, "")}`);
	publish({ type: "role.status", roleId: input.roleId });
	return { ok: true, message };
}
