import type { Deliverable, DeliverableView, Me, RecordingView } from "@scout/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, ExternalLink, Loader2, Lock, Mic, UserRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { PageSkeleton, RequireAccount } from "@/components/account";
import { Appeal } from "@/components/appeal";
import { Chip, Countdown, Disclosure, EmptyState, ErrorState } from "@/components/bits";
import { BookingTimes, NoShow, ReportFake, ShowUpFee } from "@/components/call-tools";
import { CopyButton } from "@/components/copy";
import { FollowUps } from "@/components/follow-ups";
import { depositLine, PayBreakdown, RoleBrief } from "@/components/gig-brief";
import { Avatar } from "@/components/person";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
	candidateOutcome,
	depositStatusLine,
	personOf,
	SendLink,
	WhyNotAccepted,
	WorkStatus,
} from "@/components/work";
import { appCodeOf, errorData, errorMessage, isDuplicate, isNotFound } from "@/lib/errors";
import { firstName, formatMoney } from "@/lib/format";
import { eligibilityLine, requirementChips } from "@/lib/gig-access";
import { CLAIM_HOURS, GIG_TYPES, kindOf } from "@/lib/gig-types";
import { earnFor, gigApi, splitFor, useGig, useMyWork, useRecording } from "@/lib/gigs/api";
import { callApi } from "@/lib/gigs/calls";
import type { GigView } from "@/lib/gigs/schemas";
import { useWork } from "@/lib/gigs/work";
import { useTRPCClient } from "@/lib/trpc";
import { useTitle } from "@/lib/use-title";
import { useTransact } from "@/lib/use-transact";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/scout/gigs/$gigId")({
	component: () => {
		const { gigId } = Route.useParams();
		return <RequireAccount kind="scout">{(me) => <GigPage gigId={gigId} me={me} />}</RequireAccount>;
	},
});

function GigPage({ gigId, me }: { gigId: string; me: Me }) {
	const gig = useGig(gigId);
	const work = useMyWork();
	useTitle(gig.data ? (gig.data.exclusive ? gig.data.roleTitle : gig.data.title) : "Gig");
	const [sent, setSent] = useState<string | null>(null);
	if (gig.isError)
		return isNotFound(gig.error) ? <Back title="We couldn't find this gig." /> : <ErrorState />;
	if (gig.isPending) return <PageSkeleton />;
	const g = gig.data;
	const earn = earnFor(g, me.operator?.feeBps ?? 0);
	const split = splitFor(g, me.operator?.feeBps ?? 0);
	// Newest first: what this recruiter already sent to this gig.
	const mine = (work.data ?? []).filter((d) => d.gigId === g.id);
	const latest = mine[0];

	if (sent) return <Checking deliverableId={sent} gig={g} onAgain={() => setSent(null)} />;
	// A call you delivered: its status, never the empty form again.
	if (g.exclusive && latest && latest.status !== "REJECTED" && (g.claimedByMe || g.status !== "OPEN"))
		return <Delivered gig={g} work={mine} />;
	if (g.status !== "OPEN" && g.closedReason) return <ClosedForYou gig={g} />;
	if (g.status !== "OPEN")
		return mine.length || g.showUpFee ? (
			<Delivered gig={g} work={mine} />
		) : (
			<Back title="This gig is closed." />
		);
	if (g.exclusive && g.claimant && !g.claimedByMe) return <Back title="Another recruiter took this gig." />;

	return (
		<div className="mx-auto max-w-xl space-y-10">
			<header className="space-y-3">
				<Link
					to="/scout"
					className="inline-flex items-center gap-1.5 type-label text-muted-foreground hover:text-foreground"
				>
					<ArrowLeft className="size-3.5" /> Gigs
				</Link>
				<div>
					<KindChip gig={g} />
				</div>
				<h1 className="type-display">
					Earn {formatMoney(earn)} <span className="text-muted-foreground">{GIG_TYPES[kindOf(g)].unit}</span>
				</h1>
				<PayBreakdown gig={g} now={split.now} later={split.later} operator={me.operator ?? null} />
				{g.exclusive && !g.redacted && <p className="text-muted-foreground">{g.title}</p>}
				{g.candidate && <CandidateLine gig={g} />}
			</header>
			{g.post && <RoleBrief post={g.post} compact={g.type !== "SOURCING"} />}
			{g.exclusive && !g.claimedByMe ? (
				<Claim gig={g} />
			) : g.type === "SOURCING" ? (
				<>
					<SentHere work={mine} />
					<SourcingForm gig={g} onSent={setSent} operator={me.operator?.name ?? null} />
				</>
			) : (
				<>
					{latest?.status === "REJECTED" && <SentBack d={latest} />}
					<ScriptForm gig={g} onSent={setSent} />
				</>
			)}
		</div>
	);
}

function KindChip({ gig }: { gig: GigView }) {
	const info = GIG_TYPES[kindOf(gig)];
	return (
		<Chip tone="accent">
			<info.icon className="size-3.5" />
			{info.name}
		</Chip>
	);
}

