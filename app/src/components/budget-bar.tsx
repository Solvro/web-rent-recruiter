import type { RoleSummary } from "@scout/shared";
import { formatUsdc, pct } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Deposited = paid + reserved for candidates in review + available. */
export function BudgetBar({ role, compact = false }: { role: RoleSummary; compact?: boolean }) {
	const { deposited, paid, remaining, available } = role.budget;
	const reserved = (BigInt(remaining) - BigInt(available)).toString();
	const segments = [
		{ key: "paid", value: paid, className: "bg-success", label: "Paid to scouts" },
		{ key: "reserved", value: reserved, className: "bg-warning", label: "Reserved for review" },
		{ key: "available", value: available, className: "bg-primary/25", label: "Available" },
	];
	const slotsLeft = Math.max(0, role.maxCandidates - role.acceptedCount - role.pendingCount);
	const coversMore = Math.min(slotsLeft, Math.floor(Number(BigInt(available) / BigInt(role.bounty))));

	return (
		<div className="space-y-3">
			<div
				className={cn("flex w-full overflow-hidden rounded-full bg-muted", compact ? "h-1.5" : "h-3")}
				role="img"
				aria-label={`${formatUsdc(paid)} paid of ${formatUsdc(deposited)} deposited`}
			>
				{segments.map((s) => (
					<div
						key={s.key}
						className={cn("h-full transition-[width] duration-500", s.className)}
						style={{ width: `${pct(s.value, deposited)}%` }}
					/>
				))}
			</div>
			{!compact && (
				<div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-sm">
					{segments.map((s) => (
						<span key={s.key} className="inline-flex items-center gap-1.5 text-muted-foreground">
							<span className={cn("size-2 rounded-full", s.className)} />
							{s.label}
							<span className="tabular font-medium text-foreground">{formatUsdc(s.value)}</span>
						</span>
					))}
					<span className="ml-auto text-muted-foreground">
						Covers{" "}
						<span className="font-medium text-foreground">
							{coversMore} more candidate{coversMore === 1 ? "" : "s"}
						</span>
					</span>
				</div>
			)}
		</div>
	);
}
