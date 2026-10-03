import type { RoleDetail } from "@scout/shared";
import { useMutation } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Receipt } from "@/components/receipt";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { errorMessage } from "@/lib/errors";
import { formatMoney } from "@/lib/format";
import { usePayments } from "@/lib/gigs/candidates";
import type { RoleStatus } from "@/lib/gigs/status";
import { inCents } from "@/lib/payout";
import { plain } from "@/lib/plain";
import { useMe } from "@/lib/queries";
import { useTRPCClient } from "@/lib/trpc";
import { useTransact } from "@/lib/use-transact";
import { cn } from "@/lib/utils";
import { useCandidatesPanel } from "./candidates";
import { nextLine } from "./presence";

/**
 * One line, Hanna's three questions: is it working (status, shimmering while busy), what it has cost, and
 * underneath a thin line of progress. Details open on click.
 */
export function RoleHeader({
	role,
	status,
	onDetails,
}: {
	role: RoleDetail;
	status: RoleStatus | undefined;
	onDetails: () => void;
}) {
	return (
		<header className="relative z-10 space-y-1.5 bg-background py-4 after:pointer-events-none after:absolute after:inset-x-0 after:-bottom-4 after:h-4 after:bg-gradient-to-b after:from-background after:to-transparent">
			{/* Desktop: title · status on one line. Phone: the title, then the status, so neither is squeezed. */}
			<div className="flex items-baseline gap-3">
				<p className="min-w-0 flex-1 truncate" title={role.title}>
					<button type="button" onClick={onDetails} className="inline text-left hover:text-primary">
						{role.title}
					</button>
					<span className="hidden text-muted-foreground sm:inline"> · </span>
					<StatusText status={status} pending={role.pendingCount} className="hidden sm:inline" />
				</p>
				<button
					type="button"
					onClick={onDetails}
					className="shrink-0 type-label text-muted-foreground hover:text-foreground"
				>
					Details
				</button>
			</div>
			<StatusText status={status} pending={role.pendingCount} className="block truncate sm:hidden" />
			<div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
				{status && <Progress p={status.pipeline} />}
				<CandidatesButton />
				{status && (
					<span className="ml-auto">
						<Spent role={role} budget={status.budget} />
					</span>
				)}
			</div>
			{status && role.status !== "CLOSED" && (
				<p className="hidden type-label text-muted-foreground sm:block">
					{nextLine(status.pipeline, status.waitingOn)}
				</p>
			)}
		</header>
	);
}

function StatusText({
	status,
	pending = 0,
	className,
}: {
	status: RoleStatus | undefined;
	/** Deliveries waiting for the company's own review. */
	pending?: number;
	className?: string;
}) {
	// Something waiting for the company always wins over "sourcing…": the header never hides a decision.
	const asking = pending > 0 || status?.waitingOn.some((w) => w.who === "company");
	return (
		<span
			className={cn(
				"text-muted-foreground",
				status?.now.busy && !asking && "shimmer",
				asking && "text-primary",
				className,
			)}
			aria-live="polite"
		>
			{asking ? "Waiting for your decision" : plain(status?.now.text ?? "Getting ready")}
		</span>
	);
}

function CandidatesButton() {
	const { open, count } = useCandidatesPanel();
	if (!count) return null;
	return (
		<button
			type="button"
			onClick={() => open()}
			className="type-label text-foreground underline-offset-4 hover:underline"
		>
			{count} candidate{count === 1 ? "" : "s"}
		</button>
	);
}

const WORK: Record<string, string> = {
	sourcing: "profile",
	screening: "screening call",
	language: "language check",
	reference: "reference check",
	show_up_fee: "interview show-up",
	appeal: "appeal",
};

