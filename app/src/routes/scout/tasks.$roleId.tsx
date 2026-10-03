import type { Me, TaskView } from "@scout/shared";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, CheckCircle2, Loader2, ShieldCheck, UserX } from "lucide-react";
import { useState } from "react";
import { PageSkeleton, RequireAccount } from "@/components/account";
import { EmptyState, PageHeader } from "@/components/bits";
import { CriteriaFacts, CriteriaList } from "@/components/criteria";
import { ExplorerLink } from "@/components/explorer-link";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api, asDuplicate, errorMessage } from "@/lib/api";
import { formatUsdc, reviewWindowLabel } from "@/lib/format";
import { useTasks } from "@/lib/queries";
import { useTransact } from "@/lib/use-transact";

export const Route = createFileRoute("/scout/tasks/$roleId")({
	component: () => {
		const { roleId } = Route.useParams();
		return <RequireAccount kind="scout">{(me) => <TaskDetail roleId={roleId} me={me} />}</RequireAccount>;
	},
});

function TaskDetail({ roleId, me }: { roleId: string; me: Me }) {
	const tasks = useTasks();
	if (tasks.isPending) return <PageSkeleton />;
	const task = tasks.data?.find((t) => t.id === roleId);
	if (!task)
		return (
			<EmptyState
				title="This task is no longer open"
				action={
					<Link to="/scout" className={buttonVariants({ variant: "outline" })}>
						See open tasks
					</Link>
				}
			>
				The company may have filled the role or closed it.
			</EmptyState>
		);

	return (
		<div className="space-y-8">
			<PageHeader
				eyebrow={
					<Link to="/scout" className="inline-flex items-center gap-1 hover:text-foreground">
						<ArrowLeft className="size-3.5" /> Tasks
					</Link>
				}
				title={task.title}
				description={
					<span className="space-y-2">
						<span className="block">
							{task.companyName} · {task.summary}
						</span>
						<CriteriaFacts criteria={task.criteria} />
					</span>
				}
			/>
			<div className="grid gap-6 lg:grid-cols-[1fr_420px]">
				<div className="space-y-6">
					<Card>
						<CardHeader>
							<CardTitle>What the company needs</CardTitle>
							<CardDescription>
								The agent scores every candidate against these criteria. Clear notes that address them get
								accepted faster.
							</CardDescription>
						</CardHeader>
						<CardContent>
							<CriteriaList criteria={task.criteria} />
						</CardContent>
					</Card>
					<div className="grid gap-3 sm:grid-cols-3">
						<Fact
							label="You earn"
							value={formatUsdc(task.payoutPerCandidate)}
							hint="per accepted candidate"
						/>
						<Fact label="Slots left" value={String(task.slotsLeft)} hint={`of ${task.maxCandidates}`} />
						<Fact
							label="Paid within"
							value={reviewWindowLabel(task.reviewWindowSeconds)}
							hint="or automatically"
						/>
					</div>
					<p className="flex items-start gap-2 px-1 text-sm text-muted-foreground">
						<ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" />
						Your payout is already funded: the company deposited the budget before this task went live, and
						only the payment rules can release it.
					</p>
				</div>
				<SubmitForm task={task} me={me} />
			</div>
		</div>
	);
}

function Fact({ label, value, hint }: { label: string; value: string; hint: string }) {
	return (
		<div className="rounded-2xl border bg-card p-4">
			<p className="text-xs text-muted-foreground">{label}</p>
			<p className="tabular text-lg font-semibold">{value}</p>
			<p className="text-xs text-muted-foreground">{hint}</p>
		</div>
	);
}

