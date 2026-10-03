import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/** Ids that existed when the page opened: only things that arrive later get the "just changed" treatment. */
export function useSeen<T extends { id: string }>(items: T[] | undefined) {
	const seen = useRef<Set<string> | null>(null);
	if (!seen.current && items) seen.current = new Set(items.map((i) => i.id));
	return (id: string) => !seen.current || seen.current.has(id);
}

/** A brief highlight on something that just appeared, then it settles. Nothing changes silently. */
export function Fresh({
	fresh,
	children,
	className,
}: {
	fresh: boolean;
	children: ReactNode;
	className?: string;
}) {
	const [lit, setLit] = useState(fresh);
	useEffect(() => {
		if (!fresh) return;
		const t = setTimeout(() => setLit(false), 1800);
		return () => clearTimeout(t);
	}, [fresh]);
	return (
		<div
			className={cn(
				"rounded-2xl transition-colors duration-1000",
				fresh && "animate-in fade-in slide-in-from-bottom-2 duration-500",
				lit ? "bg-accent/70" : "bg-transparent",
				className,
			)}
		>
			{children}
		</div>
	);
}

/** A count that pops when it changes. */
export function Count({ value, className }: { value: number | string; className?: string }) {
	return (
		<span
			key={String(value)}
			className={cn("inline-block tabular animate-in zoom-in-75 duration-300", className)}
		>
			{value}
		</span>
	);
}

/** Reveals a new agent message word by word, like a reply being written. Old messages show at once. */
export function Typed({ text, live }: { text: string; live: boolean }) {
	const words = text.split(/(\s+)/);
	const [n, setN] = useState(live ? 0 : words.length);
	useEffect(() => {
		if (n >= words.length) return;
		const t = setTimeout(() => setN((x) => Math.min(words.length, x + 2)), 28);
		return () => clearTimeout(t);
	}, [n, words.length]);
	return <>{words.slice(0, n).join("")}</>;
}
