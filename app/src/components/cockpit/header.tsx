import type { RoleDetail } from "@scout/shared";
import { useMutation } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { Receipt } from "@/components/receipt";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { errorMessage } from "@/lib/errors";
import { formatMoney } from "@/lib/format";
import { usePayments } from "@/lib/gigs/candidates";
import type { RoleStatus } from "@/lib/gigs/status";
import { inCents } from "@/lib/payout";
import { useMe } from "@/lib/queries";
import { useTRPCClient } from "@/lib/trpc";
import { useTransact } from "@/lib/use-transact";
import { cn } from "@/lib/utils";

/**
 * What matters to the company, in order: one sentence for where things stand (or that it is waiting for them),
 * money on the right, then the people and what the agent is waiting on. Details open on the title.
 */
export function RoleHeader({
	role,
	status,
	headline,
	onDetails,
	children,
}: {
	role: RoleDetail;
	status: RoleStatus | undefined;
	/** One sentence: does anything need the company, else where things stand. */
	headline: { text: string; tone: "primary" | "plain" };
	onDetails: () => void;
	/** The people and what the agent is waiting on, kept in view above the activity. */
	children?: ReactNode;
}) {
	return (
		<header className="relative z-10 space-y-3 bg-background pt-4 pb-3 after:pointer-events-none after:absolute after:inset-x-0 after:-bottom-4 after:h-4 after:bg-gradient-to-b after:from-background after:to-transparent">
			<div className="space-y-1 px-2">
				<div className="flex items-baseline gap-3">
					<button
						type="button"
						onClick={onDetails}
						title={role.title}
						className="min-w-0 flex-1 truncate text-left type-label text-muted-foreground hover:text-foreground"
					>
						{role.title}
					</button>
					<button
						type="button"
						onClick={onDetails}
						className="shrink-0 type-label text-muted-foreground hover:text-foreground"
					>
						Details
					</button>
				</div>
				<div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
					<p
						aria-live="polite"
						className={cn("min-w-0 type-display", headline.tone === "primary" && "text-primary")}
					>
						{headline.text}
					</p>
					{status && <Spent role={role} budget={status.budget} />}
				</div>
			</div>
			{/* Kept in view, but never so tall that the activity and the composer lose their room. */}
			{children && (
				<div className="max-h-[34svh] space-y-3 overflow-y-auto overscroll-contain sm:max-h-[46svh]">
					{children}
				</div>
			)}
		</header>
	);
}

const WORK: Record<string, string> = {
	sourcing: "profile",
	screening: "screening call",
	language: "language check",
	reference: "reference check",
	show_up_fee: "interview show-up",
	appeal: "appeal",
};

/** Who got what, for which gig, with the receipt. */
function Ledger({ roleId }: { roleId: string }) {
	const ledger = usePayments(roleId, true);
	if (!ledger.data?.length) return null;
	return (
		<ul className="max-h-64 space-y-3 overflow-y-auto border-t pt-3 type-label">
			{ledger.data.map((p) => {
				// The line at its plan price (what the company paid for it); the recruiter's share and fee in the detail.
				const price = BigInt(p.bounty ?? BigInt(p.amount) + BigInt(p.held) + BigInt(p.fees));
				const c = inCents(p.amount, p.held);
				return (
					<li key={p.deliverableId} className="space-y-0.5">
						<p className="flex items-baseline justify-between gap-3">
							<span className="min-w-0 truncate">
								{p.recruiter} <span className="text-muted-foreground">· {WORK[p.kind] ?? "task"}</span>
							</span>
							<span className="shrink-0 tabular">{formatMoney(price)}</span>
						</p>
						<p className="text-muted-foreground">
							{formatMoney(c.now)} to {p.recruiter.split(" ")[0]}
							{BigInt(p.held) > 0n &&
								` · ${formatMoney(c.later)} ${p.heldStatus === "HELD" ? "after the interview" : p.heldStatus === "RELEASED" ? "paid after the interview" : "returned to you"}`}
							{BigInt(p.fees) > 0n && ` · ${formatMoney(p.fees)} fee`}
							{p.signature && <Receipt signature={p.signature} className="ml-2" />}
						</p>
					</li>
				);
			})}
		</ul>
	);
}

/** Accepted work at its plan price (what the company pays for it, fees included). Falls back for older APIs. */
const spentOf = (b: RoleStatus["budget"]) => BigInt(b.spent ?? BigInt(b.paid) + BigInt(b.heldBack));

