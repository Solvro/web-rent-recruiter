import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

/** Quiet "Copy link" text action. */
export function CopyButton({
	text,
	label = "Copy link",
	className,
}: {
	text: string;
	label?: string;
	className?: string;
}) {
	const [copied, setCopied] = useState(false);
	return (
		<button
			type="button"
			onClick={() =>
				void navigator.clipboard?.writeText(text).then(() => {
					setCopied(true);
					setTimeout(() => setCopied(false), 2000);
				})
			}
			className={cn(
				"inline-flex items-center gap-1 type-label text-muted-foreground underline-offset-4 hover:text-foreground hover:underline",
				className,
			)}
		>
			{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
			{copied ? "Copied" : label}
		</button>
	);
}
