/**
 * Company chat never changes anything by itself. A change request ("find more people with Go",
 * "pause screening", "cancel the extra slots", "raise the price") becomes a proposal with its cost
 * in plain words; the company confirms in its inbox and the backend runs `applyProposal`.
 */
import { fromBaseUnits, USDC_UNIT } from "@scout/shared";
import { priceForRole } from "../gigs/market.ts";
import {
	type ActionResult,
	adjustCriteria,
	type CriteriaChange,
	GIG_WORDS,
	postExtraSourcing,
	setGigsPaused,
} from "./actions.ts";
import type { ChangeProposal, GigView, PortTaskType, RoleAgentPorts } from "./ports.ts";

const usd = (base: bigint) => `$${fromBaseUnits(base).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const fail = (error: string): ActionResult => ({ ok: false, error });

const gigName = (g: Pick<GigView, "taskType" | "variant" | "title">) =>
	g.variant === "language" ? "the language check" : `“${g.title}”`;

/** Sends the proposal to the company's inbox, or (no port) only describes it. */
export async function propose(ports: RoleAgentPorts, proposal: ChangeProposal): Promise<ActionResult> {
	if (!ports.proposeChange) {
		return {
			ok: true,
			message: `Not changed. If you want it, this is what I'd do: ${proposal.summary}`,
			data: { proposed: false },
		};
	}
	const { proposalId } = await ports.proposeChange(proposal);
	return {
		ok: true,
		message: `I've put it in the card above the message box: Yes or No. ${proposal.summary}`,
		data: { proposed: true, proposalId },
	};
}

export async function proposeExtraSourcing(
	ports: RoleAgentPorts,
	input: { count: number; focus?: string },
): Promise<ActionResult> {
	const role = await ports.getRole();
	const bounty = BigInt(priceForRole(role.criteria, "SOURCING").usd) * BigInt(USDC_UNIT);
	const count = Math.min(input.count, Number(role.budget.available / bounty), 30);
	if (count < 1)
		return fail(
			`There isn't budget for more profiles: ${usd(role.budget.available)} left, ${usd(bounty)} each.`,
		);
	const focus = input.focus?.trim();
	return propose(ports, {
		kind: "extra_sourcing",
		summary: `Open ${count} more profile slots${focus ? ` focused on ${focus}` : ""} at ${usd(bounty)} each (${usd(
			bounty * BigInt(count),
		)} from the reserve)?`,
		input: { count, ...(focus ? { focus } : {}) },
	});
}

export async function proposeCriteriaChange(
	ports: RoleAgentPorts,
	change: CriteriaChange,
): Promise<ActionResult> {
	const role = await ports.getRole();
	const labelOf = (id: string) =>
		[...role.criteria.mustHave, ...role.criteria.niceToHave, ...role.criteria.dealBreakers].find(
			(c) => c.id === id,
		)?.label ?? id;
	const kindWords = { mustHave: "a must-have", niceToHave: "a nice-to-have", dealBreaker: "a deal breaker" };
	const parts = [
		...(change.add ?? []).map((a) => `add “${a.label}” as ${kindWords[a.kind]}`),
		...(change.remove ?? []).map((id) => `remove “${labelOf(id)}”`),
		...(change.reweight ?? []).map(
			(r) => `make “${labelOf(r.id)}” ${r.weight >= 4 ? "more" : "less"} important`,
		),
	];
	if (!parts.length) return fail("Nothing to change in the criteria.");
	const text = parts.join(", ");
	return propose(ports, {
		kind: "adjust_criteria",
		summary: `${text.charAt(0).toUpperCase()}${text.slice(1)}? New profiles are judged against the new criteria; nothing already decided changes.`,
		input: change as unknown as Record<string, unknown>,
	});
}

export async function proposePause(
	ports: RoleAgentPorts,
	input: { taskTypes?: PortTaskType[]; gigIds?: string[] },
	paused: boolean,
): Promise<ActionResult> {
	const role = await ports.getRole();
	const named = input.gigIds?.length
		? role.gigs.filter((g) => input.gigIds?.includes(g.gigId)).map(gigName)
		: (input.taskTypes ?? []).map((t) => GIG_WORDS[t]);
	const what = named.length ? named.join(" and ") : "all gigs";
	return propose(ports, {
		kind: paused ? "pause_gigs" : "resume_gigs",
		summary: paused
			? `Pause ${what}? Recruiters can't take or deliver them until you resume; nothing is paid meanwhile.`
			: `Resume ${what}? Recruiters can take them again.`,
		input: {
			...(input.taskTypes ? { taskTypes: input.taskTypes } : {}),
			...(input.gigIds ? { gigIds: input.gigIds } : {}),
		},
	});
}