function Spent({ role, budget }: { role: RoleDetail; budget: RoleStatus["budget"] }) {
	const spent = spentOf(budget);
	const closed = role.status === "CLOSED";
	// Deposits forfeited by recruiters sit in "not yet used" on top of the budget: shown, so the lines add up.
	const kept = BigInt(budget.bondsForfeited ?? "0");
	// Spent + set aside + uncommitted − kept deposits = the budget, so the lines below always add up to the total.
	const rows: [string, bigint, string?][] = [
		[
			"Spent on accepted work",
			spent,
			[
				BigInt(budget.heldBack) > 0n &&
					`${formatMoney(budget.heldBack)} of it is paid only once the candidate comes to the interview`,
				budget.fees && BigInt(budget.fees) > 0n && `includes ${formatMoney(budget.fees)} in fees`,
			]
				.filter(Boolean)
				.join("; ") || undefined,
		],
		...(closed
			? [["Came back to you", BigInt(budget.refunded ?? "0")] as [string, bigint]]
			: [
					[
						"Set aside for open work",
						BigInt(budget.committed),
						"money promised to tasks recruiters are working on",
					] as [string, bigint, string],
					["Not yet used", BigInt(budget.available)] as [string, bigint],
				]),
	];
	return (
		<Popover>
			<PopoverTrigger className="shrink-0 type-label text-muted-foreground tabular hover:text-foreground">
				{role.status === "CLOSED"
					? `${formatMoney(spent)} spent · ${formatMoney(budget.refunded ?? 0n)} back to you`
					: `${formatMoney(spent)} of ${formatMoney(budget.deposited)} spent`}
			</PopoverTrigger>
			<PopoverContent align="end" className="w-[min(26rem,calc(100vw-2rem))] space-y-4">
				<dl className="space-y-2.5">
					{rows.map(([k, v, note]) => (
						<div key={k}>
							<div className="flex justify-between gap-4">
								<dt className="text-muted-foreground">{k}</dt>
								<dd className="tabular">{formatMoney(v)}</dd>
							</div>
							{note && <p className="type-label text-muted-foreground">{note}</p>}
						</div>
					))}
					{kept > 0n && (
						<div>
							<div className="flex justify-between gap-4">
								<dt className="text-muted-foreground">Kept from rejected work</dt>
								<dd className="tabular">−{formatMoney(kept)}</dd>
							</div>
							<p className="type-label text-muted-foreground">
								recruiters' deposits on work your agent didn't accept; it adds to your budget
							</p>
						</div>
					)}
					<div className="flex justify-between gap-4 border-t pt-2">
						<dt>Budget</dt>
						<dd className="tabular">{formatMoney(budget.deposited)}</dd>
					</div>
				</dl>
				<Ledger roleId={role.id} />
				{role.status === "OPEN" && <TopUp role={role} />}
			</PopoverContent>
		</Popover>
	);
}

function TopUp({ role }: { role: RoleDetail }) {
	const client = useTRPCClient();
	const me = useMe();
	const balance = BigInt(me.data?.usdcBalance ?? "0");
	const [amount, setAmount] = useState(100);
	const { transact } = useTransact();
	const value = BigInt(amount) * 1_000_000n;
	const topUp = useMutation({
		mutationFn: async () => {
			const { unsignedTx } = await client.roles.topUp.mutate({ id: role.id, amount: value.toString() });
			await transact(unsignedTx, { pending: "Adding budget…", success: `${formatMoney(value)} added.` });
		},
		onError: (e) => toast.error(errorMessage(e)),
	});
	return (
		<div className="space-y-2 border-t pt-4">
			<p className="type-label text-muted-foreground">You have {formatMoney(balance)} available to add</p>
			{balance < 1_000_000n ? (
				<p className="type-label text-muted-foreground">Nothing left to add from your account.</p>
			) : (
				<div className="flex flex-wrap items-center gap-2">
					{[100, 250, 500].map((n) => (
						<Button
							key={n}
							size="sm"
							variant={amount === n ? "secondary" : "ghost"}
							onClick={() => setAmount(n)}
							disabled={BigInt(n) * 1_000_000n > balance}
						>
							+${n}
						</Button>
					))}
					<Button
						size="sm"
						className="ml-auto"
						onClick={() => topUp.mutate()}
						disabled={topUp.isPending || value > balance}
					>
						{topUp.isPending && <Loader2 className="animate-spin" />}
						Add
					</Button>
				</div>
			)}
			{value > balance && balance >= 1_000_000n && (
				<p className="type-label text-destructive">That's more than you have. Pick a smaller amount.</p>
			)}
		</div>
	);
}
