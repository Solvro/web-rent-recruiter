import { Bot, Check, KeyRound, UserCheck } from "lucide-react";
import { Input } from "@/components/ui/input";
import type { ReviewerModeValue } from "@/lib/gigs/review";
import { cn } from "@/lib/utils";

const OPTIONS: { mode: ReviewerModeValue; icon: typeof Bot; name: string; line: string }[] = [
	{
		mode: "scout",
		icon: Bot,
		name: "Scout agent",
		line: "Checks every delivery within seconds and pays for good work.",
	},
	{
		mode: "custom",
		icon: KeyRound,
		name: "Your own agent",
		line: "Any agent you run. Paste its ID.",
	},
	{
		mode: "self",
		icon: UserCheck,
		name: "I'll review myself",
		line: "Deliveries wait for you to accept or reject.",
	},
];

const KEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const validReviewer = (mode: ReviewerModeValue, key: string) =>
	mode !== "custom" || KEY.test(key.trim());

/** "Who checks the work?": three choices, plus the key field for your own agent. */
export function ReviewerChoice({
	mode,
	agentKey,
	onChange,
}: {
	mode: ReviewerModeValue;
	agentKey: string;
	onChange: (mode: ReviewerModeValue, agentKey: string) => void;
}) {
	return (
		<fieldset className="space-y-3">
			<legend className="mb-3 type-label text-muted-foreground">Who checks the work?</legend>
			<div className="grid gap-2 sm:grid-cols-3">
				{OPTIONS.map((o) => {
					const selected = mode === o.mode;
					return (
						<label
							key={o.mode}
							className={cn(
								"relative flex cursor-pointer flex-col gap-2 rounded-3xl p-4 ring-1 transition-colors",
								selected ? "bg-accent ring-primary" : "bg-card ring-foreground/10 hover:bg-muted",
							)}
						>
							<input
								type="radio"
								name="reviewer"
								value={o.mode}
								checked={selected}
								onChange={() => onChange(o.mode, agentKey)}
								className="sr-only"
							/>
							<span className="flex items-center gap-2">
								<o.icon className="size-4 text-primary" />
								{o.name}
								{selected && <Check className="ml-auto size-4 text-primary" />}
							</span>
							<span className="type-label text-muted-foreground">{o.line}</span>
						</label>
					);
				})}
			</div>
			{mode === "custom" && (
				<div className="space-y-1">
					<Input
						value={agentKey}
						onChange={(e) => onChange(mode, e.target.value)}
						placeholder="Your agent's ID"
						aria-label="Your agent's ID"
						className="h-11"
					/>
					{agentKey && !KEY.test(agentKey.trim()) && (
						<p className="type-label text-destructive">That doesn't look like an agent ID.</p>
					)}
				</div>
			)}
		</fieldset>
	);
}
