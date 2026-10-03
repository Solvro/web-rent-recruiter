import type { AgentReview, SubmissionView } from "@scout/shared";
import { PROJECT_NAME } from "@scout/shared";
import { CheckCircle2, CircleDashed, Clock, XCircle } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";

export function Brand({ className }: { className?: string }) {
	return (
		<span className={cn("inline-flex items-center gap-2 font-semibold tracking-tight", className)}>
			<span className="grid size-7 place-items-center rounded-lg bg-primary text-primary-foreground">
				<svg
					viewBox="0 0 24 24"
					className="size-4"
					fill="none"
					stroke="currentColor"
					strokeWidth="2.4"
					aria-hidden
				>
					<circle cx="11" cy="11" r="6" />
					<path d="m20 20-4.2-4.2" strokeLinecap="round" />
				</svg>
			</span>
			{PROJECT_NAME}
		</span>
	);
}

export function StatusBadge({ status }: { status: SubmissionView["status"] }) {
	if (status === "ACCEPTED")
		return (
			<Badge className="gap-1 bg-success/10 text-success">
				<CheckCircle2 className="size-3" /> Paid
			</Badge>
		);
	if (status === "REJECTED")
		return (
			<Badge variant="secondary" className="gap-1 text-muted-foreground">
				<XCircle className="size-3" /> Rejected
			</Badge>
		);
	return (
		<Badge variant="outline" className="gap-1">
			<Clock className="size-3" /> In review
		</Badge>
	);
}

const REC_STYLE: Record<AgentReview["recommendation"], string> = {
	ADVANCE: "bg-success/10 text-success ring-success/20",
	MAYBE: "bg-warning/15 text-warning-foreground ring-warning/30",
	PASS: "bg-muted text-muted-foreground ring-border",
};
const REC_LABEL: Record<AgentReview["recommendation"], string> = {
	ADVANCE: "Advance",
	MAYBE: "Maybe",
	PASS: "Pass",
};

export function ScoreBadge({ review, size = "md" }: { review: AgentReview; size?: "md" | "lg" }) {
	return (
		<div
			className={cn(
				"inline-flex items-center gap-2 rounded-xl px-2.5 py-1 ring-1 ring-inset",
				REC_STYLE[review.recommendation],
				size === "lg" && "px-3 py-1.5",
			)}
		>
			<span className={cn("tabular font-semibold", size === "lg" ? "text-2xl" : "text-base")}>
				{review.score}
			</span>
			<span className="text-xs font-medium uppercase tracking-wide">{REC_LABEL[review.recommendation]}</span>
		</div>
	);
}

export function useNow(intervalMs = 1000) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const t = setInterval(() => setNow(Date.now()), intervalMs);
		return () => clearInterval(t);
	}, [intervalMs]);
	return now;
}

export function secondsUntil(iso: string, now: number) {
	return (new Date(iso).getTime() - now) / 1000;
}

export function Countdown({ deadline, prefix = "Auto-accepts in" }: { deadline: string; prefix?: string }) {
	const now = useNow();
	const left = secondsUntil(deadline, now);
	if (left <= 0)
		return <span className="text-xs font-medium text-warning-foreground">Review window ended</span>;
	return (
		<span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
			<Clock className="size-3" />
			{prefix} <span className="tabular font-medium text-foreground">{formatDuration(left)}</span>
		</span>
	);
}

export function EmptyState({
	icon,
	title,
	children,
	action,
}: {
	icon?: ReactNode;
	title: string;
	children?: ReactNode;
	action?: ReactNode;
}) {
	return (
		<div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed bg-card/50 px-6 py-14 text-center">
			<div className="grid size-11 place-items-center rounded-full bg-accent text-accent-foreground">
				{icon ?? <CircleDashed className="size-5" />}
			</div>
			<div className="space-y-1">
				<p className="font-medium">{title}</p>
				{children && <p className="mx-auto max-w-sm text-sm text-muted-foreground">{children}</p>}
			</div>
			{action}
		</div>
	);
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
	return (
		<div className="space-y-1">
			<p className="text-xs font-medium text-muted-foreground">{label}</p>
			<p className="tabular text-2xl font-semibold tracking-tight">{value}</p>
			{hint && <p className="text-xs text-muted-foreground">{hint}</p>}
		</div>
	);
}

export function PageHeader({
	title,
	description,
	actions,
	eyebrow,
}: {
	title: ReactNode;
	description?: ReactNode;
	actions?: ReactNode;
	eyebrow?: ReactNode;
}) {
	return (
		<div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
			<div className="space-y-1.5">
				{eyebrow && <div className="text-sm text-muted-foreground">{eyebrow}</div>}
				<h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
				{description && <div className="max-w-2xl text-muted-foreground">{description}</div>}
			</div>
			{actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
		</div>
	);
}
