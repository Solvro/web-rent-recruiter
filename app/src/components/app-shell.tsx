import type { LiveEvent } from "@scout/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { AccountMenu } from "@/components/account";
import { Brand, Chip } from "@/components/bits";
import { Receipt, type ReceiptDetails } from "@/components/receipt";
import { Button } from "@/components/ui/button";
import { useOffline } from "@/lib/connection";
import { AUTH_MODE } from "@/lib/env";
import { dateLabel, firstName, formatMoney, personInTitle } from "@/lib/format";
import { useMyWork } from "@/lib/gigs/api";
import type { DeliverableView } from "@/lib/gigs/schemas";
import { inCents } from "@/lib/payout";
import { useMe } from "@/lib/queries";
import { useTRPCClient } from "@/lib/trpc";

const NAV = {
	company: [{ to: "/company", label: "Roles" }],
	scout: [
		{ to: "/scout", label: "Gigs" },
		{ to: "/scout/submissions", label: "Earnings" },
	],
} as const;

/** One live-events connection for the whole app; components listen through this set. */
const liveListeners = new Set<(e: LiveEvent) => void>();

function useLiveUpdates() {
	const qc = useQueryClient();
	const client = useTRPCClient();
	useEffect(() => {
		const sub = client.events.subscribe(undefined, {
			onData: (e) => {
				for (const l of liveListeners) l(e);
				void qc.invalidateQueries();
			},
		});
		return () => sub.unsubscribe();
	}, [client, qc]);
}

/** Per submission: "STATUS:LATER", e.g. "ACCEPTED:HELD". */
type Seen = Map<string, string>;
const seenKey = (wallet: string) => `scout.seen.${wallet}`;
const stateOf = (s: DeliverableView) => `${s.status}:${s.payout?.laterStatus ?? "NONE"}`;

/** Who a piece of work is about: the sourced candidate, or the person the call was with. */
function personOf(d: DeliverableView) {
	if (d.deliverable.type === "SOURCING") return d.deliverable.name;
	return personInTitle(d.gigTitle);
}
/** Payments this recent still get their moment even if the pending state was never seen. */
const RECENT_MS = 30 * 60_000;

function loadSeen(wallet: string): Seen | null {
	try {
		const raw = localStorage.getItem(seenKey(wallet));
		return raw ? new Map(JSON.parse(raw)) : null;
	} catch {
		return null;
	}
}
function saveSeen(wallet: string, seen: Seen) {
	try {
		localStorage.setItem(seenKey(wallet), JSON.stringify([...seen]));
	} catch {
		// private mode
	}
}

type Moment = {
	key: string;
	big: boolean;
	amount: string;
	line: string;
	extra?: string;
	receipt: string | null;
	details?: ReceiptDetails;
};

/**
 * The recruiter's big moment: "+$11.34 · Payment sent" when a candidate is accepted, then a smaller one
 * when the held-back part arrives. Also catches payments that landed while the recruiter was away.
 */
