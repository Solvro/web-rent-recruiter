/**
 * The agent's plan for the budget: one line per kind of gig, the price counting up as it lands, and a single bar
 * showing how the budget splits (reserve last, quieter).
 */
import { fromBaseUnits } from "@scout/shared";
import { useEffect, useRef, useState } from "react";
import { GIG_TYPES } from "@/lib/gig-types";
import type { Plan } from "@/lib/gigs/plan";
import { cn } from "@/lib/utils";
import "./role-draft.css";

const usd = (n: number) =>
	n.toLocaleString("en-US", {
		style: "currency",
		currency: "USD",
		minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
		maximumFractionDigits: 2,
	});

/** Counts up to `to` once (strong ease-out), then follows `to` instantly when the budget changes. */
function CountUp({ to, delay = 0, animate }: { to: number; delay?: number; animate: boolean }) {
	const [value, setValue] = useState(animate ? 0 : to);
	const played = useRef(!animate);
	useEffect(() => {
		if (played.current) {
			setValue(to);
			return;
		}
		played.current = true;
		let raf = 0;
		const start = performance.now() + delay;
		const duration = 600;
		const tick = (now: number) => {
			const t = Math.min(1, Math.max(0, (now - start) / duration));
			setValue(to * (1 - (1 - t) ** 3));
			if (t < 1) raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, [to, delay]);
	return <span className="tabular">{usd(Math.round(value))}</span>;
}

/** Shades of the accent for the budget bar segments, in plan order. */
const SHADES = ["bg-primary", "bg-primary/70", "bg-primary/45", "bg-primary/30"];

export function PlanView({ plan, animate }: { plan: Plan; animate: boolean }) {
	const parts = plan.gigs.map((g) => fromBaseUnits(g.price * BigInt(g.count)));
	const reserve = fromBaseUnits(plan.reserve);
	const total = parts.reduce((a, b) => a + b, 0) + reserve;
	const stagger = 90;

	return (
		<div className="space-y-6">
			<ul className="divide-y divide-border/60">
				{plan.gigs.map((g, i) => {
					const info = GIG_TYPES[g.kind];
					return (
						<li
							key={g.kind}
							className={cn("flex items-baseline justify-between gap-4 py-3", animate && "rd-in")}
							style={animate ? { animationDelay: `${i * stagger}ms` } : undefined}
						>
							<span className="min-w-0">
								{info.name}
								{g.kind === "LANGUAGE_CHECK" && <span className="text-muted-foreground"> · {g.label}</span>}
								<span className="block type-label text-muted-foreground">
									<span className="tabular">{g.count}</span> × {usd(fromBaseUnits(g.price))} {info.unit}
									{g.kind === "SOURCING" && " · paid when the candidate confirms interest"}
								</span>
							</span>
							<CountUp to={parts[i]} delay={i * stagger} animate={animate} />
						</li>
					);
				})}
				{reserve > 0 && (
					<li
						className={cn(
							"flex items-baseline justify-between gap-4 py-3 text-muted-foreground",
							animate && "rd-in",
						)}
						style={animate ? { animationDelay: `${plan.gigs.length * stagger}ms` } : undefined}
					>
						<span>Kept in reserve for retries</span>
						<CountUp to={reserve} delay={plan.gigs.length * stagger} animate={animate} />
					</li>
				)}
			</ul>

			<div className="flex h-2 gap-1 overflow-hidden rounded-full" aria-hidden>
				{[...parts, reserve].map((v, i) => (
					<span
						// biome-ignore lint/suspicious/noArrayIndexKey: fixed order of plan segments
						key={i}
						className="h-full overflow-hidden rounded-full"
						style={{ flexGrow: v, flexBasis: 0 }}
					>
						<span
							className={cn(
								"block h-full w-full rounded-full",
								i < parts.length ? SHADES[i % SHADES.length] : "bg-foreground/10",
								animate && "rd-grow",
							)}
							style={animate ? { animationDelay: `${150 + i * stagger}ms` } : undefined}
						/>
					</span>
				))}
			</div>
			<p className="sr-only">Total {usd(total)}</p>
		</div>
	);
}
