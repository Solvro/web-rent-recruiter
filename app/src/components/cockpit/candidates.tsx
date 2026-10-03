import type { Criteria } from "@scout/shared";
import { ArrowUpRight, Loader2 } from "lucide-react";
import { createContext, type ReactNode, useContext, useMemo, useState } from "react";
import { toast } from "sonner";
import { Disclosure } from "@/components/bits";
import { ReportFake } from "@/components/call-tools";
import { WhyThisScore } from "@/components/criteria";
import { Avatar } from "@/components/person";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "@/lib/errors";
import { formatMoney } from "@/lib/format";
import { callApi } from "@/lib/gigs/calls";
import {
	type CallDetail,
	type CandidateDetail,
	type CandidateRow,
	STAGE_LABEL,
	useCandidate,
	useCandidateAction,
	useCandidateNotes,
	useCandidates,
} from "@/lib/gigs/candidates";
import { inCents } from "@/lib/payout";
import { plain } from "@/lib/plain";
import { useTransact } from "@/lib/use-transact";
import { cn } from "@/lib/utils";

type Ctx = { open: (candidateId?: string) => void; byName: Map<string, string>; count: number };
const CandidatesContext = createContext<Ctx>({ open: () => {}, byName: new Map(), count: 0 });
export const useCandidatesPanel = () => useContext(CandidatesContext);

/**
 * Every candidate on the role, reachable from anywhere in the cockpit: the header opens the list, any candidate
 * name (log, cards) opens their page.
 */
export function CandidatesProvider({
	roleId,
	criteria,
	children,
}: {
	roleId: string;
	criteria: Criteria;
	children: ReactNode;
}) {
	const list = useCandidates(roleId);
	const [state, setState] = useState<{ open: boolean; id: string | null }>({ open: false, id: null });
	const byName = useMemo(() => new Map((list.data ?? []).map((c) => [c.name, c.candidateId])), [list.data]);
	const value = useMemo<Ctx>(
		() => ({ open: (id) => setState({ open: true, id: id ?? null }), byName, count: list.data?.length ?? 0 }),
		[byName, list.data?.length],
	);
	return (
		<CandidatesContext.Provider value={value}>
			{children}
			<Dialog open={state.open} onOpenChange={(open) => setState((s) => ({ ...s, open }))}>
				<DialogContent className="top-0 right-0 left-auto h-svh max-h-svh w-full max-w-[min(600px,100vw)] translate-x-0 translate-y-0 grid-cols-[minmax(0,1fr)] content-start overflow-y-auto rounded-none p-6 sm:max-w-[600px] sm:rounded-l-4xl">
					{state.id ? (
						<Detail
							roleId={roleId}
							id={state.id}
							criteria={criteria}
							onBack={() => setState({ open: true, id: null })}
						/>
					) : (
						<List
							rows={list.data ?? []}
							loading={list.isPending}
							onOpen={(id) => setState({ open: true, id })}
						/>
					)}
				</DialogContent>
			</Dialog>
		</CandidatesContext.Provider>
	);
}

