import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { PageSkeleton, RequireAccount } from "@/components/account";
import { Chip, EmptyState, ErrorState } from "@/components/bits";
import { CashOut } from "@/components/cash-out";
import { CopyButton } from "@/components/copy";
import { Avatar } from "@/components/person";
import { buttonVariants } from "@/components/ui/button";
import { personOf, WorkStatus, workInfo } from "@/components/work";
import { firstName, formatMoney } from "@/lib/format";
import { GIG_TYPES, kindOf } from "@/lib/gig-types";
import { useMyWork } from "@/lib/gigs/api";
import type { DeliverableView, GigView } from "@/lib/gigs/schemas";
import { publicLink } from "@/lib/public-url";
import { typedClient } from "@/lib/trpc";
import { useTitle } from "@/lib/use-title";
import { useWallet } from "@/lib/wallet";

export const Route = createFileRoute("/scout/submissions")({
	component: () => (
		<RequireAccount kind="scout">
			{(me) => (
				<Earnings
					operator={me.operator?.name ?? null}
					slug={me.slug}
					earned={me.earned ?? null}
					available={BigInt(me.usdcBalance)}
				/>
			)}
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
/** Held parts waiting for an interview, and deposits held or kept. */
function moneyOf(list: DeliverableView[]) {
	let waiting = 0n;
	let held = 0n;
	let kept = 0n;
	for (const d of list) {
		if (d.status === "ACCEPTED" && d.payout?.laterStatus === "HELD") waiting += BigInt(d.payout.later);
		if (d.deposit?.status === "HELD") held += BigInt(d.deposit.amount);
		if (d.deposit?.status === "KEPT") kept += BigInt(d.deposit.amount);
	}
	return { waiting, held, kept };
}

function Earnings({
	operator,
	slug,
	earned,
	available,
}: {
	operator: string | null;
	slug: string;
	earned: string | null;
	available: bigint;
}) {
	const work = useMyWork();
	const closed = useClosedCalls();
	useTitle("My work");
	if (work.isError) return <ErrorState />;
	if (work.isPending) return <PageSkeleton />;
	const list = work.data;
	const m = moneyOf(list);
	const facts = [
		`${formatMoney(available)} in your account`,
		m.waiting > 0n ? `${formatMoney(m.waiting)} after interviews` : null,
		m.held > 0n ? `${formatMoney(m.held)} in deposits` : null,
		m.kept > 0n ? `${formatMoney(m.kept)} in deposits kept` : null,
	].filter(Boolean);
	if (!list.length && !closed.length)
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
					<p className="type-label text-muted-foreground">{facts.join(" · ")}</p>
					<p className="type-label text-muted-foreground">
						{operator && <>Vouched by {operator} · </>}
						<Link
							to="/r/$slug"
							params={{ slug }}
							className="underline-offset-4 hover:text-foreground hover:underline"
						>
							Your public profile
						</Link>
					</p>
				</div>
				<CashOut available={available} />
			</div>
			<ul className="space-y-1">
				{closed.map((g) => (
					<ClosedRow key={g.id} gig={g} />
				))}
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
				<p className="line-clamp-2 type-label text-muted-foreground">
					{info.name} · {dayLabel(d.review?.reviewedAt ?? d.submittedAt)} · {d.roleTitle}
				</p>
			</div>
			<div className="relative z-10 flex max-w-[48%] shrink-0 flex-col items-end gap-1.5 text-right">
				<WorkStatus d={d} person={person} />
				{confirmUrl && <CopyButton text={publicLink(confirmUrl)} />}
				{callLink?.url && (
					<CopyButton text={publicLink(callLink.url)} label={`Copy call check for ${firstName(person)}`} />
				)}
			</div>
		</li>
	);
}

const dayLabel = (iso: string) =>
	new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

/** Calls you took that ended early (fake report, two no-shows): they stay on record here. */
function useClosedCalls() {
	const { address } = useWallet();
	const q = useQuery({
		queryKey: ["gigs", "mine", "closed"],
		queryFn: async () => (await typedClient.gigs.mine.query()).gigs,
		enabled: !!address,
		refetchInterval: 15_000,
	});
	return (q.data ?? []).filter((g) => g.closedReason);
}

function ClosedRow({ gig }: { gig: GigView }) {
	const info = GIG_TYPES[kindOf(gig)];
	const person = gig.candidate?.name ?? gig.roleTitle;
	return (
		<li className="relative -mx-3 flex items-center gap-4 rounded-3xl px-3 py-5 transition-colors hover:bg-muted/60">
			<span className="grid size-10 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
				<info.icon className="size-4" />
			</span>
			<div className="min-w-0 flex-1">
				<Link
					to="/scout/gigs/$gigId"
					params={{ gigId: gig.id }}
					className="block truncate after:absolute after:inset-0 after:rounded-3xl focus-visible:outline-none"
				>
					{person}
				</Link>
				<p className="line-clamp-2 type-label text-muted-foreground">
					{info.name}
					{gig.closedAt && ` · ${dayLabel(gig.closedAt)}`} · {gig.roleTitle}
				</p>
			</div>
			<div className="relative z-10 shrink-0 text-right">
				<Chip>{gig.closedReason === "REPORTED_FAKE" ? "You reported it" : "Candidate didn't show"}</Chip>
				{gig.showUpFee && (
					<p className="mt-1.5 type-label tabular text-success">
						{gig.showUpFee.status === "PAID" ? "+" : ""}
						{formatMoney(gig.showUpFee.amount)} show-up fee
						{gig.showUpFee.status === "PAID" ? "" : " to claim"}
					</p>
				)}
			</div>
		</li>
	);
}
