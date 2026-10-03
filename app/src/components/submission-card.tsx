import type { AgentReview, Criteria, RejectReason, RoleSummary, SubmissionView } from "@scout/shared";
import { REJECT_REASON_LABELS } from "@scout/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
	AlertTriangle,
	Bot,
	Check,
	ChevronDown,
	CircleHelp,
	ExternalLink,
	Loader2,
	Minus,
	X,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Countdown, ScoreBadge, StatusBadge, secondsUntil, useNow } from "@/components/bits";
import { criterionLabel } from "@/components/criteria";
import { ExplorerLink } from "@/components/explorer-link";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { api, errorMessage } from "@/lib/api";
import { formatUsdc, hostOf, netOfFee, timeAgo } from "@/lib/format";
import { useTransact } from "@/lib/use-transact";
import { cn } from "@/lib/utils";

const VERDICT = {
	MET: { icon: Check, className: "bg-success/10 text-success", label: "Met" },
	PARTIAL: { icon: Minus, className: "bg-warning/15 text-warning-foreground", label: "Partly" },
	NOT_MET: { icon: X, className: "bg-destructive/10 text-destructive", label: "Not met" },
	UNKNOWN: { icon: CircleHelp, className: "bg-muted text-muted-foreground", label: "Unknown" },
};
// On deal-breakers the agent reports MET when the candidate triggers it.
const DEAL_BREAKER = {
	MET: { icon: AlertTriangle, className: "bg-destructive/10 text-destructive", label: "Triggered" },
	PARTIAL: { icon: AlertTriangle, className: "bg-warning/15 text-warning-foreground", label: "Possibly" },
	NOT_MET: { icon: Check, className: "bg-muted text-muted-foreground", label: "Clear" },
	UNKNOWN: { icon: CircleHelp, className: "bg-muted text-muted-foreground", label: "Unknown" },
};

function Verdicts({ review, criteria }: { review: AgentReview; criteria: Criteria }) {
	const dealIds = new Set(criteria.dealBreakers.map((c) => c.id));
	return (
		<ul className="grid gap-1.5 sm:grid-cols-2">
			{review.verdicts.map((v) => {
				const style = (dealIds.has(v.criterionId) ? DEAL_BREAKER : VERDICT)[v.verdict];
				return (
					<li key={v.criterionId} className="flex gap-2.5 rounded-xl border p-2.5">
						<span
							className={cn("mt-0.5 grid size-5 shrink-0 place-items-center rounded-md", style.className)}
						>
							<style.icon className="size-3" />
						</span>
						<div className="min-w-0 space-y-0.5">
							<p className="text-sm font-medium">
								{criterionLabel(criteria, v.criterionId)}
								<span className="ml-1.5 text-xs font-normal text-muted-foreground">{style.label}</span>
							</p>
							<p className="text-xs text-muted-foreground">{v.reasoning}</p>
						</div>
					</li>
				);
			})}
		</ul>
	);
}

function useReview(sub: SubmissionView) {
	return useQuery({
		queryKey: ["review", sub.id],
		queryFn: () => api.review(sub.id),
		enabled: !sub.review,
		staleTime: Number.POSITIVE_INFINITY,
		retry: 2,
	});
}