/** Wraps known candidate names in a text with links to their page. */
export function WithCandidateLinks({ text }: { text: string }) {
	const { byName, open } = useCandidatesPanel();
	const names = [...byName.keys()].sort((a, b) => b.length - a.length);
	if (!names.length) return <>{text}</>;
	const re = new RegExp(`(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "g");
	return (
		<>
			{text.split(re).map((part, i) =>
				byName.has(part) ? (
					<button
						// biome-ignore lint/suspicious/noArrayIndexKey: parts of one fixed string
						key={i}
						type="button"
						onClick={(e) => {
							e.stopPropagation();
							open(byName.get(part));
						}}
						className="underline decoration-border underline-offset-4 hover:text-primary hover:decoration-primary"
					>
						{part}
					</button>
				) : (
					part
				),
			)}
		</>
	);
}

function ProfileLink({ url }: { url: string }) {
	return (
		<a
			href={url}
			target="_blank"
			rel="noreferrer"
			onClick={(e) => e.stopPropagation()}
			className="inline-flex shrink-0 items-center gap-0.5 type-label text-muted-foreground hover:text-foreground"
		>
			Profile <ArrowUpRight className="size-3" />
		</a>
	);
}

const titleOf = (c: Pick<CandidateRow, "currentTitle" | "currentCompany">) =>
	[c.currentTitle, c.currentCompany].filter(Boolean).join(" at ") || null;

function List({
	rows,
	loading,
	onOpen,
}: {
	rows: CandidateRow[];
	loading: boolean;
	onOpen: (id: string) => void;
}) {
	return (
		<div className="space-y-4">
			<DialogTitle>Candidates</DialogTitle>
			{loading ? (
				<Loader2 className="size-5 animate-spin text-muted-foreground" />
			) : !rows.length ? (
				<p className="text-muted-foreground">
					No candidates yet. Profiles appear here as recruiters send them.
				</p>
			) : (
				<ul className="divide-y">
					{rows.map((c) => (
						<li key={c.candidateId} className="flex items-center gap-3 py-3">
							<button
								type="button"
								onClick={() => onOpen(c.candidateId)}
								className="flex min-w-0 flex-1 items-center gap-3 text-left hover:text-primary"
							>
								<Avatar name={c.name} src={c.avatarUrl} size="sm" />
								<span className="min-w-0 flex-1">
									<span className="flex items-baseline gap-2">
										<span className="min-w-0 truncate">{c.name}</span>
										{c.score !== null && (
											<span className="shrink-0 type-label tabular text-muted-foreground">fit {c.score}</span>
										)}
									</span>
									<span
										className={cn(
											"block truncate type-label",
											c.stage === "PASSED" || c.stage === "REJECTED"
												? "text-muted-foreground"
												: "text-foreground",
										)}
									>
										{STAGE_LABEL[c.stage]}
										<span className="text-muted-foreground"> · sourced by {c.sourcedBy.displayName}</span>
									</span>
									{titleOf(c) && (
										<span className="block truncate type-label text-muted-foreground">{titleOf(c)}</span>
									)}
								</span>
							</button>
							<ProfileLink url={c.profileUrl} />
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="space-y-2 border-t pt-4">
			<p className="type-label text-muted-foreground">{title}</p>
			{children}
		</section>
	);
}

function Detail({
	roleId,
	id,
	criteria,
	onBack,
}: {
	roleId: string;
	id: string;
	criteria: Criteria;
	onBack: () => void;
}) {
	const c = useCandidate(roleId, id);
	if (c.isPending) return <Loader2 className="size-5 animate-spin text-muted-foreground" />;
	if (c.isError || !c.data) return <p className="text-muted-foreground">Couldn't load this candidate.</p>;
	const d = c.data;
	return (
		<div className="space-y-5">
			<button
				type="button"
				onClick={onBack}
				className="type-label text-muted-foreground hover:text-foreground"
			>
				← All candidates
			</button>
			<div className="flex items-start gap-4">
				<Avatar name={d.name} src={d.avatarUrl} size="lg" />
				<div className="min-w-0 flex-1 space-y-1">
					<DialogTitle>{d.name}</DialogTitle>
					<p className="type-label text-muted-foreground">
						{[titleOf(d), d.location].filter(Boolean).join(" · ")}
					</p>
					<p className="type-label">
						{STAGE_LABEL[d.stage]}
						{d.score !== null && <span className="text-muted-foreground"> · fit {d.score}</span>}
						<span className="text-muted-foreground"> · sourced by {d.sourcedBy.displayName}</span>
					</p>
					<ProfileLink url={d.profileUrl} />
				</div>
			</div>
			<Actions roleId={roleId} d={d} />
			<Notes roleId={roleId} d={d} />
			<Section title={`${d.sourcedBy.displayName}'s note`}>
				<p>{d.recruiterNote}</p>
			</Section>
			{d.review && (
				<Section title={`Why the agent scored ${d.review.score}`}>
					<p>{plain(d.review.summary)}</p>
					<WhyThisScore review={d.review} criteria={criteria} />
				</Section>
			)}
			{(d.confirmation || d.candidateAnswers) && (
				<Section title="From the candidate">
					<p>
						{d.confirmation?.status === "YES"
							? "Said yes to a conversation"
							: d.confirmation?.status === "NO"
								? "Not interested right now"
								: d.confirmation?.status === "EXPIRED"
									? "Didn't answer in time"
									: "Hasn't answered yet"}
					</p>
					{d.candidateAnswers?.availability && (
						<p className="type-label text-muted-foreground">Available: {d.candidateAnswers.availability}</p>
					)}
					{d.candidateAnswers?.salaryExpectation && (
						<p className="type-label text-muted-foreground">
							Expects: {d.candidateAnswers.salaryExpectation}
						</p>
					)}
				</Section>
			)}
			{d.followUps.length > 0 && (
				<Section title="The agent asked the recruiter">
					<FollowUpList list={d.followUps} />
				</Section>
			)}
			{d.calls.map((call) => (
				<CallSection key={call.deliverableId} call={call} />
			))}
			{d.payments.length > 0 && (
				<Section title="Payments">
					<ul className="space-y-1 type-label">
						{d.payments.map((p) => (
							<li key={p.deliverableId} className="flex justify-between gap-3">
								<span>
									{p.recruiter} · {KIND_WORD[p.kind]}
								</span>
								<span className="tabular text-muted-foreground">
									{formatMoney(inCents(p.now, p.later).now)} paid
									{BigInt(p.later) > 0n &&
										` · ${formatMoney(inCents(p.now, p.later).later)} ${p.laterStatus === "HELD" ? "held" : p.laterStatus.toLowerCase()}`}
								</span>
							</li>
						))}
					</ul>
				</Section>
			)}
		</div>
	);
}

