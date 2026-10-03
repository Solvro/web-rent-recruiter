import type { RoleDetail } from "@scout/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Receipt } from "@/components/receipt";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { errorMessage } from "@/lib/errors";
import { formatMoney } from "@/lib/format";
import { lifecycleApi, useClosePreview } from "@/lib/gigs/lifecycle";
import type { ThreadActivity } from "@/lib/gigs/schemas";
import { useMe } from "@/lib/queries";
import { useTRPCClient } from "@/lib/trpc";
import { useTransact } from "@/lib/use-transact";

/**
 * A role whose budget never landed (the signing was interrupted or failed). Nothing was charged; the company can
 * add the budget again, or drop the role. Never a dead page.
 */
export function FundRole({ role }: { role: RoleDetail }) {
	const me = useMe();
	const qc = useQueryClient();
	const navigate = useNavigate();
	const { transact, pending } = useTransact();
	const amount = BigInt(role.intendedDeposit ?? "0");
	const balance = BigInt(me.data?.usdcBalance ?? "0");
	const short = amount > balance;
	const fund = useMutation({
		mutationFn: async () => {
			const res = await lifecycleApi.fund(role.id);
			if (res.alreadyFunded) toast("The budget had already arrived. Your agent is starting.");
			else if (res.unsignedTx)
				await transact(res.unsignedTx, {
					pending: "Adding the budget…",
					success: `Your agent is on it. ${formatMoney(amount)} set aside.`,
					receipt: true,
				});
			await qc.invalidateQueries({ queryKey: ["roles"] });
		},
		onError: (e) => toast.error(errorMessage(e)),
	});
	const discard = useMutation({
		mutationFn: () => lifecycleApi.discardDraft(role.id),
		onSuccess: () => {
			void qc.invalidateQueries({ queryKey: ["roles"] });
			navigate({ to: "/company" });
		},
		onError: (e) => toast.error(errorMessage(e)),
	});
	return (
		<div className="mx-auto max-w-xl space-y-6 py-16">
			<p className="type-label text-muted-foreground">{role.title}</p>
			<h1 className="type-display">
				{amount > 0n
					? `Your ${formatMoney(amount)} budget didn't go through`
					: "This role hasn't started yet"}
			</h1>
			<p className="text-muted-foreground">
				Nothing was charged, and your agent hasn't started. Add the budget to start it, or drop this role.
			</p>
			<p className="type-label text-muted-foreground">
				You have {formatMoney(balance)} available
				{short && amount > 0n && ` · ${formatMoney(amount - balance)} short of the budget`}
			</p>
			<div className="flex flex-wrap gap-3">
				<Button
					size="lg"
					onClick={() => fund.mutate()}
					disabled={short || fund.isPending || pending || amount === 0n}
				>
					{(fund.isPending || pending) && <Loader2 className="animate-spin" />}
					Add the {formatMoney(amount)} budget
				</Button>
				<Button size="lg" variant="ghost" onClick={() => discard.mutate()} disabled={discard.isPending}>
					Drop this role
				</Button>
			</div>
		</div>
	);
}

/** Close with a clear refund: what comes back, what's still in flight. Only then sign. */
export function CloseRole({ role }: { role: RoleDetail }) {
	const [open, setOpen] = useState(false);
	const preview = useClosePreview(role.id, open);
	const client = useTRPCClient();
	const qc = useQueryClient();
	const { transact, pending } = useTransact();
	const refund = preview.data?.refund ?? null;
	const close = useMutation({
		mutationFn: async () => {
			const { unsignedTx } = await client.roles.close.mutate({ id: role.id });
			const ok = await transact(unsignedTx, {
				pending: "Closing the role…",
				success: refund ? `Closed. ${formatMoney(refund)} is back in your account.` : "Closed.",
				receipt: true,
			});
			if (ok) setOpen(false);
			await qc.invalidateQueries({ queryKey: ["roles"] });
		},
		onError: (e) => toast.error(errorMessage(e)),
	});
	return (
		<>
			<Button variant="ghost" className="self-start text-muted-foreground" onClick={() => setOpen(true)}>
				Close role…
			</Button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent className="gap-5 p-6">
					<DialogTitle>Close this role?</DialogTitle>
					{preview.isPending ? (
						<Loader2 className="size-5 animate-spin text-muted-foreground" />
					) : preview.isError ? (
						<p className="text-muted-foreground">
							Closing stops your agent and every open task. Everything not yet paid comes back to you.
						</p>
					) : (
						<div className="space-y-2 text-muted-foreground">
							<p>
								Your agent stops
								{preview.data.openGigs === 1
									? " and its open task closes"
									: preview.data.openGigs
										? ` and ${preview.data.openGigs} open tasks close`
										: ""}
								.{" "}
								<span className="text-foreground">{formatMoney(preview.data.refund)} comes back to you.</span>
							</p>
							{preview.data.inProgress.length > 0 && (
								<p className="type-label">
									Still in progress: {preview.data.inProgress.map((c) => c.name).join(", ")}. What's held for
									them stays until you say whether they came to the interview.
								</p>
							)}
						</div>
					)}
					<DialogFooter>
						<Button variant="ghost" onClick={() => setOpen(false)}>
							Keep role open
						</Button>
						<Button
							variant="destructive"
							onClick={() => close.mutate()}
							disabled={close.isPending || pending}
						>
							{(close.isPending || pending) && <Loader2 className="animate-spin" />}
							{refund ? `Close and get ${formatMoney(refund)} back` : "Close role"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}

/** Deposits and refunds on record: each with a lasting proof of payment. */
export function MoneyRecord({ items, role }: { items: ThreadActivity[]; role?: RoleDetail }) {
	const logged = items.filter((i) => i.kind === "BUDGET" && (i.signature || i.solscanUrl));
	// Roles funded before deposits were logged: the amount from the role itself, without a receipt.
	const deposited = role ? BigInt(role.budget.deposited) : 0n;
	const rows: Pick<ThreadActivity, "id" | "message" | "signature">[] = logged.length
		? logged
		: deposited > 0n
			? [{ id: "deposit", message: `Set aside ${formatMoney(deposited)} for this role`, signature: null }]
			: [];
	if (!rows.length) return null;
	return (
		<div className="space-y-1.5">
			<p className="type-label text-muted-foreground">Budget</p>
			<ul className="space-y-1 type-label">
				{rows.map((r) => (
					<li key={r.id} className="flex items-baseline justify-between gap-3">
						<span>{r.message}</span>
						{r.signature && <Receipt signature={r.signature} />}
					</li>
				))}
			</ul>
		</div>
	);
}
