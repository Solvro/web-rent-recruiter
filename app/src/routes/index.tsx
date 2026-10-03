import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";
import { rememberIntent } from "@/components/account";
import { Button } from "@/components/ui/button";
import { useWallet } from "@/lib/wallet";

export const Route = createFileRoute("/")({ component: Landing });

const STEPS = ["Paste the role", "Recruiters pick it up", "You review the candidate", "They get paid"];

function Landing() {
	const wallet = useWallet();
	const navigate = useNavigate();

	const go = (kind: "company" | "scout") => {
		rememberIntent(kind);
		if (wallet.mode === "demo") wallet.selectPersona(kind);
		navigate({ to: kind === "company" ? "/company" : "/scout" });
	};

	return (
		<section className="flex flex-col items-center gap-10 pt-16 text-center sm:pt-28">
			<div className="space-y-4">
				<h1 className="type-display">Pay recruiters per candidate you accept</h1>
				<p className="text-muted-foreground">Recruiters get paid the moment you accept a candidate.</p>
			</div>
			<div className="flex flex-wrap justify-center gap-3">
				<Button size="lg" className="h-12 px-6" onClick={() => go("company")}>
					I'm hiring <ArrowUpRight />
				</Button>
				<Button size="lg" variant="outline" className="h-12 px-6" onClick={() => go("scout")}>
					I'm a recruiter <ArrowUpRight />
				</Button>
			</div>
			<ol className="mt-10 grid w-full max-w-3xl grid-cols-2 gap-6 border-t pt-8 text-left sm:grid-cols-4">
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
