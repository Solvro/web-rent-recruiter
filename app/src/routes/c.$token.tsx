import { createFileRoute } from "@tanstack/react-router";
import { Check, Loader2, MapPin, Wallet2 } from "lucide-react";
import { useState } from "react";
import { Avatar } from "@/components/person";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/errors";
import { firstName } from "@/lib/format";
import { type CandidateConfirmView, useCandidateConfirm, useCandidateRespond } from "@/lib/gigs/confirm";
import { useTitle } from "@/lib/use-title";

/**
 * The candidate's page: one question, no login. It shows only what a candidate needs (role, company, who reached
 * out), never the company's internal brief or anything about payments.
 */
export const Route = createFileRoute("/c/$token")({
	component: () => {
		const { token } = Route.useParams();
		return <Confirm token={token} />;
	},
});

function Confirm({ token }: { token: string }) {
	const view = useCandidateConfirm(token);
	useTitle(view.data?.roleTitle ?? null);
	return (
		<main className="mx-auto flex min-h-svh max-w-md flex-col justify-center gap-8 px-4 py-10">
			{view.isPending ? (
				<Loader2 className="mx-auto size-6 animate-spin text-muted-foreground" />
			) : view.isError ? (
				<p className="text-center text-muted-foreground">
					This link isn't valid anymore. If you were expecting it, ask the recruiter for a new one.
				</p>
			) : (
				<Card view={view.data} token={token} />
			)}
		</main>
	);
}

function Card({ view, token }: { view: CandidateConfirmView; token: string }) {
	const respond = useCandidateRespond();
	const [answer, setAnswer] = useState<"yes" | "no" | null>(null);
	const [availability, setAvailability] = useState("");
	const [salary, setSalary] = useState("");
	const status = respond.data?.status ?? view.status;
	const recruiter = firstName(view.recruiterName);

	if (view.kind === "call") return <CallCheck view={view} token={token} />;

	if (status !== "PENDING")
		return (
			<div className="space-y-4 text-center">
				<span className="mx-auto grid size-12 place-items-center rounded-full bg-accent text-accent-foreground">
					<Check className="size-5" />
				</span>
				<h1 className="type-display">
					{status === "YES"
						? "Thank you"
						: status === "NO"
							? "Thanks for letting us know"
							: "This link has expired"}
				</h1>
				<p className="text-muted-foreground">
					{status === "YES"
						? "A recruiter will be in touch to set up a call."
						: status === "NO"
							? "Nobody will contact you about this role."
							: `If you're still interested, reply to ${recruiter} directly.`}
				</p>
			</div>
		);

	const send = (a: "yes" | "no") => {
		setAnswer(a);
		respond.mutate({
			token,
			interested: a === "yes",
			availability: availability.trim() || undefined,
			salaryExpectation: salary.trim() || undefined,
			timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
		});
	};

	return (
		<>
			<div className="flex items-center gap-3">
				<Avatar name={view.recruiterName} />
				<p className="text-muted-foreground">
					Hi {view.candidateFirstName}, {view.recruiterName} told you about this role.
				</p>
			</div>
			<div className="space-y-3">
				<h1 className="type-display">{view.roleTitle}</h1>
				<p className="text-muted-foreground">{view.companyDescriptor}</p>
				{view.summary && <p className="text-muted-foreground">{view.summary}</p>}
				<div className="flex flex-wrap gap-x-5 gap-y-1 text-muted-foreground">
					{view.location && (
						<span className="inline-flex items-center gap-1.5">
							<MapPin className="size-4" /> {view.location}
						</span>
					)}
					{view.salaryLabel && (
						<span className="inline-flex items-center gap-1.5">
							<Wallet2 className="size-4" /> {view.salaryLabel}
						</span>
					)}
				</div>
			</div>
			<p>Are you open to a 30-minute call about it?</p>
			<div className="space-y-3">
				<Input
					value={availability}
					onChange={(e) => setAvailability(e.target.value)}
					placeholder="When suits you (optional)"
					aria-label="When suits you"
					className="h-12"
				/>
				<Input
					value={salary}
					onChange={(e) => setSalary(e.target.value)}
					placeholder="Salary you'd expect (optional)"
					aria-label="Salary you'd expect"
					className="h-12"
				/>
			</div>
			<div className="space-y-3">
				<Button size="lg" className="h-12 w-full" onClick={() => send("yes")} disabled={respond.isPending}>
					{respond.isPending && answer === "yes" && <Loader2 className="animate-spin" />}
					Yes, I'm open to a conversation
				</Button>
				<Button
					size="lg"
					variant="ghost"
					className="h-12 w-full"
					onClick={() => send("no")}
					disabled={respond.isPending}
				>
					{respond.isPending && answer === "no" && <Loader2 className="animate-spin" />}
					Not now
				</Button>
				{respond.isError && <p className="text-center text-destructive">{errorMessage(respond.error)}</p>}
			</div>
			<p className="type-label text-muted-foreground">
				Your answer goes only to {recruiter} and the hiring company. Nothing else happens until you talk.
			</p>
		</>
	);
}

