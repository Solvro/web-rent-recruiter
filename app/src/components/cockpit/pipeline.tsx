import {
	ChevronRight,
	Languages,
	ListChecks,
	MailCheck,
	MessagesSquare,
	PhoneCall,
	UserSearch,
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { RoleStatus } from "@/lib/gigs/status";
import { cn } from "@/lib/utils";
import { Count } from "./fresh";

type Stage = {
	key: string;
	icon: typeof UserSearch;
	label: string;
	done: number;
	active: number;
	target: number | null;
	about: string;
};

/** Where every candidate is: found → confirmed → screened → language → reference → shortlist. */
export function Pipeline({ p }: { p: RoleStatus["pipeline"] }) {
	const stages: Stage[] = [
		{
			key: "sourcing",
			icon: UserSearch,
			label: "Sourcing",
			done: p.sourcingAccepted,
			active: 0,
			target: p.sourcingSlots,
			about: "Profiles the agent accepted from recruiters, out of the planned number.",
		},
		{
			key: "confirmed",
			icon: MailCheck,
			label: "Confirmed",
			done: p.confirmed,
			active: 0,
			target: null,
			about: "Candidates who said yes to a call themselves. Only these are paid for.",
		},
		{
			key: "screening",
			icon: PhoneCall,
			label: "Screening",
			done: p.screeningDone,
			active: 0,
			target: p.screeningSlots,
			about: "30-minute calls run by recruiters, checked by the agent.",
		},
		{
			key: "language",
			icon: Languages,
			label: "Language",
			done: p.languageDone,
			active: 0,
			target: null,
			about: "Short language checks for the strongest candidates.",
		},
		{
			key: "reference",
			icon: MessagesSquare,
			label: "Reference",
			done: p.referenceDone,
			active: 0,
			target: null,
			about: "A call with a former manager of the finalist.",
		},
		{
			key: "shortlist",
			icon: ListChecks,
			label: "Shortlist",
			done: p.shortlisted,
			active: 0,
			target: null,
			about: "Candidates ready for your decision.",
		},
	];
	return (
		<ol
			className="-mx-1 flex items-stretch gap-1 overflow-x-auto px-1 py-1 scrollbar-none"
			aria-label="Pipeline"
		>
			{stages.map((s, i) => (
				<li key={s.key} className="flex shrink-0 items-center gap-1">
					{i > 0 && <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/50" aria-hidden />}
					<Popover>
						<PopoverTrigger
							className={cn(
								"flex items-center gap-2 rounded-2xl px-3 py-2 text-left ring-1 transition-colors hover:bg-muted",
								s.active > 0
									? "bg-accent ring-primary/30"
									: s.done > 0
										? "bg-card ring-foreground/10"
										: "ring-transparent",
							)}
						>
							<s.icon
								className={cn("size-4", s.done || s.active ? "text-primary" : "text-muted-foreground")}
							/>
							<span>
								<span className="block type-label text-muted-foreground">{s.label}</span>
								<span className="flex items-baseline gap-1">
									<Count value={s.done} />
									{s.target !== null && s.target > 0 && (
										<span className="type-label text-muted-foreground">/ {s.target}</span>
									)}
									{s.target ? (
										<span
											className="ml-1 h-1 w-10 self-center overflow-hidden rounded-full bg-muted"
											aria-hidden
										>
											<span
												className="block h-full rounded-full bg-primary transition-[width] duration-700"
												style={{ width: `${Math.min(100, (s.done / s.target) * 100)}%` }}
											/>
										</span>
									) : null}
									{s.active > 0 && (
										<span className="type-label text-primary">
											+<Count value={s.active} />
										</span>
									)}
								</span>
							</span>
						</PopoverTrigger>
						<PopoverContent align="start" className="w-64 space-y-2">
							<p>{s.label}</p>
							<p className="type-label text-muted-foreground">{s.about}</p>
							<p className="type-label">
								{s.done} done{s.active ? ` · ${s.active} in progress` : ""}
								{s.target ? ` · ${s.target} planned` : ""}
							</p>
						</PopoverContent>
					</Popover>
				</li>
			))}
		</ol>
	);
}
