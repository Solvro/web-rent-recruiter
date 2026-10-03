import type { Criteria, DraftRoleResponse } from "@scout/shared";
import {
	BPS_DENOMINATOR,
	DEFAULT_FEE_BPS,
	DEFAULT_REVIEW_WINDOW_SECONDS,
	DEMO_REVIEW_WINDOW_SECONDS,
	toBaseUnits,
} from "@scout/shared";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Bot, Loader2, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { RequireAccount } from "@/components/account";
import { PageHeader } from "@/components/bits";
import { CriteriaEditor } from "@/components/criteria";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api, errorMessage } from "@/lib/api";
import { formatUsdc } from "@/lib/format";
import { useTransact } from "@/lib/use-transact";

export const Route = createFileRoute("/company/roles/new")({
	component: () => (
		<RequireAccount kind="company">{(me) => <NewRole balance={me.usdcBalance} />}</RequireAccount>
	),
});

const EXAMPLE_JD = `Senior Full-stack Engineer (TypeScript)
Northwind Robotics builds fleet software for warehouse robots used across 40+ logistics sites in Europe.

You'll build the operator console that shift managers use to plan robot missions in real time.

What we're looking for
- 5+ years with TypeScript, React and Node.js in production
- PostgreSQL and data modelling for real-time dashboards
- Experience with event-driven systems (Kafka or similar)
- Nice to have: Kubernetes, AWS, mentoring other engineers, early-stage startup experience

Hybrid in Kraków, 2 days a week in the office. English required, Polish is a plus.
Salary 25 000 - 33 000 PLN per month on B2B.`;

const WINDOWS = [
	{ value: String(DEMO_REVIEW_WINDOW_SECONDS), label: "60 seconds (live demo)" },
	{ value: String(24 * 3600), label: "24 hours" },
	{ value: String(DEFAULT_REVIEW_WINDOW_SECONDS), label: "72 hours" },
	{ value: String(7 * 86400), label: "7 days" },
];

