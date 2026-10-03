import type { RoleSummary } from "@scout/shared";
import { createFileRoute, Link } from "@tanstack/react-router";
import { BriefcaseBusiness, Plus } from "lucide-react";
import { PageSkeleton, RequireAccount } from "@/components/account";
import { EmptyState, PageHeader } from "@/components/bits";
import { BudgetBar } from "@/components/budget-bar";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { formatUsdc, timeAgo } from "@/lib/format";
import { useRoles } from "@/lib/queries";

export const Route = createFileRoute("/company/")({
	component: () => (
		<RequireAccount kind="company">
			{(me) => <Roles company={me.companyName ?? me.displayName} />}
		</RequireAccount>
	),
});

function Roles({ company }: { company: string }) {
	const roles = useRoles();
	return (
		<div className="space-y-8">
			<PageHeader
				eyebrow={company}
				title="Roles"
				description="Each role has its own budget. Scouts are paid from it the moment you accept a candidate."
				actions={
					<Link to="/company/roles/new" className={buttonVariants()}>
						<Plus /> New role
					</Link>
				}
			/>
			{roles.isPending ? (
				<PageSkeleton />
			) : roles.data?.length ? (
				<div className="grid gap-4 md:grid-cols-2">
					{roles.data.map((r) => (
						<RoleCard key={r.id} role={r} />
					))}
				</div>
			) : (
				<EmptyState
					icon={<BriefcaseBusiness className="size-5" />}
					title="No roles yet"
					action={
						<Link to="/company/roles/new" className={buttonVariants()}>
							Create your first role
						</Link>
					}
				>
					Paste a job description and the agent will draft the criteria and a budget for you.
				</EmptyState>
			)}
		</div>
	);
}

function RoleCard({ role }: { role: RoleSummary }) {
	return (
		<Link
			to="/company/roles/$roleId"
			params={{ roleId: role.id }}
			className="group space-y-5 rounded-2xl border bg-card p-5 transition-shadow hover:shadow-lg hover:shadow-primary/5"
		>
			<div className="flex items-start justify-between gap-3">
				<div className="space-y-1">
					<h3 className="font-semibold group-hover:text-primary">{role.title}</h3>
					<p className="text-sm text-muted-foreground">
						{formatUsdc(role.bounty)} per candidate · created {timeAgo(role.createdAt)}
					</p>
				</div>
				{role.status === "CLOSED" ? (
					<Badge variant="secondary">Closed</Badge>
				) : role.pendingCount > 0 ? (
					<Badge className="bg-warning/15 text-warning-foreground">{role.pendingCount} to review</Badge>
				) : (
					<Badge variant="outline">Open</Badge>
				)}
			</div>
			<BudgetBar role={role} compact />
			<div className="grid grid-cols-3 gap-3 text-sm">
				<div>
					<p className="text-muted-foreground">Accepted</p>
					<p className="tabular font-medium">
						{role.acceptedCount} / {role.maxCandidates}
					</p>
				</div>
				<div>
					<p className="text-muted-foreground">Paid out</p>
					<p className="tabular font-medium">{formatUsdc(role.budget.paid)}</p>
				</div>
				<div>
					<p className="text-muted-foreground">Remaining</p>
					<p className="tabular font-medium">{formatUsdc(role.budget.remaining)}</p>
				</div>
			</div>
		</Link>
	);
}
