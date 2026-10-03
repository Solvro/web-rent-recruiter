import { createFileRoute, Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { PageSkeleton, RequireAccount } from "@/components/account";
import { Chip, EmptyState, ErrorState } from "@/components/bits";
import { buttonVariants } from "@/components/ui/button";
import { dateLabel, formatMoney } from "@/lib/format";
import { useRoles } from "@/lib/queries";

export const Route = createFileRoute("/company/")({
	component: () => <RequireAccount kind="company">{() => <Roles />}</RequireAccount>,
});

function Roles() {
	const roles = useRoles();
	if (roles.isPending) return <PageSkeleton />;
	if (roles.isError) return <ErrorState />;
	if (!roles.data?.length)
		return (
			<EmptyState
				title="Paste a job description and recruiters start sourcing for you."
				action={
					<Link to="/company/roles/new" className={buttonVariants({ size: "lg" })}>
						Create a role
					</Link>
				}
			/>
		);

	return (
		<div className="space-y-10">
			<div className="flex items-end justify-between gap-4">
				<h1 className="type-display">Roles</h1>
				<Link to="/company/roles/new" className={buttonVariants({ variant: "outline" })}>
					<Plus /> New role
				</Link>
			</div>
			<ul className="divide-y">
				{roles.data.map((r) => (
					<li key={r.id}>
						<Link
							to="/company/roles/$roleId"
							params={{ roleId: r.id }}
							className="flex items-center gap-4 py-5 transition-colors hover:text-primary"
						>
							<span className="min-w-0 flex-1">
								<span className="block truncate">{r.title}</span>
								<span className="block type-label text-muted-foreground">
									{r.status === "OPEN" ? "Agent working" : r.status === "CLOSED" ? "Closed" : "Draft"} ·
									created {dateLabel(new Date(r.createdAt))}
								</span>
							</span>
							{r.pendingCount > 0 && <Chip tone="warn">{r.pendingCount} to review</Chip>}
							<span className="text-right type-label text-muted-foreground tabular">
								{r.status === "DRAFT"
									? BigInt(r.intendedDeposit ?? "0") > 0n
										? `${formatMoney(r.intendedDeposit ?? "0")} budget not added`
										: "No budget"
									: r.status === "CLOSED"
										? `${formatMoney(r.budget.spent ?? BigInt(r.budget.paid) + BigInt(r.budget.heldBack))} spent · ${formatMoney(r.budget.refunded ?? 0n)} back to you`
										: `${formatMoney(r.budget.spent ?? BigInt(r.budget.paid) + BigInt(r.budget.heldBack))} of ${formatMoney(r.budget.deposited)} spent`}
							</span>
						</Link>
					</li>
				))}
			</ul>
		</div>
	);
}
