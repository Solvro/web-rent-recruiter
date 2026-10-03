import type { RoleDetail } from "@scout/shared";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { PageSkeleton, RequireAccount } from "@/components/account";
import { ErrorState } from "@/components/bits";
import { Pinned, useAsks } from "@/components/cockpit/asks";
import { CandidatesProvider } from "@/components/cockpit/candidates";
import { RoleHeader } from "@/components/cockpit/header";
import { Log } from "@/components/cockpit/log";
import { Thinking, WaitingList, WhatHappensNext } from "@/components/cockpit/presence";
import { CriteriaChips } from "@/components/criteria";
import { ReviewerSettings } from "@/components/reviewer-settings";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { errorMessage } from "@/lib/errors";
import { formatMoney } from "@/lib/format";
import { useRoleActivity, useShortlist } from "@/lib/gigs/api";
import { useRoleStatus } from "@/lib/gigs/status";
import { useRole } from "@/lib/queries";
import { useTRPCClient } from "@/lib/trpc";
import { useTransact } from "@/lib/use-transact";

export const Route = createFileRoute("/company/roles/$roleId")({
	component: () => {
		const { roleId } = Route.useParams();
		return <RequireAccount kind="company">{() => <Cockpit roleId={roleId} />}</RequireAccount>;
	},
});

/**
 * The role is its agent, full screen like a coding agent: one line of status and spend, the log in one calm
 * column, and the composer at the bottom. Whatever needs the company is pinned right above the composer.
 */
function Cockpit({ roleId }: { roleId: string }) {
	const role = useRole(roleId);
	const status = useRoleStatus(roleId);
	const activity = useRoleActivity(roleId);
	const shortlist = useShortlist(roleId);
	const [details, setDetails] = useState(false);
	const items = activity.data?.items ?? [];
	const asks = useAsks({
		roleId,
		waiting: (status.data?.waitingOn ?? []).filter((w) => w.who === "company"),
		shortlist: shortlist.data ?? [],
		thread: items,
	});
	if (role.isError) return <ErrorState />;
	if (role.isPending) return <PageSkeleton />;
	const r = role.data;

	return (
		<CandidatesProvider roleId={r.id}>
			<div className="fixed inset-x-0 top-16 bottom-0 z-20 bg-background">
				<div className="mx-auto flex h-full w-full max-w-[760px] flex-col px-4">
					<RoleHeader role={r} status={status.data} onDetails={() => setDetails(true)} />
					<Log
						roleId={r.id}
						items={items}
						now={status.data?.now.text ?? null}
						busy={!!status.data?.now.busy}
						above={
							<WhatHappensNext roleId={r.id} started={(status.data?.pipeline.sourcingAccepted ?? 0) > 0} />
						}
						below={
							<>
								<Thinking items={items} status={status.data} />
								<WaitingList roleId={r.id} status={status.data} />
							</>
						}
						pinned={<Pinned asks={asks} />}
						pinnedKey={asks.map((a) => a.key).join(",")}
					/>
				</div>
				<Dialog open={details} onOpenChange={setDetails}>
					<DialogContent className="max-h-[85svh] gap-6 overflow-y-auto p-6 sm:max-w-xl">
						<DialogTitle>{r.title}</DialogTitle>
						<CriteriaChips criteria={r.criteria} />
						<ReviewerSettings roleId={r.id} />
						{r.status === "OPEN" && <CloseRole role={r} left={status.data?.budget.available} />}
					</DialogContent>
				</Dialog>
			</div>
		</CandidatesProvider>
	);
}

function CloseRole({ role, left }: { role: RoleDetail; left: string | undefined }) {
	const client = useTRPCClient();
	const { transact } = useTransact();
	const back = left ?? (BigInt(role.budget.remaining) - BigInt(role.budget.heldBack)).toString();
	const close = useMutation({
		mutationFn: async () => {
			const { unsignedTx } = await client.roles.close.mutate({ id: role.id });
			await transact(unsignedTx, {
				pending: "Closing…",
				success: `Role closed. ${formatMoney(back)} returned to you.`,
			});
		},
		onError: (e) => toast.error(errorMessage(e)),
	});
	return (
		<Button
			variant="ghost"
			className="self-start text-muted-foreground"
			onClick={() => close.mutate()}
			disabled={close.isPending || role.pendingCount > 0 || BigInt(role.budget.heldBack) > 0n}
		>
			Close role and get {formatMoney(back)} back
		</Button>
	);
}