/** Your work on this gig so far, each a link to its detail. */
function SentHere({ work }: { work: DeliverableView[] }) {
	if (!work.length) return null;
	return (
		<section className="space-y-2">
			<h2 className="type-label text-muted-foreground">
				You sent {work.length} profile{work.length === 1 ? "" : "s"} here
			</h2>
			<ul className="divide-y rounded-3xl bg-card px-4 ring-1 ring-foreground/5">
				{work.map((d) => {
					const person = personOf(d);
					const url =
						d.status === "PENDING" && d.confirmation?.status === "PENDING" ? d.confirmation.url : null;
					return (
						<li key={d.id} className="relative flex items-center gap-3 py-3">
							<Avatar name={person} size="sm" />
							<Link
								to="/scout/work/$deliverableId"
								params={{ deliverableId: d.id }}
								className="min-w-0 flex-1 truncate after:absolute after:inset-0"
							>
								{person}
							</Link>
							<span className="relative z-10 flex flex-col items-end gap-1">
								<WorkStatus d={d} person={person} />
								{url && <CopyButton text={url} />}
							</span>
						</li>
					);
				})}
			</ul>
		</section>
	);
}

/** A call the agent sent back: why, and the way to fix and resend below. */
function SentBack({ d }: { d: DeliverableView }) {
	return (
		<div className="space-y-1 rounded-3xl bg-muted p-4">
			<p>The agent sent your notes back</p>
			{d.review?.reasons[0] && <p className="type-label text-muted-foreground">{d.review.reasons[0]}</p>}
			<Link
				to="/scout/work/$deliverableId"
				params={{ deliverableId: d.id }}
				className="type-label text-primary underline-offset-4 hover:underline"
			>
				See what you sent
			</Link>
		</div>
	);
}

/** "The agent asked the company about 2 answers" or the agent's first reason. */
function escalationLine(d: DeliverableView) {
	const reasons = d.review?.reasons ?? [];
	if (reasons.length > 1)
		return `The agent asked the company about ${reasons.length} points before paying. Nothing for you to do.`;
	if (reasons[0]) return `The agent asked the company before paying: ${reasons[0]}`;
	return "The agent asked the company before paying. Nothing for you to do.";
}

/** Under the person on a delivered call: what happens next, or a pointer to the detail. */
function deliveredLine(d: DeliverableView) {
	if (d.status === "PENDING" && d.review?.verdict === "ESCALATE") return escalationLine(d);
	if (d.status === "REJECTED") return d.review?.reasons[0] ?? "See why";
	return "See your notes and the agent's review";
}

/** The call you took ended early: what was recorded, what happens next, and whether you're paid for your time. */
function ClosedForYou({ gig }: { gig: GigView }) {
	const who = gig.candidate?.name ? firstName(gig.candidate.name) : "The candidate";
	const when = gig.closedAt
		? new Date(gig.closedAt).toLocaleString("en-GB", {
				day: "numeric",
				month: "short",
				hour: "2-digit",
				minute: "2-digit",
			})
		: null;
	const fake = gig.closedReason === "REPORTED_FAKE";
	return (
		<div className="mx-auto max-w-xl space-y-10">
			<header className="space-y-3">
				<KindChip gig={gig} />
				<h1 className="type-display">
					{fake ? "Thanks, we got your report" : `${who} missed the call twice`}
				</h1>
				<p className="text-muted-foreground">
					{fake
						? `The agent stopped all work on ${who} and the company decides what happens next. Reporting doesn't count against you.`
						: "The screening is stopped. Nothing counts against you."}
				</p>
			</header>
			<dl className="space-y-2 rounded-3xl bg-card p-5 ring-1 ring-foreground/5">
				<div className="flex justify-between gap-4">
					<dt className="text-muted-foreground">Recorded</dt>
					<dd className="text-right">
						{[fake ? "Reported as possibly fake" : "Two no-shows", when].filter(Boolean).join(" · ")}
					</dd>
				</div>
				{fake && gig.reportReason && (
					<div className="space-y-1">
						<dt className="text-muted-foreground">What you wrote</dt>
						<dd>“{gig.reportReason}”</dd>
					</div>
				)}
				<div className="flex justify-between gap-4">
					<dt className="text-muted-foreground">Pay for this call</dt>
					<dd className="text-right">
						{gig.showUpFee
							? gig.showUpFee.status === "PAID"
								? `Show-up fee paid · ${formatMoney(gig.showUpFee.amount)}`
								: `Show-up fee of ${formatMoney(gig.showUpFee.amount)} to claim`
							: "None, the call didn't happen"}
					</dd>
				</div>
			</dl>
			{gig.showUpFee && <ShowUpFee gig={gig} />}
			<div className="flex flex-wrap gap-3">
				<Link to="/scout" className={buttonVariants()}>
					Find another gig
				</Link>
				<Link to="/scout/submissions" className={buttonVariants({ variant: "outline" })}>
					My work
				</Link>
			</div>
		</div>
	);
}

/** The gig after you delivered (or after it closed): where your work stands, and the show-up fee if there is one. */
function Delivered({ gig, work }: { gig: GigView; work: DeliverableView[] }) {
	const d = work[0];
	const person = d ? personOf(d, gig.candidate?.name) : (gig.candidate?.name ?? "the candidate");
	const title = !d
		? gig.status === "OPEN"
			? "Nothing sent yet"
			: "This gig is closed"
		: d.status === "ACCEPTED"
			? "Accepted"
			: d.status === "PENDING"
				? "Sent to the agent"
				: "Not accepted";
	return (
		<div className="mx-auto max-w-xl space-y-10">
			<header className="space-y-3">
				<KindChip gig={gig} />
				<h1 className="type-display">{title}</h1>
				<p className="text-muted-foreground">{gig.exclusive ? gig.roleTitle : gig.title}</p>
			</header>
			{gig.showUpFee && <ShowUpFee gig={gig} />}
			{gig.type === "SOURCING" ? (
				<SentHere work={work} />
			) : (
				d && (
					<Link
						to="/scout/work/$deliverableId"
						params={{ deliverableId: d.id }}
						className="flex items-center gap-4 rounded-3xl bg-card p-5 ring-1 ring-foreground/5 transition-colors hover:bg-muted/60"
					>
						<span className="min-w-0 flex-1">
							<span className="block truncate">{person}</span>
							<span className="block type-label text-muted-foreground">{deliveredLine(d)}</span>
						</span>
						<WorkStatus d={d} person={person} />
					</Link>
				)
			)}
			<Link to="/scout" className={buttonVariants({ variant: "outline" })}>
				Back to gigs
			</Link>
		</div>
	);
}

