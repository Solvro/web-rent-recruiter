import { PROJECT_NAME } from "@scout/shared";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
	ArrowRight,
	BadgeCheck,
	Bot,
	Globe2,
	Landmark,
	ShieldCheck,
	Sparkles,
	UsersRound,
	Wallet,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMe } from "@/lib/queries";
import { useWallet } from "@/lib/wallet";

export const Route = createFileRoute("/")({ component: Landing });

const PROBLEMS = [
	{
		icon: UsersRound,
		title: "AI can't make the first call",
		text: "Models screen profiles well. Reaching hard-to-find people, earning a reply and running the first conversation still takes a human with a network.",
	},
	{
		icon: Landmark,
		title: "Agencies or nothing",
		text: "Companies pay an agency around 20% of annual salary, only on hire, or do all the sourcing themselves. There is little in between.",
	},
	{
		icon: Wallet,
		title: "Recruiters wait to get paid",
		text: "Independent recruiters around the world wait weeks or months for invoices, and carry the risk of never being paid at all.",
	},
];

const STEPS = [
	{
		title: "Paste a job description",
		text: "The agent turns it into clear criteria and suggests a bounty per qualified candidate.",
	},
	{
		title: "Fund a small budget",
		text: "Start with 200 USDC. The money sits in a program-controlled vault, not with us.",
	},
	{
		title: "Scouts submit candidates",
		text: "Independent recruiters bring qualified, interested people. The agent scores each one against your criteria.",
	},
	{
		title: "Accept and they're paid",
		text: "One click pays the scout instantly. If you don't answer in time, the candidate is accepted automatically.",
	},
];

const GUARANTEES = [
	{
		icon: ShieldCheck,
		title: "No custodian",
		text: "The budget is held by an on-chain program. We never touch the funds.",
	},
	{
		icon: Globe2,
		title: "Paid anywhere, instantly",
		text: "Scouts in any country receive USDC the moment a candidate is accepted.",
	},
	{
		icon: BadgeCheck,
		title: "Reputation they own",
		text: "Accepted candidates build a public track record that moves with the scout.",
	},
	{
		icon: Sparkles,
		title: "First submission wins",
		text: "A candidate can be submitted once per role, so the first scout keeps the credit.",
	},
];