/** Who got what, for which gig, with the receipt. */
function Ledger({ roleId }: { roleId: string }) {
	const ledger = usePayments(roleId, true);
	if (!ledger.data?.length) return null;
	return (
		<ul className="max-h-64 space-y-3 overflow-y-auto border-t pt-3 type-label">
			{ledger.data.map((p) => {
				// The line at its plan price (what the company paid for it); the recruiter's share and fee in the detail.
				const price = BigInt(p.bounty ?? BigInt(p.amount) + BigInt(p.held) + BigInt(p.fees));
				const c = inCents(p.amount, p.held);
				return (
					<li key={p.deliverableId} className="space-y-0.5">
						<p className="flex items-baseline justify-between gap-3">
							<span className="min-w-0 truncate">
								{p.recruiter} <span className="text-muted-foreground">· {WORK[p.kind] ?? "task"}</span>
							</span>
							<span className="shrink-0 tabular">{formatMoney(price)}</span>
						</p>
						<p className="text-muted-foreground">
							{formatMoney(c.now)} to {p.recruiter.split(" ")[0]}
							{BigInt(p.held) > 0n &&
								` · ${formatMoney(c.later)} ${p.heldStatus === "HELD" ? "after the interview" : p.heldStatus === "RELEASED" ? "paid after the interview" : "returned to you"}`}
							{BigInt(p.fees) > 0n && ` · ${formatMoney(p.fees)} fee`}
							{p.signature && <Receipt signature={p.signature} className="ml-2" />}
						</p>
					</li>
				);
			})}
		</ul>
	);
}

/** Accepted work at its plan price (what the company pays for it, fees included). Falls back for older APIs. */
const spentOf = (b: RoleStatus["budget"]) => BigInt(b.spent ?? BigInt(b.paid) + BigInt(b.heldBack));

function Spent({ role, budget }: { role: RoleDetail; budget: RoleStatus["budget"] }) {
	const spent = spentOf(budget);
	const closed = role.status === "CLOSED";
	// Spent + set aside + uncommitted = the budget, so the lines below always add up to the total.
	const rows: [string, bigint, string?][] = [
		[
			"Spent on accepted work",
			spent,
			[
				BigInt(budget.heldBack) > 0n &&
					`${formatMoney(budget.heldBack)} of it is paid only once the candidate comes to the interview`,
				budget.fees && BigInt(budget.fees) > 0n && `includes ${formatMoney(budget.fees)} in fees`,
			]
				.filter(Boolean)
				.join("; ") || undefined,
		],
		...(closed
			? [["Came back to you", BigInt(budget.refunded ?? "0")] as [string, bigint]]
			: [
					[
						"Set aside for open work",
						BigInt(budget.committed),
						"money promised to tasks recruiters are working on",
					] as [string, bigint, string],
					["Not yet used", BigInt(budget.available)] as [string, bigint],
				]),
	];
	return (
		<Popover>
			<PopoverTrigger className="shrink-0 type-label text-muted-foreground tabular hover:text-foreground">
				{role.status === "CLOSED"
					? `${formatMoney(spent)} spent · ${formatMoney(budget.refunded ?? 0n)} back to you`
					: `${formatMoney(spent)} of ${formatMoney(budget.deposited)} spent`}
			</PopoverTrigger>
			<PopoverContent align="end" className="w-[min(26rem,calc(100vw-2rem))] space-y-4">
				<dl className="space-y-2.5">
					{rows.map(([k, v, note]) => (
						<div key={k}>
							<div className="flex justify-between gap-4">
								<dt className="text-muted-foreground">{k}</dt>
								<dd className="tabular">{formatMoney(v)}</dd>
							</div>
							{note && <p className="type-label text-muted-foreground">{note}</p>}
						</div>
					))}
					<div className="flex justify-between gap-4 border-t pt-2">
						<dt>Budget</dt>
						<dd className="tabular">{formatMoney(budget.deposited)}</dd>
					</div>
				</dl>
				<Ledger roleId={role.id} />
				{role.status === "OPEN" && <TopUp role={role} />}
			</PopoverContent>
		</Popover>
	);
}

