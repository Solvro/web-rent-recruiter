/**
 * A recruiter's own work (My work list and its detail page): the type label, the one-line status, the links the
 * candidate has to click, and where the money went.
 */
import { type AgentReview, type Criteria, type DeliverableView, explorerTxUrl } from "@scout/shared";
import { Loader2 } from "lucide-react";
import { Chip } from "@/components/bits";
import { CopyButton } from "@/components/copy";
import { API_MOCK } from "@/lib/env";
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
	if (d.status === "PENDING" && d.followUps?.some((f) => !f.answer))
		return <Chip tone="warn">The agent asked you something</Chip>;
	if (d.status === "PENDING" && d.review?.verdict === "ESCALATE")
		return <Chip tone="accent">The company is deciding</Chip>;
	if (d.status === "PENDING")
		return (
			<Chip tone="accent">
				<Loader2 className="size-3.5 animate-spin" /> The agent is checking
			</Chip>
		);
	if (d.status === "REJECTED")
		return (
			<Chip>{d.review?.reasons[0] === "Withdrawn by the recruiter." ? "Taken back" : "Not accepted"}</Chip>
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
						label: "Held back",
						amount: p.later,
						note:
							p.laterStatus === "RELEASED"
								? "paid"
								: p.laterStatus === "REFUNDED"
									? "returned to the company"
									: p.laterReleasesAt
										? `paid by ${new Date(p.laterReleasesAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}, sooner if ${firstName(person)} is interviewed`
										: `paid when ${firstName(person)} is interviewed`,
					},
				]
			: []),
		...(BigInt(p.operatorFee) > 0n
			? [{ label: operator ? `${operator}, who vouched for you` : "Your operator", amount: p.operatorFee }]
			: []),
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
			{d.settlementTx && API_MOCK && (
				<p className="type-label text-muted-foreground/80">Demo data: no real payment to show.</p>
			)}
			{d.settlementTx && !API_MOCK && (
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

/** The agent accepts a profile on its own from this score (packages/agent POLICY.sourcingAcceptScore). */
export const ACCEPT_SCORE = 75;

/** What the profile missed: must-haves not met, and deal-breakers it triggered. */
export function missedOf(review: AgentReview, criteria: Criteria) {
	const must = new Map(criteria.mustHave.map((c) => [c.id, c.label]));
	const deal = new Map(criteria.dealBreakers.map((c) => [c.id, c.label]));
	return review.verdicts.flatMap((v) => {
		if (must.has(v.criterionId) && v.verdict === "NOT_MET")
			return [{ label: must.get(v.criterionId) ?? "", deal: false }];
		if (deal.has(v.criterionId) && v.verdict === "MET")
			return [{ label: deal.get(v.criterionId) ?? "", deal: true }];
		return [];
	});
}

/** "Score 43 / 100. The agent accepts from 75." plus the must-haves it couldn't find. */
export function WhyNotAccepted({ review, criteria }: { review: AgentReview; criteria: Criteria | null }) {
	const missed = criteria ? missedOf(review, criteria) : [];
	return (
		<div className="space-y-3 text-left">
			<p className="text-muted-foreground">
				Score <span className="tabular text-foreground">{review.score} / 100</span>. The agent accepts from{" "}
				<span className="tabular">{ACCEPT_SCORE}</span>.
			</p>
			{missed.length > 0 && (
				<div className="space-y-1.5">
					<p className="type-label text-muted-foreground">What the note didn't show</p>
					<ul className="space-y-1">
						{missed.slice(0, 5).map((m) => (
							<li key={m.label} className="flex gap-2">
								<span className="mt-2.5 size-1 shrink-0 rounded-full bg-destructive/70" aria-hidden />
								{m.deal ? `Not a fit: ${m.label}` : m.label}
							</li>
						))}
					</ul>
					{missed.length > 5 && (
						<p className="type-label text-muted-foreground">and {missed.length - 5} more</p>
					)}
				</div>
			)}
		</div>
	);
}

/** Where the deposit stands, in one line ("Your $2.50 deposit stays with the company"). */
export function depositStatusLine(d: DeliverableView) {
	const dep = d.deposit;
	if (!dep || BigInt(dep.amount) === 0n) return null;
	const amount = formatMoney(dep.amount);
	if (dep.status === "KEPT") return `Your ${amount} deposit stays with the company.`;
	if (dep.status === "RETURNED") return `Your ${amount} deposit was returned.`;
	return `Your ${amount} deposit comes back when the agent accepts.`;
}
