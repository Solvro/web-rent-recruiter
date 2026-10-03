import { explorerAddressUrl, explorerTxUrl } from "@scout/shared";
import { ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";

/** The one place the chain shows through: a quiet link to the confirmed transaction. */
export function ExplorerLink({
	signature,
	address,
	className,
	children = "View on Solana Explorer",
}: {
	signature?: string | null;
	address?: string | null;
	className?: string;
	children?: React.ReactNode;
}) {
	const href = signature ? explorerTxUrl(signature) : address ? explorerAddressUrl(address) : null;
	if (!href) return null;
	return (
		<a
			href={href}
			target="_blank"
			rel="noreferrer"
			className={cn(
				"inline-flex items-center gap-0.5 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline",
				className,
			)}
		>
			{children}
			<ArrowUpRight className="size-3" />
		</a>
	);
}
