/**
 * A recruiter's own work (My work list and its detail page): the type label, the one-line status, the links the
 * candidate has to click, and where the money went.
 */
import { type DeliverableView, explorerTxUrl } from "@scout/shared";
import { Loader2 } from "lucide-react";
import { Chip } from "@/components/bits";
import { CopyButton } from "@/components/copy";
import { firstName, formatMoney, personInTitle } from "@/lib/format";
import { GIG_TYPES, type GigKind } from "@/lib/gig-types";
import { kindOfWork, type WorkKind } from "@/lib/gigs/work";
import { inCents } from "@/lib/payout";

export const KIND_OF: Record<WorkKind, GigKind> = {
	sourcing: "SOURCING",
	screening: "SCREENING_CALL",
	language: "LANGUAGE_CHECK",
	reference: "REFERENCE_CHECK",
};

/** Find candidates / Screening call / Language check / Reference check, from the gig's type and variant. */
export const workInfo = (d: DeliverableView) => GIG_TYPES[KIND_OF[kindOfWork(d)]];

/** "Karolina Mazurek": the sourced person, or the person the call was about (from the gig's title). */
export function personOf(d: DeliverableView, fallback?: string | null) {
	if (d.deliverable.type === "SOURCING") return d.deliverable.name;
	return fallback || personInTitle(d.gigTitle);
}

const LATER: Record<string, { label: string; tone: "accent" | "good" | "neutral" }> = {
	HELD: { label: "after the interview", tone: "accent" },
	RELEASED: { label: "paid", tone: "good" },
	REFUNDED: { label: "returned to the company", tone: "neutral" },
};

/** The paid parts, rounded to whole cents so they add up. */
export const payoutOf = (d: DeliverableView) =>
	d.payout && { ...d.payout, ...inCents(d.payout.now, d.payout.later) };

/** One line: where this piece of work stands. */
export function WorkStatus({ d, person }: { d: DeliverableView; person: string }) {
	const p = payoutOf(d);
	const later = p && p.laterStatus !== "NONE" ? LATER[p.laterStatus] : null;
	if (d.status === "PENDING" && d.confirmation?.status === "PENDING")
		return <Chip tone="accent">Waiting for {firstName(person)} to confirm</Chip>;
	if (
		d.status === "PENDING" &&
		d.deliverable.type === "SCREENING_CALL" &&
		d.deliverable.evidence === "self-reported" &&
		!d.review
	)
		return <Chip tone="accent">Waiting for {firstName(person)} to confirm the call</Chip>;
	if (d.status === "PENDING")
		return (
			<Chip tone="accent">
				<Loader2 className="size-3.5 animate-spin" /> The agent is checking
			</Chip>
		);
	if (d.status === "REJECTED")
		return (
			<Chip>{d.review?.reasons[0] === "Withdrawn by the recruiter." ? "Withdrawn" : "Not accepted"}</Chip>
		);
	return (
		<span className="flex flex-wrap items-center justify-end gap-2">
			{p && <span className="type-label tabular text-success">+{formatMoney(p.now)}</span>}
			{later && p && (
				<Chip tone={later.tone}>
					<span className="tabular">{formatMoney(p.later)}</span> {later.label}
				</Chip>
			)}
		</span>
	);
}

/**
 * Calls about the recruiter's candidate that weren't recorded: the candidate confirms they happened. The sourcer
 * knows the candidate, so the link comes to them (never to the recruiter who held the call).
 */
export function CallChecks({
	d,
	person,
	align = "end",
}: {
	d: DeliverableView;
	person: string;
	align?: "start" | "end";
}) {
	const list = d.callChecks ?? [];
	if (!list.length) return null;
	const who = firstName(person);
	return (
		<ul className={`flex flex-col gap-1.5 ${align === "end" ? "items-end text-right" : "items-start"}`}>
			{list.map((c) =>
				c.status === "PENDING" && c.url ? (
					<li
						key={c.deliverableId}
						className="flex flex-col gap-1 rounded-2xl bg-accent p-3 text-left text-accent-foreground"
					>
						<span className="type-label">
							Send {who} this link: did the {c.callKind} with {firstName(c.recruiterName)} happen?
						</span>
						<CopyButton text={c.url} className="text-accent-foreground" />
					</li>
				) : (
					<li key={c.deliverableId} className="type-label text-muted-foreground">
						{c.status === "YES"
							? `${who} confirmed the ${c.callKind} with ${firstName(c.recruiterName)}`
							: c.status === "NO"
								? `${who} says the ${c.callKind} didn't happen`
								: `${who} didn't confirm the ${c.callKind} in time`}
					</li>
				),
			)}
		</ul>
	);
}

/** Where the money for this work went: to you now, to you after the interview, your operator, the service fee. */
export function PayoutBreakdown({
	d,
	person,
	operator,
}: {
	d: DeliverableView;
	person: string;
	operator: string | null;
}) {
	const p = payoutOf(d);
	if (!p) return null;
	const rows: { label: string; amount: bigint | string; note?: string }[] = [
		{ label: "Paid to you", amount: p.now },
		...(BigInt(p.later) > 0n
			? [
					{
						label: `After ${firstName(person)}'s interview`,
						amount: p.later,
						note:
							p.laterStatus === "RELEASED"
								? "paid"
								: p.laterStatus === "REFUNDED"
									? "returned to the company"
									: "waiting",
					},
				]
			: []),
		...(BigInt(p.operatorFee) > 0n ? [{ label: operator ?? "Your operator", amount: p.operatorFee }] : []),
		...(BigInt(p.platformFee) > 0n ? [{ label: "Service fee", amount: p.platformFee }] : []),
	];
	return (
		<div className="space-y-3">
			<dl className="divide-y rounded-3xl bg-card px-5 ring-1 ring-foreground/5">
				{rows.map((r) => (
					<div key={r.label} className="flex items-baseline justify-between gap-4 py-3">
						<dt className="text-muted-foreground">
							{r.label}
							{r.note && <span className="type-label"> · {r.note}</span>}
						</dt>
						<dd className="tabular">{formatMoney(r.amount)}</dd>
					</div>
				))}
			</dl>
			{d.settlementTx && (
				<a
					href={explorerTxUrl(d.settlementTx)}
					target="_blank"
					rel="noreferrer"
					className="type-label text-muted-foreground/80 underline-offset-2 hover:text-foreground hover:underline"
				>
					Proof of payment
				</a>
			)}
		</div>
	);
}