function SubmitForm({ task, me }: { task: TaskView; me: Me }) {
	const { transact, pending } = useTransact();
	const [name, setName] = useState("");
	const [profileUrl, setProfileUrl] = useState("");
	const [notes, setNotes] = useState("");
	const [consent, setConsent] = useState(false);
	const [done, setDone] = useState<{ name: string; signature: string } | null>(null);
	const [duplicate, setDuplicate] = useState<{ firstSubmittedAt: string } | null>(null);

	const submit = useMutation({
		mutationFn: async () => {
			setDuplicate(null);
			const res = await api.submitCandidate(task.id, { name, profileUrl, notes, consent: true });
			const tx = await transact(res.unsignedTx, `${name} submitted. You'll be paid when they're accepted.`);
			if (tx) {
				setDone({ name, signature: tx.signature });
				setName("");
				setProfileUrl("");
				setNotes("");
				setConsent(false);
			}
		},
		onError: (e) => {
			const dup = asDuplicate(e);
			if (dup) setDuplicate(dup);
		},
	});

	if (done)
		return (
			<Card className="h-fit">
				<CardContent className="space-y-4 py-8 text-center">
					<CheckCircle2 className="mx-auto size-10 text-success" />
					<div className="space-y-1">
						<p className="text-lg font-semibold">{done.name} is in review</p>
						<p className="text-sm text-muted-foreground">
							Your submission is timestamped, so nobody else can claim this candidate for this role. You'll
							get {formatUsdc(task.payoutPerCandidate)} when they're accepted.
						</p>
						<ExplorerLink signature={done.signature} />
					</div>
					<div className="flex justify-center gap-2">
						<Button variant="outline" onClick={() => setDone(null)}>
							Submit another
						</Button>
						<Link to="/scout/submissions" className={buttonVariants()}>
							My submissions
						</Link>
					</div>
				</CardContent>
			</Card>
		);

	return (
		<Card className="h-fit">
			<CardHeader>
				<CardTitle>Submit a candidate</CardTitle>
				<CardDescription>Only people you've spoken to who are interested in this role.</CardDescription>
			</CardHeader>
			<CardContent>
				{task.roleVault === null ? (
					<div className="space-y-2 rounded-xl bg-muted p-4 text-sm">
						<p className="font-medium">Not funded yet</p>
						<p className="text-muted-foreground">
							Submissions open once {task.companyName} deposits the budget, so every accepted candidate is
							guaranteed to be paid.
						</p>
					</div>
				) : (
					<form
						className="space-y-4"
						onSubmit={(e) => {
							e.preventDefault();
							submit.mutate();
						}}
					>
						<div className="space-y-1.5">
							<Label htmlFor="name">Candidate name</Label>
							<Input
								id="name"
								required
								value={name}
								onChange={(e) => setName(e.target.value)}
								placeholder="Anna Kowalczyk"
							/>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="url">Profile URL</Label>
							<Input
								id="url"
								type="url"
								required
								value={profileUrl}
								onChange={(e) => {
									setProfileUrl(e.target.value);
									setDuplicate(null);
								}}
								placeholder="https://www.linkedin.com/in/…"
							/>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="notes">Your notes</Label>
							<Textarea
								id="notes"
								required
								value={notes}
								onChange={(e) => setNotes(e.target.value)}
								className="min-h-32"
								placeholder="Experience against the must-haves, motivation, notice period, salary expectations…"
							/>
						</div>
						<label htmlFor="consent" className="flex items-start gap-2.5 text-sm">
							<Checkbox
								id="consent"
								checked={consent}
								onCheckedChange={(v) => setConsent(v === true)}
								className="mt-0.5"
							/>
							<span>The candidate agreed to be presented to {task.companyName} for this role.</span>
						</label>
						{duplicate && (
							<Alert variant="destructive">
								<UserX />
								<AlertTitle>Already submitted by another scout</AlertTitle>
								<AlertDescription>
									This candidate was submitted for this role on{" "}
									{new Date(duplicate.firstSubmittedAt).toLocaleString()}. The first scout keeps the credit,
									so this one can't be paid twice.
								</AlertDescription>
							</Alert>
						)}
						{submit.isError && !duplicate && (
							<p className="text-sm text-destructive">{errorMessage(submit.error)}</p>
						)}
						<Button
							type="submit"
							className="w-full"
							size="lg"
							disabled={!consent || submit.isPending || pending}
						>
							{submit.isPending && <Loader2 className="animate-spin" />}
							Submit candidate
						</Button>
						<p className="text-center text-xs text-muted-foreground">
							Personal data stays private. Only a fingerprint of the profile link is recorded to prove you
							submitted first.
							{!me.scoutRegistered &&
								" Your first submission also sets up your payout account, free of charge."}
						</p>
					</form>
				)}
			</CardContent>
		</Card>
	);
}
