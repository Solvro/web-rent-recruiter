import { APPEAL_WINDOW_DAYS, type DeliverableView } from "@scout/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "@/lib/errors";
import { formatMoney } from "@/lib/format";
import { reviewApi } from "@/lib/gigs/review";

const DAY = 86_400_000;

/**
 * On a rejected delivery: the reasons, and once (within the appeal window) "Ask the company to review" with a
 * short note. Then the appeal's state: waiting, paid after a second look, or kept rejected with the company's note.
 */
export function Appeal({
	d,
	align = "start",
	showReasons = true,
}: {
	d: DeliverableView;
	align?: "start" | "end";
	/** Off where the page already shows the reasons. */
	showReasons?: boolean;
}) {
	const qc = useQueryClient();
	const [open, setOpen] = useState(false);
	const [why, setWhy] = useState(false);
	const [text, setText] = useState("");
	const send = useMutation({
		mutationFn: () => reviewApi.appeal(d.id, text.trim()),
		onSuccess: () => {
			setOpen(false);
			void qc.invalidateQueries({ queryKey: ["gigs", "mine"] });
		},
	});
	const reasons = showReasons ? (d.review?.reasons ?? []) : [];
	const reviewedAt = d.review?.reviewedAt ? Date.parse(d.review.reviewedAt) : Date.parse(d.submittedAt);
	const canAppeal = !d.appeal && Date.now() - reviewedAt < APPEAL_WINDOW_DAYS * DAY;
	const side = align === "end" ? "items-end text-right" : "items-start text-left";

	return (
		<div className={`flex flex-col gap-1.5 ${side}`}>
			{reasons.length > 0 && (
				<button
					type="button"
					onClick={() => setWhy((w) => !w)}
					aria-expanded={why}
					className="type-label text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
				>
					Why was this rejected?
				</button>
			)}
			{why && (
				<ul className="max-w-sm space-y-1 type-label text-muted-foreground">
					{reasons.map((r) => (
						<li key={r}>{r}</li>
					))}
				</ul>
			)}
			{d.appeal?.status === "OPEN" && <p className="type-label text-primary">The company is looking again</p>}
			{d.appeal?.status === "OVERTURNED" && (
				<p className="type-label text-success">
					Paid{d.appeal.paid ? ` ${formatMoney(d.appeal.paid)}` : ""} after a second look
				</p>
			)}
			{d.appeal?.status === "UPHELD" && (
				<p className="max-w-sm type-label text-muted-foreground">
					Kept rejected{d.appeal.note ? `: “${d.appeal.note}”` : ""}
				</p>
			)}
			{canAppeal && !open && (
				<button
					type="button"
					onClick={() => setOpen(true)}
					className="type-label text-primary underline-offset-4 hover:underline"
				>
					Ask the company to review
				</button>
			)}
			{open && (
				<div className="w-full max-w-sm space-y-2 text-left">
					<Textarea
						value={text}
						onChange={(e) => setText(e.target.value)}
						placeholder="What did the agent miss? The company sees this."
						aria-label="Why the company should look again"
						className="min-h-20 rounded-2xl p-3"
						autoFocus
					/>
					<div className="flex gap-2">
						<Button
							size="sm"
							onClick={() => send.mutate()}
							disabled={text.trim().length < 10 || send.isPending}
						>
							{send.isPending && <Loader2 className="animate-spin" />}
							Send
						</Button>
						<Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
							Cancel
						</Button>
					</div>
					<p className="type-label text-muted-foreground">You can ask once per delivery.</p>
					{send.isError && <p className="type-label text-destructive">{errorMessage(send.error)}</p>}
				</div>
			)}
		</div>
	);
}
