/**
 * The company's thread, in plain words: one line per decision, sentence case, no raw verdict tokens.
 * "Accepted Karolina's screening (96) and paid Ola $22.68." The agent's own text becomes the line's detail.
 */
import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/index.ts";

const TOKENS: Record<string, string> = {
	ACCEPT: "accept",
	REJECT: "reject",
	ESCALATE: "ask you",
	FOLLOW_UP: "ask the recruiter",
	ADVANCE: "strong",
	MAYBE: "borderline",
	PASS: "not a fit",
};
/** "Scored 59 (MAYBE)" → "Scored 59 (borderline)"; also sentence case. */
export function humanize(text: string): string {
	const t = text.replace(
		/\b(ACCEPT|REJECT|ESCALATE|FOLLOW_UP|ADVANCE|MAYBE|PASS)\b/g,
		(m) => TOKENS[m] ?? m.toLowerCase(),
	);
	return t.charAt(0).toUpperCase() + t.slice(1);
}

const usd = (base: bigint) => `$${(Number(base) / 1e6).toFixed(2).replace(/\.00$/, "")}`;
const first = (name: string | null | undefined) => (name ?? "").split(" ")[0] || "the candidate";
const firstSentence = (s: string) => (s.split(/(?<=[.!?])\s+/)[0] ?? s).replace(/[.!?]$/, "");

/**
 * The decision line for a deliverable, or null to fall back to the agent's text. `skip` drops the row: the review
 * itself (the decision row tells it) and pre-accepts (the confirmation flow writes its own line).
 */
export async function decisionLine(
	kind: string,
	message: string,
	data: Record<string, unknown>,
): Promise<{ skip: true } | { line: string } | null> {
	if (kind === "review") return { skip: true };
	if (kind === "accepted" && data.signature === "") return { skip: true };
	if (kind !== "accepted" && kind !== "rejected" && kind !== "escalated") return null;
	const id = typeof data.deliverableId === "string" ? data.deliverableId : null;
	if (!id) return null;
	const [row] = await db
		.select({ sub: schema.submissions, gig: schema.gigs, scout: schema.accounts })
		.from(schema.submissions)
		.leftJoin(schema.gigs, eq(schema.gigs.id, schema.submissions.gigId))
		.leftJoin(schema.accounts, eq(schema.accounts.wallet, schema.submissions.scoutWallet))
		.where(eq(schema.submissions.id, id));
	if (!row) return null;
	const { sub, gig, scout } = row;
	// A decided sourced candidate gets one line: drop the earlier "X sourced Y".
	if (sub.deliverableType === "SOURCING" && kind !== "escalated")
		await db
			.delete(schema.agentActivity)
			.where(
				and(
					eq(schema.agentActivity.deliverableId, sub.id),
					eq(schema.agentActivity.kind, "DELIVERY_RECEIVED"),
				),
			);
	const r = sub.agentReview as { sourcing?: { score?: number }; call?: { score?: number } } | null;
	const score = r?.sourcing?.score ?? r?.call?.score;
	const s = score !== undefined ? ` (${score})` : "";
	const who = first(scout?.displayName);
	const sourcing = sub.deliverableType === "SOURCING";
	const what = sourcing
		? sub.candidateName
		: `${first(sub.candidateName)}'s ${gig?.type === "REFERENCE_CHECK" ? "reference check" : gig?.variant === "language" ? "language check" : "screening"}`;
	const why = humanize(firstSentence(message.replace(/^[^:]{0,60}:\s*/, "")));
	if (kind === "accepted") {
		const now = sub.payoutNow ?? 0n;
		const later = sub.laterStatus === "HELD" ? (sub.payoutLater ?? 0n) : 0n;
		const paid =
			now > 0n
				? ` and paid ${who} ${usd(now)}${later > 0n ? ` (+${usd(later)} once ${first(sub.candidateName)} attends)` : ""}`
				: "";
		return { line: `Accepted ${what}${s}${paid}.` };
	}
	if (kind === "rejected")
		return {
			line: sourcing
				? `Passed on ${what}${s} from ${who}: ${why}.`
				: `Sent back ${who}'s notes on ${what}${s}: ${why}.`,
		};
	return { line: `Asked you about ${what}${s}: ${why}.` };
}
