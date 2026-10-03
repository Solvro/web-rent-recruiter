import { createFileRoute, Link } from "@tanstack/react-router";
import { Check, Loader2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Brand } from "@/components/bits";
import { Avatar } from "@/components/person";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { API_MOCK } from "@/lib/env";
import { appCodeOf, errorMessage } from "@/lib/errors";
import { firstName } from "@/lib/format";
import {
	type CandidateConfirmInput,
	type CandidateConfirmView,
	useCandidateConfirm,
	useCandidateRespond,
} from "@/lib/gigs/confirm";
import { useTitle } from "@/lib/use-title";

/**
 * The candidate's page: one question, no login. It shows only what a candidate needs (who is asking, the role,
 * the company, the salary), never the company's internal brief or anything about payments.
 */
export const Route = createFileRoute("/c/$token")({
	component: () => {
		const { token } = Route.useParams();
		return <Confirm token={token} />;
	},
});

const deadline = (iso: string) =>
	new Date(iso).toLocaleString("en-GB", {
		weekday: "short",
		day: "numeric",
		month: "short",
		hour: "2-digit",
		minute: "2-digit",
	});

function Confirm({ token }: { token: string }) {
	const view = useCandidateConfirm(token);
	const v = view.data;
	useTitle(v ? `${v.candidateFirstName}, a role at ${v.companyDescriptor}` : "A role shared with you");
	return (
		<main className="mx-auto flex min-h-svh max-w-md flex-col gap-10 px-4 py-6">
			<header className="flex items-center justify-between">
				<Brand />
				<span className="type-label text-muted-foreground">Independent recruiters, paid by companies</span>
			</header>
			<div className="flex flex-1 flex-col justify-center gap-8 pb-10">
				{view.isPending ? (
					<Loader2 className="mx-auto size-6 animate-spin text-muted-foreground" />
				) : view.isError || !v ? (
					<p className="text-center text-muted-foreground">
						We couldn't find this link. Check that you opened the whole link, or ask the recruiter who sent it
						for a new one.
						{API_MOCK && " (Demo links only open in the browser they were made in.)"}
					</p>
				) : v.kind === "call" ? (
					<CallCheck view={v} token={token} />
				) : (
					<Interest view={v} token={token} />
				)}
			</div>
		</main>
	);
}

/** Who is asking, with a link to their public track record. */
function WhoIsAsking({ view, children }: { view: CandidateConfirmView; children: ReactNode }) {
	const name = view.kind === "call" ? (view.callWith ?? view.recruiterName) : view.recruiterName;
	return (
		<div className="flex items-center gap-3">
			<Avatar name={name} src={view.recruiterAvatarUrl} />
			<div className="min-w-0">
				<p className="text-muted-foreground">{children}</p>
				{view.recruiterSlug && (
					<Link
						to="/r/$slug"
						params={{ slug: view.recruiterSlug }}
						target="_blank"
						className="type-label text-primary underline-offset-4 hover:underline"
					>
						See {firstName(name)}'s track record
					</Link>
				)}
			</div>
		</div>
	);
}

/** After an answer: a calm closing line (no icon for an expired link, it isn't good news). */
function Done({ title, line, good = true }: { title: string; line: string; good?: boolean }) {
	return (
		<div className="space-y-4 text-center">
			{good && (
				<span className="mx-auto grid size-12 place-items-center rounded-full bg-accent text-accent-foreground">
					<Check className="size-5" />
				</span>
			)}
			<h1 className="type-display">{title}</h1>
			<p className="text-muted-foreground">{line}</p>
		</div>
	);
}

/** One respond mutation per page; an expired link mid-answer becomes the expired state, not an error. */
function useAnswer(view: CandidateConfirmView) {
	const respond = useCandidateRespond();
	const expired = appCodeOf(respond.error) === "LINK_EXPIRED";
	const status = expired ? "EXPIRED" : (respond.data?.status ?? view.status);
	return { respond, status, expired };
}