function NewRole({ balance }: { balance: string }) {
	const navigate = useNavigate();
	const { transact, pending } = useTransact();
	const [jd, setJd] = useState("");
	const [draft, setDraft] = useState<DraftRoleResponse | null>(null);
	const [title, setTitle] = useState("");
	const [criteria, setCriteria] = useState<Criteria | null>(null);
	const [bounty, setBounty] = useState("20");
	const [maxCandidates, setMaxCandidates] = useState("10");
	const [deposit, setDeposit] = useState("200");
	const [windowSeconds, setWindowSeconds] = useState(String(DEMO_REVIEW_WINDOW_SECONDS));
	const [depositTouched, setDepositTouched] = useState(false);

	const analyze = useMutation({
		mutationFn: () => api.draftRole({ jobDescription: jd }),
		onSuccess: (d) => {
			setDraft(d);
			setTitle(d.title);
			setCriteria(d.criteria);
			const b = Number(d.suggestedBounty) / 1e6;
			setBounty(String(b));
			setMaxCandidates(String(d.suggestedMaxCandidates));
			setDeposit(String(b * d.suggestedMaxCandidates));
			setDepositTouched(false);
		},
	});

	useEffect(() => {
		if (!depositTouched) setDeposit(String((Number(bounty) || 0) * (Number(maxCandidates) || 0)));
	}, [bounty, maxCandidates, depositTouched]);

	const bountyBase = toBaseUnits(Number(bounty) || 0);
	const fee = (bountyBase * BigInt(DEFAULT_FEE_BPS)) / BigInt(BPS_DENOMINATOR);
	const depositBase = toBaseUnits(Number(deposit) || 0);
	const coversCandidates = bountyBase > 0n ? Number(depositBase / bountyBase) : 0;
	const tooMuch = depositBase > BigInt(balance);
	const invalid = !criteria || !title.trim() || bountyBase <= 0n || depositBase < bountyBase || tooMuch;

	const publish = useMutation({
		mutationFn: async () => {
			if (!draft || !criteria) throw new Error("Analyze the job description first");
			const res = await api.createRole({
				title,
				summary: draft.summary,
				jobDescription: jd,
				criteria,
				taskType: "SOURCING",
				bounty: bountyBase.toString(),
				maxCandidates: Number(maxCandidates),
				reviewWindowSeconds: Number(windowSeconds),
				deposit: depositBase.toString(),
			});
			const tx = await transact(res.unsignedTx, `${title} is live. ${formatUsdc(depositBase)} funded.`);
			if (tx) navigate({ to: "/company/roles/$roleId", params: { roleId: res.roleId } });
		},
	});

	return (
		<div className="space-y-8">
			<PageHeader
				eyebrow={
					<button
						type="button"
						onClick={() => history.back()}
						className="inline-flex items-center gap-1 hover:text-foreground"
					>
						<ArrowLeft className="size-3.5" /> Roles
					</button>
				}
				title="New role"
				description="Paste the job description. The agent drafts the criteria scouts work against and suggests a fair bounty."
			/>

			<div className="grid items-start gap-6 lg:grid-cols-[1fr_1.1fr]">
				<Card>
					<CardHeader>
						<CardTitle>Job description</CardTitle>
						<CardDescription>
							The full text is fine. Requirements, location and salary help the most.
						</CardDescription>
					</CardHeader>
					<CardContent className="space-y-3">
						<Textarea
							value={jd}
							onChange={(e) => setJd(e.target.value)}
							placeholder="Senior Backend Engineer…"
							className="min-h-80 font-mono text-[13px] leading-relaxed"
							aria-label="Job description"
						/>
						<div className="flex flex-wrap items-center gap-2">
							<Button onClick={() => analyze.mutate()} disabled={jd.trim().length < 50 || analyze.isPending}>
								{analyze.isPending ? <Loader2 className="animate-spin" /> : <Sparkles />}
								{draft ? "Analyze again" : "Analyze with agent"}
							</Button>
							{!jd && (
								<Button variant="ghost" onClick={() => setJd(EXAMPLE_JD)}>
									Use an example
								</Button>
							)}
							{jd && jd.trim().length < 50 && (
								<span className="text-xs text-muted-foreground">A few more lines, please.</span>
							)}
						</div>
						{analyze.isError && <p className="text-sm text-destructive">{errorMessage(analyze.error)}</p>}
					</CardContent>
				</Card>

				{analyze.isPending ? (
					<AgentThinking />
				) : draft && criteria ? (
					<div className="space-y-6">
						<Card>
							<CardHeader>
								<CardTitle className="flex items-center gap-2">
									<Bot className="size-4 text-primary" /> Criteria
								</CardTitle>
								<CardDescription>{draft.summary} Edit anything before you publish.</CardDescription>
							</CardHeader>
							<CardContent className="space-y-5">
								<div className="space-y-1.5">
									<Label htmlFor="title">Role title</Label>
									<Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} />
								</div>
								<CriteriaEditor value={criteria} onChange={setCriteria} />
							</CardContent>
						</Card>

						<Card>
							<CardHeader>
								<CardTitle>Budget</CardTitle>
								<CardDescription className="rounded-xl bg-accent/60 p-3 text-accent-foreground">
									{draft.rationale}
								</CardDescription>
							</CardHeader>
							<CardContent className="space-y-5">
								<div className="grid gap-4 sm:grid-cols-3">
									<div className="space-y-1.5">
										<Label htmlFor="bounty">Per accepted candidate</Label>
										<UsdcInput id="bounty" value={bounty} onChange={setBounty} />
									</div>
									<div className="space-y-1.5">
										<Label htmlFor="max">Candidates</Label>
										<Input
											id="max"
											type="number"
											min={1}
											value={maxCandidates}
											onChange={(e) => setMaxCandidates(e.target.value)}
										/>
									</div>
									<div className="space-y-1.5">
										<Label htmlFor="deposit">Fund now</Label>
										<UsdcInput
											id="deposit"
											value={deposit}
											onChange={(v) => {
												setDeposit(v);
												setDepositTouched(true);
											}}
										/>
									</div>
								</div>
								<div className="space-y-1.5">
									<Label>If you don't respond to a candidate</Label>
									<Select
										value={windowSeconds}
										onValueChange={(v) => v && setWindowSeconds(v)}
										items={WINDOWS}
									>
										<SelectTrigger className="w-full" aria-label="Review window">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{WINDOWS.map((w) => (
												<SelectItem key={w.value} value={w.value}>
													{w.label}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
									<p className="text-xs text-muted-foreground">
										After this window the candidate counts as accepted and the scout is paid automatically.
									</p>
								</div>
								<ul className="space-y-1.5 rounded-xl border p-3 text-sm">
									<li className="flex justify-between">
										<span className="text-muted-foreground">Scout receives per candidate</span>
										<span className="tabular font-medium">{formatUsdc(bountyBase - fee)}</span>
									</li>
									<li className="flex justify-between">
										<span className="text-muted-foreground">Platform fee (10%)</span>
										<span className="tabular">{formatUsdc(fee)}</span>
									</li>
									<li className="flex justify-between">
										<span className="text-muted-foreground">Budget covers</span>
										<span className="tabular">
											{coversCandidates} candidate{coversCandidates === 1 ? "" : "s"}
										</span>
									</li>
									<li className="flex justify-between">
										<span className="text-muted-foreground">Your balance</span>
										<span className="tabular">{formatUsdc(balance)}</span>
									</li>
								</ul>
								{tooMuch && (
									<Alert variant="destructive">
										<AlertTitle>Not enough USDC</AlertTitle>
										<AlertDescription>Fund a smaller amount now and top up later.</AlertDescription>
									</Alert>
								)}
								<Button
									size="lg"
									className="w-full"
									disabled={invalid || publish.isPending || pending}
									onClick={() => publish.mutate()}
								>
									{publish.isPending ? <Loader2 className="animate-spin" /> : null}
									Fund and publish · {formatUsdc(depositBase)}
								</Button>
								<p className="text-center text-xs text-muted-foreground">
									Funds go into this role's vault, which only the payment rules can release. You can withdraw
									what's left at any time by closing the role.
								</p>
								{publish.isError && <p className="text-sm text-destructive">{errorMessage(publish.error)}</p>}
							</CardContent>
						</Card>
					</div>
				) : (
					<div className="grid place-items-center rounded-2xl border border-dashed p-10 text-center text-sm text-muted-foreground">
						<div className="max-w-xs space-y-2">
							<Bot className="mx-auto size-6 text-primary" />
							<p>
								The agent's draft appears here: must-haves, nice-to-haves, deal-breakers and a suggested
								bounty.
							</p>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}

function UsdcInput({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
	return (
		<div className="relative">
			<Input
				id={id}
				type="number"
				min={0}
				step="1"
				value={value}
				onChange={(e) => onChange(e.target.value)}
				className="pr-14 tabular"
			/>
			<span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">
				USDC
			</span>
		</div>
	);
}

const THINKING_STEPS = [
	"Reading the job description",
	"Extracting must-haves and deal-breakers",
	"Pricing the bounty",
];

function AgentThinking() {
	const steps = THINKING_STEPS;
	const [step, setStep] = useState(0);
	useEffect(() => {
		const t = setInterval(() => setStep((s) => Math.min(s + 1, THINKING_STEPS.length - 1)), 2500);
		return () => clearInterval(t);
	}, []);
	return (
		<Card className="justify-center">
			<CardContent className="space-y-4 py-10">
				<div className="mx-auto grid size-12 place-items-center rounded-full bg-accent">
					<Bot className="size-5 animate-pulse text-primary" />
				</div>
				<ul className="mx-auto max-w-xs space-y-2 text-sm">
					{steps.map((s, i) => (
						<li key={s} className={i <= step ? "text-foreground" : "text-muted-foreground/60"}>
							{i < step ? "✓" : i === step ? "…" : "·"} {s}
						</li>
					))}
				</ul>
				<p className="text-center text-xs text-muted-foreground">Usually takes about 10 seconds.</p>
			</CardContent>
		</Card>
	);
}