function Landing() {
	const wallet = useWallet();
	const me = useMe();
	const navigate = useNavigate();

	const go = (kind: "company" | "scout") => {
		if (wallet.mode === "demo") wallet.selectPersona(kind);
		else if (!wallet.address) return wallet.login();
		navigate({ to: kind === "company" ? "/company" : "/scout" });
	};

	return (
		<div className="space-y-20 sm:space-y-28">
			<section className="grid items-center gap-10 pt-4 lg:grid-cols-[1.15fr_1fr]">
				<div className="space-y-6">
					<span className="inline-flex items-center gap-1.5 rounded-full bg-accent px-3 py-1 text-xs font-medium text-accent-foreground">
						<Bot className="size-3.5" /> AI recruiting agent with human scouts
					</span>
					<h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
						Pay for qualified candidates, not for promises.
					</h1>
					<p className="max-w-xl text-lg text-muted-foreground text-pretty">
						Give {PROJECT_NAME}'s agent a budget. It turns your role into clear criteria and posts small paid
						tasks to independent recruiters. Every candidate you accept is paid out instantly in USDC, and
						every scout builds a reputation they own.
					</p>
					<div className="flex flex-wrap gap-3">
						<Button size="lg" onClick={() => go("company")}>
							I'm hiring <ArrowRight />
						</Button>
						<Button size="lg" variant="outline" onClick={() => go("scout")}>
							I'm a recruiter
						</Button>
						{me.data && (
							<Link
								to={me.data.kind === "company" ? "/company" : "/scout"}
								className="self-center text-sm text-muted-foreground hover:text-foreground"
							>
								Continue as {me.data.displayName} →
							</Link>
						)}
					</div>
				</div>
				<HeroCard />
			</section>

			<section className="space-y-8">
				<div className="max-w-2xl space-y-2">
					<p className="text-sm font-medium text-primary">The problem</p>
					<h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
						Hiring is stuck between expensive agencies and doing it all yourself
					</h2>
				</div>
				<div className="grid gap-4 md:grid-cols-3">
					{PROBLEMS.map((p) => (
						<div key={p.title} className="space-y-3 rounded-2xl border bg-card p-6">
							<p.icon className="size-5 text-primary" />
							<h3 className="font-semibold">{p.title}</h3>
							<p className="text-sm text-muted-foreground">{p.text}</p>
						</div>
					))}
				</div>
				<p className="max-w-2xl text-muted-foreground">
					Our model: pay per accepted unit of work, one qualified and interested candidate at a time. Start
					small and top up as trust grows.
				</p>
			</section>

			<section className="space-y-8">
				<div className="max-w-2xl space-y-2">
					<p className="text-sm font-medium text-primary">How it works</p>
					<h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
						From job description to paid scout in minutes
					</h2>
				</div>
				<ol className="grid gap-4 md:grid-cols-4">
					{STEPS.map((s, i) => (
						<li key={s.title} className="space-y-2 rounded-2xl bg-secondary/60 p-5">
							<span className="tabular text-sm font-semibold text-primary">0{i + 1}</span>
							<h3 className="font-semibold">{s.title}</h3>
							<p className="text-sm text-muted-foreground">{s.text}</p>
						</li>
					))}
				</ol>
			</section>

			<section className="grid gap-4 rounded-3xl border bg-card p-6 sm:grid-cols-2 sm:p-10 lg:grid-cols-4">
				{GUARANTEES.map((g) => (
					<div key={g.title} className="space-y-2">
						<g.icon className="size-5 text-primary" />
						<h3 className="font-semibold">{g.title}</h3>
						<p className="text-sm text-muted-foreground">{g.text}</p>
					</div>
				))}
			</section>
		</div>
	);
}

function HeroCard() {
	return (
		<div className="relative">
			<div className="absolute -inset-4 -z-10 rounded-[2.5rem] bg-gradient-to-br from-primary/10 via-accent to-transparent" />
			<div className="space-y-4 rounded-3xl border bg-card p-5 shadow-xl shadow-primary/5">
				<div className="flex items-center justify-between">
					<div>
						<p className="text-xs text-muted-foreground">Northwind Robotics</p>
						<p className="font-semibold">Senior Backend Engineer (Payments)</p>
					</div>
					<span className="rounded-full bg-secondary px-2.5 py-1 text-xs font-medium">
						20 USDC / candidate
					</span>
				</div>
				<div className="h-2 overflow-hidden rounded-full bg-muted">
					<div className="flex h-full">
						<div className="w-[20%] bg-success" />
						<div className="w-[10%] bg-warning" />
						<div className="w-[70%] bg-primary/25" />
					</div>
				</div>
				{[
					{
						name: "Tomasz Wójcik",
						score: 92,
						rec: "Advance",
						tone: "bg-success/10 text-success",
						note: "7 yrs TypeScript, built a payments ledger",
					},
					{
						name: "Kamil Dąbrowski",
						score: 30,
						rec: "Pass",
						tone: "bg-muted text-muted-foreground",
						note: "Not open to hybrid in Warsaw",
					},
				].map((c) => (
					<div key={c.name} className="flex items-center gap-3 rounded-2xl border p-3">
						<div
							className={`grid size-11 shrink-0 place-items-center rounded-xl text-lg font-semibold tabular ${c.tone}`}
						>
							{c.score}
						</div>
						<div className="min-w-0 flex-1">
							<p className="truncate font-medium">{c.name}</p>
							<p className="truncate text-xs text-muted-foreground">{c.note}</p>
						</div>
						<span className="text-xs font-medium uppercase text-muted-foreground">{c.rec}</span>
					</div>
				))}
				<div className="flex items-center gap-2 rounded-2xl bg-success/10 px-3 py-2.5 text-sm text-success">
					<BadgeCheck className="size-4" /> Marta received 18 USDC · 2 seconds after acceptance
				</div>
			</div>
		</div>
	);
}
