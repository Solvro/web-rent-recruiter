/**
 * Keep what the agent just resolved in view while it works, until the person scrolls back up themselves: then stop
 * following and let them read (the page offers a "Follow along" pill to resume).
 */
import { useEffect, useState } from "react";

/** Header height plus breathing room: never scroll an element's top above this. */
const TOP = 96;

export function useFollow(enabled: boolean) {
	const [following, setFollowing] = useState(true);
	useEffect(() => {
		if (!enabled) return;
		const stop = () => setFollowing(false);
		const onWheel = (e: WheelEvent) => e.deltaY < 0 && stop();
		let touchY = 0;
		const onTouchStart = (e: TouchEvent) => {
			touchY = e.touches[0]?.clientY ?? 0;
		};
		// Finger moving down = content scrolling up.
		const onTouchMove = (e: TouchEvent) => (e.touches[0]?.clientY ?? 0) > touchY + 8 && stop();
		const onKey = (e: KeyboardEvent) =>
			(["ArrowUp", "PageUp", "Home"].includes(e.key) || (e.key === " " && e.shiftKey)) && stop();
		window.addEventListener("wheel", onWheel, { passive: true });
		window.addEventListener("touchstart", onTouchStart, { passive: true });
		window.addEventListener("touchmove", onTouchMove, { passive: true });
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("wheel", onWheel);
			window.removeEventListener("touchstart", onTouchStart);
			window.removeEventListener("touchmove", onTouchMove);
			window.removeEventListener("keydown", onKey);
		};
	}, [enabled]);
	return { following, resume: () => setFollowing(true) };
}

/**
 * Scroll the window down just enough that `el` (plus `below` px of what comes next) is visible, without pushing its
 * top under the header. Only ever scrolls down: "nearest", following the reading direction.
 */
export function followInto(el: Element | null | undefined, reduced: boolean, below = 120) {
	if (!el) return;
	const r = el.getBoundingClientRect();
	const over = Math.min(r.bottom + below - window.innerHeight, r.top - TOP);
	if (over > 0) window.scrollBy({ top: over, behavior: reduced ? "auto" : "smooth" });
}
