import { ArrowDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useMessageScroller, useMessageScrollerScrollable } from "@/components/ui/message-scroller";

const reduced = () =>
	typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Keeps a live list pinned to its newest line while the reader is at the bottom. Once they scroll up, it stops
 * following and offers "New updates ↓" when something arrives; that pill jumps back and follows again.
 * `changeKey` changes whenever new lines arrive; `layoutKey` when something below the list (a pinned card)
 * changes its height.
 */
export function Follow({
	changeKey,
	layoutKey,
}: {
	changeKey: string | number;
	layoutKey?: string | number;
}) {
	const { scrollToEnd } = useMessageScroller();
	const { end: canScrollDown } = useMessageScrollerScrollable();
	const [following, setFollowing] = useState(true);
	const [unseen, setUnseen] = useState(false);
	const last = useRef(changeKey);

	// Reaching the bottom (by any means) resumes following; leaving it by scrolling up pauses it.
	useEffect(() => {
		if (!canScrollDown) {
			setFollowing(true);
			setUnseen(false);
		}
	}, [canScrollDown]);
	useEffect(() => {
		const onUp = (e: WheelEvent | KeyboardEvent | TouchEvent) => {
			if (e instanceof WheelEvent && e.deltaY >= 0) return;
			if (e instanceof KeyboardEvent && !["ArrowUp", "PageUp", "Home"].includes(e.key)) return;
			setFollowing(false);
		};
		window.addEventListener("wheel", onUp, { passive: true });
		window.addEventListener("keydown", onUp);
		window.addEventListener("touchmove", onUp, { passive: true });
		return () => {
			window.removeEventListener("wheel", onUp);
			window.removeEventListener("keydown", onUp);
			window.removeEventListener("touchmove", onUp);
		};
	}, []);

	useEffect(() => {
		if (last.current === changeKey) return;
		last.current = changeKey;
		if (following) requestAnimationFrame(() => scrollToEnd({ behavior: reduced() ? "auto" : "smooth" }));
		else setUnseen(true);
	}, [changeKey, following, scrollToEnd]);

	// Lines that grow after they arrive (a reply typing out) keep the end in view while following.
	const anchor = useRef<HTMLSpanElement>(null);
	const followingRef = useRef(following);
	followingRef.current = following;
	useEffect(() => {
		const content = anchor.current
			?.closest("[data-slot=message-scroller]")
			?.querySelector("[data-slot=message-scroller-content]");
		if (!content || typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(() => {
			if (followingRef.current) scrollToEnd({ behavior: "auto" });
		});
		ro.observe(content);
		return () => ro.disconnect();
	}, [scrollToEnd]);

	// A card appearing under the list shrinks it: keep the latest line in view.
	// biome-ignore lint/correctness/useExhaustiveDependencies: layoutKey is the trigger, not a value read inside
	useEffect(() => {
		if (following) requestAnimationFrame(() => scrollToEnd({ behavior: "auto" }));
	}, [layoutKey, following, scrollToEnd]);

	if (!unseen || following) return <span ref={anchor} hidden />;
	return (
		<>
			<span ref={anchor} hidden />
			<button
				type="button"
				onClick={() => {
					setFollowing(true);
					setUnseen(false);
					scrollToEnd({ behavior: reduced() ? "auto" : "smooth" });
				}}
				className="absolute bottom-3 left-1/2 z-10 inline-flex -translate-x-1/2 items-center gap-1 rounded-full bg-foreground px-3 py-1.5 type-label text-background shadow-lg animate-in fade-in slide-in-from-bottom-2"
			>
				New updates <ArrowDown className="size-3.5" />
			</button>
		</>
	);
}
