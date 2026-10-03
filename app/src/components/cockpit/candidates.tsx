import { ArrowUpRight, Loader2 } from "lucide-react";
import { createContext, type ReactNode, useContext, useMemo, useState } from "react";
import { toast } from "sonner";
import { Disclosure } from "@/components/bits";
import { ReportFake } from "@/components/call-tools";
import { Avatar } from "@/components/person";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "@/lib/errors";
import { formatMoney } from "@/lib/format";
import { callApi } from "@/lib/gigs/calls";
import {
	type CandidateCall,
	type CandidateDetail,
	type RoleCandidate,
	STAGE_LABEL,
	useCandidate,
	useCandidateAction,
	useCandidateNote,
	useCandidates,
} from "@/lib/gigs/candidates";
import { cn } from "@/lib/utils";

type Ctx = { open: (candidateId?: string) => void; byName: Map<string, string>; count: number };
const CandidatesContext = createContext<Ctx>({ open: () => {}, byName: new Map(), count: 0 });
export const useCandidatesPanel = () => useContext(CandidatesContext);

/**
 * Every candidate on the role, reachable from anywhere in the cockpit: the progress line opens the list, any
 * candidate name opens their page.
 */
export function CandidatesProvider({ roleId, children }: { roleId: string; children: ReactNode }) {
	const list = useCandidates(roleId);
	const [state, setState] = useState<{ open: boolean; id: string | null }>({ open: false, id: null });
	const byName = useMemo(() => new Map((list.data ?? []).map((c) => [c.name, c.id])), [list.data]);
	const value = useMemo<Ctx>(
		() => ({ open: (id) => setState({ open: true, id: id ?? null }), byName, count: list.data?.length ?? 0 }),
		[byName, list.data?.length],
	);
	return (
		<CandidatesContext.Provider value={value}>
			{children}
			<Dialog open={state.open} onOpenChange={(open) => setState((s) => ({ ...s, open }))}>
				<DialogContent className="top-0 right-0 left-auto h-svh max-h-svh w-full max-w-[min(600px,100vw)] translate-x-0 translate-y-0 content-start overflow-y-auto rounded-none rounded-l-4xl p-6 sm:max-w-[600px]">
					{state.id ? (
						<Detail roleId={roleId} id={state.id} onBack={() => setState({ open: true, id: null })} />
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

/** Wraps known candidate names in a message with links to their page. */
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

function List({
	rows,
	loading,
	onOpen,
}: {
	rows: RoleCandidate[];
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
						<li key={c.id}>
							<button
								type="button"
								onClick={() => onOpen(c.id)}
								className="flex w-full items-center gap-3 py-3 text-left hover:bg-muted/50"
							>
								<Avatar name={c.name} src={c.avatarUrl} size="sm" />
								<span className="min-w-0 flex-1">
									<span className="block truncate">{c.name}</span>
									<span className="block truncate type-label text-muted-foreground">
										{[c.title, `sourced by ${c.sourcedBy.displayName}`].filter(Boolean).join(" · ")}
									</span>
								</span>
								<span className="shrink-0 text-right">
									<span
										className={cn(
											"block type-label",
											c.stage === "PASSED" ? "text-muted-foreground" : "text-foreground",
										)}
									>
										{STAGE_LABEL[c.stage]}
									</span>
									<span className="block type-label tabular text-muted-foreground">{c.score ?? "–"}</span>
								</span>
								<ProfileLink url={c.profileUrl} />
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

const VERDICT: Record<string, { word: string; tone: string }> = {
	MET: { word: "Meets", tone: "text-success" },
	PARTIAL: { word: "Partly", tone: "text-warning-foreground" },
	NOT_MET: { word: "Doesn't meet", tone: "text-destructive" },
	UNKNOWN: { word: "Unclear", tone: "text-muted-foreground" },
};

function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="space-y-2 border-t pt-4">
			<p className="type-label text-muted-foreground">{title}</p>
			{children}
		</section>
	);
}

function Detail({ roleId, id, onBack }: { roleId: string; id: string; onBack: () => void }) {
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
						{[d.title, d.location].filter(Boolean).join(" · ")}
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
			<CompanyNote roleId={roleId} d={d} />
			<Section title={`${d.sourcedBy.displayName}'s note`}>
				<p>{d.note}</p>
			</Section>
			<Section title="Your agent's check">
				{d.summary && <p>{d.summary}</p>}
				<ul className="space-y-1.5">
					{d.verdicts.map((v) => (
						<li key={v.label} className="type-label">
							<span className={VERDICT[v.verdict]?.tone}>{VERDICT[v.verdict]?.word}</span>{" "}
							<span className="text-foreground">{v.label}</span>
							<span className="block text-muted-foreground">{v.reasoning}</span>
						</li>
					))}
				</ul>
			</Section>
			{d.confirmation && (
				<Section title="Candidate's answer">
					<p>
						{d.confirmation.status === "YES"
							? "Said yes to a conversation"
							: d.confirmation.status === "NO"
								? "Not interested right now"
								: d.confirmation.status === "EXPIRED"
									? "Didn't answer in time"
									: "Hasn't answered yet"}
					</p>
				</Section>
			)}
			{d.calls.map((call) => (
				<CallSection key={call.deliverableId} call={call} />
			))}
			{d.payments.length > 0 && (
				<Section title="Payments">
					<ul className="space-y-1 type-label">
						{d.payments.map((p, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: payments have no id
							<li key={i} className="flex justify-between gap-3">
								<span>
									{p.to} · {p.what}
								</span>
								<span className="tabular text-muted-foreground">
									{formatMoney(p.amount)} {p.status === "PAID" ? "paid" : p.status.toLowerCase()}
								</span>
							</li>
						))}
					</ul>
				</Section>
			)}
		</div>
	);
}

const CALL_TITLE = {
	SCREENING: "Screening call",
	LANGUAGE: "Language check",
	REFERENCE: "Reference check",
} as const;
const CHECK = {
	ok: { word: "Answered", tone: "text-success" },
	missing: { word: "Missing", tone: "text-warning-foreground" },
	contradicts: { word: "Contradicts the profile", tone: "text-destructive" },
} as const;

function CallSection({ call }: { call: CandidateCall }) {
	const [query, setQuery] = useState("");
	const lines = (call.transcript ?? []).filter(
		(l) => !query.trim() || l.text.toLowerCase().includes(query.trim().toLowerCase()),
	);
	return (
		<Section title={`${CALL_TITLE[call.kind]} · ${call.recruiter}`}>
			<p className="type-label">
				{call.status === "PENDING"
					? "Being checked"
					: call.status === "ACCEPTED"
						? "Accepted"
						: "Not accepted"}
				{call.score !== null && <span className="text-muted-foreground"> · {call.score}</span>}
				{call.level && <span className="text-muted-foreground"> · level {call.level}</span>}
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
				<span className="text-muted-foreground">
					{" "}
					·{" "}
					{call.evidence === "recording"
						? "recorded"
						: call.evidence === "self-reported"
							? `self-reported${call.callConfirmed === "YES" ? ", confirmed by the candidate" : call.callConfirmed === "NO" ? ", candidate says no call" : ", waiting for the candidate to confirm"}`
							: "notes"}
				</span>
			</p>
			{call.referee && <p className="type-label text-muted-foreground">Spoke with {call.referee}</p>}
			<ol className="space-y-3">
				{call.items.map((item, i) => (
					<li key={item.question} className="space-y-0.5">
						<p className="type-label text-muted-foreground">
							<span className="tabular">{i + 1}.</span> {item.question}
						</p>
						<p>{item.answer || "–"}</p>
						<p className={cn("type-label", CHECK[item.check].tone)}>{CHECK[item.check].word}</p>
					</li>
				))}
			</ol>
			{call.recordingUrl && (
				// biome-ignore lint/a11y/useMediaCaption: the transcript below is the caption
				<audio controls src={call.recordingUrl} className="w-full" />
			)}
			{call.transcript && (
				<Disclosure label={`Transcript · ${call.transcript.length} lines`}>
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
	const act = useCandidateAction(roleId, d.id);
	const [reasonFor, setReasonFor] = useState<"pass" | "remove" | null>(null);
	const [reason, setReason] = useState("");
	const run = (action: "accept" | "pass" | "shortlist" | "remove", why?: string) =>
		act.mutate(
			{ action, reason: why },
			{
				onSuccess: () => {
					setReasonFor(null);
					setReason("");
				},
				onError: (e) => toast.error(errorMessage(e)),
			},
		);
	const passed = d.stage === "PASSED";
	const shortlisted = d.stage === "SHORTLISTED";
	return (
		<div className="space-y-2">
			<div className="flex flex-wrap items-center gap-2">
				{(passed || d.stage === "PROFILE") && (
					<Button size="sm" onClick={() => run("accept")} disabled={act.isPending}>
						{passed ? "Take anyway" : "Accept"}
					</Button>
				)}
				{!shortlisted && !passed && d.stage !== "PROFILE" && (
					<Button size="sm" onClick={() => run("shortlist")} disabled={act.isPending}>
						Move to shortlist
					</Button>
				)}
				{!passed && (
					<Button size="sm" variant="ghost" onClick={() => setReasonFor("pass")} disabled={act.isPending}>
						Pass
					</Button>
				)}
				<Button size="sm" variant="ghost" onClick={() => setReasonFor("remove")} disabled={act.isPending}>
					Remove
				</Button>
				<span className="ml-auto">
					<ReportFake label="Report a problem" onReport={(r) => callApi.reportCandidate(roleId, d.id, r)} />
				</span>
			</div>
			{reasonFor && (
				<div className="flex gap-2">
					<Input
						value={reason}
						onChange={(e) => setReason(e.target.value)}
						placeholder={
							reasonFor === "pass" ? "Why? The recruiter sees this." : "Why remove them? (optional)"
						}
						aria-label="Reason"
						className="h-9"
						autoFocus
					/>
					<Button
						size="sm"
						variant="outline"
						onClick={() => run(reasonFor, reason.trim())}
						disabled={act.isPending}
					>
						{act.isPending && <Loader2 className="animate-spin" />}
						{reasonFor === "pass" ? "Pass" : "Remove"}
					</Button>
				</div>
			)}
		</div>
	);
}

function CompanyNote({ roleId, d }: { roleId: string; d: CandidateDetail }) {
	const [text, setText] = useState(d.companyNote ?? "");
	const save = useCandidateNote(roleId, d.id);
	const dirty = text !== (d.companyNote ?? "");
	return (
		<div className="space-y-1.5">
			<Textarea
				value={text}
				onChange={(e) => setText(e.target.value)}
				placeholder="Private note (only your team sees it)"
				aria-label="Private note"
				className="min-h-16 rounded-2xl p-3"
			/>
			{dirty && (
				<Button size="sm" variant="outline" onClick={() => save.mutate(text)} disabled={save.isPending}>
					{save.isPending && <Loader2 className="animate-spin" />}
					Save note
				</Button>
			)}
		</div>
	);
}
