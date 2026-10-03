import type { Me, SubmissionView, TaskView } from "@scout/shared";
import { REJECT_REASON_LABELS } from "@scout/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ExternalLink, Inbox, Loader2, Share2 } from "lucide-react";
import { toast } from "sonner";
import { PageSkeleton, RequireAccount } from "@/components/account";
import {
	Countdown,
	EmptyState,
	PageHeader,
	Stat,
	StatusBadge,
	secondsUntil,
	useNow,
} from "@/components/bits";
import { ExplorerLink } from "@/components/explorer-link";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { api, errorMessage } from "@/lib/api";
import { formatUsdc, hostOf, netOfFee, timeAgo } from "@/lib/format";
import { useMySubmissions, useScout, useTasks } from "@/lib/queries";
import { useWallet } from "@/lib/wallet";

export const Route = createFileRoute("/scout/submissions")({
	component: () => <RequireAccount kind="scout">{(me) => <MySubmissions me={me} />}</RequireAccount>,
});

function MySubmissions({ me }: { me: Me }) {
	const { address } = useWallet();
	const subs = useMySubmissions();
	const tasks = useTasks();
	const profile = useScout(address ?? "");
	const byRole = new Map((tasks.data ?? []).map((t) => [t.id, t]));
	const list = subs.data ?? [];
	const accepted = list.filter((s) => s.status === "ACCEPTED").length;
	const waiting = list.filter((s) => s.status === "PENDING").length;

	const share = async () => {
		const url = `${location.origin}/scouts/${address}`;
		try {
			await navigator.clipboard.writeText(url);
			toast.success("Profile link copied");
		} catch {
			toast(url);
		}
	};

	return (
		<div className="space-y-8">
			<PageHeader
				title="My submissions"
				description="Every candidate you submitted, and where the money is."
				actions={
					address && (
						<>
							<Link
								to="/scouts/$pubkey"
								params={{ pubkey: address }}
								className={buttonVariants({ variant: "outline" })}
							>
								Public profile
							</Link>
							<Button variant="outline" onClick={share}>
								<Share2 /> Copy link
							</Button>
						</>
					)
				}
			/>
			<Card>
				<CardContent className="grid grid-cols-2 gap-6 md:grid-cols-4">
					<Stat
						label="Total earned"
						value={profile.data ? formatUsdc(profile.data.reputation.totalEarned) : "—"}
						hint={`Balance ${formatUsdc(me.usdcBalance)}`}
					/>
					<Stat label="Accepted" value={`${accepted} / ${list.length}`} />
					<Stat
						label="Acceptance rate"
						value={
							list.length
								? `${Math.round((accepted / Math.max(1, accepted + list.filter((s) => s.status === "REJECTED").length)) * 100)}%`
								: "—"
						}
					/>
					<Stat label="In review" value={waiting} />
				</CardContent>
			</Card>
			{subs.isPending ? (
				<PageSkeleton />
			) : list.length ? (
				<div className="space-y-3">
					{list.map((s) => (
						<SubmissionRow key={s.id} sub={s} task={byRole.get(s.roleId)} />
					))}
				</div>
			) : (
				<EmptyState
					icon={<Inbox className="size-5" />}
					title="No submissions yet"
					action={
						<Link to="/scout" className={buttonVariants()}>
							Browse open tasks
						</Link>
					}
				>
					Pick a task and submit someone from your network.
				</EmptyState>
			)}
		</div>
	);
}

function SubmissionRow({ sub, task }: { sub: SubmissionView; task?: TaskView }) {
	const now = useNow();
	const qc = useQueryClient();
	const expired = sub.status === "PENDING" && secondsUntil(sub.reviewDeadline, now) <= 0;
	const claim = useMutation({
		mutationFn: () => api.settle(sub.id),
		onSuccess: () => void qc.invalidateQueries(),
		onError: (e) => toast.error(errorMessage(e)),
	});
	const payout = task ? formatUsdc(netOfFee(task.bounty, task.feeBps)) : null;

	return (
		<div className="flex flex-col gap-3 rounded-2xl border bg-card p-4 sm:flex-row sm:items-center">
			<div className="min-w-0 flex-1 space-y-0.5">
				<p className="font-medium">{sub.candidateName}</p>
				<p className="truncate text-sm text-muted-foreground">
					{task ? `${task.title} · ${task.companyName}` : "Closed role"} · {timeAgo(sub.submittedAt)}
				</p>
				<a
					href={sub.profileUrl}
					target="_blank"
					rel="noreferrer"
					className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
				>
					{hostOf(sub.profileUrl)} <ExternalLink className="size-3" />
				</a>
			</div>
			<div className="flex shrink-0 flex-col gap-1.5 sm:items-end">
				<div className="flex items-center gap-2">
					{sub.status === "ACCEPTED" && payout && (
						<span className="tabular font-semibold text-success">+{payout}</span>
					)}
					<StatusBadge status={sub.status} />
				</div>
				{sub.status === "PENDING" &&
					(expired ? (
						<Button size="sm" onClick={() => claim.mutate()} disabled={claim.isPending}>
							{claim.isPending && <Loader2 className="animate-spin" />}
							Claim payout
						</Button>
					) : (
						<Countdown deadline={sub.reviewDeadline} prefix="Paid automatically in" />
					))}
				{sub.status === "REJECTED" && sub.rejectReason && (
					<span className="text-xs text-muted-foreground">{REJECT_REASON_LABELS[sub.rejectReason]}</span>
				)}
				{sub.settlementTx && <ExplorerLink signature={sub.settlementTx} />}
			</div>
		</div>
	);
}