/** "Sourcing 1/17 → Screening 0/3 → Shortlist 0" */
function Progress({ p }: { p: RoleStatus["pipeline"] }) {
	const steps = [
		{ label: "Sourcing", value: `${p.sourcingAccepted}/${p.sourcingSlots}`, live: p.sourcingAccepted > 0 },
		{ label: "Confirmed", value: `${p.confirmed}`, live: p.confirmed > 0, hide: p.confirmed === 0 },
		{
			label: "Screening",
			value: p.screeningSlots ? `${p.screeningDone}/${p.screeningSlots}` : `${p.screeningDone}`,
			live: p.screeningDone > 0,
		},
		{
			label: "Reference",
			value: `${p.referenceDone}`,
			live: p.referenceDone > 0,
			hide: p.referenceDone === 0,
		},
		{ label: "Shortlist", value: `${p.shortlisted}`, live: p.shortlisted > 0 },
	].filter((s) => !s.hide);
	return (
		<Popover>
			<PopoverTrigger className="flex flex-wrap items-center gap-x-2 type-label text-muted-foreground hover:text-foreground">
				{steps.map((s, i) => (
					<span key={s.label} className="inline-flex items-center gap-2">
						{i > 0 && <span className="text-muted-foreground/50">→</span>}
						<span className={cn(s.live && "text-foreground")}>
							{s.label}{" "}
							<span key={s.value} className="inline-block tabular animate-in zoom-in-75 duration-300">
								{s.value}
							</span>
						</span>
					</span>
				))}
			</PopoverTrigger>
			<PopoverContent align="start" className="w-80">
				<dl className="space-y-2 type-label">
					{[
						["Profiles accepted", `${p.sourcingAccepted} of ${p.sourcingSlots} planned`],
						["Candidates who confirmed interest", p.confirmed],
						["Screening calls done", `${p.screeningDone} of ${p.screeningSlots}`],
						...(p.languageDone ? [["Language checks done", p.languageDone] as [string, number]] : []),
						["References done", p.referenceDone],
						["On your shortlist", p.shortlisted],
					].map(([k, v]) => (
						<div key={String(k)} className="flex justify-between gap-4">
							<dt className="text-muted-foreground">{k}</dt>
							<dd className="tabular">{v}</dd>
						</div>
					))}
				</dl>
			</PopoverContent>
		</Popover>
	);
}

function TopUp({ role }: { role: RoleDetail }) {
	const client = useTRPCClient();
	const me = useMe();
	const balance = BigInt(me.data?.usdcBalance ?? "0");
	const [amount, setAmount] = useState(100);
	const { transact } = useTransact();
	const value = BigInt(amount) * 1_000_000n;
	const topUp = useMutation({
		mutationFn: async () => {
			const { unsignedTx } = await client.roles.topUp.mutate({ id: role.id, amount: value.toString() });
			await transact(unsignedTx, { pending: "Adding budget…", success: `${formatMoney(value)} added.` });
		},
		onError: (e) => toast.error(errorMessage(e)),
	});
	return (
		<div className="space-y-2 border-t pt-4">
			<p className="type-label text-muted-foreground">You have {formatMoney(balance)} available to add</p>
			{balance < 1_000_000n ? (
				<p className="type-label text-muted-foreground">Nothing left to add from your account.</p>
			) : (
				<div className="flex flex-wrap items-center gap-2">
					{[100, 250, 500].map((n) => (
						<Button
							key={n}
							size="sm"
							variant={amount === n ? "secondary" : "ghost"}
							onClick={() => setAmount(n)}
							disabled={BigInt(n) * 1_000_000n > balance}
						>
							+${n}
						</Button>
					))}
					<Button
						size="sm"
						className="ml-auto"
						onClick={() => topUp.mutate()}
						disabled={topUp.isPending || value > balance}
					>
						{topUp.isPending && <Loader2 className="animate-spin" />}
						Add
					</Button>
				</div>
			)}
			{value > balance && balance >= 1_000_000n && (
				<p className="type-label text-destructive">That's more than you have. Pick a smaller amount.</p>
			)}
		</div>
	);
}
