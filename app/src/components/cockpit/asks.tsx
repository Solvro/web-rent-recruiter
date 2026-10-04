import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { ReportFake } from "@/components/call-tools";
import { Avatar } from "@/components/person";
import { ReviewCard } from "@/components/review-queue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/errors";
import { firstName, formatMoney } from "@/lib/format";
import { useWaitingAction } from "@/lib/gigs/actions";
import { gigApi } from "@/lib/gigs/api";
import { callApi } from "@/lib/gigs/calls";
import { useCandidates } from "@/lib/gigs/candidates";
import { useReviewQueue } from "@/lib/gigs/review";
import type { ShortlistItemView as ShortlistItem, ThreadActivity } from "@/lib/gigs/schemas";
import type { Waiting } from "@/lib/gigs/status";
import { plain } from "@/lib/plain";
import { useTransact } from "@/lib/use-transact";
import { cn } from "@/lib/utils";
import { useCandidatesPanel, WithCandidateLinks } from "./candidates";

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
			key: `act-${w.deliverableId ?? w.actions?.[0]?.proposalId ?? w.actions?.[0]?.activityId ?? w.gigId ?? ""}-${w.actions?.[0]?.id ?? ""}`,
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

const card = "space-y-3 rounded-3xl bg-card p-4 shadow-sm ring-1 ring-foreground/10 sm:p-5";

/** A company item exactly as the API describes it: what it waits for, the agent's reasoning, its actions. */
function ActionCard({ w, roleId, thread }: { w: Waiting; roleId: string; thread: ThreadActivity[] }) {
	const run = useWaitingAction(roleId);
	const { byName, open } = useCandidatesPanel();
	const [rejecting, setRejecting] = useState(false);
	const [reason, setReason] = useState("");
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
	// "Your call on Karolina Mazurek: No usable answer to …" → a short title, and the reason underneath.
	const raw = plain(w.what.replace(/^You to /, "").replace(/\s*\(\d+\)$/, ""));
	const proposal = w.actions?.some((x) => x.id === "approve_proposal");
	const [head, ...rest] = proposal ? [raw] : raw.split(/:\s+/);
	const inviting = w.actions?.some((x) => x.id === "invite");
	const baseTitle = rest.length && (head?.length ?? 0) < 80 ? (head ?? raw) : raw;
	// "Decide on Karolina: invite or pass" → the buttons already say that; name the decision instead.
	const title = inviting && !/interview/i.test(baseTitle) ? `${baseTitle} for an interview` : baseTitle;
	const restText = rest.length && baseTitle !== raw ? rest.join(": ") : null;
	const reasonText =
		restText && !/^(invite|pass|accept|reject|yes|no)\b[\w\s,]*$/i.test(restText) ? restText : null;
	const fullDetail = why?.detail && !raw.includes(plain(why.detail).slice(0, 40)) ? plain(why.detail) : null;
	// "From Andreea Popescu. Karolina …" → who sourced them on a quiet line of its own, the reasoning as prose.
	const from = fullDetail?.match(/^From ([^.]+)\.\s*/);
	const detail = from ? fullDetail?.slice(from[0].length) || null : fullDetail;
	const person = [...byName.keys()].find((n) => raw.includes(n));
	const candidates = useCandidates(roleId);
	const fit = person ? candidates.data?.find((c) => c.name === person)?.score : null;
	const source =
		from?.[1] ?? (person ? candidates.data?.find((c) => c.name === person)?.sourcedBy.displayName : null);
	const decides = (w.actions ?? []).filter((x) => x.id === "decide");
	const generic = decides.length === 1 && !/accept|take|yes|reject|no\b|pass/i.test(decides[0]?.label ?? "");
	const others = (w.actions ?? []).filter((x) => !(generic && x.id === "decide"));
	const decide = decides[0];
	return (
		<article className={card}>
			<p className="type-label text-primary">Needs you</p>
			<p>
				<WithCandidateLinks text={title.charAt(0).toUpperCase() + title.slice(1)} />
			</p>
			{(source || fit != null) && person && (
				<p className="type-label text-muted-foreground">
					{[source && `Sourced by ${source}`, fit != null && `fit ${fit}`].filter(Boolean).join(" · ")}
				</p>
			)}
			{reasonText && <p className="type-label text-muted-foreground">{reasonText}</p>}
			{w.actions?.some((x) => x.id === "attended") && (
				<p className="type-label text-muted-foreground">
					Set up the interview directly with them. Yes pays the recruiters what's still held; no returns it to
					your budget.
				</p>
			)}
			{detail && <p className="type-label text-muted-foreground">{detail}</p>}
			{rejecting && (
				<Input
					value={reason}
					onChange={(e) => setReason(e.target.value)}
					placeholder="Why? The recruiter sees this."
					aria-label="Why you reject it"
					className="h-9"
					autoFocus
				/>
			)}
			<div className="flex flex-wrap items-center gap-2">
				{generic && decide && !rejecting && (
					<Button onClick={() => run.mutate({ action: decide, decision: "accept" })} disabled={run.isPending}>
						{run.isPending && run.variables?.decision === "accept" && <Loader2 className="animate-spin" />}
						Accept and pay{decide.bounty ? ` ${formatMoney(decide.bounty)}` : ""}
					</Button>
				)}
				{generic && decide && (
					<Button
						variant={rejecting ? "outline" : "ghost"}
						onClick={() =>
							rejecting
								? run.mutate({
										action: decide,
										decision: "reject",
										reason: reason.trim() || "Not good enough for this role",
									})
								: setRejecting(true)
						}
						disabled={run.isPending}
					>
						{run.isPending && run.variables?.decision === "reject" && <Loader2 className="animate-spin" />}
						{rejecting ? "Reject" : "Reject…"}
					</Button>
				)}
				{others.map((action, i) => (
					<Button
						key={`${action.id}-${action.label}`}
						variant={!generic && i === 0 ? "default" : "ghost"}
						onClick={() => run.mutate({ action })}
						disabled={run.isPending}
					>
						{run.isPending && run.variables?.action === action && <Loader2 className="animate-spin" />}
						{action.label}
					</Button>
				))}
				{person && (
					<button
						type="button"
						onClick={() => open(byName.get(person))}
						className="ml-auto type-label text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
					>
						See the answers
					</button>
				)}
			</div>
		</article>
	);
}

