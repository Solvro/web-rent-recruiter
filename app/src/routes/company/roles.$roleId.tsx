import type { RoleDetail } from "@scout/shared";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { PageSkeleton, RequireAccount } from "@/components/account";
import { Disclosure, EmptyState, ErrorState } from "@/components/bits";
import { Pinned, useAsks } from "@/components/cockpit/asks";
import { CandidatesProvider } from "@/components/cockpit/candidates";
import { RoleHeader } from "@/components/cockpit/header";
import { CloseRole, FundRole, MoneyRecord } from "@/components/cockpit/lifecycle";
import { Log } from "@/components/cockpit/log";
import { Thinking, WaitingList, WhatHappensNext } from "@/components/cockpit/presence";
import { ReviewerSettings } from "@/components/reviewer-settings";
import { locationText, SENIORITY, salaryText } from "@/components/role-draft/job-post";
import { buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { appCodeOf, errorMessage } from "@/lib/errors";
import { formatMoney } from "@/lib/format";
import { useRoleActivity, useShortlist } from "@/lib/gigs/api";
import { useRoleStatus } from "@/lib/gigs/status";
import { useRole } from "@/lib/queries";

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
	if (role.isError)
		return appCodeOf(role.error) === "NOT_FOUND" || /not found|invalid/i.test(errorMessage(role.error)) ? (
			<EmptyState
				title="This role doesn't exist, or it isn't yours."
				action={
					<Link to="/company" className={buttonVariants({ variant: "outline" })}>
						Your roles
					</Link>
				}
			/>
		) : (
			<ErrorState />
		);
	if (role.isPending) return <PageSkeleton />;
	const r = role.data;
	if (r.status === "DRAFT") return <FundRole role={r} />;
	const closed = r.status === "CLOSED";

	return (
		<CandidatesProvider roleId={r.id} criteria={r.criteria}>
			<div className="fixed inset-x-0 top-16 bottom-0 z-20 bg-background">
				<div className="mx-auto flex h-full w-full max-w-[760px] flex-col px-4">
					<RoleHeader role={r} status={status.data} onDetails={() => setDetails(true)} />
					<Log
						roleId={r.id}
						items={items}
						now={status.data?.now.text ?? null}
						busy={!!status.data?.now.busy}
						closed={closed}
						above={
							closed ? null : (
								<WhatHappensNext roleId={r.id} started={(status.data?.pipeline.sourcingAccepted ?? 0) > 0} />
							)
						}
						below={
							closed ? (
								<ClosedNote role={r} />
							) : (
								<>
									<Thinking items={items} status={status.data} />
									<WaitingList roleId={r.id} status={status.data} />
								</>
							)
						}
						pinned={closed ? null : <Pinned asks={asks} />}
						pinnedKey={asks.map((a) => a.key).join(",")}
					/>
				</div>
				<Dialog open={details} onOpenChange={setDetails}>
					<DialogContent className="max-h-[85svh] gap-6 overflow-y-auto p-6 sm:max-w-xl">
						<div className="space-y-1">
							<DialogTitle>{r.title}</DialogTitle>
							<p className="type-label text-muted-foreground">
								{[
									SENIORITY[r.criteria.seniority],
									locationText(r.criteria.location),
									salaryText(r.criteria.salaryRange),
									r.criteria.languages.join(", "),
								]
									.filter(Boolean)
									.join(" · ")}
							</p>
						</div>
						<RequirementsList criteria={r.criteria} />
						{r.jobDescription && (
							<Disclosure label="Show the job post you pasted">
								<p className="max-h-80 overflow-y-auto rounded-2xl bg-muted p-4 type-label whitespace-pre-wrap">
									{r.jobDescription}
								</p>
							</Disclosure>
						)}
						<MoneyRecord items={items} />
						{!closed && <ReviewerSettings roleId={r.id} />}
						{r.status === "OPEN" && <CloseRole role={r} />}
					</DialogContent>
				</Dialog>
			</div>
		</CandidatesProvider>
	);
}

/** A closed role is a record: what came back, with proof; no agent, no upsells. */
function ClosedNote({ role }: { role: RoleDetail }) {
	const refunded = role.budget.refunded;
	return (
		<p className="px-2 py-3 text-muted-foreground">
			This role is closed{refunded ? `. ${formatMoney(refunded)} came back to you` : ""}. Its history stays
			here.
		</p>
	);
}

/** Everything the agent checks against, grouped as the company set it. */
function RequirementsList({ criteria }: { criteria: RoleDetail["criteria"] }) {
	const groups: [string, { id: string; label: string }[]][] = [
		["Must have", criteria.mustHave],
		["Nice to have", criteria.niceToHave],
		["Deal-breakers", criteria.dealBreakers],
	];
	return (
		<div className="space-y-3">
			{groups
				.filter(([, items]) => items.length)
				.map(([title, items]) => (
					<div key={title} className="space-y-1.5">
						<p className="type-label text-muted-foreground">{title}</p>
						<ul className="flex flex-wrap gap-1.5">
							{items.map((c) => (
								<li key={c.id} className="rounded-full bg-muted px-3 py-1 type-label">
									{c.label}
								</li>
							))}
						</ul>
					</div>
				))}
			<p className="type-label text-muted-foreground">
				To change these, tell your agent; it proposes the change first.
			</p>
		</div>
	);
}
