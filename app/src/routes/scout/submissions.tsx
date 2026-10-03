import { createFileRoute, Link } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { PageSkeleton, RequireAccount } from "@/components/account";
import { Appeal } from "@/components/appeal";
import { Chip, EmptyState, ErrorState } from "@/components/bits";
import { CopyButton } from "@/components/copy";
import { FollowUps } from "@/components/follow-ups";
import { Avatar } from "@/components/person";
import { Receipt, type ReceiptDetails } from "@/components/receipt";
import { buttonVariants } from "@/components/ui/button";
import { firstName, formatMoney, personInTitle } from "@/lib/format";
import { GIG_TYPES } from "@/lib/gig-types";
import { useMyWork } from "@/lib/gigs/api";
import type { DeliverableView } from "@/lib/gigs/schemas";
import { inCents } from "@/lib/payout";

export const Route = createFileRoute("/scout/submissions")({
	component: () => (
		<RequireAccount kind="scout">
			{(me) => <Earnings operator={me.operator?.name ?? null} slug={me.slug} />}
		</RequireAccount>
	),
});

/** What the recruiter has been paid: accepted parts now, plus held parts once released. */
function earnedOf(list: DeliverableView[]) {
	return list.reduce((sum, d) => {
		if (d.status !== "ACCEPTED" || !d.payout) return sum;
		return sum + BigInt(d.payout.now) + (d.payout.laterStatus === "RELEASED" ? BigInt(d.payout.later) : 0n);
	}, 0n);
}

function Earnings({ operator, slug }: { operator: string | null; slug: string }) {
	const work = useMyWork();
	if (work.isError) return <ErrorState />;
	if (work.isPending) return <PageSkeleton />;
	const list = work.data;
	if (!list.length)
		return (
			<EmptyState
				title="You haven't done any gigs yet."
				action={
					<Link to="/scout" className={buttonVariants({ size: "lg" })}>
						Browse gigs
					</Link>
				}
			/>
		);

	return (
		<div className="mx-auto max-w-3xl space-y-12">
			<div className="flex flex-wrap items-end justify-between gap-4">
				<div className="space-y-2">
					<h1 className="type-display">You've earned {formatMoney(earnedOf(list))}</h1>
					{operator && <p className="type-label text-muted-foreground">Vouched by {operator}</p>}
				</div>
				<Link
					to="/r/$slug"
					params={{ slug }}
					className="type-label text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
				>
					Your public profile
				</Link>
			</div>
			<ul className="divide-y">
				{list.map((d) => (
					<Row key={d.id} work={d} />
				))}
			</ul>
		</div>
	);
}

const LATER: Record<string, { label: string; tone: "accent" | "good" | "neutral" }> = {
	HELD: { label: "after the interview", tone: "accent" },
	RELEASED: { label: "paid", tone: "good" },
	REFUNDED: { label: "refunded", tone: "neutral" },
};

function personOf(d: DeliverableView) {
	if (d.deliverable.type === "SOURCING") return d.deliverable.name;
	return personInTitle(d.gigTitle);
}

function Row({ work: d }: { work: DeliverableView }) {
	const info = GIG_TYPES[/^language check/i.test(d.gigTitle) ? "LANGUAGE_CHECK" : d.gigType];
	const person = personOf(d);
	const p = d.payout && { ...d.payout, ...inCents(d.payout.now, d.payout.later) };
	const later = p && p.laterStatus !== "NONE" ? LATER[p.laterStatus] : null;
	const receipt: ReceiptDetails | undefined = p
		? {
				title: `Paid ${formatMoney(p.laterStatus === "RELEASED" ? BigInt(p.now) + BigInt(p.later) : p.now)} to you`,
				lines: [`${info.name} · ${person}`, d.roleTitle],
			}
		: undefined;

	return (
		<li className="flex items-center gap-4 py-5">
			{d.gigType === "SOURCING" ? (
				<Avatar name={person} />
			) : (
				<span className="grid size-10 shrink-0 place-items-center rounded-full bg-accent text-accent-foreground">
					<info.icon className="size-4" />
				</span>
			)}
			<div className="min-w-0 flex-1">
				<p className="truncate">{person}</p>
				<p className="truncate type-label text-muted-foreground">
					{info.name} · {d.roleTitle}
				</p>
			</div>
			<div className="flex shrink-0 flex-col items-end gap-1.5">
				<FollowUps d={d} />
				{d.status === "PENDING" && d.confirmation?.status === "PENDING" ? (
					<>
						<Chip tone="accent">Waiting for {firstName(person)} to confirm</Chip>
						{d.confirmation.url && <CopyButton text={d.confirmation.url} />}
					</>
				) : d.status === "PENDING" ? (
					<Chip tone="accent">
						<Loader2 className="size-3.5 animate-spin" /> The agent is checking
					</Chip>
				) : d.status === "REJECTED" ? (
					<>
						<Chip>Not accepted</Chip>
						<Appeal d={d} align="end" />
					</>
				) : (
					<>
						<div className="flex items-center gap-2">
							{p && <span className="type-label tabular text-success">+{formatMoney(p.now)}</span>}
							{later && p && (
								<Chip tone={later.tone}>
									<span className="tabular">{formatMoney(p.later)}</span> {later.label}
								</Chip>
							)}
						</div>
						<Receipt signature={d.settlementTx} details={receipt} />
					</>
				)}
			</div>
		</li>
	);
}
