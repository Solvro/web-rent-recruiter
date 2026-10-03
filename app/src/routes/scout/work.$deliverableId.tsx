import type { CallDetail, DeliverableView, Me } from "@scout/shared";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Check, ExternalLink, Loader2, Minus, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { PageSkeleton, RequireAccount } from "@/components/account";
import { Appeal } from "@/components/appeal";
import { Chip, Countdown, Disclosure, EmptyState, ErrorState, ScoreChip } from "@/components/bits";
import { CopyButton } from "@/components/copy";
import { WhyThisScore } from "@/components/criteria";
import { FollowUps } from "@/components/follow-ups";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
	CallChecks,
	depositStatusLine,
	PayoutBreakdown,
	personOf,
	WhyNotAccepted,
	WorkStatus,
	workInfo,
} from "@/components/work";
import { appCodeOf, errorMessage, isNotFound } from "@/lib/errors";
import { firstName, formatMoney } from "@/lib/format";
import { type GigWorkView, useEditWork, useWithdrawWork, useWork } from "@/lib/gigs/work";
import { useTitle } from "@/lib/use-title";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/scout/work/$deliverableId")({
	component: () => {
		const { deliverableId } = Route.useParams();
		return <RequireAccount kind="scout">{(me) => <WorkPage id={deliverableId} me={me} />}</RequireAccount>;
	},
});

const dateLabel = (iso: string) =>
	new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

function WorkPage({ id, me }: { id: string; me: Me }) {
	const detail = useWork(id);
	const w = detail.data;
	useTitle(w ? personOf(w.work, w.candidateName) : "My work");

	if (detail.isPending) return <PageSkeleton />;
	if (!w)
		return isNotFound(detail.error) || appCodeOf(detail.error) === "FORBIDDEN" ? (
			<EmptyState
				title="We couldn't find this work."
				action={
					<Link to="/scout/submissions" className={buttonVariants({ variant: "outline" })}>
						Back to my work
					</Link>
				}
			/>
		) : (
			<ErrorState />
		);

	const d = w.work;
	const person = personOf(d, w.candidateName);
	const info = workInfo(d);
	const questions = w.call?.questions ?? [];

	return (
		<div className="mx-auto max-w-xl space-y-12">
			<header className="space-y-4">
				<Link
					to="/scout/submissions"
					className="inline-flex items-center gap-1.5 type-label text-muted-foreground hover:text-foreground"
				>
					<ArrowLeft className="size-3.5" /> My work
				</Link>
				<div className="space-y-3">
					<Chip tone="accent">
						<info.icon className="size-3.5" />
						{info.name}
					</Chip>
					<h1 className="type-display">{person}</h1>
					<p className="text-muted-foreground">
						{[d.roleTitle, w.companyName, `sent ${dateLabel(d.submittedAt)}`].filter(Boolean).join(" · ")}
					</p>
					<div className="flex">
						<WorkStatus d={d} person={person} />
					</div>
				</div>
			</header>

			<Waiting d={d} person={person} />
			<FollowUps d={d} />

			<section className="space-y-4">
				<h2 className="type-label text-muted-foreground">What you sent</h2>
				{d.deliverable.type === "SOURCING" ? (
					<div className="space-y-3 rounded-3xl bg-card p-5 ring-1 ring-foreground/5">
						<a
							href={d.deliverable.profileUrl}
							target="_blank"
							rel="noreferrer"
							className="inline-flex max-w-full items-center gap-1.5 text-primary hover:underline"
						>
							<span className="truncate">{d.deliverable.profileUrl.replace(/^https?:\/\/(www\.)?/, "")}</span>
							<ExternalLink className="size-3.5 shrink-0" />
						</a>
						<p className="whitespace-pre-line">{w.note ?? d.deliverable.notes}</p>
					</div>
				) : (
					<CallAnswers d={d} questions={questions} call={w.call ?? null} />
				)}
				{w.editable && <EditNote id={d.id} note={w.note ?? ""} sourcing={d.gigType === "SOURCING"} />}
			</section>

			<Review d={d} w={w} />

			{d.status === "REJECTED" && !WITHDRAWN.test(d.review?.reasons[0] ?? "") && (
				<Appeal d={d} align="start" showReasons={false} />
			)}

			<div className="space-y-6">
				{w.call?.transcript && w.call.transcript.length > 0 && (
					<Disclosure label="Call transcript">
						<div className="space-y-3">
							<Transcript lines={w.call.transcript} />
							{w.call.recordingUrl && (
								<a
									href={w.call.recordingUrl}
									target="_blank"
									rel="noreferrer"
									className="type-label text-primary underline-offset-4 hover:underline"
								>
									Listen to the recording
								</a>
							)}
						</div>
					</Disclosure>
				)}
				{d.payout && (
					<Disclosure label="Where the money went">
						<PayoutBreakdown d={d} person={person} operator={me.operator?.name ?? null} />
					</Disclosure>
				)}
				{w.editable && <Withdraw d={d} person={person} />}
			</div>
		</div>
	);
}

