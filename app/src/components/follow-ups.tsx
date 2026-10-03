import type { DeliverableView } from "@scout/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "@/lib/errors";
import { typedClient } from "@/lib/trpc";

/** The agent's questions about a delivery, each with an answer box until answered. */
export function FollowUps({ d }: { d: DeliverableView }) {
	const list = d.followUps ?? [];
	if (!list.length) return null;
	return (
		<div className="w-full max-w-md space-y-3 text-left">
			{list.map((f, index) => (
				<FollowUp key={f.askedAt} id={d.id} index={index} question={f.question} answer={f.answer} />
			))}
		</div>
	);
}

function FollowUp({
	id,
	index,
	question,
	answer,
}: {
	id: string;
	index: number;
	question: string;
	answer: string | null;
}) {
	const qc = useQueryClient();
	const [text, setText] = useState("");
	const send = useMutation({
		mutationFn: () => typedClient.gigs.answerFollowUp.mutate({ id, index, answer: text.trim() }),
		onSuccess: () => void qc.invalidateQueries({ queryKey: ["gigs", "mine"] }),
	});
	return (
		<div className="space-y-2 rounded-2xl bg-accent p-3">
			<p className="type-label text-primary">The agent asks</p>
			<p>{question}</p>
			{answer ? (
				<p className="type-label text-muted-foreground">You answered: {answer}</p>
			) : (
				<>
					<Textarea
						value={text}
						onChange={(e) => setText(e.target.value)}
						placeholder="Your answer"
						aria-label="Your answer"
						className="min-h-16 rounded-2xl bg-card p-3"
					/>
					<Button size="sm" onClick={() => send.mutate()} disabled={!text.trim() || send.isPending}>
						{send.isPending && <Loader2 className="animate-spin" />}
						Answer
					</Button>
					{send.isError && <p className="type-label text-destructive">{errorMessage(send.error)}</p>}
				</>
			)}
		</div>
	);
}
