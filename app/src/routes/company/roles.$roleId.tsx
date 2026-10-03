import type { RoleDetail } from "@scout/shared";
import { toBaseUnits } from "@scout/shared";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Bot, Inbox, Loader2, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { PageSkeleton, RequireAccount } from "@/components/account";
import { EmptyState, PageHeader, Stat } from "@/components/bits";
import { BudgetBar } from "@/components/budget-bar";
import { CriteriaFacts, CriteriaList } from "@/components/criteria";
import { ExplorerLink } from "@/components/explorer-link";
import { SubmissionCard } from "@/components/submission-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, errorMessage } from "@/lib/api";
import { formatUsdc, netOfFee, reviewWindowLabel } from "@/lib/format";
import { useMe, useRole } from "@/lib/queries";
import { useTransact } from "@/lib/use-transact";

export const Route = createFileRoute("/company/roles/$roleId")({
	component: () => {
		const { roleId } = Route.useParams();
		return <RequireAccount kind="company">{() => <RoleDashboard roleId={roleId} />}</RequireAccount>;
	},
});

function RoleDashboard({ roleId }: { roleId: string }) {
	const role = useRole(roleId);
	if (role.isPending) return <PageSkeleton />;
	if (role.isError)
		return <EmptyState title="Couldn't load this role">{errorMessage(role.error)}</EmptyState>;
	const r = role.data;
	const pending = r.submissions.filter((s) => s.status === "PENDING");
	const decided = r.submissions.filter((s) => s.status !== "PENDING");

	return (
		<div className="space-y-8">
			<PageHeader
				eyebrow={
					<Link to="/company" className="inline-flex items-center gap-1 hover:text-foreground">
						<ArrowLeft className="size-3.5" /> Roles
					</Link>
				}
				title={
					<span className="flex flex-wrap items-center gap-3">
						{r.title}
						{r.status === "CLOSED" ? (
							<Badge variant="secondary">Closed</Badge>
						) : (
							<Badge variant="outline">Open</Badge>
						)}
					</span>
				}
				description={<CriteriaFacts criteria={r.criteria} />}
				actions={r.status === "OPEN" && <RoleActions role={r} />}
			/>

			<Card>
				<CardContent className="space-y-6">
					<div className="grid grid-cols-2 gap-6 md:grid-cols-4">
						<Stat label="Deposited" value={formatUsdc(r.budget.deposited)} />
						<Stat
							label="Paid to scouts"
							value={formatUsdc(r.budget.paid)}
							hint={`${r.acceptedCount} accepted`}
						/>
						<Stat
							label="Remaining"
							value={formatUsdc(r.budget.remaining)}
							hint={`${formatUsdc(r.bounty)} per candidate`}
						/>
						<Stat
							label="Accepted"
							value={`${r.acceptedCount} / ${r.maxCandidates}`}
							hint={`Auto-accept after ${reviewWindowLabel(r.reviewWindowSeconds)}`}
						/>
					</div>
					<BudgetBar role={r} />
				</CardContent>
			</Card>

			<div className="flex gap-3 rounded-2xl bg-accent/60 p-4 text-sm text-accent-foreground">
				<Bot className="mt-0.5 size-4 shrink-0" />
				{r.pipelineSummary ? (
					<p>{r.pipelineSummary}</p>
				) : (
					<p className="animate-pulse">The agent is updating its pipeline summary…</p>
				)}
			</div>

			<div className="grid gap-8 lg:grid-cols-[1fr_300px]">
				<div className="space-y-8">
					<section className="space-y-3">
						<h2 className="flex items-center gap-2 font-semibold">
							Waiting for your review
							{pending.length > 0 && (
								<Badge className="bg-warning/15 text-warning-foreground">{pending.length}</Badge>
							)}
						</h2>
						{pending.length ? (
							pending.map((s) => <SubmissionCard key={s.id} sub={s} role={r} criteria={r.criteria} />)
						) : (
							<EmptyState icon={<Inbox className="size-5" />} title="Nothing to review">
								{r.submissions.length
									? "You're all caught up. New candidates from scouts land here."
									: "Scouts can see this role now. The first candidates usually arrive within a day."}
							</EmptyState>
						)}
					</section>
					{decided.length > 0 && (
						<section className="space-y-3">
							<h2 className="font-semibold">Decided</h2>
							{decided.map((s) => (
								<SubmissionCard key={s.id} sub={s} role={r} criteria={r.criteria} />
							))}
						</section>
					)}
				</div>
				<aside className="space-y-4">
					<Card>
						<CardHeader>
							<CardTitle className="text-base">What scouts look for</CardTitle>
						</CardHeader>
						<CardContent>
							<CriteriaList criteria={r.criteria} />
						</CardContent>
					</Card>
					<p className="px-1 text-xs text-muted-foreground">
						Scouts receive {formatUsdc(netOfFee(r.bounty, r.feeBps))} per accepted candidate. The budget sits
						in a vault that only the payment rules can release.{" "}
						<ExplorerLink address={r.roleVault}>Verify</ExplorerLink>
					</p>
				</aside>
			</div>
		</div>
	);
}