function CandidateLine({ gig }: { gig: GigView }) {
	const c = gig.candidate;
	if (!c) return null;
	// Before the gig is yours the API sends an anonymous summary, no name, photo or link.
	if (c.redacted || !c.name)
		return (
			<div className="flex items-center gap-3 rounded-3xl bg-card p-4 ring-1 ring-foreground/5">
				<span className="grid size-10 place-items-center rounded-full bg-muted" aria-hidden>
					<UserRound className="size-5 text-muted-foreground" />
				</span>
				<p className="text-muted-foreground">
					{[c.summary.headline, c.summary.city].filter(Boolean).join(" · ")}
				</p>
			</div>
		);
	const reach = [c.contact?.email, c.contact?.phone].filter((x): x is string => !!x);
	return (
		<div className="space-y-3 rounded-3xl bg-card p-4 ring-1 ring-foreground/5">
			<div className="flex items-center gap-3">
				<Avatar name={c.name} src={c.card?.avatarUrl} />
				<div className="min-w-0 flex-1">
					<p className="truncate">{c.name}</p>
					<p className="truncate type-label text-muted-foreground">{c.summary.headline}</p>
				</div>
				{c.profileUrl && (
					<a
						href={c.profileUrl}
						target="_blank"
						rel="noreferrer"
						className="inline-flex items-center gap-1 type-label text-primary hover:underline"
					>
						Profile <ExternalLink className="size-3" />
					</a>
				)}
			</div>
			{gig.claimedByMe && gig.type !== "REFERENCE_CHECK" && (
				<div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t pt-3 pl-13 type-label">
					{reach.length ? (
						reach.map((x) => (
							<span key={x} className="inline-flex items-center gap-2">
								{x} <CopyButton text={x} label="Copy" />
							</span>
						))
					) : (
						<span className="text-muted-foreground">
							No email or phone yet. Ask the recruiter who found {firstName(c.name)}, or message them on their
							profile.
						</span>
					)}
				</div>
			)}
		</div>
	);
}

/** Reference checks: who to call, as the candidate named them on the screening call. */
function RefereeLine({ gig }: { gig: GigView }) {
	const r = gig.candidate?.referee;
	const who = gig.candidate?.name ? firstName(gig.candidate.name) : "the candidate";
	if (!r)
		return (
			<p className="rounded-3xl bg-muted p-4 text-muted-foreground">
				{who} didn't name a referee on the screening call. Ask {who} for a former manager, then fill in who
				you talked to below.
			</p>
		);
	return (
		<div className="flex flex-wrap items-center justify-between gap-3 rounded-3xl bg-accent p-4 text-accent-foreground">
			<span>
				Call {r.name} · {r.relation}
				<span className="block type-label">{r.contact}</span>
			</span>
			<CopyButton text={r.contact} label="Copy" className="text-accent-foreground" />
		</div>
	);
}

function Back({ title }: { title: string }) {
	return (
		<EmptyState
			title={title}
			action={
				<Link to="/scout" className={buttonVariants({ variant: "outline" })}>
					Back to gigs
				</Link>
			}
		/>
	);
}

/** Exclusive gigs: one recruiter takes it, then delivers. Shows the agent's questions up front. */
function Claim({ gig }: { gig: GigView }) {
	const { transact, pending } = useTransact();
	const qc = useQueryClient();
	const claim = useMutation({
		mutationFn: async () => {
			const { unsignedTx } = await gigApi.claim(gig.id);
			const ok = await transact(unsignedTx, { pending: "Taking the gig…", success: "It's yours." });
			if (ok) await qc.invalidateQueries({ queryKey: ["gigs"] });
		},
	});
	const info = GIG_TYPES[kindOf(gig)];
	const locked = !!gig.eligibility && !gig.eligibility.allowed;
	return (
		<div className="space-y-8">
			<p>{gig.brief}</p>
			<dl className="space-y-1 type-label">
				<div className="flex gap-2">
					<dt className="text-muted-foreground">You send:</dt>
					<dd>{info.deliver}</dd>
				</div>
				<div className="flex gap-2">
					<dt className="text-muted-foreground">Time:</dt>
					<dd>{info.time}</dd>
				</div>
				<div className="flex gap-2">
					<dt className="text-muted-foreground">It's yours for:</dt>
					<dd>{CLAIM_HOURS} hours after you take it</dd>
				</div>
				{gig.requirements.summary && (
					<div className="flex gap-2">
						<dt className="text-muted-foreground">Who can take it:</dt>
						<dd>{requirementChips(gig.requirements).join(" · ") || "Anyone"}</dd>
					</div>
				)}
			</dl>
			{gig.exclusive && gig.type === "SCREENING_CALL" && <BookingTimes gig={gig} />}
			{locked && gig.eligibility && (
				<p className="flex items-center gap-2 rounded-3xl bg-muted p-4 text-muted-foreground">
					<Lock className="size-4 shrink-0" /> {eligibilityLine(gig.eligibility)}
				</p>
			)}
			{gig.script && (
				<ol className="list-decimal space-y-2 pl-5 text-muted-foreground">
					{gig.script.map((q) => (
						<li key={q.id}>{q.question}</li>
					))}
				</ol>
			)}
			<Button
				size="lg"
				className="h-12 w-full"
				onClick={() => claim.mutate()}
				disabled={claim.isPending || pending || locked}
			>
				{(claim.isPending || pending) && <Loader2 className="animate-spin" />}
				Take gig
			</Button>
			{claim.isError && <p className="text-destructive">{errorMessage(claim.error)}</p>}
		</div>
	);
}

