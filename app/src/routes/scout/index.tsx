import type { TaskView } from "@scout/shared";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Clock, Search, Users } from "lucide-react";
import { PageSkeleton, RequireAccount } from "@/components/account";
import { EmptyState, PageHeader } from "@/components/bits";
import { CriteriaFacts } from "@/components/criteria";
import { formatUsdc, reviewWindowLabel, timeAgo } from "@/lib/format";
import { useTasks } from "@/lib/queries";

export const Route = createFileRoute("/scout/")({
	component: () => <RequireAccount kind="scout">{() => <TaskBoard />}</RequireAccount>,
});

function TaskBoard() {
	const tasks = useTasks();
	const open = tasks.data?.filter((t) => t.slotsLeft > 0) ?? [];
	return (
		<div className="space-y-8">
			<PageHeader
				title="Open tasks"
				description="Bring qualified, interested candidates. You're paid the moment a company accepts one, or automatically if it doesn't answer in time."
			/>
			{tasks.isPending ? (
				<PageSkeleton />
			) : open.length ? (
				<div className="grid gap-4 md:grid-cols-2">
					{open.map((t) => (
						<TaskCard key={t.id} task={t} />
					))}
				</div>
			) : (
				<EmptyState icon={<Search className="size-5" />} title="No open tasks right now">
					New roles appear here as soon as a company funds them.
				</EmptyState>
			)}
		</div>
	);
}

function TaskCard({ task }: { task: TaskView }) {
	return (
		<Link
			to="/scout/tasks/$roleId"
			params={{ roleId: task.id }}
			className="group flex flex-col gap-4 rounded-2xl border bg-card p-5 transition-shadow hover:shadow-lg hover:shadow-primary/5"
		>
			<div className="flex items-start justify-between gap-4">
				<div className="min-w-0 space-y-1">
					<p className="text-sm text-muted-foreground">{task.companyName}</p>
					<h3 className="font-semibold group-hover:text-primary">{task.title}</h3>
				</div>
				<div className="shrink-0 text-right">
					<p className="tabular text-xl font-semibold text-success">{formatUsdc(task.payoutPerCandidate)}</p>
					<p className="text-xs text-muted-foreground">per accepted candidate</p>
				</div>
			</div>
			<CriteriaFacts criteria={task.criteria} />
			<div className="flex flex-wrap gap-1.5">
				{task.criteria.mustHave.slice(0, 4).map((c) => (
					<span key={c.id} className="rounded-lg bg-accent px-2 py-0.5 text-xs text-accent-foreground">
						{c.label}
					</span>
				))}
			</div>
			<div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-1 border-t pt-3 text-xs text-muted-foreground">
				<span className="inline-flex items-center gap-1">
					<Users className="size-3.5" />
					<span className="font-medium text-foreground">{task.slotsLeft}</span> slot
					{task.slotsLeft === 1 ? "" : "s"} left
				</span>
				<span className="inline-flex items-center gap-1">
					<Clock className="size-3.5" /> Paid within {reviewWindowLabel(task.reviewWindowSeconds)}
				</span>
				<span className="ml-auto">Posted {timeAgo(task.createdAt)}</span>
			</div>
		</Link>
	);
}