export async function proposeRaisePrice(
	ports: RoleAgentPorts,
	input: { gigId: string; newPriceUsd: number },
): Promise<ActionResult> {
	if (!ports.repriceGig) return fail("Prices can't be changed on this role.");
	const role = await ports.getRole();
	const gig = role.gigs.find((g) => g.gigId === input.gigId && g.status !== "CLOSED");
	if (!gig) return fail("I can't find that open gig.");
	const bounty = BigInt(Math.round(input.newPriceUsd * 100)) * BigInt(USDC_UNIT / 100);
	if (bounty <= gig.bounty) return fail(`Open gigs are never made cheaper; it's ${usd(gig.bounty)} now.`);
	if (role.maxBounty && bounty > role.maxBounty)
		return fail(`${usd(bounty)} is above your limit of ${usd(role.maxBounty)} per delivery.`);
	const slots = BigInt(gig.maxDeliverables - gig.acceptedCount);
	const extra = (bounty - gig.bounty) * slots;
	if (extra > role.budget.available)
		return fail(
			`Raising to ${usd(bounty)} needs ${usd(extra)} more than the ${usd(role.budget.available)} left.`,
		);
	return propose(ports, {
		kind: "raise_price",
		summary: `Raise ${gigName(gig)} from ${usd(gig.bounty)} to ${usd(bounty)}? Up to ${usd(extra)} more is set aside for its ${slots} open slot${slots === 1n ? "" : "s"}.`,
		input: { gigId: gig.gigId, bounty: bounty.toString() },
	});
}

export async function proposeCloseSlots(
	ports: RoleAgentPorts,
	input: { gigId: string },
): Promise<ActionResult> {
	const role = await ports.getRole();
	const gig = role.gigs.find((g) => g.gigId === input.gigId);
	if (!gig) return fail("I can't find that gig.");
	if (gig.status === "CLOSED") return fail(`${gigName(gig)} is already closed.`);
	const open = gig.maxDeliverables - gig.acceptedCount - gig.pendingCount;
	if (open <= 0) return fail(`${gigName(gig)} has no open slots left to close.`);
	const paid = gig.acceptedCount
		? ` The ${gig.acceptedCount} profile${gig.acceptedCount === 1 ? "" : "s"} already accepted stay paid; that can't be undone.`
		: "";
	const waiting = gig.pendingCount ? ` ${gig.pendingCount} waiting for review are still reviewed.` : "";
	return propose(ports, {
		kind: "close_slots",
		summary: `Close the ${open} open slot${open === 1 ? "" : "s"} of ${gigName(gig)} and return ${usd(
			gig.bounty * BigInt(open),
		)} to your budget?${paid}${waiting}`,
		input: { gigId: gig.gigId },
	});
}

/** Closes a gig's unused slots (close_task); accepted work stays paid. */
export async function closeOpenSlots(ports: RoleAgentPorts, input: { gigId: string }): Promise<ActionResult> {
	if (!ports.closeGig) return fail("Closing gigs isn't available on this role.");
	const role = await ports.getRole();
	const gig = role.gigs.find((g) => g.gigId === input.gigId);
	if (!gig || gig.status === "CLOSED") return fail("That gig is already closed.");
	const open = gig.maxDeliverables - gig.acceptedCount - gig.pendingCount;
	await ports.closeGig(gig.gigId, "Closed at the company's request.");
	const message = `Closed ${gigName(gig)}; ${usd(gig.bounty * BigInt(Math.max(0, open)))} is back in the budget.`;
	await ports.log({ kind: "note", message, data: { gigId: gig.gigId } });
	return { ok: true, message };
}

/** Runs a confirmed proposal (the company clicked Yes). */
export async function applyProposal(ports: RoleAgentPorts, proposal: Omit<ChangeProposal, "summary">) {
	const i = proposal.input;
	switch (proposal.kind) {
		case "extra_sourcing":
			return postExtraSourcing(ports, {
				count: Number(i.count),
				...(i.focus ? { focus: String(i.focus) } : {}),
			});
		case "adjust_criteria":
			return adjustCriteria(ports, i as unknown as CriteriaChange);
		case "pause_gigs":
		case "resume_gigs":
			return setGigsPaused(
				ports,
				{
					...(i.taskTypes ? { taskTypes: i.taskTypes as PortTaskType[] } : {}),
					...(i.gigIds ? { gigIds: i.gigIds as string[] } : {}),
				},
				proposal.kind === "pause_gigs",
			);
		case "raise_price": {
			if (!ports.repriceGig) return fail("Prices can't be changed on this role.");
			const bounty = BigInt(String(i.bounty));
			const message = `Raised the price to ${usd(bounty)} at the company's request.`;
			await ports.repriceGig(String(i.gigId), bounty, message);
			await ports.log({ kind: "repriced", message, data: { gigId: i.gigId } });
			return { ok: true, message } satisfies ActionResult;
		}
		case "close_slots":
			return closeOpenSlots(ports, { gigId: String(i.gigId) });
	}
}
