import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { ReportFake } from "@/components/call-tools";
import { Avatar } from "@/components/person";
import { ReviewCard } from "@/components/review-queue";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/errors";
import { firstName } from "@/lib/format";
import { useWaitingAction } from "@/lib/gigs/actions";
import { gigApi } from "@/lib/gigs/api";
import { callApi } from "@/lib/gigs/calls";
import { useReviewQueue } from "@/lib/gigs/review";
import type { ShortlistItemView as ShortlistItem, ThreadActivity } from "@/lib/gigs/schemas";
import type { Waiting } from "@/lib/gigs/status";
import { useTransact } from "@/lib/use-transact";
import { WithCandidateLinks } from "./candidates";
import { Meter } from "./decisions";

/**
 * Everything that waits for the company, as cards. The cockpit pins only the first one above the composer (with
 * "1 of 3" to page through); when nothing needs Hanna, nothing is shown.
 */
export function useAsks({
	roleId,
	waiting,
	shortlist,
	thread,
}: {
	roleId: string;
	waiting: Waiting[];
	shortlist: ShortlistItem[];
	thread: ThreadActivity[];
}): { key: string; node: ReactNode }[] {
	const queue = useReviewQueue(roleId, true);
	// The API's own actions win: a waiting item that carries them is shown as-is, and the cards we build from the
	// shortlist skip candidates it already covers.
	const withActions = waiting.filter((w) => w.actions?.length);
	const covered = new Set(
		withActions
			.flatMap((w) => [w.deliverableId, ...(w.actions ?? []).map((x) => x.candidateId)])
			.filter(Boolean),
	);
	return [
		...withActions.map((w) => ({
			key: `act-${w.deliverableId ?? w.actions?.[0]?.activityId ?? w.gigId ?? ""}-${w.actions?.[0]?.id ?? ""}`,
			node: <ActionCard w={w} roleId={roleId} thread={thread} />,
		})),
		...(queue.data ?? [])
			.filter((item) => !covered.has(item.id))
			.map((item) => ({ key: `review-${item.id}`, node: <ReviewCard item={item} /> })),
		...shortlist
			.filter((s) => s.decision === "NONE" && !covered.has(s.candidateId))
			.map((s) => ({ key: `finalist-${s.candidateId}`, node: <FinalistCard item={s} roleId={roleId} /> })),
		...shortlist
			.filter((s) => s.decision === "INVITED" && !covered.has(s.candidateId))
			.map((s) => ({ key: `attended-${s.candidateId}`, node: <AttendedCard item={s} roleId={roleId} /> })),
	];
}

export function Pinned({ asks }: { asks: { key: string; node: ReactNode }[] }) {
	// The pager follows the item, not its position: a refetch that reorders the list keeps the same card shown.
	const [selected, setSelected] = useState<string | null>(null);
	if (!asks.length) return null;
	const found = asks.findIndex((x) => x.key === selected);
	const at = found >= 0 ? found : 0;
	const setI = (n: number) => setSelected(asks[n]?.key ?? null);
	return (
		<div className="space-y-2 animate-in fade-in slide-in-from-bottom-2">
			{asks.length > 1 && (
				<div className="flex items-center justify-between type-label text-muted-foreground">
					<span>
						Needs you · {at + 1} of {asks.length}
					</span>
					<span className="flex gap-3">
						<button
							type="button"
							disabled={at === 0}
							onClick={() => setI(at - 1)}
							className="hover:text-foreground disabled:opacity-40"
						>
							Previous
						</button>
						<button
							type="button"
							disabled={at === asks.length - 1}
							onClick={() => setI(at + 1)}
							className="hover:text-foreground disabled:opacity-40"
						>
							Next
						</button>
					</span>
				</div>
			)}
			<div key={asks[at]?.key}>{asks[at]?.node}</div>
		</div>
	);
}

const card = "space-y-3 rounded-3xl bg-card p-5 shadow-sm ring-1 ring-foreground/10";

