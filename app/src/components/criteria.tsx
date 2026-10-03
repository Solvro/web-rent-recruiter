import type { Criteria, Criterion } from "@scout/shared";
import { Briefcase, Globe2, Languages, MapPin, Plus, Wallet, X } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const SENIORITY: Record<Criteria["seniority"], string> = {
	JUNIOR: "Junior",
	MID: "Mid-level",
	SENIOR: "Senior",
	STAFF: "Staff / Lead",
	PRINCIPAL: "Principal",
	EXECUTIVE: "Executive",
};
const MODE: Record<Criteria["location"]["mode"], string> = {
	ONSITE: "On-site",
	HYBRID: "Hybrid",
	REMOTE: "Remote",
};

export function criterionLabel(criteria: Criteria, id: string) {
	return (
		[...criteria.mustHave, ...criteria.niceToHave, ...criteria.dealBreakers].find((c) => c.id === id)
			?.label ?? id
	);
}

export function CriteriaFacts({ criteria }: { criteria: Criteria }) {
	const salary = criteria.salaryRange;
	const facts = [
		{ icon: Briefcase, text: SENIORITY[criteria.seniority] },
		{
			icon: criteria.location.mode === "REMOTE" ? Globe2 : MapPin,
			text: [MODE[criteria.location.mode], criteria.location.places.join(", ")].filter(Boolean).join(" · "),
		},
		{ icon: Languages, text: criteria.languages.join(", ") },
		salary && {
			icon: Wallet,
			text: `${salary.min.toLocaleString("en-US")}–${salary.max.toLocaleString("en-US")} ${salary.currency} / ${salary.period === "YEAR" ? "year" : "month"}`,
		},
	].filter(Boolean) as { icon: typeof Briefcase; text: string }[];
	return (
		<div className="flex flex-wrap gap-x-4 gap-y-1.5 text-sm text-muted-foreground">
			{facts.map((f) => (
				<span key={f.text} className="inline-flex items-center gap-1.5">
					<f.icon className="size-3.5" />
					{f.text}
				</span>
			))}
		</div>
	);
}

const TONE = {
	must: "bg-accent text-accent-foreground ring-primary/15",
	nice: "bg-secondary text-secondary-foreground ring-border",
	deal: "bg-destructive/8 text-destructive ring-destructive/15",
};

export function CriteriaList({ criteria, limit }: { criteria: Criteria; limit?: number }) {
	const groups = [
		{ title: "Must have", items: criteria.mustHave, tone: TONE.must },
		{ title: "Nice to have", items: criteria.niceToHave, tone: TONE.nice },
		{ title: "Deal-breakers", items: criteria.dealBreakers, tone: TONE.deal },
	];
	return (
		<div className="space-y-3">
			{groups
				.filter((g) => g.items.length)
				.map((g) => (
					<div key={g.title} className="space-y-1.5">
						<p className="text-xs font-medium text-muted-foreground">{g.title}</p>
						<div className="flex flex-wrap gap-1.5">
							{g.items.slice(0, limit).map((c) => (
								<span key={c.id} className={cn("rounded-lg px-2 py-0.5 text-xs ring-1 ring-inset", g.tone)}>
									{c.label}
								</span>
							))}
							{limit && g.items.length > limit && (
								<Badge variant="ghost" className="text-xs">
									+{g.items.length - limit}
								</Badge>
							)}
						</div>
					</div>
				))}
		</div>
	);
}

function slug(label: string) {
	return (
		label
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 40) || `c-${Date.now()}`
	);
}

function ChipGroup({
	title,
	hint,
	items,
	tone,
	defaultWeight,
	onChange,
}: {
	title: string;
	hint: string;
	items: Criterion[];
	tone: string;
	defaultWeight: number;
	onChange: (items: Criterion[]) => void;
}) {
	const [draft, setDraft] = useState("");
	const add = () => {
		const label = draft.trim();
		if (!label) return;
		let id = slug(label);
		while (items.some((c) => c.id === id)) id = `${id}-2`;
		onChange([...items, { id, label, weight: defaultWeight }]);
		setDraft("");
	};
	return (
		<div className="space-y-2">
			<div className="flex items-baseline justify-between gap-2">
				<p className="text-sm font-medium">{title}</p>
				<p className="text-xs text-muted-foreground">{hint}</p>
			</div>
			<div className="flex flex-wrap items-center gap-1.5">
				{items.map((c) => (
					<span
						key={c.id}
						className={cn(
							"group inline-flex items-center gap-1 rounded-lg py-1 pr-1 pl-2.5 text-sm ring-1 ring-inset",
							tone,
						)}
					>
						{c.label}
						<button
							type="button"
							aria-label={`Remove ${c.label}`}
							onClick={() => onChange(items.filter((x) => x.id !== c.id))}
							className="grid size-5 place-items-center rounded-md opacity-60 hover:bg-foreground/10 hover:opacity-100"
						>
							<X className="size-3" />
						</button>
					</span>
				))}
				<form
					className="inline-flex items-center"
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
						aria-label={`Add to ${title}`}
						className="h-8 w-36 rounded-lg text-sm"
					/>
					<button type="submit" className="sr-only">
						<Plus />
					</button>
				</form>
			</div>
		</div>
	);
}

export function CriteriaEditor({ value, onChange }: { value: Criteria; onChange: (c: Criteria) => void }) {
	return (
		<div className="space-y-5">
			<ChipGroup
				title="Must have"
				hint="Scored with the highest weight"
				items={value.mustHave}
				tone={TONE.must}
				defaultWeight={4}
				onChange={(mustHave) => onChange({ ...value, mustHave })}
			/>
			<ChipGroup
				title="Nice to have"
				hint="Raise the score, never block"
				items={value.niceToHave}
				tone={TONE.nice}
				defaultWeight={2}
				onChange={(niceToHave) => onChange({ ...value, niceToHave })}
			/>
			<ChipGroup
				title="Deal-breakers"
				hint="Candidates hitting these are flagged"
				items={value.dealBreakers}
				tone={TONE.deal}
				defaultWeight={5}
				onChange={(dealBreakers) => onChange({ ...value, dealBreakers })}
			/>
			<CriteriaFacts criteria={value} />
		</div>
	);
}