/** Company view of one submission: agent score, per-criterion verdicts, decision. */
export function SubmissionCard({
	sub,
	role,
	criteria,
}: {
	sub: SubmissionView;
	role: RoleSummary;
	criteria: Criteria;
}) {
	const reviewQuery = useReview(sub);
	const review = { data: sub.review ?? reviewQuery.data, isError: !sub.review && reviewQuery.isError };
	const queryClient = useQueryClient();
	const [open, setOpen] = useState(sub.status === "PENDING");
	const { transact, pending } = useTransact();
	const now = useNow();
	const expired = sub.status === "PENDING" && secondsUntil(sub.reviewDeadline, now) <= 0;
	const net = netOfFee(role.bounty, role.feeBps);

	const accept = useMutation({
		mutationFn: async () => {
			const { unsignedTx } = await api.decide(sub.id, { decision: "accept" });
			await transact(
				unsignedTx,
				`${sub.candidateName} accepted. ${sub.scout.displayName} received ${formatUsdc(net)}.`,
			);
		},
		onError: (e) => toast.error(errorMessage(e)),
	});
	const settle = useMutation({
		mutationFn: () => api.settle(sub.id),
		onSuccess: (res) => {
			void queryClient.invalidateQueries();
			toast.success(`Auto-accepted. ${sub.scout.displayName} received ${formatUsdc(net)}.`, {
				description: <ExplorerLink signature={res.signature} />,
			});
		},
		onError: (e) => toast.error(errorMessage(e)),
	});

	return (
		<article className="overflow-hidden rounded-2xl border bg-card">
			<button
				type="button"
				onClick={() => setOpen((o) => !o)}
				className="flex w-full items-center gap-4 p-4 text-left hover:bg-muted/40"
				aria-expanded={open}
			>
				<div className="w-32 shrink-0">
					{review.data ? (
						<ScoreBadge review={review.data} />
					) : review.isError ? (
						<span className="text-xs text-muted-foreground">No score</span>
					) : (
						<span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
							<Loader2 className="size-3.5 animate-spin" /> Scoring
						</span>
					)}
				</div>
				<div className="min-w-0 flex-1">
					<p className="truncate font-medium">{sub.candidateName}</p>
					<p className="truncate text-sm text-muted-foreground">
						by {sub.scout.displayName} · {timeAgo(sub.submittedAt)}
					</p>
				</div>
				<div className="hidden shrink-0 flex-col items-end gap-1 sm:flex">
					<StatusBadge status={sub.status} />
					{sub.status === "PENDING" && <Countdown deadline={sub.reviewDeadline} />}
				</div>
				<ChevronDown
					className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
				/>
			</button>

			{open && (
				<div className="space-y-4 border-t p-4">
					<div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
						<a
							href={sub.profileUrl}
							target="_blank"
							rel="noreferrer"
							className="inline-flex items-center gap-1 text-primary hover:underline"
						>
							{hostOf(sub.profileUrl)} <ExternalLink className="size-3" />
						</a>
						<Link
							to="/scouts/$pubkey"
							params={{ pubkey: sub.scout.wallet }}
							className="text-muted-foreground hover:text-foreground"
						>
							Scout profile →
						</Link>
						<span className="sm:hidden">
							<StatusBadge status={sub.status} />
						</span>
					</div>
					<p className="rounded-xl bg-muted/50 p-3 text-sm whitespace-pre-line">{sub.notes}</p>

					{review.data ? (
						<div className="space-y-3">
							<p className="flex items-start gap-2 text-sm">
								<Bot className="mt-0.5 size-4 shrink-0 text-primary" />
								{review.data.summary}
							</p>
							<Verdicts review={review.data} criteria={criteria} />
						</div>
					) : review.isError ? (
						<p className="text-sm text-muted-foreground">
							The agent couldn't score this candidate. Decide from the notes.
						</p>
					) : (
						<div className="space-y-2">
							<p className="inline-flex items-center gap-2 text-sm text-muted-foreground">
								<Bot className="size-4 animate-pulse text-primary" /> The agent is checking each criterion…
							</p>
							<div className="grid gap-1.5 sm:grid-cols-2">
								{[0, 1, 2, 3].map((i) => (
									<Skeleton key={i} className="h-14 rounded-xl" />
								))}
							</div>
						</div>
					)}

					{sub.status === "PENDING" ? (
						<div className="flex flex-wrap items-center gap-2 border-t pt-4">
							{expired ? (
								<>
									<Button onClick={() => settle.mutate()} disabled={settle.isPending}>
										{settle.isPending && <Loader2 className="animate-spin" />}
										Settle now · pay {formatUsdc(net)}
									</Button>
									<p className="text-xs text-muted-foreground">
										The review window ended, so this candidate counts as accepted. Anyone can trigger the
										payout.
									</p>
								</>
							) : (
								<>
									<Button onClick={() => accept.mutate()} disabled={accept.isPending || pending}>
										{accept.isPending && <Loader2 className="animate-spin" />}
										Accept · pay {formatUsdc(net)}
									</Button>
									<RejectButton sub={sub} />
									<span className="ml-auto">
										<Countdown deadline={sub.reviewDeadline} />
									</span>
								</>
							)}
						</div>
					) : (
						<div className="flex flex-wrap items-center gap-3 border-t pt-4 text-sm text-muted-foreground">
							{sub.status === "ACCEPTED" ? (
								<span>
									{sub.scout.displayName} was paid {formatUsdc(net)}.
								</span>
							) : (
								<span>
									Rejected:{" "}
									{sub.rejectReason
										? REJECT_REASON_LABELS[sub.rejectReason].toLowerCase()
										: "no reason given"}
									.
								</span>
							)}
							<ExplorerLink signature={sub.settlementTx} />
						</div>
					)}
				</div>
			)}
		</article>
	);
}

const REASONS = Object.entries(REJECT_REASON_LABELS).map(([value, label]) => ({ value, label }));

function RejectButton({ sub }: { sub: SubmissionView }) {
	const [open, setOpen] = useState(false);
	const [reason, setReason] = useState<RejectReason>("NOT_MATCHING");
	const { transact } = useTransact();
	const reject = useMutation({
		mutationFn: async () => {
			const { unsignedTx } = await api.decide(sub.id, { decision: "reject", reasonCode: reason });
			const ok = await transact(unsignedTx, `${sub.candidateName} rejected. The budget stays in the role.`);
			if (ok) setOpen(false);
		},
		onError: (e) => toast.error(errorMessage(e)),
	});
	return (
		<>
			<Button variant="outline" onClick={() => setOpen(true)}>
				Reject
			</Button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Reject {sub.candidateName}?</DialogTitle>
						<DialogDescription>
							{sub.scout.displayName} isn't paid for this candidate and sees the reason you pick.
						</DialogDescription>
					</DialogHeader>
					<Select value={reason} onValueChange={(v) => v && setReason(v as RejectReason)} items={REASONS}>
						<SelectTrigger className="w-full" aria-label="Reason">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{REASONS.map((r) => (
								<SelectItem key={r.value} value={r.value}>
									{r.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<DialogFooter>
						<Button variant="outline" onClick={() => setOpen(false)}>
							Cancel
						</Button>
						<Button variant="destructive" onClick={() => reject.mutate()} disabled={reject.isPending}>
							{reject.isPending && <Loader2 className="animate-spin" />}
							Reject candidate
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