/** A company item exactly as the API describes it: what it waits for, the agent's reasoning, its actions. */
function ActionCard({ w, roleId, thread }: { w: Waiting; roleId: string; thread: ThreadActivity[] }) {
	const run = useWaitingAction(roleId);
	// The reasoning for exactly this item: its activity (agent questions) or its deliverable's review line.
	const activityId = w.actions?.find((x) => x.activityId)?.activityId;
	const why = activityId
		? thread.find((t) => t.id === activityId)
		: w.deliverableId
			? thread.findLast(
					(t) =>
						t.deliverableId === w.deliverableId &&
						!!t.detail &&
						["ESCALATED", "REVIEWED", "DELIVERY_REJECTED", "DELIVERY_ACCEPTED", "SHORTLISTED"].includes(
							t.kind,
						),
				)
			: undefined;
	const title = w.what.replace(/^You to /, "").replace(/\s*\(\d+\)$/, "");
	return (
		<article className={card}>
			<p className="type-label text-primary">Needs you</p>
			<p>
				<WithCandidateLinks text={title.charAt(0).toUpperCase() + title.slice(1)} />
			</p>
			{why?.detail && <p className="type-label text-muted-foreground">{why.detail}</p>}
			<div className="flex flex-wrap gap-2">
				{(w.actions ?? []).map((action, i) => (
					<Button
						key={`${action.id}-${action.label}`}
						variant={i === 0 ? "default" : "ghost"}
						onClick={() => run.mutate({ action })}
						disabled={run.isPending}
					>
						{run.isPending && run.variables?.action === action && <Loader2 className="animate-spin" />}
						{action.label}
					</Button>
				))}
			</div>
		</article>
	);
}

function FinalistCard({ item, roleId }: { item: ShortlistItem; roleId: string }) {
	const qc = useQueryClient();
	const decide = useMutation({
		mutationFn: async (decision: "invite" | "pass") => {
			await gigApi.decide(roleId, item.candidateId, decision);
			await qc.invalidateQueries();
		},
		onError: (e) => toast.error(errorMessage(e)),
	});
	const line = [item.card.currentTitle, item.card.currentCompany].filter(Boolean).join(" at ");
	return (
		<article className={card}>
			<p className="type-label text-success">Finalist</p>
			<div className="flex items-center gap-3">
				<Avatar name={item.name} src={item.card.avatarUrl} />
				<div className="min-w-0 flex-1">
					<a href={item.profileUrl} target="_blank" rel="noreferrer" className="hover:text-primary">
						{item.name}
					</a>
					<p className="truncate type-label text-muted-foreground">{line}</p>
				</div>
				{item.score !== null && <Meter score={item.score} />}
			</div>
			{item.screening && (
				<p className="line-clamp-2 type-label text-muted-foreground">“{item.screening.summary}”</p>
			)}
			<div className="flex flex-wrap items-center gap-2">
				<Button onClick={() => decide.mutate("invite")} disabled={decide.isPending}>
					{decide.isPending && decide.variables === "invite" && <Loader2 className="animate-spin" />}
					Invite to interview
				</Button>
				<Button variant="ghost" onClick={() => decide.mutate("pass")} disabled={decide.isPending}>
					Pass
				</Button>
				<span className="ml-auto">
					<ReportFake
						label="Report a problem"
						onReport={(reason) => callApi.reportCandidate(roleId, item.candidateId, reason)}
					/>
				</span>
			</div>
		</article>
	);
}

function AttendedCard({ item, roleId }: { item: ShortlistItem; roleId: string }) {
	const qc = useQueryClient();
	const { transact, pending } = useTransact();
	const attended = useMutation({
		mutationFn: async () => {
			const { unsignedTx } = await gigApi.decide(roleId, item.candidateId, "attended");
			if (unsignedTx)
				await transact(unsignedTx, {
					pending: "Saving…",
					success: `The recruiters who screened ${firstName(item.name)} got the rest of their payment.`,
					receipt: true,
				});
			await qc.invalidateQueries();
		},
		onError: (e) => toast.error(errorMessage(e)),
	});
	return (
		<article className={card}>
			<div className="flex items-center gap-3">
				<Avatar name={item.name} src={item.card.avatarUrl} />
				<p className="flex-1">Did {firstName(item.name)} come to the interview?</p>
			</div>
			<p className="type-label text-muted-foreground">
				Saying yes pays the recruiters the part they are still owed.
			</p>
			<Button onClick={() => attended.mutate()} disabled={attended.isPending || pending}>
				{attended.isPending && <Loader2 className="animate-spin" />}
				Yes, they came
			</Button>
		</article>
	);
}