/** Something only the candidate can do now: the link to send them. */
function Waiting({ d, person }: { d: DeliverableView; person: string }) {
	const confirm = d.status === "PENDING" ? d.confirmation : null;
	const who = firstName(person);
	if (confirm?.status === "PENDING" && confirm.url)
		return (
			<div className="space-y-3 rounded-3xl bg-accent p-5 text-accent-foreground">
				<p>Send {who} this link. You get paid when they confirm they are open to a call.</p>
				<div className="flex flex-wrap items-center gap-x-4 gap-y-2">
					<CopyButton text={confirm.url} className="text-accent-foreground" />
					<Countdown deadline={confirm.expiresAt} prefix="" suffix="left" />
				</div>
			</div>
		);
	if (d.callChecks?.length)
		return (
			<section className="space-y-3">
				<h2 className="type-label text-muted-foreground">Calls with {who}</h2>
				<CallChecks d={d} person={person} align="start" />
			</section>
		);
	return null;
}

/** The agent's summary is written for the company; say its codes in words. */
const plainWords = (text: string) =>
	text
		.replace(/\bADVANCE\b/g, "moving forward")
		.replace(/\bMAYBE\b/g, "not sure")
		.replace(/\bPASS\b/g, "not a fit");

const WITHDRAWN = /^withdrawn by the recruiter/i;

const REC: Record<string, string> = { ADVANCE: "Move forward", MAYBE: "Not sure", PASS: "Not a fit" };

function CallAnswers({
	d,
	questions,
	call,
}: {
	d: DeliverableView;
	questions: CallDetail["questions"];
	call: CallDetail | null;
}) {
	const p = d.deliverable;
	if (p.type === "SOURCING") return null;
	return (
		<div className="space-y-6">
			{p.type === "REFERENCE_CHECK" && (
				<p className="text-muted-foreground">
					You talked to {p.refereeName} · {p.refereeRelation}
				</p>
			)}
			<ol className="space-y-5">
				{questions.map((q, i) => (
					<li key={q.id} className="space-y-1.5">
						<p className="text-muted-foreground">
							<span className="tabular">{i + 1}. </span>
							{q.question}
						</p>
						<p className="flex items-start gap-2">
							<CheckMark check={q.check} />
							<span className={cn(!q.answer && "text-muted-foreground")}>{q.answer ?? "Not answered"}</span>
						</p>
					</li>
				))}
			</ol>
			<p className="type-label text-muted-foreground">
				Your call: {REC[p.recommendation] ?? p.recommendation}
				{p.type === "SCREENING_CALL" && p.assessedLevel && ` · level ${p.assessedLevel}`}
				{p.type === "SCREENING_CALL" &&
					(p.evidence === "recording"
						? " · recorded"
						: p.evidence === "self-reported"
							? " · not recorded"
							: "")}
			</p>
			{call?.recruiterNote && <p className="whitespace-pre-line">{call.recruiterNote}</p>}
		</div>
	);
}

/** The agent's check of one answer, once it has looked: a quiet mark, never a score. */
function CheckMark({ check }: { check: CallDetail["questions"][number]["check"] }) {
	if (!check) return null;
	const bad = check.missing || check.contradiction;
	const weak = !bad && check.generic;
	const Icon = bad ? X : weak ? Minus : Check;
	return (
		<Icon
			aria-label={bad ? "The agent found a problem" : weak ? "Too general" : "Good answer"}
			className={cn(
				"mt-1 size-4 shrink-0",
				bad ? "text-destructive" : weak ? "text-muted-foreground" : "text-success",
			)}
		/>
	);
}

