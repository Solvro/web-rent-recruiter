import { explorerTxUrl } from "@scout/shared";
import { useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export type ReceiptDetails = {
	/** "Paid $11.34 to Ola Wiśniewska" */
	title: string;
	/** Candidate, role, date: one short line each. */
	lines?: (string | null | undefined)[];
};

/** "Receipt" opens an in-app payment confirmation; the independent proof sits behind a tiny link inside it. */
export function Receipt({
	signature,
	details,
	className,
}: {
	signature?: string | null;
	details?: ReceiptDetails;
	className?: string;
}) {
	const [open, setOpen] = useState(false);
	if (!signature) return null;
	return (
		<>
			<button
				type="button"
				onClick={() => setOpen(true)}
				className={cn(
					"type-label text-muted-foreground/80 underline-offset-2 hover:text-foreground hover:underline",
					className,
				)}
			>
				Receipt
			</button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent className="gap-6 p-8">
					<DialogTitle>{details?.title ?? "Payment confirmed"}</DialogTitle>
					{details?.lines?.some(Boolean) && (
						<ul className="space-y-1 text-muted-foreground">
							{details.lines.filter(Boolean).map((l) => (
								<li key={l}>{l}</li>
							))}
						</ul>
					)}
					<a
						href={explorerTxUrl(signature)}
						target="_blank"
						rel="noreferrer"
						className="type-label text-muted-foreground/80 underline-offset-2 hover:text-foreground hover:underline"
					>
						Proof of payment
					</a>
				</DialogContent>
			</Dialog>
		</>
	);
}

export const whenLabel = (iso?: string | null) =>
	iso
		? new Date(iso).toLocaleString("en-GB", {
				day: "numeric",
				month: "short",
				hour: "2-digit",
				minute: "2-digit",
			})
		: null;
