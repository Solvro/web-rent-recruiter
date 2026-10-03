import { ArrowUp, ArrowUpRight, Loader2 } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { Marker, MarkerContent } from "@/components/ui/marker";
import {
	MessageScroller,
	MessageScrollerContent,
	MessageScrollerItem,
	MessageScrollerProvider,
	MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Textarea } from "@/components/ui/textarea";
import { API_MOCK } from "@/lib/env";
import { errorMessage } from "@/lib/errors";
import { firstName } from "@/lib/format";
import { useSendMessage } from "@/lib/gigs/api";
import type { ThreadActivity } from "@/lib/gigs/schemas";
import { cn } from "@/lib/utils";
import { useCandidatesPanel, WithCandidateLinks } from "./candidates";
import { Follow } from "./follow";
import { Fresh, Typed, useSeen } from "./fresh";

const MESSAGES = new Set(["COMPANY_MESSAGE", "AGENT_MESSAGE"]);
const QUIET = new Set(["DELIVERY_RECEIVED", "GIG_CLAIMED", "NOTE", "PLANNED"]);

/** A phase starts when the agent posts its first gig of that kind (or shortlists someone). Never goes back. */
const PHASES = ["Sourcing", "Screening", "References", "Shortlist"];
function phaseOf(item: ThreadActivity): number {
	if (item.kind === "SHORTLISTED") return 3;
	if (item.kind === "PLANNED") return 0;
	if (item.kind !== "GIG_POSTED") return -1;
	if (/reference/i.test(item.message)) return 2;
	if (/screening|language/i.test(item.message)) return 1;
	return 0;
}

type Row =
	| { kind: "phase"; id: string; name: string }
	| { kind: "message"; id: string; item: ThreadActivity }
	| { kind: "step"; id: string; item: ThreadActivity };

function toRows(items: ThreadActivity[]): Row[] {
	const rows: Row[] = [];
	let phase = -1;
	for (const item of items) {
		// Tool calls behind a reply are the agent's plumbing, not news for Hanna.
		if (item.kind === "TOOL") continue;
		const p = phaseOf(item);
		if (p > phase) {
			phase = p;
			rows.push({ kind: "phase", id: `phase-${p}`, name: PHASES[p] ?? "" });
		}
		rows.push({ kind: MESSAGES.has(item.kind) ? "message" : "step", id: item.id, item });
	}
	return rows;
}

/**
 * The agent's log, Claude Code style: plain lines, no icons. The agent's own words stand out; its steps are quiet
 * and open on click (why, proof of payment, time). A live line says what it is doing right now.
 */
export function Log({
	roleId,
	items,
	now,
	busy,
	pinned,
	pinnedKey,
	above,
	below,
}: {
	roleId: string;
	items: ThreadActivity[];
	now: string | null;
	busy: boolean;
	/** The one thing that needs the company, pinned right above the composer. */
	pinned: ReactNode;
	/** Changes when the pinned card changes, so the list can keep its last line in view. */
	pinnedKey?: string;
	/** Orientation and waiting lines shown under the log. */
	above?: ReactNode;
	below?: ReactNode;
}) {
	const seen = useSeen(items);
	const rows = toRows(items);
	const bottom = useComposerHeight();
	return (
		<MessageScrollerProvider defaultScrollPosition="end">
			<div className="flex min-h-0 flex-1 flex-col">
				<MessageScroller className="relative min-h-0 flex-1">
					<MessageScrollerViewport aria-label="What your agent did" className="scroll-fade-none">
						<MessageScrollerContent className="gap-1 pt-4 pb-16" spacerClassName="hidden">
							{above}
							{rows.map((r) => (
								<MessageScrollerItem key={r.id} messageId={r.id}>
									{r.kind === "phase" ? (
										<Marker variant="separator" className="pt-6 pb-2">
											<MarkerContent>{r.name}</MarkerContent>
										</Marker>
									) : (
										<Fresh fresh={!seen(r.id)}>
											{r.kind === "message" ? (
												<ChatLine item={r.item} live={!seen(r.id)} />
											) : (
												<StepLine item={r.item} />
											)}
										</Fresh>
									)}
								</MessageScrollerItem>
							))}
							{below && <MessageScrollerItem messageId="now">{below}</MessageScrollerItem>}
						</MessageScrollerContent>
					</MessageScrollerViewport>
					<Follow changeKey={`${items.length}:${busy ? now : ""}`} layoutKey={pinnedKey} />
				</MessageScroller>
				<div ref={bottom} className="space-y-3 pb-4">
					{pinned}
					<Composer roleId={roleId} items={items} />
				</div>
			</div>
		</MessageScrollerProvider>
	);
}

/** Publishes the composer area's height so toasts can sit above it. */
function useComposerHeight() {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const el = ref.current;
		const root = document.documentElement;
		if (!el || typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(() => root.style.setProperty("--composer-height", `${el.offsetHeight}px`));
		ro.observe(el);
		return () => {
			ro.disconnect();
			root.style.removeProperty("--composer-height");
		};
	}, []);
	return ref;
}