/** The agent's review: its verdict per criterion (profiles) or its summary (calls), and the reason when rejected. */
function Review({ d, w }: { d: DeliverableView; w: GigWorkView }) {
	const review = d.review?.candidateReview ?? null;
	const reasons = d.review?.reasons ?? [];
	const raw = w.rejectText ?? (d.status === "REJECTED" ? reasons[0] : null);
	const rejectText =
		raw && WITHDRAWN.test(raw)
			? "You took this back. It doesn't affect your record."
			: review && d.status === "REJECTED"
				? null
				: raw && plainWords(raw);
	const deposit = depositStatusLine(d);
	const summary = !review && w.call?.summary ? plainWords(w.call.summary) : null;
	const others = !review && !rejectText ? reasons : [];
	if (!review && !rejectText && !summary && !others.length) {
		if (d.status !== "ACCEPTED") return null;
		return (
			<section className="space-y-4">
				<h2 className="type-label text-muted-foreground">The agent's review</h2>
				<p>Accepted.</p>
			</section>
		);
	}
	return (
		<section className="space-y-4">
			<h2 className="type-label text-muted-foreground">The agent's review</h2>
			{d.status === "PENDING" && d.review?.verdict === "ESCALATE" && (
				<p>The agent asked the company to decide before paying. Nothing for you to do.</p>
			)}
			{rejectText && <p>{rejectText}</p>}
			{review && d.status === "REJECTED" && !WITHDRAWN.test(raw ?? "") && (
				<WhyNotAccepted review={review} criteria={w.criteria} />
			)}
			{deposit && d.status !== "PENDING" && <p className="type-label text-muted-foreground">{deposit}</p>}
			{review && (
				<div className="space-y-4">
					<div className="flex flex-wrap items-center gap-3">
						<ScoreChip review={review} />
					</div>
					{review.summary && <p className="text-muted-foreground">{review.summary}</p>}
					{w.criteria && <WhyThisScore review={review} criteria={w.criteria} />}
				</div>
			)}
			{summary && <p className="text-muted-foreground">{summary}</p>}
			{others.length > 0 && (
				<ul className="space-y-1 text-muted-foreground">
					{others.map((r) => (
						<li key={r}>{r}</li>
					))}
				</ul>
			)}
		</section>
	);
}

const clock = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

function Transcript({ lines }: { lines: NonNullable<CallDetail["transcript"]> }) {
	return (
		<ol className="max-h-96 space-y-3 overflow-y-auto rounded-3xl bg-muted p-5">
			{lines.map((l) => (
				<li key={`${l.startSec}-${l.speaker}`} className="grid grid-cols-[3rem_1fr] gap-x-3">
					<span className="type-label tabular text-muted-foreground">{clock(l.startSec)}</span>
					<span>
						<span className="block type-label text-muted-foreground">{l.speaker}</span>
						{l.text}
					</span>
				</li>
			))}
		</ol>
	);
}

/** Change the note while the agent hasn't decided. */
function EditNote({ id, note, sourcing }: { id: string; note: string; sourcing: boolean }) {
	const [open, setOpen] = useState(false);
	const [text, setText] = useState(note);
	const edit = useEditWork(id);
	if (!open)
		return (
			<button
				type="button"
				onClick={() => {
					setText(note);
					setOpen(true);
				}}
				className="type-label text-primary underline-offset-4 hover:underline"
			>
				{sourcing ? "Edit your note" : note ? "Edit your note" : "Add a note"}
			</button>
		);
	return (
		<div className="space-y-2">
			<Textarea
				value={text}
				onChange={(e) => setText(e.target.value)}
				aria-label="Your note"
				placeholder="What should the agent know?"
				className="min-h-24 rounded-3xl p-4"
				autoFocus
			/>
			<div className="flex gap-2">
				<Button
					size="sm"
					disabled={!text.trim() || text.trim() === note.trim() || edit.isPending}
					onClick={() =>
						edit.mutate(text.trim(), {
							onSuccess: () => {
								setOpen(false);
								toast.success("Note saved");
							},
						})
					}
				>
					{edit.isPending && <Loader2 className="animate-spin" />}
					Save
				</Button>
				<Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
					Cancel
				</Button>
			</div>
			{edit.isError && <p className="type-label text-destructive">{errorMessage(edit.error)}</p>}
		</div>
	);
}

/** Take it back before the agent decides. It doesn't count against the recruiter. */
function Withdraw({ d, person }: { d: DeliverableView; person: string }) {
	const [open, setOpen] = useState(false);
	const withdraw = useWithdrawWork(d.id);
	const what = d.gigType === "SOURCING" ? `${firstName(person)}'s profile` : "your notes";
	return (
		<>
			<button
				type="button"
				onClick={() => setOpen(true)}
				className="block type-label text-muted-foreground underline-offset-4 hover:text-destructive hover:underline"
			>
				Take it back
			</button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent className="gap-4 p-6">
					<DialogTitle>Take back {what}?</DialogTitle>
					<p className="text-muted-foreground">
						The agent stops checking it and nothing is paid for it. It doesn't affect your record.
						{d.deposit?.status === "HELD" &&
							` Your ${formatMoney(d.deposit.amount)} deposit stays with the company.`}
						{d.gigType !== "SOURCING" && " The gig goes back on the board."}
					</p>
					{withdraw.isError && <p className="type-label text-destructive">{errorMessage(withdraw.error)}</p>}
					<DialogFooter>
						<Button variant="ghost" onClick={() => setOpen(false)}>
							Keep it
						</Button>
						<Button
							variant="destructive"
							disabled={withdraw.isPending}
							onClick={() =>
								withdraw.mutate(undefined, {
									onSuccess: () => {
										setOpen(false);
										toast.success("Taken back");
									},
								})
							}
						>
							{withdraw.isPending && <Loader2 className="animate-spin" />}
							Take it back
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
