import type { AgentReview, SubmissionView } from "@scout/shared";
import { PROJECT_NAME } from "@scout/shared";
import { Check, Clock } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { formatDuration, initials } from "@/lib/format";
import { cn } from "@/lib/utils";

export function Brand() {
	return (
		<span className="inline-flex items-center gap-2 type-body text-foreground">
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

const SIZES = { xs: "size-6", sm: "size-9", md: "size-10", lg: "size-16" } as const;
const TINTS = [
	"bg-[oklch(0.94_0.04_262)] text-[oklch(0.42_0.12_262)]",
	"bg-[oklch(0.94_0.04_160)] text-[oklch(0.42_0.09_160)]",
	"bg-[oklch(0.94_0.05_70)] text-[oklch(0.45_0.1_60)]",
	"bg-[oklch(0.94_0.04_330)] text-[oklch(0.45_0.12_330)]",
	"bg-[oklch(0.94_0.03_200)] text-[oklch(0.42_0.08_200)]",
];
function tint(name: string) {
	let h = 0;
	for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
	return TINTS[h % TINTS.length];
}

/** Every person gets a face: their photo, or initials on a soft tint derived from the name. */
export function PersonAvatar({
	name,
	src,
	size = "md",
}: {
	name: string;
	src?: string | null;
	size?: keyof typeof SIZES;
}) {
	const [failed, setFailed] = useState(false);
	return src && !failed ? (
		<img
			src={src}
			alt=""
			className={cn(SIZES[size], "shrink-0 rounded-full bg-muted object-cover")}
			onError={() => setFailed(true)}
		/>
	) : (
		<span
			className={cn(SIZES[size], "grid shrink-0 place-items-center rounded-full type-label", tint(name))}
			aria-hidden
		>
			{initials(name)}
		</span>
	);
}

export function Chip({
	children,
	tone = "neutral",
}: {
	children: ReactNode;
	tone?: "neutral" | "good" | "warn" | "accent";
}) {
	return (
		<span
			className={cn(
				"inline-flex items-center gap-1 rounded-full px-2.5 py-1 type-label",
				tone === "neutral" && "bg-secondary text-muted-foreground",
				tone === "good" && "bg-success/10 text-success",
				tone === "warn" && "bg-warning/15 text-warning-foreground",
				tone === "accent" && "bg-accent text-accent-foreground",
			)}
		>
			{children}
		</span>
	);
}

export function TrustChip({ children }: { children: ReactNode }) {
	return (
		<Chip tone="good">
			<Check className="size-3.5" />
			{children}
		</Chip>
	);
}

export function StatusChip({ status }: { status: SubmissionView["status"] }) {
	if (status === "ACCEPTED")
		return (
			<Chip tone="good">
				<Check className="size-3.5" /> Paid
			</Chip>
		);
	if (status === "REJECTED") return <Chip>Not selected</Chip>;
	return <Chip tone="accent">In review</Chip>;
}

const MATCH: Record<AgentReview["recommendation"], { label: string; tone: "good" | "warn" | "neutral" }> = {
	ADVANCE: { label: "Strong match", tone: "good" },
	MAYBE: { label: "Partial match", tone: "warn" },
	PASS: { label: "Weak match", tone: "neutral" },
};

export function ScoreChip({ review }: { review: AgentReview }) {
	const m = MATCH[review.recommendation];
	return (
		<Chip tone={m.tone}>
			<span className="tabular">{review.score}</span> · {m.label}
		</Chip>
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

/** Small line: how long until something happens automatically. Green when it's good news for the reader. */
export function Countdown({
	deadline,
	prefix,
	suffix,
	tone = "warn",
}: {
	deadline: string;
	prefix: string;
	suffix?: string;
	tone?: "warn" | "good";
}) {
	const left = secondsUntil(deadline, useNow());
	if (left <= 0) return null;
	return (
		<span
			className={cn(
				"inline-flex items-center gap-1 type-label",
				tone === "good" ? "text-success" : "text-warning-foreground",
			)}
		>
			<Clock className="size-3.5" />
			{prefix} <span className="tabular">{formatDuration(left)}</span>
			{suffix && <span> {suffix}</span>}
		</span>
	);
}

export function EmptyState({ title, action }: { title: string; action?: ReactNode }) {
	return (
		<div className="flex flex-col items-center gap-6 py-24 text-center">
			<p className="max-w-sm text-muted-foreground">{title}</p>
			{action}
		</div>
	);
}

/** Calm failure state: never raw errors, never mistaken for "nothing here". */
export function ErrorState() {
	return (
		<div className="flex flex-col items-center gap-6 py-24 text-center">
			<p className="max-w-sm text-muted-foreground">Something went wrong. Refresh the page to try again.</p>
			<button
				type="button"
				onClick={() => location.reload()}
				className="rounded-full px-4 py-2 type-label ring-1 ring-border hover:bg-muted"
			>
				Refresh
			</button>
		</div>
	);
}

/** Text-link disclosure for everything that isn't one of the screen's two main things. */
export function Disclosure({ label, children }: { label: string; children: ReactNode }) {
	const [open, setOpen] = useState(false);
	return (
		<div className="space-y-3">
			<button
				type="button"
				onClick={() => setOpen((o) => !o)}
				aria-expanded={open}
				className="type-label text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
			>
				{open ? "Hide" : label}
			</button>
			{open && <div className="animate-in fade-in-0">{children}</div>}
		</div>
	);
}
