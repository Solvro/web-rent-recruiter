import {
	ArrowUp,
	ArrowUpRight,
	Check,
	ChevronDown,
	Inbox,
	Loader2,
	Megaphone,
	MessageCircleQuestion,
	Pause,
	Play,
	SlidersHorizontal,
	Sparkles,
	StickyNote,
	UserCheck,
	UserPlus,
	X,
} from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import { Message, MessageContent } from "@/components/ui/message";
import {
	MessageScroller,
	MessageScrollerButton,
	MessageScrollerContent,
	MessageScrollerItem,
	MessageScrollerProvider,
	MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "@/lib/errors";
import { timeAgo } from "@/lib/format";
import { useSendMessage } from "@/lib/gigs/api";
import type { ThreadActivity } from "@/lib/gigs/schemas";
import { cn } from "@/lib/utils";
import { Fresh, Typed, useSeen } from "./fresh";
import { AgentAvatar } from "./status-bar";

const MESSAGE_KINDS = new Set(["COMPANY_MESSAGE", "AGENT_MESSAGE"]);
const STEP_ICON: Record<string, typeof Check> = {
	PLANNED: Sparkles,
	GIG_POSTED: Megaphone,
	GIG_CLAIMED: UserPlus,
	DELIVERY_RECEIVED: Inbox,
	REVIEWED: Sparkles,
	DELIVERY_ACCEPTED: Check,
	DELIVERY_REJECTED: X,
	ESCALATED: MessageCircleQuestion,
	SHORTLISTED: UserCheck,
	DECISION: UserCheck,
	PAUSED: Pause,
	RESUMED: Play,
	CRITERIA_UPDATED: SlidersHorizontal,
	NOTE: StickyNote,
};
const STEP_TONE: Record<string, string> = {
	DELIVERY_ACCEPTED: "text-success",
	SHORTLISTED: "text-success",
	DELIVERY_REJECTED: "text-destructive",
	ESCALATED: "text-primary",
};

/** Phases only move forward; a marker shows where each one starts. */
const PHASES = [
	{ name: "Sourcing", test: () => true },
	{ name: "Screening", test: (t: string) => /screening|language check/i.test(t) },
	{ name: "References", test: (t: string) => /reference/i.test(t) },
	{ name: "Shortlist", test: (t: string) => /shortlist|invited|interview/i.test(t) },
];

type Turn =
	| { kind: "phase"; id: string; name: string }
	| { kind: "message"; id: string; item: ThreadActivity }
	| { kind: "steps"; id: string; items: ThreadActivity[] };

function toTurns(items: ThreadActivity[]): Turn[] {
	const turns: Turn[] = [];
	let phase = -1;
	for (const item of items) {
		const next = PHASES.findLastIndex((p) => p.test(item.message));
		if (next > phase && !MESSAGE_KINDS.has(item.kind)) {
			phase = next;
			turns.push({ kind: "phase", id: `phase-${next}`, name: PHASES[next]?.name ?? "" });
		}
		if (MESSAGE_KINDS.has(item.kind)) turns.push({ kind: "message", id: item.id, item });
		else {
			const last = turns.at(-1);
			if (last?.kind === "steps") last.items.push(item);
			else turns.push({ kind: "steps", id: item.id, items: [item] });
		}
	}
	return turns;
}

/**
 * The agent's work log and the chat with it, in one scroller: phase markers, the agent narrating each change,
 * collapsible step rows with the "why", proof links on payments, and the live "what I'm doing now" line.
 */
export function Thread({
	roleId,
	items,
	now,
	busy,
}: {
	roleId: string;
	items: ThreadActivity[];
	now: string | null;
	busy: boolean;
}) {
	const seen = useSeen(items);
	const turns = toTurns(items);
	return (
		<div className="flex h-[calc(100svh-23rem)] min-h-[26rem] flex-col overflow-hidden rounded-4xl bg-card ring-1 ring-foreground/5">
			<MessageScrollerProvider autoScroll defaultScrollPosition="end">
				<MessageScroller className="min-h-0 flex-1">
					<MessageScrollerViewport aria-label="What your agent did">
						<MessageScrollerContent className="gap-4 px-4 pt-6 pb-14 sm:px-6" spacerClassName="hidden">
							{turns.map((t) => (
								<MessageScrollerItem key={t.id} messageId={t.id}>
									{t.kind === "phase" ? (
										<Marker variant="separator">
											<MarkerContent>{t.name}</MarkerContent>
										</Marker>
									) : t.kind === "message" ? (
										<Fresh fresh={!seen(t.id)}>
											<ChatMessage item={t.item} live={!seen(t.id)} />
										</Fresh>
									) : (
										<Steps items={t.items} seen={seen} />
									)}
								</MessageScrollerItem>
							))}
							{busy && now && (
								<MessageScrollerItem messageId="now">
									<Marker>
										<MarkerIcon>
											<Loader2 className="animate-spin text-primary" />
										</MarkerIcon>
										<MarkerContent className="shimmer">{now}…</MarkerContent>
									</Marker>
								</MessageScrollerItem>
							)}
						</MessageScrollerContent>
					</MessageScrollerViewport>
					<MessageScrollerButton />
				</MessageScroller>
			</MessageScrollerProvider>
			<Composer roleId={roleId} />
		</div>
	);
}

function ChatMessage({ item, live }: { item: ThreadActivity; live: boolean }) {
	if (item.kind === "COMPANY_MESSAGE")
		return (
			<Message align="end">
				<MessageContent>
					<Bubble align="end">
						<BubbleContent>{item.message}</BubbleContent>
					</Bubble>
				</MessageContent>
			</Message>
		);
	return (
		<Message>
			<AgentAvatar small />
			<MessageContent>
				<Bubble variant="ghost" className="max-w-full">
					<BubbleContent className="whitespace-pre-line">
						<Typed text={item.message} live={live} />
					</BubbleContent>
				</Bubble>
			</MessageContent>
		</Message>
	);
}

function Steps({ items, seen }: { items: ThreadActivity[]; seen: (id: string) => boolean }) {
	const [all, setAll] = useState(false);
	const hidden = items.length > 6 && !all ? items.length - 4 : 0;
	return (
		<div className="space-y-0.5 border-l-2 border-border pl-3">
			{hidden > 0 && (
				<button
					type="button"
					onClick={() => setAll(true)}
					className="flex items-center gap-1 py-1 type-label text-muted-foreground hover:text-foreground"
				>
					<ChevronDown className="size-3.5" /> {hidden} earlier steps
				</button>
			)}
			{items.slice(hidden).map((item) => (
				<Fresh key={item.id} fresh={!seen(item.id)}>
					<Step item={item} />
				</Fresh>
			))}
		</div>
	);
}

function Step({ item }: { item: ThreadActivity }) {
	const [open, setOpen] = useState(false);
	const Icon = STEP_ICON[item.kind] ?? Sparkles;
	const proof = item.solscanUrl ?? item.explorerUrl;
	return (
		<div className="px-1 py-1">
			<Marker className="text-foreground">
				<MarkerIcon>
					<Icon className={STEP_TONE[item.kind] ?? "text-muted-foreground"} />
				</MarkerIcon>
				<MarkerContent className="min-w-0 flex-1">
					{item.detail ? (
						<button
							type="button"
							onClick={() => setOpen((o) => !o)}
							aria-expanded={open}
							className="inline-flex max-w-full items-center gap-1 text-left text-foreground hover:text-primary"
						>
							<span className="truncate">{item.message}</span>
							<ChevronDown className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-180")} />
						</button>
					) : (
						<span className="text-foreground">{item.message}</span>
					)}
				</MarkerContent>
				{proof && (
					<a
						href={proof}
						target="_blank"
						rel="noreferrer"
						className="hidden shrink-0 items-center gap-0.5 no-underline! hover:text-foreground sm:inline-flex"
					>
						Signed by your agent <ArrowUpRight className="size-3" />
					</a>
				)}
				<time
					dateTime={item.createdAt}
					title={timeAgo(item.createdAt)}
					className="w-12 shrink-0 text-right tabular"
				>
					{shortAgo(item.createdAt)}
				</time>
			</Marker>
			<div
				className="grid transition-[grid-template-rows,opacity] duration-300"
				style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0 }}
			>
				<div className="overflow-hidden">
					<p className="mt-1 mb-1 ml-6 type-label text-muted-foreground">{item.detail}</p>
				</div>
			</div>
		</div>
	);
}

