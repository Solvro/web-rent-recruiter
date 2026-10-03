import type { RoleDetail } from "@scout/shared";
import { useMutation } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { errorMessage } from "@/lib/errors";
import { formatMoney } from "@/lib/format";
import type { RoleStatus } from "@/lib/gigs/status";
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
		<header className="space-y-1.5 py-4">
			<div className="flex items-baseline gap-3">
				<p className="min-w-0 flex-1">
					<button type="button" onClick={onDetails} className="inline text-left hover:text-primary">
						{role.title}
					</button>
					<span className="text-muted-foreground"> · </span>
					<span className={cn("text-muted-foreground", status?.now.busy && "shimmer")} aria-live="polite">
						{status?.now.text ?? "Getting ready"}
					</span>
				</p>
				{status && <Spent role={role} budget={status.budget} />}
			</div>
			<div className="flex flex-wrap items-baseline gap-x-4">
				{status && <Progress p={status.pipeline} />}
				<CandidatesButton />
			</div>
			{status && <p className="type-label text-muted-foreground">{nextLine(status.pipeline)}</p>}
		</header>
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

function Spent({ role, budget }: { role: RoleDetail; budget: RoleStatus["budget"] }) {
	return (
		<Popover>
			<PopoverTrigger className="shrink-0 type-label text-muted-foreground tabular hover:text-foreground">
				{formatMoney(budget.paid)} of {formatMoney(budget.deposited)} spent
			</PopoverTrigger>
			<PopoverContent align="end" className="w-72 space-y-4">
				<dl className="space-y-2">
					{[
						["Spent on accepted work", budget.paid],
						["Set aside for open gigs", budget.committed],
						["Waiting on interviews", budget.heldBack],
						["Uncommitted", budget.available],
					].map(([k, v]) => (
						<div key={k} className="flex justify-between gap-4">
							<dt className="text-muted-foreground">{k}</dt>
							<dd className="tabular">{formatMoney(v)}</dd>
						</div>
					))}
				</dl>
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
						["Language checks done", p.languageDone],
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
		<div className="flex flex-wrap items-center gap-2 border-t pt-4">
			{[100, 250, 500].map((n) => (
				<Button key={n} size="sm" variant={amount === n ? "secondary" : "ghost"} onClick={() => setAmount(n)}>
					+${n}
				</Button>
			))}
			<Button size="sm" className="ml-auto" onClick={() => topUp.mutate()} disabled={topUp.isPending}>
				{topUp.isPending && <Loader2 className="animate-spin" />}
				Add
			</Button>
		</div>
	);
}
