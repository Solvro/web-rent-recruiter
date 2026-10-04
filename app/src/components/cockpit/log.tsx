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
import { isPlumbing, plain } from "@/lib/plain";
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
	| { kind: "step"; id: string; item: ThreadActivity }
	| { kind: "fold"; id: string; items: ThreadActivity[] };

/** Bookkeeping: how the work moved along. Runs of it fold in place so payments and decisions stand out. */
const ROUTINE = new Set([
	"PLANNED",
	"GIG_POSTED",
	"GIG_CLAIMED",
	"DELIVERY_RECEIVED",
	"NOTE",
	"REVIEWED",
	"REPRICED",
]);

/** Internal failures the agent retries on its own are not the company's business; anything else, one plain line. */
const hidden = (item: ThreadActivity) =>
	item.kind === "TOOL" ||
	isPlumbing(item.message) ||
	(item.kind === "ERROR" &&
		(/retry|retrying/i.test(item.message) || /[{[]|Error|failed:/.test(item.message)));

function toRows(items: ThreadActivity[], fresh: (id: string) => boolean): Row[] {
	const rows: Row[] = [];
	let phase = -1;
	// Consecutive routine steps fold where they happened; a lone one stays a quiet line.
	let run: ThreadActivity[] = [];
	const flush = () => {
		if (run.length > 1) rows.push({ kind: "fold", id: `fold-${run[0]?.id}`, items: run });
		else if (run[0]) rows.push({ kind: "step", id: run[0].id, item: run[0] });
		run = [];
	};
	for (const item of items) {
		if (hidden(item)) continue;
		const p = phaseOf(item);
		if (p > phase) {
			flush();
			phase = p;
			rows.push({ kind: "phase", id: `phase-${p}`, name: PHASES[p] ?? "" });
		}
		// What just happened stays visible until the next visit.
		if (ROUTINE.has(item.kind) && !fresh(item.id)) {
			run.push(item);
			continue;
		}
		flush();
		rows.push({ kind: MESSAGES.has(item.kind) ? "message" : "step", id: item.id, item });
	}
	flush();
	return rows;
}

/**
 * The agent's log, Claude Code style: plain lines, no icons. The agent's own words stand out; its steps are quiet
 * and open on click (why, proof of payment, time). A live line says what it is doing right now.
 */
export function Log({
	roleId,
	items,
	loaded,
	now,
	busy,
	pinned,
	pinnedKey,
	closed = false,
	above,
	below,
}: {
	roleId: string;
	items: ThreadActivity[];
	/** The first load arrived: only lines after it count as new. */
	loaded: boolean;
	now: string | null;
	busy: boolean;
	/** The one thing that needs the company, pinned right above the composer. */
	pinned: ReactNode;
	/** Changes when the pinned card changes, so the list can keep its last line in view. */
	pinnedKey?: string;
	/** A closed role: read-only, no composer. */
	closed?: boolean;
	/** Orientation and waiting lines shown under the log. */
	above?: ReactNode;
	below?: ReactNode;
}) {
	const seen = useSeen(loaded ? items : undefined);
	const rows = toRows(items, (id) => !seen(id));
	const bottom = useComposerHeight();
	return (
		<MessageScrollerProvider defaultScrollPosition="end">
			<div className="flex min-h-0 flex-1 flex-col">
				<MessageScroller className="relative min-h-0 flex-1">
					<MessageScrollerViewport aria-label="What your agent did" className="scroll-fade-none">
						<MessageScrollerContent className="gap-1 pt-4 pb-16" spacerClassName="hidden">
							{above}
							{rows.length > 0 && <h2 className="px-2 pt-2 type-label text-muted-foreground">Activity</h2>}
							{rows.map((r) => (
								<MessageScrollerItem key={r.id} messageId={r.id}>
									{r.kind === "phase" ? (
										<Marker variant="separator" className="pt-6 pb-2">
											<MarkerContent>{r.name}</MarkerContent>
										</Marker>
									) : r.kind === "fold" ? (
										<Folded items={r.items} />
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
					{!closed && <Composer roleId={roleId} items={items} asking={!!pinnedKey} />}
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
			{live ? <Typed text={plain(item.message)} live /> : <WithCandidateLinks text={plain(item.message)} />}
		</p>
	);
}

function StepLine({ item }: { item: ThreadActivity }) {
	const [open, setOpen] = useState(false);
	// Demo data has made-up signatures: no proof link that leads nowhere.
	const proof = API_MOCK ? null : (item.solscanUrl ?? item.explorerUrl);
	const amount = moneyOf(item);
	const tone =
		item.kind === "DELIVERY_ACCEPTED" ||
		item.kind === "SHORTLISTED" ||
		item.kind === "DECISION" ||
		item.kind === "BUDGET"
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
					<WithCandidateLinks text={plain(item.message)} />
				</span>
				{amount && <span className="shrink-0 tabular text-foreground">{amount}</span>}
				<time
					dateTime={item.createdAt}
					className={cn(
						"shrink-0 tabular text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100",
						amount && "hidden",
					)}
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
						{item.detail && <p>{plain(item.detail)}</p>}
						<p className="flex flex-wrap gap-x-3">
							<span>{new Date(item.createdAt).toLocaleString()}</span>
							{proof && (
								<a
									href={proof}
									target="_blank"
									rel="noreferrer"
									className="inline-flex items-center gap-0.5 hover:text-foreground"
								>
									Proof of payment <ArrowUpRight className="size-3" />
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
	const at = items.findLastIndex((i) => i.kind === "DELIVERY_REJECTED");
	const rejected = items[at]?.message.match(/on (.+?)'s profile/)?.[1];
	// Stale once the company took them anyway or already asked.
	const settled =
		rejected &&
		items
			.slice(at + 1)
			.some(
				(i) =>
					i.message.includes(firstName(rejected)) &&
					/\b(took|taking|accepted|why did you pass)\b/i.test(i.message),
			);
	if (rejected && !settled) out.push(`Why did you pass on ${firstName(rejected)}?`);
	const paused = items.findLast((i) => i.kind === "PAUSED" || i.kind === "RESUMED")?.kind === "PAUSED";
	const screening = items.some((i) => i.kind === "GIG_POSTED" && /screening/i.test(i.message));
	if (paused) out.push("Resume");
	else if (screening) out.push("Pause screening");
	return out.slice(0, 3);
}

/** `asking`: a "Needs you" card sits above; on a phone the suggestions then give way to the feed. */
function Composer({ roleId, items, asking }: { roleId: string; items: ThreadActivity[]; asking?: boolean }) {
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
				<div
					className={cn(
						"-mx-4 flex gap-1.5 overflow-x-auto px-4 scrollbar-none sm:mx-0 sm:flex-wrap sm:px-0",
						asking && "max-sm:hidden",
					)}
				>
					{suggestionsFor(items).map((s) => (
						<button
							key={s}
							type="button"
							onClick={() => submit(s)}
							className="shrink-0 rounded-full px-3 py-1 type-label whitespace-nowrap text-muted-foreground ring-1 ring-border transition-colors hover:text-foreground"
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

/** The amount a line moved, for a right-aligned money column: payments and budget lines only. */
function moneyOf(item: ThreadActivity): string | null {
	if (item.kind === "BUDGET") return item.message.match(/\$[\d,]+(?:\.\d{2})?/)?.[0] ?? null;
	if (item.kind === "DELIVERY_ACCEPTED" || item.kind === "DECISION")
		return item.message.match(/\bpaid [^$]*?(\$[\d,]+(?:\.\d{2})?)/)?.[1] ?? null;
	return null;
}

/** A run of routine steps (posted, took, sent notes, booked), one quiet control until opened, in place. */
function Folded({ items }: { items: ThreadActivity[] }) {
	const [open, setOpen] = useState(false);
	return (
		<div>
			<button
				type="button"
				onClick={() => setOpen((o) => !o)}
				aria-expanded={open}
				className="rounded-xl px-2 py-1 type-label text-muted-foreground underline decoration-muted-foreground/40 decoration-dotted underline-offset-4 hover:text-foreground"
			>
				{open ? "Hide" : `Show ${items.length} earlier steps`}
			</button>
			<div
				className="grid transition-[grid-template-rows,opacity] duration-200 ease-out"
				style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0 }}
			>
				<div className="overflow-hidden">
					{items.map((item) => (
						<StepLine key={item.id} item={item} />
					))}
				</div>
			</div>
		</div>
	);
}