function useDeliver(gig: GigView, onSent: (id: string) => void) {
	const { transact, pending } = useTransact();
	const mutation = useMutation({
		mutationFn: async (deliverable: Deliverable) => {
			const res = await gigApi.deliver(gig.id, deliverable);
			const ok = await transact(res.unsignedTx, { pending: "Sending…", success: "Sent to the agent." });
			if (ok) onSent(res.deliverableId);
		},
		onError: (e) => console.error("[deliver]", gig.id, errorData(e) ?? e),
	});
	return { ...mutation, busy: mutation.isPending || pending };
}

const NOISE = new Set(
	"demo dev developer engineer backend frontend fullstack live fde rust java go golang python ml ai sre cto pm eng swe test".split(
		" ",
	),
);
/** "linkedin.com/in/karolina-mazurek-backend-demo" → "Karolina Mazurek". */
function nameFromProfile(url: string) {
	const slug = url.match(/linkedin\.com\/in\/([^/?#]+)/i)?.[1] ?? url.match(/github\.com\/([^/?#]+)/i)?.[1];
	if (!slug) return "";
	const parts = decodeURIComponent(slug)
		.split(/[-_.]/)
		.filter((p) => /^[\p{L}]+$/u.test(p) && !NOISE.has(p.toLowerCase()))
		.slice(0, 3);
	return parts.length >= 2 ? parts.map((p) => p[0].toUpperCase() + p.slice(1).toLowerCase()).join(" ") : "";
}

/** "a, b and c" */
const listOf = (items: string[]) =>
	items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

const profileKey = (url: string) =>
	url
		.trim()
		.toLowerCase()
		.replace(/^https?:\/\/(www\.)?/, "")
		.replace(/[/?#].*$/, (m) => (m.startsWith("/") ? m.split(/[?#]/)[0].replace(/\/$/, "") : ""));
const sameProfile = (a: string, b: string) => !!b.trim() && profileKey(a) === profileKey(b);

function SourcingForm({
	gig,
	onSent,
	operator,
}: {
	gig: GigView;
	onSent: (id: string) => void;
	/** The recruiter's operator: vouched recruiters put down no deposit. */
	operator: string | null;
}) {
	const client = useTRPCClient();
	const [profileUrl, setProfileUrl] = useState("");
	const [name, setName] = useState("");
	const [nameTouched, setNameTouched] = useState(false);
	const [notes, setNotes] = useState("");
	const [duplicate, setDuplicate] = useState(false);
	// Once the link was pasted, the name and note stay on screen (clearing the link never wipes them).
	const [expanded, setExpanded] = useState(false);
	const deliver = useDeliver(gig, onSent);
	const work = useMyWork();
	const sentByMe = (work.data ?? []).some(
		(d) =>
			d.roleId === gig.roleId &&
			d.deliverable.type === "SOURCING" &&
			sameProfile(d.deliverable.profileUrl, profileUrl),
	);
	const dupLine = sentByMe
		? "You already sent this person for this role. See them in My work."
		: "Another recruiter already submitted this person for this role.";
	const validUrl = /^(https?:\/\/)?(www\.)?[\w-]+(\.[\w-]+)+\/\S+/.test(profileUrl.trim());
	const missing = [
		!profileUrl.trim() ? "their profile link" : !validUrl ? "a full profile link" : null,
		!name.trim() ? "their name" : null,
		!notes.trim() ? "a short note" : null,
	].filter(Boolean);

	// Duplicate check right after the link is pasted.
	useEffect(() => {
		if (!/^https?:\/\/\S+\.\S+/.test(profileUrl)) return;
		let cancelled = false;
		const t = setTimeout(() => {
			client.submissions.checkDuplicate
				.query({ roleId: gig.roleId, profileUrl })
				.then((res) => {
					if (!cancelled) setDuplicate(res.duplicate);
				})
				.catch(() => {});
		}, 400);
		return () => {
			cancelled = true;
			clearTimeout(t);
		};
	}, [profileUrl, gig.roleId, client]);

	return (
		<form
			className="space-y-6"
			noValidate
			onSubmit={(e) => {
				e.preventDefault();
				if (missing.length) return;
				const url = /^https?:\/\//.test(profileUrl.trim())
					? profileUrl.trim()
					: `https://${profileUrl.trim()}`;
				deliver.mutate({ type: "SOURCING", name: name.trim(), profileUrl: url, notes });
			}}
		>
			<Input
				id="url"
				type="url"
				autoFocus
				value={profileUrl}
				onChange={(e) => {
					setProfileUrl(e.target.value);
					if (e.target.value) setExpanded(true);
					setDuplicate(false);
					if (!nameTouched) setName(nameFromProfile(e.target.value));
				}}
				placeholder="Paste their LinkedIn"
				aria-label="Profile link"
				className="h-12"
			/>
			{(expanded || profileUrl) && (
				<div className="animate-in space-y-6 fade-in-0">
					<Input
						id="name"
						required
						value={name}
						onChange={(e) => {
							setName(e.target.value);
							setNameTouched(true);
						}}
						placeholder="Their name"
						aria-label="Candidate name"
						className="h-12"
					/>
					<Textarea
						id="notes"
						required
						value={notes}
						onChange={(e) => setNotes(e.target.value)}
						placeholder="Two lines: why they fit, and that they're open to a move"
						aria-label="Note"
						className="min-h-28 rounded-3xl p-4"
					/>
				</div>
			)}
			<ul className="space-y-1 type-label text-muted-foreground">
				<li>You get a link to send them. You're paid once they confirm they are open to a call.</li>
				{gig.eligibility?.needsBond ? (
					<li>{depositLine(BigInt(gig.bounty) / 10n)}</li>
				) : (
					operator && <li>No deposit: you are vouched by {operator}.</li>
				)}
			</ul>
			{duplicate && <p className="text-destructive">{dupLine}</p>}
			{deliver.isError && !isDuplicate(deliver.error) && (
				<p className="text-destructive">{errorMessage(deliver.error)}</p>
			)}
			{deliver.isError && isDuplicate(deliver.error) && !duplicate && (
				<p className="text-destructive">{dupLine}</p>
			)}
			<Button
				type="submit"
				size="lg"
				className="h-12 w-full"
				disabled={missing.length > 0 || duplicate || deliver.busy}
			>
				{deliver.busy && <Loader2 className="animate-spin" />}
				Send to the agent
			</Button>
			{missing.length > 0 && expanded && (
				<p className="text-center type-label text-muted-foreground">
					Add {listOf(missing as string[])} to send.
				</p>
			)}
		</form>
	);
}

const LEVELS = ["B1", "B2", "C1", "C2"] as const;

const RECOMMENDATIONS = [
	{ value: "ADVANCE", label: "Move forward" },
	{ value: "MAYBE", label: "Not sure" },
	{ value: "PASS", label: "Not a fit" },
] as const;

function LevelPicker({
	level,
	onPick,
}: {
	level: (typeof LEVELS)[number] | null;
	onPick: (l: (typeof LEVELS)[number]) => void;
}) {
	return (
		<div className="flex flex-wrap items-center gap-2">
			<span className="type-label text-muted-foreground">Level you heard</span>
			{LEVELS.map((l) => (
				<button
					key={l}
					type="button"
					aria-pressed={level === l}
					onClick={() => onPick(l)}
					className={cn(
						"rounded-full px-3.5 py-1.5 type-label ring-1 ring-inset transition-colors",
						level === l
							? "bg-accent text-accent-foreground ring-primary/30"
							: "text-muted-foreground ring-border hover:bg-muted",
					)}
				>
					{l}
				</button>
			))}
		</div>
	);
}

const draftKey = (gigId: string) => `scout.answers.${gigId}`;
function readDraft(gigId: string): Record<string, string> {
	try {
		return JSON.parse(sessionStorage.getItem(draftKey(gigId)) ?? "{}") as Record<string, string>;
	} catch {
		return {};
	}
}
function writeDraft(gigId: string, answers: Record<string, string>) {
	try {
		sessionStorage.setItem(draftKey(gigId), JSON.stringify(answers));
	} catch {
		// private mode: the draft lives in memory only
	}
}

/** Screening and reference gigs: the agent's questions, one answer each, and the recruiter's own call. */
function ScriptForm({ gig, onSent }: { gig: GigView; onSent: (id: string) => void }) {
	const script = gig.script ?? [];
	// A draft survives a reload or a re-render; what the recruiter typed is never replaced by the notetaker.
	const [answers, setAnswersState] = useState<Record<string, string>>(() => readDraft(gig.id));
	const touched = useRef(new Set(Object.keys(readDraft(gig.id))));
	const setAnswers = (update: (a: Record<string, string>) => Record<string, string>) =>
		setAnswersState((current) => {
			const next = update(current);
			writeDraft(gig.id, next);
			return next;
		});
	const typeAnswer = (id: string, text: string) => {
		touched.current.add(id);
		setAnswers((a) => ({ ...a, [id]: text }));
	};
	const [recommendation, setRecommendation] = useState<"ADVANCE" | "MAYBE" | "PASS" | null>(null);
	const [refereeName, setRefereeName] = useState(gig.candidate?.referee?.name ?? "");
	const [refereeRelation, setRefereeRelation] = useState(gig.candidate?.referee?.relation ?? "");
	// Screening calls: a referee the candidate named, for the reference check that follows (optional).
	const [named, setNamed] = useState({ name: "", relation: "", contact: "" });
	const namedComplete = named.name.trim() && named.relation.trim() && named.contact.trim();
	const deliver = useDeliver(gig, onSent);
	const reference = gig.type === "REFERENCE_CHECK";
	const language = gig.variant === "language";
	const [level, setLevel] = useState<(typeof LEVELS)[number] | null>(null);
	const [recording, setRecording] = useState<RecordingView | null>(null);
	const missing = new Set(recording?.prefill?.missing ?? []);
	// Fill the form once, when the notetaker's transcript is ready; the recruiter edits from there.
	const onDone = (view: RecordingView) => {
		setRecording(view);
		if (!view.prefill) return;
		setAnswers((current) => {
			const next = { ...current };
			for (const a of view.prefill?.answers ?? [])
				if (!touched.current.has(a.questionId) && !next[a.questionId]?.trim()) next[a.questionId] = a.answer;
			return next;
		});
	};
	// The notetaker's reading of the call is a hint; the recommendation stays the recruiter's own click.
	const suggested = RECOMMENDATIONS.find((r) => r.value === recording?.prefill?.recommendation)?.label;
	// Language checks: the level picker sits under the question that asks for the level (asked once).
	const levelQuestion = language ? script.find((q) => /\blevel\b/i.test(q.question))?.id : undefined;
	const unanswered = script.filter((q) => !answers[q.id]?.trim()).length;
	const todo = [
		reference && !refereeName.trim() ? "who you talked to" : null,
		reference && !refereeRelation.trim() ? "how they know the candidate" : null,
		unanswered ? `${unanswered} more answer${unanswered === 1 ? "" : "s"}` : null,
		!recommendation ? "your call" : null,
		language && !level ? "the level you heard" : null,
	].filter((x): x is string => !!x);
	const complete = todo.length === 0;
	const yoursUntil = gig.claimedAt ? Date.parse(gig.claimedAt) + CLAIM_HOURS * 3_600_000 : null;

	return (
		<form
			className="space-y-8"
			noValidate
			onSubmit={(e) => {
				e.preventDefault();
				if (!recommendation || !complete) return;
				const list = script.map((q) => ({ questionId: q.id, answer: answers[q.id]?.trim() ?? "" }));
				deliver.mutate(
					reference
						? { type: "REFERENCE_CHECK", refereeName, refereeRelation, answers: list, recommendation }
						: // A recorded call is attached as evidence by the server, never sent from here.
							{
								type: "SCREENING_CALL",
								answers: list,
								recommendation,
								...(language && level ? { assessedLevel: level } : {}),
								...(!language && namedComplete
									? {
											referee: {
												name: named.name.trim(),
												relation: named.relation.trim(),
												contact: named.contact.trim(),
											},
										}
									: {}),
							},
				);
			}}
		>
			{yoursUntil && yoursUntil > Date.now() && (
				<p className="type-label text-muted-foreground">
					Yours until{" "}
					{new Date(yoursUntil).toLocaleString("en-GB", {
						weekday: "short",
						hour: "2-digit",
						minute: "2-digit",
					})}
					<Countdown deadline={new Date(yoursUntil).toISOString()} prefix=" ·" suffix="left" tone="good" />.
					If you don't send your notes by then, the gig goes back on the board.
				</p>
			)}
			{!reference && <BookingTimes gig={gig} />}
			{!reference && <ShowUpFee gig={gig} />}
			<Notetaker gigId={gig.id} onDone={onDone} />
			{recording?.status === "done" && (
				<p className="type-label text-success">Filled in from the call. Check and edit before you send.</p>
			)}
			{reference && <RefereeLine gig={gig} />}
			{reference && (
				<div className="grid gap-3 sm:grid-cols-2">
					<Input
						required
						value={refereeName}
						onChange={(e) => setRefereeName(e.target.value)}
						placeholder="Who did you talk to?"
						aria-label="Reference name"
						className="h-12"
					/>
					<Input
						required
						value={refereeRelation}
						onChange={(e) => setRefereeRelation(e.target.value)}
						placeholder="How they know the candidate"
						aria-label="How they know the candidate"
						className="h-12"
					/>
				</div>
			)}
			<ol className="space-y-6">
				{script.map((q, i) => (
					<li key={q.id} className="space-y-2">
						<label htmlFor={`a-${q.id}`} className="block">
							<span className="tabular text-muted-foreground">{i + 1}. </span>
							{q.question}
							<span className="mt-1 block type-label text-muted-foreground">{q.whatGoodLooksLike}</span>
						</label>
						{missing.has(q.id) && (
							<span className="type-label text-warning-foreground">Not covered in the call</span>
						)}
						<Textarea
							id={`a-${q.id}`}
							value={answers[q.id] ?? ""}
							onChange={(e) => typeAnswer(q.id, e.target.value)}
							className="min-h-20 rounded-3xl p-4"
						/>
						{q.id === levelQuestion && <LevelPicker level={level} onPick={setLevel} />}
					</li>
				))}
			</ol>
			{!reference && !language && (
				<Disclosure label="They named a referee (optional)">
					<div className="grid gap-3 sm:grid-cols-3">
						<Input
							value={named.name}
							onChange={(e) => setNamed((n) => ({ ...n, name: e.target.value }))}
							placeholder="Name"
							aria-label="Referee name"
							className="h-11"
						/>
						<Input
							value={named.relation}
							onChange={(e) => setNamed((n) => ({ ...n, relation: e.target.value }))}
							placeholder="e.g. former manager"
							aria-label="How they know the candidate"
							className="h-11"
						/>
						<Input
							value={named.contact}
							onChange={(e) => setNamed((n) => ({ ...n, contact: e.target.value }))}
							placeholder="Email or phone"
							aria-label="Referee email or phone"
							className="h-11"
						/>
					</div>
					<p className="type-label text-muted-foreground">
						The recruiter who runs the reference check calls them. Fill in all three or leave it empty.
					</p>
				</Disclosure>
			)}
			<fieldset className="space-y-2">
				<legend className="type-label text-muted-foreground">
					Your call{suggested && !recommendation ? ` · the notetaker heard "${suggested}"` : ""}
				</legend>
				<div className="flex flex-wrap gap-2">
					{RECOMMENDATIONS.map((r) => (
						<button
							key={r.value}
							type="button"
							aria-pressed={recommendation === r.value}
							onClick={() => setRecommendation(r.value)}
							className={cn(
								"rounded-full px-3.5 py-1.5 type-label ring-1 ring-inset transition-colors",
								recommendation === r.value
									? "bg-accent text-accent-foreground ring-primary/30"
									: "text-muted-foreground ring-border hover:bg-muted",
							)}
						>
							{r.label}
						</button>
					))}
				</div>
			</fieldset>
			{language && !levelQuestion && (
				<fieldset className="space-y-3">
					<legend className="type-label text-muted-foreground">Level you heard</legend>
					<LevelPicker level={level} onPick={setLevel} />
				</fieldset>
			)}
			{!reference && (
				<div className="flex flex-wrap items-center justify-between gap-3">
					<NoShow gig={gig} />
					<ReportFake onReport={(reason) => callApi.report(gig.id, reason)} />
				</div>
			)}
			{!reference && recording?.status !== "done" && (
				<p className="type-label text-muted-foreground">
					Not recorded, so these answers are self-reported. The agent will ask the candidate to confirm.
				</p>
			)}
			{deliver.isError && <p className="text-destructive">{errorMessage(deliver.error)}</p>}
			<Button type="submit" size="lg" className="h-12 w-full" disabled={!complete || deliver.busy}>
				{deliver.busy && <Loader2 className="animate-spin" />}
				Send to the agent
			</Button>
			{!complete && (
				<p className="text-center type-label text-muted-foreground">Add {listOf(todo)} to send.</p>
			)}
		</form>
	);
}

/** A full Google Meet, Zoom or Teams link (the notetaker can't join anything else). */
const MEETING_LINK =
	/^(https?:\/\/)?(meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}|([\w-]+\.)?zoom\.us\/(j|my)\/\S+|teams\.(microsoft|live)\.com\/\S+)/i;

const ACTIVE = new Set(["joining", "waiting_room", "in_call", "recording", "processing"]);

/** "Record this call": paste the meeting link, a notetaker joins and records; answers come back pre-filled. */
function Notetaker({ gigId, onDone }: { gigId: string; onDone: (view: RecordingView) => void }) {
	const [url, setUrl] = useState("");
	const [started, setStarted] = useState(false);
	const meetingOk = MEETING_LINK.test(url.trim());
	const recording = useRecording(gigId, true);
	const view = recording.data;
	const delivered = useRef(false);
	useEffect(() => {
		if (view?.status === "done" && !delivered.current) {
			delivered.current = true;
			onDone(view);
		}
	}, [view, onDone]);
	const invite = useMutation({
		mutationFn: () => gigApi.inviteNotetaker(gigId, url.trim()),
		onSuccess: () => {
			setStarted(true);
			void recording.refetch();
		},
	});
	const stop = useMutation({
		mutationFn: () => gigApi.stopNotetaker(gigId),
		onSuccess: () => void recording.refetch(),
	});

	if (view?.status === "failed")
		return (
			<p className="rounded-3xl bg-muted p-4 text-muted-foreground">
				The notetaker couldn't record this call. You can still fill in the answers yourself.
			</p>
		);
	if (view && ACTIVE.has(view.status))
		return (
			<div className="flex items-center gap-3 rounded-3xl bg-accent p-4 text-accent-foreground">
				{view.status === "recording" ? (
					<span className="size-2.5 animate-pulse rounded-full bg-destructive" aria-hidden />
				) : (
					<Loader2 className="size-4 animate-spin" />
				)}
				<span className="flex-1">{view.statusText}</span>
				{view.status !== "processing" && (
					<button
						type="button"
						onClick={() => stop.mutate()}
						className="type-label underline-offset-4 hover:underline"
						disabled={stop.isPending}
					>
						Stop
					</button>
				)}
			</div>
		);
	if (view?.status === "done")
		return view.lines ? (
			<Disclosure label="Transcript">
				<ol className="max-h-80 space-y-2 overflow-y-auto rounded-3xl bg-muted p-4">
					{view.lines.map((l) => (
						<li key={`${l.startSec}-${l.speaker}`}>
							<span className="type-label text-muted-foreground">{l.speaker} </span>
							{l.text}
						</li>
					))}
				</ol>
			</Disclosure>
		) : null;

	return (
		<div className="space-y-2 rounded-3xl bg-card p-4 ring-1 ring-foreground/5">
			<p className="flex items-center gap-2">
				<Mic className="size-4 text-primary" /> Record this call
			</p>
			<div className="flex flex-col gap-2 sm:flex-row">
				<Input
					value={url}
					onChange={(e) => setUrl(e.target.value)}
					placeholder="Paste the Google Meet, Zoom or Teams link"
					aria-label="Meeting link"
					className="h-11"
				/>
				<Button type="button" onClick={() => invite.mutate()} disabled={!meetingOk || invite.isPending}>
					{invite.isPending && <Loader2 className="animate-spin" />}
					Invite notetaker
				</Button>
			</div>
			{invite.isError ? (
				<p className="type-label text-destructive">{notetakerError(invite.error)}</p>
			) : (
				!started && (
					<p className="type-label text-muted-foreground">
						{url.trim() && !meetingOk
							? "Paste the full meeting link, e.g. meet.google.com/abc-defg-hij."
							: "The notetaker records the call and fills in the answers for you. Optional."}
					</p>
				)
			)}
		</div>
	);
}

function notetakerError(e: unknown) {
	const code = appCodeOf(e);
	if (code === "UNSUPPORTED_MEETING") return "Paste a Google Meet, Zoom or Teams link.";
	if (code === "RECALL_NOT_CONFIGURED")
		return "The notetaker isn't available right now. Fill in the answers yourself.";
	if (code === "RECORDING_DONE") return "This call is already recorded.";
	return errorMessage(e);
}

/** After sending: the agent reviews within seconds; the payout panel (app shell) shows when it accepts. */
function Checking({
	deliverableId,
	gig,
	onAgain,
}: {
	deliverableId: string;
	gig: GigView;
	onAgain: () => void;
}) {
	const work = useMyWork();
	const detail = useWork(deliverableId);
	const mine = work.data?.find((d) => d.id === deliverableId);
	const status = mine?.status ?? "PENDING";
	const confirm = status === "PENDING" ? mine?.confirmation : null;
	const who = mine?.deliverable.type === "SOURCING" ? firstName(mine.deliverable.name) : "the candidate";
	const asks = status === "PENDING" && (mine?.followUps ?? []).some((f) => !f.answer);
	const deposit = mine ? depositStatusLine(mine) : null;
	const review = mine?.review?.candidateReview ?? null;

	return (
		<div className="mx-auto flex max-w-xl flex-col items-center gap-6 py-20 text-center">
			{confirm && mine ? (
				<>
					<h1 className="type-display">Send this link to {who}</h1>
					<p className="max-w-md text-muted-foreground">
						The agent likes this profile. You get paid when {who} confirms they are open to a conversation.
					</p>
					<SendLink
						d={mine}
						person={who}
						role={{
							title: gig.post?.title ?? gig.roleTitle,
							company: gig.post?.companyDescriptor ?? gig.companyName,
						}}
					/>
				</>
			) : asks && mine ? (
				<>
					<h1 className="type-display">The agent has a question for you</h1>
					<p className="max-w-md text-muted-foreground">
						Answer below. The agent decides with your answer, or asks the company.
					</p>
				</>
			) : status === "PENDING" &&
				mine?.deliverable.type === "SCREENING_CALL" &&
				mine.deliverable.evidence === "self-reported" ? (
				<>
					<Loader2 className="size-6 animate-spin text-primary" />
					<h1 className="type-display">
						Waiting for {gig.candidate?.name ? firstName(gig.candidate.name) : "the candidate"} to confirm the
						call
					</h1>
					<p className="max-w-md text-muted-foreground">
						The call wasn't recorded, so the agent asks the candidate whether it happened. Then it checks your
						notes.
					</p>
				</>
			) : status === "PENDING" && mine?.review?.verdict === "ESCALATE" ? (
				<>
					<h1 className="type-display">The company is deciding</h1>
					<p className="max-w-md text-muted-foreground">{escalationLine(mine)}</p>
				</>
			) : status === "PENDING" ? (
				<>
					<Loader2 className="size-6 animate-spin text-primary" />
					<h1 className="type-display">The agent is checking your work</h1>
					<p className="text-muted-foreground">
						Usually within a minute. Until it starts, you can still edit or take it back from your work.
					</p>
				</>
			) : status === "ACCEPTED" ? (
				<>
					<h1 className="type-display">Accepted</h1>
					<p className="text-muted-foreground">
						{mine?.payout && BigInt(mine.payout.now) > 0n
							? `${formatMoney(mine.payout.now)} is on its way to you.`
							: "Payment is on its way to you."}
						{deposit && ` ${deposit}`}
					</p>
				</>
			) : mine && candidateOutcome(mine) ? (
				<>
					<h1 className="type-display">{candidateOutcome(mine)}</h1>
					<p className="max-w-md text-muted-foreground">
						{/didn't answer/.test(candidateOutcome(mine) ?? "")
							? `${who} didn't answer in time, so this profile isn't paid. It doesn't affect your record.`
							: `That's ${who}'s answer, not a judgement of your work. It doesn't affect your record.`}
					</p>
					{deposit && <p className="type-label text-muted-foreground">{deposit}</p>}
				</>
			) : (
				<>
					<h1 className="type-display">Not accepted</h1>
					{review ? (
						<WhyNotAccepted review={review} criteria={detail.data?.criteria ?? null} />
					) : (
						<p className="max-w-md text-muted-foreground">
							{mine?.review?.reasons[0] || "The agent couldn't use this one."}
						</p>
					)}
					{deposit && <p className="type-label text-muted-foreground">{deposit}</p>}
					{mine && <Appeal d={mine} align="start" showReasons={false} />}
				</>
			)}
			{mine && <FollowUps d={mine} />}
			<div className="flex flex-wrap justify-center gap-3">
				{mine && (
					<Link
						to="/scout/work/$deliverableId"
						params={{ deliverableId: mine.id }}
						className={buttonVariants({ variant: "outline" })}
					>
						See your work
					</Link>
				)}
				{status !== "PENDING" && (gig.type === "SOURCING" || status === "REJECTED") ? (
					<Button onClick={onAgain}>{gig.type === "SOURCING" ? "Send another" : "Fix and resend"}</Button>
				) : (
					<Link to="/scout" className={buttonVariants()}>
						Back to gigs
					</Link>
				)}
			</div>
		</div>
	);
}
