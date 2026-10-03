/** "Show QR code": the candidate scans the link with their own phone (rendered locally, no external service). */
import { useMemo, useState } from "react";
import { encode } from "uqr";

export function QrCode({ text, size = 200 }: { text: string; size?: number }) {
	const path = useMemo(() => {
		const { data } = encode(text, { border: 2 });
		let d = "";
		data.forEach((row, y) => {
			row.forEach((on, x) => {
				if (on) d += `M${x} ${y}h1v1h-1z`;
			});
		});
		return { d, n: data.length };
	}, [text]);
	return (
		<svg
			viewBox={`0 0 ${path.n} ${path.n}`}
			width={size}
			height={size}
			role="img"
			aria-label="QR code of the link"
			shapeRendering="crispEdges"
			className="rounded-2xl bg-white"
		>
			<path d={path.d} fill="#111" />
		</svg>
	);
}

export function QrToggle({ text, className }: { text: string; className?: string }) {
	const [open, setOpen] = useState(false);
	return (
		<div className={className}>
			<button
				type="button"
				onClick={() => setOpen((o) => !o)}
				aria-expanded={open}
				className="type-label underline-offset-4 hover:underline"
			>
				{open ? "Hide QR code" : "Show QR code"}
			</button>
			{open && (
				<div className="mt-3 flex animate-in justify-center fade-in-0 zoom-in-95">
					<QrCode text={text} />
				</div>
			)}
		</div>
	);
}