function RoleActions({ role }: { role: RoleDetail }) {
	const me = useMe();
	const [open, setOpen] = useState(false);
	const [amount, setAmount] = useState("100");
	const { transact } = useTransact();

	const topUp = useMutation({
		mutationFn: async () => {
			const base = toBaseUnits(Number(amount) || 0);
			const { unsignedTx } = await api.topUp(role.id, { amount: base.toString() });
			const ok = await transact(unsignedTx, `Added ${formatUsdc(base)} to ${role.title}.`);
			if (ok) setOpen(false);
		},
		onError: (e) => toast.error(errorMessage(e)),
	});
	const close = useMutation({
		mutationFn: async () => {
			const { unsignedTx } = await api.closeRole(role.id);
			await transact(
				unsignedTx,
				`${role.title} closed. ${formatUsdc(role.budget.remaining)} returned to you.`,
			);
		},
		onError: (e) => toast.error(errorMessage(e)),
	});

	return (
		<>
			<Button
				variant="ghost"
				onClick={() => close.mutate()}
				disabled={close.isPending || role.pendingCount > 0}
				title={role.pendingCount > 0 ? "Decide on pending candidates first" : undefined}
			>
				Close role
			</Button>
			<Button onClick={() => setOpen(true)}>
				<Plus /> Top up
			</Button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Top up the budget</DialogTitle>
						<DialogDescription>
							Add more when you like the quality. Each {formatUsdc(role.bounty)} funds one more accepted
							candidate.
						</DialogDescription>
					</DialogHeader>
					<div className="space-y-3">
						<div className="flex gap-2">
							{["50", "100", "200"].map((v) => (
								<Button
									key={v}
									variant={amount === v ? "secondary" : "outline"}
									size="sm"
									onClick={() => setAmount(v)}
								>
									{v} USDC
								</Button>
							))}
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="topup">Amount</Label>
							<div className="relative">
								<Input
									id="topup"
									type="number"
									min={1}
									value={amount}
									onChange={(e) => setAmount(e.target.value)}
									className="pr-14 tabular"
								/>
								<span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">
									USDC
								</span>
							</div>
							{me.data && (
								<p className="text-xs text-muted-foreground">Balance: {formatUsdc(me.data.usdcBalance)}</p>
							)}
						</div>
					</div>
					<DialogFooter>
						<Button variant="outline" onClick={() => setOpen(false)}>
							Cancel
						</Button>
						<Button onClick={() => topUp.mutate()} disabled={topUp.isPending || !(Number(amount) > 0)}>
							{topUp.isPending && <Loader2 className="animate-spin" />}
							Add {amount || 0} USDC
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