function PayoutMoment({ wallet }: { wallet: string }) {
	const subs = useMyWork();
	const seen = useRef<Seen | null>(null);
	const receipts = useRef(new Map<string, string>());
	const [queue, setQueue] = useState<Moment[]>([]);

	useEffect(() => {
		const listener = (e: LiveEvent) => {
			if (
				e.submissionId &&
				e.signature &&
				(e.type === "submission.outcome" || e.type === "submission.released")
			)
				receipts.current.set(e.submissionId, e.signature);
		};
		liveListeners.add(listener);
		return () => {
			liveListeners.delete(listener);
		};
	}, []);

	useEffect(() => {
		if (!subs.data) return;
		const prev = seen.current ?? loadSeen(wallet);
		if (prev) {
			const fresh: Moment[] = [];
			for (const s of subs.data) {
				// Work that was sent and paid while this tab wasn't watching (e.g. the candidate confirmed while the
				// recruiter was on another page): still a moment, if it is recent.
				const recent = Date.now() - Date.parse(s.review?.reviewedAt ?? s.submittedAt) < RECENT_MS;
				const before = prev.get(s.id) ?? (recent && s.status === "ACCEPTED" ? "PENDING:NONE" : undefined);
				if (!before) continue;
				const [wasStatus, wasLater] = before.split(":");
				const p = s.payout && { ...s.payout, ...inCents(s.payout.now, s.payout.later) };
				const person = personOf(s);
				const name = firstName(person);
				const what = s.gigType === "SOURCING" ? person : s.gigTitle;
				if (wasStatus === "PENDING" && s.status === "ACCEPTED" && p) {
					fresh.push({
						key: `${s.id}:now`,
						big: true,
						amount: formatMoney(p.now),
						line:
							s.gigType === "SOURCING" ? `${name} confirmed · payment sent` : `Payment sent · ${s.gigTitle}`,
						extra:
							// Keyed on the amount: right after accept the server may not have marked it HELD yet.
							BigInt(p.later) > 0n && p.laterStatus !== "RELEASED" && p.laterStatus !== "REFUNDED"
								? `+${formatMoney(p.later)} when ${name} comes to the interview`
								: undefined,
						receipt: s.settlementTx,
						details: {
							title: `Paid ${formatMoney(p.now)} to you`,
							lines: [`${what} · ${s.roleTitle}`, dateLabel(new Date())],
						},
					});
				}
				// Status notes join the same queue so nothing ever stacks on top of a payout panel.
				if (
					wasStatus === "PENDING" &&
					s.status === "REJECTED" &&
					!/^withdrawn by the recruiter/i.test(s.review?.reasons[0] ?? "")
				)
					fresh.push({
						key: `${s.id}:rejected`,
						big: false,
						amount: "",
						line: `The agent didn't accept ${s.gigType === "SOURCING" ? `${person}'s profile` : "your notes"}`,
						receipt: null,
					});
				if (s.status === "ACCEPTED" && p && wasLater !== p.laterStatus) {
					if (p.laterStatus === "RELEASED")
						fresh.push({
							key: `${s.id}:later`,
							big: false,
							amount: formatMoney(p.later),
							line:
								p.outcome === "ADVANCED"
									? `${name} came to the interview`
									: `Rest of the payment for ${name}`,
							receipt: receipts.current.get(s.id) ?? null,
							details: {
								title: `Paid ${formatMoney(p.later)} to you`,
								lines: [`${what} · ${s.roleTitle}`, dateLabel(new Date())],
							},
						});
					if (p.laterStatus === "REFUNDED")
						fresh.push({
							key: `${s.id}:refunded`,
							big: false,
							amount: "",
							line: `The company reported a problem with ${person}`,
							receipt: null,
						});
				}
			}
			if (fresh.length) setQueue((q) => [...q, ...fresh]);
		}
		const next: Seen = new Map(subs.data.map((s) => [s.id, stateOf(s)]));
		seen.current = next;
		saveSeen(wallet, next);
	}, [subs.data, wallet]);

	const current = queue[0];
	const panel = useRef<HTMLDivElement>(null);
	// Any other toast (e.g. "Submitted") is lifted above the panel instead of covering it.
	useEffect(() => {
		const root = document.documentElement;
		if (!current || !panel.current) {
			root.style.removeProperty("--moment-height");
			return;
		}
		root.style.setProperty("--moment-height", `${panel.current.offsetHeight}px`);
		return () => {
			root.style.removeProperty("--moment-height");
		};
	}, [current]);
	if (!current) return null;
	const dismiss = () => setQueue((q) => q.slice(1));
	return (
		<div
			ref={panel}
			className="fixed inset-x-0 bottom-0 z-50 animate-in border-t bg-card shadow-2xl slide-in-from-bottom-8 fade-in-0"
		>
			{current.big ? (
				<div className="mx-auto flex max-w-3xl flex-col items-center gap-4 px-6 py-10 text-center">
					<p className="type-display text-success">+{current.amount}</p>
					<p>{current.line}</p>
					{current.extra && <p className="type-label text-muted-foreground">{current.extra}</p>}
					<Button size="lg" className="min-w-40" onClick={dismiss}>
						Got it
					</Button>
					<Receipt signature={current.receipt} details={current.details} />
				</div>
			) : (
				<div className="mx-auto flex max-w-3xl items-center gap-4 px-6 py-5">
					<p className="flex-1">
						{current.amount && (
							<>
								<span className="text-success">+{current.amount}</span> ·{" "}
							</>
						)}
						{current.line}
					</p>
					<Receipt signature={current.receipt} details={current.details} />
					<Button onClick={dismiss}>Got it</Button>
				</div>
			)}
		</div>
	);
}

export function AppShell({ children }: { children: ReactNode }) {
	const me = useMe();
	useLiveUpdates();
	const nav = me.data ? NAV[me.data.kind] : [];

	return (
		<div className="flex min-h-svh flex-col">
			<Reconnecting />
			<header className="sticky top-0 z-40 bg-background/85 backdrop-blur">
				<div className="mx-auto flex h-16 max-w-5xl items-center gap-3 px-4 sm:gap-8 sm:px-6">
					<Link to="/" aria-label="Home" className="flex items-center gap-2">
						<Brand />
						{AUTH_MODE === "demo" && <Chip>Demo</Chip>}
					</Link>
					<nav className="flex items-center gap-1">
						{nav.map((item) => (
							<Link
								key={item.to}
								to={item.to}
								activeOptions={{ exact: item.to === "/scout" }}
								className="rounded-full px-3 py-1.5 type-label text-muted-foreground transition-colors hover:text-foreground data-[status=active]:text-foreground"
							>
								{item.label}
							</Link>
						))}
					</nav>
					<div className="ml-auto">
						<AccountMenu />
					</div>
				</div>
			</header>
			<main className="mx-auto w-full max-w-5xl flex-1 px-4 py-12 sm:px-6 sm:py-16">{children}</main>
			{me.data?.kind === "scout" && <PayoutMoment key={me.data.wallet} wallet={me.data.wallet} />}
		</div>
	);
}

/** Quiet notice while the backend restarts; everything retries by itself. */
function Reconnecting() {
	const offline = useOffline();
	if (!offline) return null;
	return (
		<div className="fixed top-3 left-1/2 z-50 -translate-x-1/2 animate-in fade-in slide-in-from-top-2">
			<p className="flex items-center gap-2 rounded-full bg-foreground px-4 py-2 type-label text-background shadow-lg">
				<Loader2 className="size-3.5 animate-spin" /> Reconnecting…
			</p>
		</div>
	);
}