function ChatLine({ item, live }: { item: ThreadActivity; live: boolean }) {
	if (item.kind === "COMPANY_MESSAGE")
		return (
			<Bubble align="end" className="my-2 ml-auto">
				<BubbleContent>{item.message}</BubbleContent>
			</Bubble>
		);
	return (
		<p className="my-2 px-2 whitespace-pre-line" title={new Date(item.createdAt).toLocaleString()}>
			{live ? <Typed text={item.message} live /> : <WithCandidateLinks text={item.message} />}
		</p>
	);
}

function StepLine({ item }: { item: ThreadActivity }) {
	const [open, setOpen] = useState(false);
	// Demo data has made-up signatures: no proof link that leads nowhere.
	const proof = API_MOCK ? null : (item.solscanUrl ?? item.explorerUrl);
	const tone =
		item.kind === "DELIVERY_ACCEPTED" || item.kind === "SHORTLISTED"
			? "text-foreground"
			: item.kind === "DELIVERY_REJECTED"
				? "text-muted-foreground"
				: item.kind === "ESCALATED"
					? "text-primary"
					: QUIET.has(item.kind)
						? "text-muted-foreground/80"
						: "text-muted-foreground";
	return (
		<div className="group">
			<button
				type="button"
				onClick={() => setOpen((o) => !o)}
				aria-expanded={open}
				className="flex w-full items-baseline gap-3 rounded-xl px-2 py-1 text-left type-label hover:bg-muted"
			>
				<span className={cn("min-w-0 flex-1", tone)}>
					<WithCandidateLinks text={item.message} />
				</span>
				<time
					dateTime={item.createdAt}
					className="shrink-0 tabular text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
				>
					{new Date(item.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
				</time>
			</button>
			<div
				className="grid transition-[grid-template-rows,opacity] duration-300"
				style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0 }}
			>
				<div className="overflow-hidden">
					<div className="space-y-1 px-2 pt-1 pb-2 type-label text-muted-foreground">
						{item.detail && <p>{item.detail}</p>}
						<p className="flex flex-wrap gap-x-3">
							<span>{new Date(item.createdAt).toLocaleString()}</span>
							{proof && (
								<a
									href={proof}
									target="_blank"
									rel="noreferrer"
									className="inline-flex items-center gap-0.5 hover:text-foreground"
								>
									Signed by your agent <ArrowUpRight className="size-3" />
								</a>
							)}
						</p>
					</div>
				</div>
			</div>
		</div>
	);
}

/** Two or three things worth asking right now, from what actually happened. */
function suggestionsFor(items: ThreadActivity[]) {
	const out = ["What are you waiting for?"];
	const rejected = items
		.findLast((i) => i.kind === "DELIVERY_REJECTED")
		?.message.match(/on (.+?)'s profile/)?.[1];
	if (rejected) out.push(`Why did you pass on ${firstName(rejected)}?`);
	const paused = items.findLast((i) => i.kind === "PAUSED" || i.kind === "RESUMED")?.kind === "PAUSED";
	const screening = items.some((i) => i.kind === "GIG_POSTED" && /screening/i.test(i.message));
	if (paused) out.push("Resume");
	else if (screening) out.push("Pause screening");
	return out.slice(0, 3);
}

function Composer({ roleId, items }: { roleId: string; items: ThreadActivity[] }) {
	const [text, setText] = useState("");
	const send = useSendMessage(roleId);
	const { byName, open } = useCandidatesPanel();
	const submit = (value: string, e?: FormEvent) => {
		e?.preventDefault();
		const v = value.trim();
		if (!v || send.isPending) return;
		// "Show Karolina's notes / transcript / profile": open their page right away; the agent still answers.
		if (
			/\b(show|open|see|view)\b.*\b(notes?|profile|transcript|screening|call|reference|candidate)\b/i.test(v)
		) {
			const hit = [...byName].find(
				([name]) =>
					v.toLowerCase().includes(name.toLowerCase()) ||
					v.toLowerCase().includes(name.split(" ")[0].toLowerCase()),
			);
			if (hit) open(hit[1]);
		}
		setText("");
		send.mutate(v, {
			onError: (err) => {
				setText(v);
				toast.error(errorMessage(err));
			},
		});
	};
	return (
		<div className="space-y-2">
			{!text && (
				<div className="flex flex-wrap gap-1.5">
					{suggestionsFor(items).map((s) => (
						<button
							key={s}
							type="button"
							onClick={() => submit(s)}
							className="rounded-full px-3 py-1 type-label text-muted-foreground ring-1 ring-border transition-colors hover:text-foreground"
						>
							{s}
						</button>
					))}
				</div>
			)}
			<form
				onSubmit={(e) => submit(text, e)}
				className="flex items-end gap-2 rounded-3xl bg-card p-1.5 shadow-sm ring-1 ring-foreground/10 focus-within:ring-primary/40"
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