function FinalistCard({ item, roleId }: { item: ShortlistItem; roleId: string }) {
	const qc = useQueryClient();
	const { transact } = useTransact();
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
						onReport={async (why) => {
							const res = await callApi.reportCandidate(roleId, item.candidateId, why);
							if (res.unsignedTx)
								await transact(res.unsignedTx, { pending: "Reporting…", success: "Reported." });
						}}
					/>
				</span>
			</div>
		</article>
	);
}

/** After the invite: the one thing left to tell the agent. Yes pays what is held; no returns it to the budget. */
function AttendedCard({ item, roleId }: { item: ShortlistItem; roleId: string }) {
	const run = useWaitingAction(roleId);
	const name = firstName(item.name);
	const act = (id: "attended" | "no_show") =>
		run.mutate({ action: { id, label: id, candidateId: item.candidateId } });
	return (
		<article className={card}>
			<div className="flex items-center gap-3">
				<Avatar name={item.name} src={item.card.avatarUrl} />
				<p className="flex-1">Did {name} come to the interview?</p>
			</div>
			<p className="type-label text-muted-foreground">
				You invited {name}; set up the interview directly with them. Tell me how it went: yes pays the
				recruiters what's still held, no returns it to your budget.
			</p>
			<div className="flex flex-wrap gap-2">
				<Button onClick={() => act("attended")} disabled={run.isPending}>
					{run.isPending && run.variables?.action.id === "attended" && <Loader2 className="animate-spin" />}
					Yes, {name} came
				</Button>
				<Button variant="ghost" onClick={() => act("no_show")} disabled={run.isPending}>
					{run.isPending && run.variables?.action.id === "no_show" && <Loader2 className="animate-spin" />}
					{name} didn't come
				</Button>
			</div>
		</article>
	);
}

/** Fit as five bars: green when strong, amber when borderline. */
function Meter({ score }: { score: number }) {
	const filled = Math.round(score / 20);
	return (
		<span className="flex items-end gap-0.5" role="img" aria-label={`Fit ${score} of 100`}>
			{[0, 1, 2, 3, 4].map((i) => (
				<span
					key={i}
					className={cn(
						"w-1.5 rounded-full",
						i < filled ? (score >= 75 ? "bg-success" : "bg-warning") : "bg-muted",
					)}
					style={{ height: 6 + i * 3 }}
				/>
			))}
		</span>
	);
}
