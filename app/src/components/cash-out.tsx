/**
 * "Cash out" on Earnings, told honestly: the money already sits in the recruiter's own account (RentRecruiter never holds
 * it); a bank transfer through a payments partner is on the roadmap; today it can be sent to another account, as
 * one advanced field.
 */
import { useMutation } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { Disclosure } from "@/components/bits";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/errors";
import { formatMoney } from "@/lib/format";
import { typedClient } from "@/lib/trpc";
import { useTransact } from "@/lib/use-transact";

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function CashOut({ available }: { available: bigint }) {
	const [open, setOpen] = useState(false);
	const [to, setTo] = useState("");
	const { transact, pending } = useTransact();
	const send = useMutation({
		mutationFn: async () => {
			const { unsignedTx } = await typedClient.me.cashOut.mutate({
				to: to.trim(),
				amount: available.toString(),
			});
			const ok = await transact(unsignedTx, {
				pending: "Sending…",
				success: `Sent ${formatMoney(available)}`,
				receipt: true,
			});
			if (ok) {
				setOpen(false);
				setTo("");
			}
		},
	});
	const valid = ADDRESS.test(to.trim());

	return (
		<>
			<Button variant="outline" onClick={() => setOpen(true)} disabled={available <= 0n}>
				Cash out
			</Button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent className="gap-5 p-6 sm:p-8">
					<DialogTitle>{formatMoney(available)} is yours</DialogTitle>
					<div className="space-y-3 text-muted-foreground">
						<p>
							Your earnings are already in your own account, the moment each payment lands. RentRecruiter never holds
							them and can't take them back.
						</p>
						<p>Moving money to your bank, through a payments partner, is coming soon.</p>
					</div>
					<Disclosure label="Send to another account">
						<div className="space-y-3">
							<Input
								value={to}
								onChange={(e) => setTo(e.target.value)}
								placeholder="Account address"
								aria-label="Account address"
								className="h-11"
								spellCheck={false}
							/>
							<Button
								onClick={() => send.mutate()}
								disabled={!valid || send.isPending || pending || available <= 0n}
							>
								{(send.isPending || pending) && <Loader2 className="animate-spin" />}
								Send {formatMoney(available)}
							</Button>
							{to.trim() && !valid && (
								<p className="type-label text-destructive">That address doesn't look right.</p>
							)}
							{send.isError && <p className="type-label text-destructive">{errorMessage(send.error)}</p>}
						</div>
					</Disclosure>
				</DialogContent>
			</Dialog>
		</>
	);
}
