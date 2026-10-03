import type { RoleDetail } from "@scout/shared";
import { useMutation } from "@tanstack/react-query";
import { Bot, Clock, Hourglass, Link2, Loader2, Plus, UserRound, Users } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useNow } from "@/components/bits";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { errorMessage } from "@/lib/errors";
import { formatMoney } from "@/lib/format";
import type { RoleStatus, Waiting } from "@/lib/gigs/status";
import { useTRPCClient } from "@/lib/trpc";
import { useTransact } from "@/lib/use-transact";
import { cn } from "@/lib/utils";

/** "4 min", "1 h 20 min", "now" */
export function span(ms: number) {
	const m = Math.max(0, Math.round(ms / 60_000));
	if (m < 1) return "less than a minute";
	if (m < 60) return `${m} min`;
	const h = Math.floor(m / 60);
	return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

export function AgentAvatar({ busy = false, small = false }: { busy?: boolean; small?: boolean }) {
	return (
		<span
			className={cn(
				"relative grid shrink-0 place-items-center rounded-full bg-primary text-primary-foreground",
				small ? "size-7" : "size-10",
			)}
		>
			<Bot className={small ? "size-3.5" : "size-5"} />
			{busy && (
				<span className="absolute -right-0.5 -bottom-0.5 flex size-3">
					<span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60" />
					<span className="relative inline-flex size-3 rounded-full border-2 border-background bg-success" />
				</span>
			)}
		</span>
	);
}

/**
 * Sticky cockpit header: what the agent is doing right now, what it is waiting for (with deadlines), when it
 * looks again, and the one budget number that matters.
 */
export function StatusBar({ role, status }: { role: RoleDetail; status: RoleStatus | undefined }) {
	const now = useNow();
	// What waits for the company lives in "Needs you"; here: everyone else the agent is waiting for.
	const waiting = (status?.waitingOn ?? []).filter((w) => w.who !== "company");
	const shown = waiting.slice(0, 2);
	const more = waiting.slice(2);
	const next = status?.nextCheckAt ? Date.parse(status.nextCheckAt) - now : null;
	return (
		<div className="sticky top-16 z-30 -mx-4 border-b bg-background/90 px-4 py-4 backdrop-blur sm:-mx-6 sm:px-6">
			<div className="flex flex-wrap items-center gap-x-6 gap-y-3">
				<div className="flex min-w-0 flex-1 items-center gap-3">
					<AgentAvatar busy={status?.now.busy} />
					<div className="min-w-0 space-y-1">
						<p className="type-label text-muted-foreground">{role.title}</p>
						<p className={cn("truncate", status?.now.busy && "shimmer")} aria-live="polite">
							{status ? `${status.now.text}${status.now.busy ? "…" : ""}` : "Your agent is getting ready…"}
						</p>
					</div>
				</div>
				<div className="flex shrink-0 items-center gap-3">
					{status && <Budget status={status} />}
					{role.status === "OPEN" && <TopUp role={role} />}
				</div>
			</div>
			{(waiting.length > 0 || next !== null) && (
				<ul className="mt-3 flex min-w-0 flex-wrap items-center gap-2 sm:pl-[52px]">
					{shown.map((w) => (
						<WaitingChip key={w.what} w={w} now={now} />
					))}
					{more.length > 0 && (
						<li>
							<Popover>
								<PopoverTrigger className="rounded-full px-2.5 py-1 type-label text-muted-foreground ring-1 ring-border hover:text-foreground">
									+{more.length} more
								</PopoverTrigger>
								<PopoverContent align="start" className="w-80">
									<ul className="space-y-2">
										{more.map((w) => (
											<WaitingChip key={w.what} w={w} now={now} />
										))}
									</ul>
								</PopoverContent>
							</Popover>
						</li>
					)}
					{next !== null && next > 0 && (
						<li className="inline-flex items-center gap-1.5 type-label text-muted-foreground">
							<Clock className="size-3.5" /> Next check in {span(next)}
						</li>
					)}
				</ul>
			)}
		</div>
	);
}

const WHO_ICON = { candidate: UserRound, recruiter: Users, company: Hourglass, chain: Link2 } as const;

function WaitingChip({ w, now }: { w: Waiting; now: number }) {
	const left = w.deadline ? Date.parse(w.deadline) - now : null;
	const Icon = WHO_ICON[w.who] ?? Hourglass;
	return (
		<li className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 type-label text-muted-foreground">
			<Icon className="size-3.5 shrink-0" />
			<span className="min-w-0 truncate">
				Waiting for <span className="text-foreground">{w.what}</span>
				{left !== null && ` · ${left > 0 ? `${span(left)} left` : "time is up"}`}
			</span>
		</li>
	);
}

function Budget({ status }: { status: RoleStatus }) {
	const b = status.budget;
	return (
		<Popover>
			<PopoverTrigger className="text-right">
				<span className="block tabular underline decoration-border decoration-dashed underline-offset-4 hover:decoration-foreground">
					{formatMoney(b.available)}
				</span>
				<span className="type-label text-muted-foreground">left</span>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-72">
				<dl className="space-y-2">
					{[
						["Budget", b.deposited],
						["Paid for accepted work", b.paid],
						["Set aside for open gigs", b.committed],
						["Waiting on interviews", b.heldBack],
					].map(([k, v]) => (
						<div key={k} className="flex justify-between gap-4">
							<dt className="text-muted-foreground">{k}</dt>
							<dd className="tabular">{formatMoney(v)}</dd>
						</div>
					))}
					<div className="flex justify-between gap-4 border-t pt-2">
						<dt>Left for new work</dt>
						<dd className="tabular">{formatMoney(b.available)}</dd>
					</div>
				</dl>
			</PopoverContent>
		</Popover>
	);
}

function TopUp({ role }: { role: RoleDetail }) {
	const client = useTRPCClient();
	const [open, setOpen] = useState(false);
	const [count, setCount] = useState(100);
	const { transact } = useTransact();
	const amount = BigInt(count) * 1_000_000n;
	const topUp = useMutation({
		mutationFn: async () => {
			const { unsignedTx } = await client.roles.topUp.mutate({ id: role.id, amount: amount.toString() });
			const ok = await transact(unsignedTx, {
				pending: "Adding budget…",
				success: `${formatMoney(amount)} added.`,
			});
			if (ok) setOpen(false);
		},
		onError: (e) => toast.error(errorMessage(e)),
	});
	return (
		<>
			<Button variant="outline" size="icon" aria-label="Add budget" onClick={() => setOpen(true)}>
				<Plus />
			</Button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent className="gap-8 p-8">
					<DialogTitle>Add budget</DialogTitle>
					<div className="flex flex-wrap gap-2">
						{[50, 100, 300].map((n) => (
							<Button key={n} variant={count === n ? "default" : "outline"} onClick={() => setCount(n)}>
								+{formatMoney(BigInt(n) * 1_000_000n)}
							</Button>
						))}
					</div>
					<DialogFooter>
						<Button size="lg" onClick={() => topUp.mutate()} disabled={topUp.isPending}>
							{topUp.isPending && <Loader2 className="animate-spin" />}
							Add {formatMoney(amount)}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
