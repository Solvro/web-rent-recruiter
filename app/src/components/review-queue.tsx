import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Avatar } from "@/components/person";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "@/lib/errors";
import { GIG_TYPES } from "@/lib/gig-types";
import {
	REJECT_REASONS,
	type RejectCode,
	type ReviewItem,
	reviewApi,
	useReviewQueue,
} from "@/lib/gigs/review";
import { useTransact } from "@/lib/use-transact";
import { cn } from "@/lib/utils";

/**
 * Deliveries waiting for the company (when it reviews by hand) and recruiters' requests to look again at a
 * rejection. Each decision is signed by the company; the reason goes to the recruiter.
 */
export function ReviewQueue({ roleId }: { roleId: string }) {
	const queue = useReviewQueue(roleId, true);
	const items = queue.data ?? [];
	if (!items.length) return null;
	return (
		<section className="space-y-4">
			<p className="type-label text-muted-foreground">Waiting for your review</p>
			{items.map((item) => (
				<ReviewCard key={item.id} item={item} />
			))}
		</section>
	);
}

function What({ item }: { item: ReviewItem }) {
	const d = item.deliverable;
	if (d.type === "SOURCING")
		return (
			<div className="space-y-2">
				<a
					href={d.profileUrl}
					target="_blank"
					rel="noreferrer"
					className="inline-flex items-center gap-1.5 hover:text-primary hover:underline"
				>
					{d.name} <ExternalLink className="size-3.5" />
				</a>
				<p className="text-muted-foreground">{d.notes}</p>
			</div>
		);
	return (
		<ol className="list-decimal space-y-1.5 pl-5 text-muted-foreground">
			{d.answers.map((a) => (
				<li key={a.questionId}>{a.answer}</li>
			))}
		</ol>
	);
}

export function ReviewCard({ item }: { item: ReviewItem }) {
	const qc = useQueryClient();
	const { transact, pending } = useTransact();
	const [rejecting, setRejecting] = useState(false);
	const [code, setCode] = useState<RejectCode>("NOT_MATCHING");
	const [reason, setReason] = useState("");
	const info = GIG_TYPES[item.gigType];
	const appeal = item.awaiting === "appeal";
	const decide = useMutation({
		mutationFn: async (action: "accept" | "reject") => {
			const { unsignedTx } = appeal
				? await reviewApi.decideAppeal(
						item.id,
						action === "accept" ? "overturn" : "uphold",
						reason.trim() || undefined,
					)
				: await reviewApi.decide(
						item.id,
						action,
						action === "accept" ? "Accepted by the company" : reason.trim(),
						action === "reject" ? code : undefined,
					);
			if (!unsignedTx) {
				toast(action === "accept" ? "Done." : `Kept rejected. ${item.recruiter.displayName} sees your note.`);
				await qc.invalidateQueries();
				return;
			}
			await transact(unsignedTx, {
				pending: action === "accept" ? "Accepting…" : "Saving…",
				success:
					action === "accept"
						? `Accepted. ${item.recruiter.displayName} gets paid.`
						: `Sent your reason to ${item.recruiter.displayName}.`,
				receipt: true,
			});
			await qc.invalidateQueries();
		},
		onError: (e) => toast.error(errorMessage(e)),
	});
	const busy = decide.isPending || pending;

	return (
		<article className="space-y-4 rounded-3xl bg-card p-5 shadow-sm ring-1 ring-foreground/10">
			<div className="flex items-center gap-3">
				<Avatar name={item.recruiter.displayName} size="sm" />
				<p className="flex-1">
					{item.recruiter.displayName} <span className="text-muted-foreground">· {info.name}</span>
				</p>
			</div>
			{appeal && item.appeal && (
				<div className="space-y-1 rounded-3xl bg-muted p-4">
					<p>“{item.appeal.reason}”</p>
					<p className="type-label text-muted-foreground">
						{item.recruiter.displayName} asks you to look again. Rejected because:{" "}
						{item.review?.reasons[0] ?? "no reason given"}
					</p>
				</div>
			)}
			<What item={item} />
			{rejecting && (
				<div className="space-y-3">
					<fieldset className="flex flex-wrap gap-2">
						<legend className="sr-only">Reason</legend>
						{REJECT_REASONS.map((r) => (
							<label
								key={r.code}
								className={cn(
									"cursor-pointer rounded-full px-3 py-1 type-label ring-1",
									code === r.code ? "bg-foreground text-background ring-foreground" : "ring-border",
								)}
							>
								<input
									type="radio"
									name={`reason-${item.id}`}
									checked={code === r.code}
									onChange={() => setCode(r.code)}
									className="sr-only"
								/>
								{r.label}
							</label>
						))}
					</fieldset>
					<Textarea
						value={reason}
						onChange={(e) => setReason(e.target.value)}
						placeholder="Why? The recruiter sees this."
						aria-label="Why you reject it"
						className="min-h-20 rounded-3xl p-4"
					/>
				</div>
			)}
			<div className="flex flex-wrap gap-3">
				<Button onClick={() => decide.mutate("accept")} disabled={busy}>
					{decide.isPending && decide.variables === "accept" && <Loader2 className="animate-spin" />}
					Accept and pay
				</Button>
				{appeal ? (
					<Button variant="ghost" onClick={() => decide.mutate("reject")} disabled={busy}>
						Keep rejected
					</Button>
				) : rejecting ? (
					<Button variant="outline" onClick={() => decide.mutate("reject")} disabled={busy || !reason.trim()}>
						{decide.isPending && decide.variables === "reject" && <Loader2 className="animate-spin" />}
						Reject
					</Button>
				) : (
					<Button variant="ghost" onClick={() => setRejecting(true)} disabled={busy}>
						Reject…
					</Button>
				)}
			</div>
		</article>
	);
}