/** "Did you have a call with Andreea about this role?" The call wasn't recorded; the candidate's yes confirms it. */
function CallCheck({ view, token }: { view: CandidateConfirmView; token: string }) {
	const respond = useCandidateRespond();
	const [answer, setAnswer] = useState<"yes" | "no" | null>(null);
	const status = respond.data?.status ?? view.status;
	const caller = view.callWith ?? "a recruiter";
	const what = view.callKind === "language check" ? "a short language check" : "a call";

	if (status !== "PENDING")
		return (
			<div className="space-y-4 text-center">
				<span className="mx-auto grid size-12 place-items-center rounded-full bg-accent text-accent-foreground">
					<Check className="size-5" />
				</span>
				<h1 className="type-display">{status === "EXPIRED" ? "This link has expired" : "Thank you"}</h1>
				<p className="text-muted-foreground">
					{status === "YES"
						? "That's all we needed. The hiring company will be in touch about next steps."
						: status === "NO"
							? "Thanks for telling us. We'll look into it."
							: "Nothing else to do here."}
				</p>
			</div>
		);

	const send = (a: "yes" | "no") => {
		setAnswer(a);
		respond.mutate({
			token,
			interested: a === "yes",
			timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
		});
	};

	return (
		<>
			<div className="space-y-3">
				<p className="text-muted-foreground">Hi {view.candidateFirstName}, one quick question.</p>
				<h1 className="type-display">
					Did you have {what} with {caller}?
				</h1>
				<p className="text-muted-foreground">
					About the {view.roleTitle} role at {view.companyDescriptor}.
				</p>
			</div>
			<div className="flex items-center gap-3 rounded-3xl bg-card p-4 ring-1 ring-foreground/5">
				<Avatar name={caller} />
				<p className="min-w-0">
					<span className="block truncate">{caller}</span>
					<span className="type-label text-muted-foreground">
						{view.callKind === "language check" ? "Language check" : "Screening call"}
					</span>
				</p>
			</div>
			<div className="space-y-3">
				<Button size="lg" className="h-12 w-full" onClick={() => send("yes")} disabled={respond.isPending}>
					{respond.isPending && answer === "yes" && <Loader2 className="animate-spin" />}
					Yes, we talked
				</Button>
				<Button
					size="lg"
					variant="outline"
					className="h-12 w-full"
					onClick={() => send("no")}
					disabled={respond.isPending}
				>
					{respond.isPending && answer === "no" && <Loader2 className="animate-spin" />}
					No, we didn't
				</Button>
				{respond.isError && <p className="text-center text-destructive">{errorMessage(respond.error)}</p>}
			</div>
			<p className="type-label text-muted-foreground">Your answer goes only to the hiring company.</p>
		</>
	);
}
