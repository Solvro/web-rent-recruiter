import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, MessageCircleQuestion, X } from "lucide-react";
import { toast } from "sonner";
import { Chip } from "@/components/bits";
import { Avatar } from "@/components/person";
import { ReviewQueue } from "@/components/review-queue";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/errors";
import { gigApi } from "@/lib/gigs/api";
import { useReviewQueue } from "@/lib/gigs/review";
import type { ShortlistItemView as ShortlistItem, ThreadActivity } from "@/lib/gigs/schemas";
import { useDecideDelivery, type Waiting } from "@/lib/gigs/status";
import { useTransact } from "@/lib/use-transact";
import { cn } from "@/lib/utils";

export function Meter({ score }: { score: number }) {
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

/**
 * Everything that waits for the company, pinned in one place: the agent's questions, deliveries to review,
 * finalists to decide on. Nothing that needs Hanna is buried in the thread.
 */
export function NeedsYou({
	roleId,
	waiting,
	shortlist,
	thread,
}: {
	roleId: string;
	/** roles.status waitingOn entries where who === "company" */
	waiting: Waiting[];
	shortlist: ShortlistItem[];
	thread: ThreadActivity[];
}) {
	const queue = useReviewQueue(roleId, true);
	const inQueue = new Set((queue.data ?? []).map((q) => q.id));
	const pending = shortlist.filter((s) => s.decision === "NONE");
	const decided = shortlist.filter((s) => s.decision !== "NONE");
	// Questions about a delivery get an approval card; finalists and manual reviews have their own cards below.
	const asks = waiting.filter((w) => w.deliverableId && !inQueue.has(w.deliverableId));
	const count = asks.length + pending.length + inQueue.size;
	return (
		<section className="space-y-3" aria-label="Needs you">
			<p className="flex items-center gap-2 type-label text-muted-foreground">
				Needs you
				{count > 0 && (
					<span
						key={count}
						className="grid size-5 place-items-center rounded-full bg-primary text-primary-foreground animate-in zoom-in-50"
					>
						{count}
					</span>
				)}
			</p>
			{asks.map((w) => (
				<AskCard key={w.deliverableId} w={w} thread={thread} />
			))}
			<ReviewQueue roleId={roleId} />
			{pending.map((item) => (
				<ShortlistCard key={item.candidateId} item={item} roleId={roleId} />
			))}
			{count === 0 && (
				<p className="rounded-3xl border border-dashed p-4 type-label text-muted-foreground">
					Nothing needs you right now. When your agent has a question or a finalist, it shows up here.
				</p>
			)}
			{decided.length > 0 && (
				<ul className="divide-y rounded-3xl bg-card px-4 ring-1 ring-foreground/5">
					{decided.map((s) => (
						<Decided key={s.candidateId} item={s} roleId={roleId} />
					))}
				</ul>
			)}
		</section>
	);
}

/** The agent asks about a borderline delivery: its reasoning (from the thread) and a one-click answer. */
function AskCard({ w, thread }: { w: Waiting; thread: ThreadActivity[] }) {
	const decide = useDecideDelivery();
	const asked = thread.findLast((t) => t.deliverableId === w.deliverableId && t.kind === "ESCALATED");
	const score = Number(w.what.match(/\((\d+)\)/)?.[1] ?? Number.NaN);
	const id = w.deliverableId ?? "";
	return (
		<article className="space-y-3 rounded-3xl bg-card p-5 shadow-sm ring-1 ring-primary/30 animate-in fade-in slide-in-from-bottom-2">
			<p className="inline-flex items-center gap-1.5 type-label text-primary">
				<MessageCircleQuestion className="size-3.5" /> Your agent asks
			</p>
			<div className="flex items-start gap-3">
				<p className="flex-1">
					{w.what
						.replace(/^You to /, "")
						.replace(/\s*\(\d+\)$/, "")
						.replace(/^\w/, (c) => c.toUpperCase())}
				</p>
				{Number.isFinite(score) && <Meter score={score} />}
			</div>
			{asked?.detail && <p className="text-muted-foreground">{asked.detail}</p>}
			<div className="flex flex-wrap gap-2">
				<Button onClick={() => decide.mutate({ id, accept: true })} disabled={decide.isPending}>
					{decide.isPending && decide.variables?.accept ? <Loader2 className="animate-spin" /> : <Check />}
					Yes, take it
				</Button>
				<Button
					variant="ghost"
					onClick={() => decide.mutate({ id, accept: false })}
					disabled={decide.isPending}
				>
					<X /> No
				</Button>
			</div>
			{decide.isError && <p className="type-label text-destructive">{errorMessage(decide.error)}</p>}
		</article>
	);
}

export function ShortlistCard({ item, roleId }: { item: ShortlistItem; roleId: string }) {
	const qc = useQueryClient();
	const decide = useMutation({
		mutationFn: async (decision: "invite" | "pass") => {
			await gigApi.decide(roleId, item.candidateId, decision);
			toast(
				decision === "invite"
					? `${item.name} invited. Mark them when they come to the interview.`
					: `You passed on ${item.name}`,
			);
			await qc.invalidateQueries();
		},
		onError: (e) => toast.error(errorMessage(e)),
	});
	const titleLine = [item.card.currentTitle, item.card.currentCompany].filter(Boolean).join(" at ");
	return (
		<article className="space-y-4 rounded-3xl bg-card p-5 shadow-sm ring-1 ring-success/40 animate-in fade-in slide-in-from-bottom-2">
			<p className="type-label text-success">Finalist · ready for your decision</p>
			<div className="flex items-start gap-3">
				<Avatar name={item.name} src={item.card.avatarUrl} size="md" />
				<div className="min-w-0 flex-1">
					<a
						href={item.profileUrl}
						target="_blank"
						rel="noreferrer"
						className="hover:text-primary hover:underline"
					>
						{item.name}
					</a>
					<p className="type-label text-muted-foreground">
						{titleLine}
						{item.card.location && ` · ${item.card.location}`}
					</p>
				</div>
				{item.score !== null && (
					<span className="flex shrink-0 items-center gap-1.5">
						<Meter score={item.score} />
						<span className="type-label tabular">{item.score}</span>
					</span>
				)}
			</div>
			{item.screening && (
				<div className="space-y-1">
					<p className="line-clamp-3">“{item.screening.summary}”</p>
					<p className="type-label text-muted-foreground">Screening call by {item.screening.recruiter}</p>
				</div>
			)}
			{item.reference ? (
				<div className="space-y-1">
					<p className="line-clamp-2 text-muted-foreground">“{item.reference.summary}”</p>
					<p className="type-label text-muted-foreground">Reference check by {item.reference.recruiter}</p>
				</div>
			) : (
				<p className="inline-flex items-center gap-2 type-label text-muted-foreground">
					<Loader2 className="size-3.5 animate-spin" />{" "}
					<span className="shimmer">Reference check in progress</span>
				</p>
			)}
			<div className="flex flex-wrap gap-2">
				<Button onClick={() => decide.mutate("invite")} disabled={decide.isPending}>
					{decide.isPending && decide.variables === "invite" && <Loader2 className="animate-spin" />}
					Invite to interview
				</Button>
				<Button variant="ghost" onClick={() => decide.mutate("pass")} disabled={decide.isPending}>
					Pass
				</Button>
			</div>
		</article>
	);
}

const DECIDED = {
	INVITED: { label: "Invited", tone: "accent" },
	ATTENDED: { label: "Came to the interview", tone: "good" },
	PASSED: { label: "Passed", tone: "neutral" },
	NONE: { label: "", tone: "neutral" },
} as const;

/** After the invite: one more fact to confirm. It releases what the recruiters are still owed. */
function Decided({ item, roleId }: { item: ShortlistItem; roleId: string }) {
	const qc = useQueryClient();
	const { transact, pending } = useTransact();
	const attended = useMutation({
		mutationFn: async () => {
			const { unsignedTx } = await gigApi.decide(roleId, item.candidateId, "attended");
			if (unsignedTx)
				await transact(unsignedTx, {
					pending: "Saving…",
					success: `Done. The recruiters who screened ${item.name} got the rest of their payment.`,
					receipt: true,
				});
			await qc.invalidateQueries();
		},
		onError: (e) => toast.error(errorMessage(e)),
	});
	const d = DECIDED[item.decision];
	return (
		<li className="flex flex-wrap items-center gap-3 py-3">
			<Avatar name={item.name} src={item.card.avatarUrl} size="sm" />
			<span className="flex-1">{item.name}</span>
			<Chip tone={d.tone}>{d.label}</Chip>
			{item.decision === "INVITED" && (
				<Button
					size="sm"
					variant="outline"
					onClick={() => attended.mutate()}
					disabled={attended.isPending || pending}
				>
					{attended.isPending && <Loader2 className="animate-spin" />}
					Came to the interview
				</Button>
			)}
		</li>
	);
}
