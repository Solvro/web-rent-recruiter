import type { SubmissionView } from "@scout/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef } from "react";
import { toast } from "sonner";
import { AccountMenu, Onboarding } from "@/components/account";
import { Brand } from "@/components/bits";
import { ExplorerLink } from "@/components/explorer-link";
import { subscribeEvents } from "@/lib/api";
import { API_MOCK, AUTH_MODE } from "@/lib/env";
import { formatUsdc, netOfFee } from "@/lib/format";
import { useMe, useMySubmissions, useTasks } from "@/lib/queries";

const NAV = {
	company: [
		{ to: "/company", label: "Roles", exact: true },
		{ to: "/company/roles/new", label: "New role", exact: false },
	],
	scout: [
		{ to: "/scout", label: "Tasks", exact: true },
		{ to: "/scout/submissions", label: "My submissions", exact: false },
	],
} as const;

function useLiveUpdates() {
	const qc = useQueryClient();
	useEffect(() => subscribeEvents(() => void qc.invalidateQueries()), [qc]);
}

type Seen = Map<string, SubmissionView["status"]>;
const seenKey = (wallet: string) => `scout.seen.${wallet}`;
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

/** Toast the scout the moment a submission flips to paid, including payouts that landed while they were away. */
function PayoutNotifier({ wallet }: { wallet: string }) {
	const subs = useMySubmissions();
	const tasks = useTasks();
	const seen = useRef<Seen | null>(null);

	useEffect(() => {
		if (!subs.data) return;
		const prev = seen.current ?? loadSeen(wallet);
		const next = new Map(subs.data.map((s) => [s.id, s.status]));
		if (prev) {
			for (const s of subs.data) {
				if (s.status === "ACCEPTED" && prev.get(s.id) === "PENDING") {
					const task = tasks.data?.find((t) => t.id === s.roleId);
					const amount = task ? formatUsdc(netOfFee(task.bounty, task.feeBps)) : "Payout";
					toast.success(`+${amount} received`, {
						description: (
							<span className="flex flex-col gap-0.5">
								<span>{s.candidateName} was accepted.</span>
								<ExplorerLink signature={s.settlementTx} />
							</span>
						),
						duration: 8000,
					});
				}
				if (s.status === "REJECTED" && prev.get(s.id) === "PENDING")
					toast(`${s.candidateName} was not accepted`, { description: "See the reason in My submissions." });
			}
		}
		seen.current = next;
		saveSeen(wallet, next);
	}, [subs.data, tasks.data, wallet]);
	return null;
}

export function AppShell({ children }: { children: ReactNode }) {
	const me = useMe();
	useLiveUpdates();
	const nav = me.data ? NAV[me.data.kind] : [];

	return (
		<div className="flex min-h-svh flex-col">
			{AUTH_MODE === "demo" ? (
				<div className="bg-foreground px-4 py-1.5 text-center text-xs text-background/80">
					Demo mode{API_MOCK ? " with simulated data" : " on Solana devnet"}. Switch between the company and
					scout accounts from the menu in the top right.
				</div>
			) : (
				API_MOCK && (
					<div className="bg-foreground px-4 py-1.5 text-center text-xs text-background/80">
						Simulated data: payments and transactions are not real yet.
					</div>
				)
			)}
			<header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur">
				<div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-4 sm:px-6">
					<Link to="/" aria-label="Home">
						<Brand />
					</Link>
					<nav className="hidden items-center gap-1 md:flex">
						{nav.map((item) => (
							<Link
								key={item.to}
								to={item.to}
								activeOptions={{ exact: item.exact }}
								className="rounded-lg px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground data-[status=active]:bg-secondary data-[status=active]:text-foreground"
							>
								{item.label}
							</Link>
						))}
					</nav>
					<div className="ml-auto">
						<AccountMenu />
					</div>
				</div>
				{nav.length > 0 && (
					<nav className="flex gap-1 overflow-x-auto border-t px-4 py-1.5 md:hidden">
						{nav.map((item) => (
							<Link
								key={item.to}
								to={item.to}
								activeOptions={{ exact: item.exact }}
								className="shrink-0 rounded-lg px-3 py-1 text-sm text-muted-foreground data-[status=active]:bg-secondary data-[status=active]:text-foreground"
							>
								{item.label}
							</Link>
						))}
					</nav>
				)}
			</header>
			<main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6 sm:py-10">{children}</main>
			<footer className="border-t">
				<div className="mx-auto flex max-w-6xl flex-col gap-1 px-4 py-6 text-xs text-muted-foreground sm:flex-row sm:justify-between sm:px-6">
					<span>Budgets are held by an on-chain program, never by us. Payouts settle in USDC.</span>
					<span>The final hiring decision always stays with a person.</span>
				</div>
			</footer>
			<Onboarding />
			{me.data?.kind === "scout" && <PayoutNotifier key={me.data.wallet} wallet={me.data.wallet} />}
		</div>
	);
}
