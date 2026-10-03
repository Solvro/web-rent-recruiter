import type { AgentReview, Criteria, Criterion } from "@scout/shared";
import { Check, Minus, X } from "lucide-react";
import { useState } from "react";
import { Chip } from "@/components/bits";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export function criterionLabel(criteria: Criteria, id: string) {
	return (
		[...criteria.mustHave, ...criteria.niceToHave, ...criteria.dealBreakers].find((c) => c.id === id)
			?.label ?? id
	);
}

/** At most five must-haves, as quiet chips. */
export function CriteriaChips({ criteria, limit = 5 }: { criteria: Criteria; limit?: number }) {
	return (
		<div className="flex flex-wrap gap-2">
			{criteria.mustHave.slice(0, limit).map((c) => (
				<Chip key={c.id}>{c.label}</Chip>
			))}
		</div>
	);
}

/** Chips you can remove or add to (at most five). */
export function ChipEditor({
	items,
	onChange,
	label,
	tone = "neutral",
	weight = 4,
}: {
	items: Criterion[];
	onChange: (items: Criterion[]) => void;
	label: string;
	tone?: "neutral" | "deal";
	weight?: number;
}) {
	const [draft, setDraft] = useState("");
	const add = () => {
		const text = draft.trim();
		if (!text) return;
		const id = `${text
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.slice(0, 40)}-${items.length}`;
		onChange([...items, { id, label: text, weight }]);
		setDraft("");
	};
	return (
		<div className="flex flex-wrap items-center gap-2">
			{items.slice(0, 5).map((c) => (
				<span
					key={c.id}
					className={cn(
						"inline-flex items-center gap-1 rounded-full py-1 pr-1 pl-3 type-label",
						tone === "deal" ? "bg-destructive/8 text-destructive" : "bg-secondary",
					)}
				>
					{c.label}
					<button
						type="button"
						aria-label={`Remove ${c.label}`}
						onClick={() => onChange(items.filter((x) => x.id !== c.id))}
						className="grid size-5 place-items-center rounded-full opacity-70 hover:bg-foreground/10"
					>
						<X className="size-3" />
					</button>
				</span>
			))}
			{items.length < 5 && (
				<form
					onSubmit={(e) => {
						e.preventDefault();
						add();
					}}
				>
					<Input
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						onBlur={add}
						placeholder="Add…"
						aria-label={`Add a ${label}`}
						className="h-8 w-32"
					/>
				</form>
			)}
		</div>
	);
}

const POSITIVE: [RegExp, string][] = [
	[/^not open to\b/i, "Open to"],
	[/^unwilling to\b/i, "Willing to"],
	[/^unable to\b/i, "Able to"],
	[/^only open to\b/i, "Not limited to"],
	[/^can't\b|^cannot\b/i, "Can"],
	[/^needs\b/i, "Doesn't need"],
	[/^requires\b/i, "Doesn't require"],
	[/^no\b/i, "Has"],
];

/** "Not open to 2 office days in Warsaw" → "Open to 2 office days in Warsaw"; otherwise "No concern: …". */
export function positiveDealBreaker(label: string) {
	for (const [re, replacement] of POSITIVE) if (re.test(label)) return label.replace(re, replacement);
	return `No concern: ${label[0]?.toLowerCase()}${label.slice(1)}`;
}

/** "Why this score": one ✓ / ✗ line per criterion. Deal-breakers read MET when the candidate triggers them. */
export function WhyThisScore({ review, criteria }: { review: AgentReview; criteria: Criteria }) {
	const deal = new Set(criteria.dealBreakers.map((c) => c.id));
	return (
		<ul className="space-y-2">
			{review.verdicts.map((v) => {
				const isDeal = deal.has(v.criterionId);
				const good = isDeal ? v.verdict === "NOT_MET" : v.verdict === "MET";
				const bad = isDeal ? v.verdict === "MET" : v.verdict === "NOT_MET";
				const label = criterionLabel(criteria, v.criterionId);
				// Never a green check next to a negative statement.
				const lower = `${label[0]?.toLowerCase()}${label.slice(1)}`;
				// A deal-breaker reads as one in every state: cleared, unknown, or hit.
				const text = !isDeal
					? label
					: good
						? positiveDealBreaker(label)
						: bad
							? `Deal-breaker: ${lower}`
							: `No sign of: ${lower}`;
				const Icon = good ? Check : bad ? X : Minus;
				return (
					<li key={v.criterionId} className="flex items-start gap-3">
						<Icon
							className={`mt-1 size-4 shrink-0 ${good ? "text-success" : bad ? "text-destructive" : "text-muted-foreground"}`}
						/>
						<span>
							{text}
							<span className="block type-label text-muted-foreground">{v.reasoning}</span>
						</span>
					</li>
				);
			})}
		</ul>
	);
}