const KIND_WORD = {
	sourcing: "found and confirmed",
	screening: "screening call",
	language: "language check",
	reference: "reference check",
	show_up_fee: "interview show-up",
} as const;

function FollowUpList({ list }: { list: CandidateDetail["followUps"] }) {
	return (
		<ul className="space-y-2">
			{list.map((f) => (
				<li key={f.askedAt}>
					<p className="type-label text-muted-foreground">{f.question}</p>
					<p>{f.answer ?? "No answer yet"}</p>
				</li>
			))}
		</ul>
	);
}

const CALL_TITLE = {
	screening: "Screening call",
	language: "Language check",
	reference: "Reference check",
} as const;

function checkWord(c: CallDetail["questions"][number]["check"]) {
	if (!c) return null;
	if (c.missing) return { word: "Missing", tone: "text-warning-foreground" };
	if (c.contradiction) return { word: "Contradicts the profile", tone: "text-destructive" };
	if (c.generic) return { word: "Too generic", tone: "text-warning-foreground" };
	return { word: "Answered", tone: "text-success" };
}

function CallSection({ call }: { call: CallDetail }) {
	const [query, setQuery] = useState("");
	const lines = (call.transcript ?? []).filter(
		(l) => !query.trim() || l.text.toLowerCase().includes(query.trim().toLowerCase()),
	);
	const evidence =
		call.evidence === "recording"
			? `recorded${call.integrity ? `, ${Math.round(call.integrity.durationSeconds / 60)} min` : ""}`
			: call.evidence === "self-reported"
				? `self-reported${call.confirmation?.status === "YES" ? ", confirmed by the candidate" : call.confirmation?.status === "NO" ? ", the candidate says no call" : call.confirmation?.status === "PENDING" ? ", waiting for the candidate to confirm" : ""}`
				: null;
	return (
		<Section title={`${CALL_TITLE[call.kind]} · ${call.recruiter.displayName}`}>
			<p className="type-label">
				{call.status === "PENDING"
					? "Being checked"
					: call.status === "ACCEPTED"
						? "Accepted"
						: "Not accepted"}
				{call.score !== null && <span className="text-muted-foreground"> · notes {call.score}</span>}
				{call.candidateFit != null && (
					<span className="text-muted-foreground"> · fit {call.candidateFit}</span>
				)}
				{call.assessedLevel && (
					<span className="ml-1 rounded-full bg-accent px-2 py-0.5 text-accent-foreground">
						{call.assessedLevel}
					</span>
				)}
				{call.recommendation && (
					<span className="text-muted-foreground">
						{" "}
						· recruiter's call:{" "}
						{call.recommendation === "ADVANCE"
							? "move forward"
							: call.recommendation === "MAYBE"
								? "not sure"
								: "not a fit"}
					</span>
				)}
				{evidence && <span className="text-muted-foreground"> · {evidence}</span>}
			</p>
			{call.summary && <p className="text-muted-foreground">{plain(call.summary)}</p>}
			{call.referee && (
				<p className="type-label text-muted-foreground">
					Spoke with {call.referee.name} · {call.referee.relation}
				</p>
			)}
			<ol className="space-y-3">
				{call.questions.map((q, i) => {
					const check = checkWord(q.check);
					return (
						<li key={q.id} className="space-y-0.5">
							<p className="type-label text-muted-foreground">
								<span className="tabular">{i + 1}.</span> {q.question}
							</p>
							<p>{q.answer || "–"}</p>
							{check && <p className={cn("type-label", check.tone)}>{check.word}</p>}
						</li>
					);
				})}
			</ol>
			{call.followUps.length > 0 && <FollowUpList list={call.followUps} />}
			{call.recordingUrl && (
				// biome-ignore lint/a11y/useMediaCaption: the transcript below is the caption
				<video controls src={call.recordingUrl} className="w-full rounded-2xl" />
			)}
			{call.transcript && (
				<Disclosure label={`Transcript · ${call.transcript.length} turns`}>
					<div className="space-y-2">
						<Input
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							placeholder="Search the transcript"
							aria-label="Search the transcript"
							className="h-9"
						/>
						<ol className="max-h-80 space-y-2 overflow-y-auto rounded-2xl bg-muted p-3">
							{lines.map((l) => (
								<li key={`${l.startSec}-${l.speaker}`}>
									<span className="type-label text-muted-foreground">
										{Math.floor(l.startSec / 60)}:{String(Math.floor(l.startSec % 60)).padStart(2, "0")}{" "}
										{l.speaker}{" "}
									</span>
									{l.text}
								</li>
							))}
						</ol>
					</div>
				</Disclosure>
			)}
		</Section>
	);
}