/** "now", "4 min", "2 h", "3 d" */
function shortAgo(iso: string) {
	const s = (Date.now() - new Date(iso).getTime()) / 1000;
	if (s < 60) return "now";
	if (s < 3600) return `${Math.floor(s / 60)} min`;
	if (s < 86400) return `${Math.floor(s / 3600)} h`;
	return `${Math.floor(s / 86400)} d`;
}

const SUGGESTIONS = ["What are you waiting for?", "Why did you reject Piotr?", "Pause screening"];

function Composer({ roleId }: { roleId: string }) {
	const [text, setText] = useState("");
	const send = useSendMessage(roleId);
	const submit = (value: string, e?: FormEvent) => {
		e?.preventDefault();
		const v = value.trim();
		if (!v || send.isPending) return;
		send.mutate(v, { onSuccess: () => setText(""), onError: (err) => toast.error(errorMessage(err)) });
	};
	return (
		<div className="space-y-2 border-t bg-background/60 p-3">
			{!text && (
				<div className="flex flex-wrap gap-1.5">
					{SUGGESTIONS.map((s) => (
						<button
							key={s}
							type="button"
							onClick={() => submit(s)}
							className="rounded-full bg-card px-3 py-1 type-label text-muted-foreground ring-1 ring-border transition-colors hover:text-foreground"
						>
							{s}
						</button>
					))}
				</div>
			)}
			<form
				onSubmit={(e) => submit(text, e)}
				className="flex items-end gap-2 rounded-3xl bg-card p-1.5 ring-1 ring-foreground/10 focus-within:ring-primary/40"
			>
				<Textarea
					value={text}
					onChange={(e) => setText(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey) submit(text, e);
					}}
					rows={1}
					placeholder="Tell your agent what to do"
					aria-label="Message your agent"
					className="max-h-40 min-h-10 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
				/>
				<Button type="submit" size="icon" aria-label="Send" disabled={!text.trim() || send.isPending}>
					{send.isPending ? <Loader2 className="animate-spin" /> : <ArrowUp />}
				</Button>
			</form>
		</div>
	);
}
