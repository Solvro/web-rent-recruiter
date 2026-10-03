import { createFileRoute, Link } from "@tanstack/react-router";
import { PageSkeleton, RequireAccount } from "@/components/account";
import { EmptyState, ErrorState } from "@/components/bits";
import { CopyButton } from "@/components/copy";
import { Avatar } from "@/components/person";
import { buttonVariants } from "@/components/ui/button";
import { personOf, WorkStatus, workInfo } from "@/components/work";
import { firstName, formatMoney } from "@/lib/format";
import { useMyWork } from "@/lib/gigs/api";
import type { DeliverableView } from "@/lib/gigs/schemas";
import { useTitle } from "@/lib/use-title";

export const Route = createFileRoute("/scout/submissions")({
	component: () => (
		<RequireAccount kind="scout">
			{(me) => <Earnings operator={me.operator?.name ?? null} slug={me.slug} earned={me.earned ?? null} />}
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

/** earned: the on-chain total (released holdbacks and show-up fees included) when the API sends it. */
function Earnings({
	operator,
	slug,
	earned,
}: {
	operator: string | null;
	slug: string;
	earned: string | null;
}) {
	const work = useMyWork();
	useTitle("My work");
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
					<h1 className="type-display">You've earned {formatMoney(earned ?? earnedOf(list))}</h1>
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
			<ul className="space-y-1">
				{list.map((d) => (
					<Row key={d.id} work={d} />
				))}
			</ul>
		</div>
	);
}

function Row({ work: d }: { work: DeliverableView }) {
	const info = workInfo(d);
	const person = personOf(d);
	const confirmUrl =
		d.status === "PENDING" && d.confirmation?.status === "PENDING" ? d.confirmation.url : null;
	const callLink = d.callChecks?.find((c) => c.status === "PENDING" && c.url);

	return (
		<li className="relative -mx-3 flex items-center gap-4 rounded-3xl px-3 py-5 transition-colors hover:bg-muted/60">
			{d.gigType === "SOURCING" ? (
				<Avatar name={person} />
			) : (
				<span className="grid size-10 shrink-0 place-items-center rounded-full bg-accent text-accent-foreground">
					<info.icon className="size-4" />
				</span>
			)}
			<div className="min-w-0 flex-1">
				<Link
					to="/scout/work/$deliverableId"
					params={{ deliverableId: d.id }}
					className="block truncate after:absolute after:inset-0 after:rounded-3xl focus-visible:outline-none"
				>
					{person}
				</Link>
				<p className="truncate type-label text-muted-foreground">
					{info.name} · {d.roleTitle}
				</p>
			</div>
			<div className="relative z-10 flex shrink-0 flex-col items-end gap-1.5 text-right">
				<WorkStatus d={d} person={person} />
				{confirmUrl && <CopyButton text={confirmUrl} />}
				{callLink?.url && (
					<CopyButton text={callLink.url} label={`Copy call check for ${firstName(person)}`} />
				)}
			</div>
		</li>
	);
}