/** "Report this message": the candidate didn't expect it. Saved as a no; the company sees the report. */
function ReportLink({ onReport, pending }: { onReport: () => void; pending: boolean }) {
	const [open, setOpen] = useState(false);
	return (
		<>
			<button
				type="button"
				onClick={() => setOpen(true)}
				className="type-label text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
			>
				Report this message
			</button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent className="gap-4 p-6">
					<DialogTitle>Report this message?</DialogTitle>
					<p className="text-muted-foreground">
						Nobody will contact you about this role, and the hiring company is told the message wasn't
						welcome.
					</p>
					<DialogFooter>
						<Button variant="ghost" onClick={() => setOpen(false)}>
							Cancel
						</Button>
						<Button
							variant="destructive"
							disabled={pending}
							onClick={() => {
								setOpen(false);
								onReport();
							}}
						>
							Report
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}

const PRIVACY =
	"Only the hiring company and the recruiter who runs the call see your answer. You never pay anything.";

/** "Is <email or phone>": an @ makes it an email, anything else a phone number. */
function contactOf(text: string): Pick<CandidateConfirmInput, "contactEmail" | "contactPhone"> {
	const t = text.trim();
	if (!t) return {};
	return t.includes("@") ? { contactEmail: t } : { contactPhone: t };
}

function Interest({ view, token }: { view: CandidateConfirmView; token: string }) {
	const { respond, status, expired } = useAnswer(view);
	const [answer, setAnswer] = useState<"yes" | "no" | "report" | null>(null);
	const [availability, setAvailability] = useState("");
	const [salary, setSalary] = useState("");
	const [contact, setContact] = useState("");
	const [sure, setSure] = useState(false);
	const recruiter = firstName(view.recruiterName);

	if (status === "EXPIRED")
		return (
			<Done
				good={false}
				title="This link has expired"
				line={
					expired && (availability || salary || contact)
						? `If you're still interested, tell ${recruiter} directly: ${[availability, salary, contact].filter(Boolean).join(" · ")}`
						: `If you're still interested, contact ${recruiter} directly.`
				}
			/>
		);
	if (status === "YES")
		return (
			<Done
				title="Thank you"
				line={`You said yes to a call about the ${view.roleTitle} role at ${view.companyDescriptor}. A recruiter will contact you${contact.trim() ? ` at ${contact.trim()}` : ""} within two working days to set it up. Changed your mind? Just tell them on the call.`}
			/>
		);
	if (status === "NO")
		return (
			<Done
				title={answer === "report" ? "Thanks for telling us" : "Thanks for letting us know"}
				line="Nobody will contact you about this role."
			/>
		);

	const send = (a: "yes" | "no" | "report") => {
		setAnswer(a);
		respond.mutate({
			token,
			interested: a === "yes",
			...(a === "report" ? { reported: true } : {}),
			availability: availability.trim() || undefined,
			salaryExpectation: salary.trim() || undefined,
			timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
			...(a === "yes" ? contactOf(contact) : {}),
		});
	};
	const facts = [view.location, view.salaryLabel].filter(Boolean).join(" · ");
	// The role's deal-breakers, as the company wrote them, so nobody says yes without knowing.
	const notAFit = ((view as { dealBreakers?: string[] }).dealBreakers ?? []).map(
		(t) => t[0]?.toLowerCase() + t.slice(1),
	);

	return (
		<>
			<WhoIsAsking view={view}>
				Hi {view.candidateFirstName}, {view.recruiterName} found your profile and thinks this role fits you.
			</WhoIsAsking>
			<div className="space-y-3">
				<h1 className="type-display">{view.roleTitle}</h1>
				<p>{view.companyDescriptor}</p>
				{view.summary && <p className="text-muted-foreground">{view.summary}</p>}
				{facts && <p className="text-muted-foreground">{facts}</p>}
				{notAFit.length > 0 && (
					<p className="text-muted-foreground">
						<span className="text-foreground">Not a fit if:</span> {notAFit.join("; ")}.
					</p>
				)}
			</div>
			<div className="space-y-1">
				<p>Are you open to a 30-minute call about it?</p>
				<p className="type-label text-muted-foreground">Please answer by {deadline(view.expiresAt)}.</p>
			</div>
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
				<Input
					value={contact}
					onChange={(e) => setContact(e.target.value)}
					placeholder="Email or phone for the call (optional)"
					aria-label="Email or phone for the call"
					autoComplete="email"
					className="h-12"
				/>
			</div>
			<div className="space-y-3">
				<Button size="lg" className="h-12 w-full" onClick={() => send("yes")} disabled={respond.isPending}>
					{respond.isPending && answer === "yes" && <Loader2 className="animate-spin" />}
					Yes, I'm open to a conversation
				</Button>
				{sure ? (
					<div className="space-y-3 rounded-3xl bg-muted p-4 text-center">
						<p className="text-muted-foreground">Nobody will contact you about this role. Sure?</p>
						<div className="flex justify-center gap-2">
							<Button variant="outline" onClick={() => send("no")} disabled={respond.isPending}>
								{respond.isPending && answer === "no" && <Loader2 className="animate-spin" />}
								Yes, not interested
							</Button>
							<Button variant="ghost" onClick={() => setSure(false)}>
								Go back
							</Button>
						</div>
					</div>
				) : (
					<Button size="lg" variant="ghost" className="h-12 w-full" onClick={() => setSure(true)}>
						Not now
					</Button>
				)}
				{respond.isError && !expired && (
					<p className="text-center text-destructive">{errorMessage(respond.error)}</p>
				)}
			</div>
			<div className="space-y-2">
				<p className="type-label text-muted-foreground">{PRIVACY}</p>
				<ReportLink onReport={() => send("report")} pending={respond.isPending} />
			</div>
		</>
	);
}

/** "Did you have a call with Andreea about this role?" The call wasn't recorded; the candidate's yes confirms it. */
function CallCheck({ view, token }: { view: CandidateConfirmView; token: string }) {
	const { respond, status } = useAnswer(view);
	const [answer, setAnswer] = useState<"yes" | "no" | "report" | null>(null);
	const caller = view.callWith ?? "a recruiter";
	const what = view.callKind === "language check" ? "a short language check" : "a call";

	if (status === "EXPIRED")
		return <Done good={false} title="This link has expired" line="Nothing else to do here." />;
	if (status !== "PENDING")
		return (
			<Done
				title="Thank you"
				line={
					status === "YES"
						? "That's all we needed. The hiring company will be in touch about next steps."
						: "Thanks for telling us. We'll look into it."
				}
			/>
		);

	const send = (a: "yes" | "no" | "report") => {
		setAnswer(a);
		respond.mutate({
			token,
			interested: a === "yes",
			...(a === "report" ? { reported: true } : {}),
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
					About the {view.roleTitle} role at {view.companyDescriptor}. Please answer by{" "}
					{deadline(view.expiresAt)}.
				</p>
			</div>
			<WhoIsAsking view={view}>
				{caller} · {view.callKind === "language check" ? "Language check" : "Screening call"}
			</WhoIsAsking>
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
			<div className="space-y-2">
				<p className="type-label text-muted-foreground">Your answer goes only to the hiring company.</p>
				<ReportLink onReport={() => send("report")} pending={respond.isPending} />
			</div>
		</>
	);
}
