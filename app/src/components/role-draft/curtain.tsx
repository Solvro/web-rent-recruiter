/**
 * The page-coloured layer between the pasted text and the post being built over it. Its lower edge follows the
 * post's current bottom: everything above it is the clean post, everything below is the pasted text. As fields land
 * it glides down (clip-path for the solid part, transform for the soft edge, both on the same spring transition, so a
 * new target mid-glide just retargets), and the raw text is visibly replaced by the post from top to bottom.
 */
import { type RefObject, useEffect, useState } from "react";
import "./role-draft.css";

/** Height of the soft gradient edge under the curtain. */
const EDGE = 24;

function useHeight(ref: RefObject<HTMLElement | null>) {
	const [height, setHeight] = useState(0);
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const ro = new ResizeObserver(() => setHeight(el.offsetHeight));
		ro.observe(el);
		setHeight(el.offsetHeight);
		return () => ro.disconnect();
	}, [ref]);
	return height;
}

export function Curtain({
	post,
	backdrop,
}: {
	/** The post layer: the curtain's edge follows its bottom. */
	post: RefObject<HTMLElement | null>;
	/** The pasted text: the curtain is laid out tall enough to cover all of it. */
	backdrop: RefObject<HTMLElement | null>;
}) {
	const y = useHeight(post);
	const b = useHeight(backdrop);
	// Absolutely positioned, so its own height never moves anything; it only has to reach past both layers.
	const height =
		Math.max(y, (backdrop.current?.offsetTop ?? 0) + Math.min(b, backdrop.current?.scrollHeight ?? b)) + EDGE;
	return (
		<div aria-hidden className="pointer-events-none absolute inset-x-[-16px] top-0" style={{ height }}>
			<div
				className="rd-curtain absolute inset-0 bg-background"
				style={{ clipPath: `polygon(0 0, 100% 0, 100% ${y}px, 0 ${y}px)` }}
			/>
			<div
				className="rd-curtain absolute inset-x-0 top-0 bg-gradient-to-b from-background to-transparent"
				style={{ height: EDGE, transform: `translateY(${y}px)` }}
			/>
		</div>
	);
}
