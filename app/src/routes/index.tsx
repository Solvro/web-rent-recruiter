import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { rememberIntent } from "@/components/account";
import { Button } from "@/components/ui/button";
import { useTitle } from "@/lib/use-title";
import { useWallet } from "@/lib/wallet";

export const Route = createFileRoute("/")({ component: Landing });

const STEPS = [
	"You fund a budget once",
	"Your agent posts small paid gigs",
	"Recruiters do the work",
	"The agent checks it and pays them",
];

function Landing() {
	const wallet = useWallet();
	const navigate = useNavigate();
	useTitle(null);

	const go = (kind: "company" | "scout") => {
		rememberIntent(kind);
		if (wallet.mode === "demo") wallet.selectPersona(kind);
		navigate({ to: kind === "company" ? "/company" : "/scout" });
	};

	return (
		<section className="flex flex-col items-center gap-10 pt-16 text-center sm:pt-28">
			<div className="max-w-2xl space-y-4">
				<h1 className="type-display text-balance">Your hiring agent, paying recruiters per task.</h1>
				<p className="text-balance text-muted-foreground">
					Fund a budget once. Your agent posts small paid gigs to freelance recruiters (find candidates,
					screening calls, reference checks), checks every piece of work and pays the moment it's good. No
					agency in the middle.
				</p>
			</div>
			<div className="flex w-full flex-col justify-center gap-3 sm:w-auto sm:flex-row">
				<Button size="lg" className="h-12 px-6" onClick={() => go("company")}>
					Hire with an agent
				</Button>
				<Button size="lg" variant="outline" className="h-12 px-6" onClick={() => go("scout")}>
					Earn as a recruiter
				</Button>
			</div>
			<p className="max-w-md type-label text-muted-foreground">
				Got a link from a recruiter? It's a real role at a real company. Answer in one tap; you never pay
				anything.
			</p>
			<ol className="mt-6 grid w-full max-w-3xl grid-cols-2 gap-6 border-t pt-8 text-left sm:grid-cols-4">
				{STEPS.map((step, i) => (
					<li key={step} className="space-y-1">
						<span className="type-label text-muted-foreground tabular">0{i + 1}</span>
						<p>{step}</p>
					</li>
				))}
			</ol>
		</section>
	);
}