function Actions({ roleId, d }: { roleId: string; d: CandidateDetail }) {
	const act = useCandidateAction(d.candidateId);
	const { transact } = useTransact();
	const run = (action: "accept" | "pass" | "remove") =>
		act.mutate(action, { onError: (e) => toast.error(errorMessage(e)) });
	const closed = d.stage === "PASSED" || d.stage === "REJECTED";
	const pending = d.stage === "REVIEWING" || d.stage === "CONFIRMING";
	return (
		<div className="flex flex-wrap items-center gap-2">
			{(closed || pending) && (
				<Button size="sm" onClick={() => run("accept")} disabled={act.isPending}>
					{act.isPending && act.variables === "accept" && <Loader2 className="animate-spin" />}
					{closed ? "Take anyway" : "Accept"}
				</Button>
			)}
			{!closed && d.stage !== "ATTENDED" && (
				<Button size="sm" variant="ghost" onClick={() => run("pass")} disabled={act.isPending}>
					Pass
				</Button>
			)}
			{!d.removed && (
				<Button size="sm" variant="ghost" onClick={() => run("remove")} disabled={act.isPending}>
					Remove
				</Button>
			)}
			<span className="ml-auto">
				<ReportFake
					label="Report a problem"
					onReport={async (why) => {
						const res = await callApi.reportCandidate(roleId, d.candidateId, why);
						if (res.unsignedTx)
							await transact(res.unsignedTx, { pending: "Reporting…", success: "Reported." });
					}}
				/>
			</span>
		</div>
	);
}

function Notes({ roleId, d }: { roleId: string; d: CandidateDetail }) {
	const [text, setText] = useState("");
	const { add, remove } = useCandidateNotes(roleId, d.candidateId);
	return (
		<div className="space-y-2">
			{d.notes.map((n) => (
				<div key={n.id} className="flex items-start gap-2 rounded-2xl bg-muted px-3 py-2">
					<p className="flex-1">{n.text}</p>
					<button
						type="button"
						onClick={() => remove.mutate(n.id)}
						className="type-label text-muted-foreground hover:text-destructive"
					>
						Delete
					</button>
				</div>
			))}
			<Textarea
				value={text}
				onChange={(e) => setText(e.target.value)}
				placeholder="Private note (only your team sees it)"
				aria-label="Private note"
				className="min-h-14 rounded-2xl p-3"
			/>
			{text.trim() && (
				<Button
					size="sm"
					variant="outline"
					onClick={() => add.mutate(text.trim(), { onSuccess: () => setText("") })}
					disabled={add.isPending}
				>
					{add.isPending && <Loader2 className="animate-spin" />}
					Add note
				</Button>
			)}
		</div>
	);
}
