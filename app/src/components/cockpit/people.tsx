/**
 * The people: the outcome the company pays for, right under the header. One row per active candidate with how far
 * they got (a compact step track), the ones that dropped out folded into one line. Click opens the drawer.
 */
import type { Criteria, RoleStatusView } from "@scout/shared";
import { useState } from "react";
import { Avatar } from "@/components/person";
import { firstName } from "@/lib/format";
import { type CandidateRow, useCandidate, useCandidates } from "@/lib/gigs/candidates";
import { plain } from "@/lib/plain";
import { cn } from "@/lib/utils";
import { requiredLanguage } from "../../../../backend/src/agent/gigs/language";
import { useCandidatesPanel } from "./candidates";

const OUT = new Set(["REJECTED", "PASSED"]);
const CALL_KINDS = ["screening", "language", "reference"] as const;
type CallKind = (typeof CALL_KINDS)[number];
type StepState = "done" | "now" | "next" | "failed";
type Step = { label: string; state: StepState; note?: string };

const isActive = (c: CandidateRow) => !OUT.has(c.stage) && !c.removed;

/** Who is furthest along first: that's the person the company is waiting to meet. */
const RANK: Record<string, number> = {
	ATTENDED: 0,
	INVITED: 1,
	SHORTLISTED: 2,
	IN_CALLS: 3,
	ACCEPTED: 4,
	CONFIRMING: 5,
	REVIEWING: 6,
};

export function activeCandidates(rows: CandidateRow[] | undefined) {
	return (rows ?? []).filter(isActive).sort((a, b) => (RANK[a.stage] ?? 9) - (RANK[b.stage] ?? 9));
}

/**
 * One sentence for "where are we", from the people first (that's what the company is paying for), then from
 * what the agent says it is doing.
 */
export function headline(
	status: RoleStatusView | undefined,
	rows: CandidateRow[] | undefined,
	opts: { closed: boolean; pending: number },
): { text: string; tone: "primary" | "plain" } {
	if (opts.closed) return { text: "This role is closed", tone: "plain" };
	if (opts.pending > 0 || status?.waitingOn.some((w) => w.who === "company"))
		return { text: "Waiting for your decision", tone: "primary" };
	const active = activeCandidates(rows);
	const names = (stage: string) => active.filter((c) => c.stage === stage).map((c) => firstName(c.name));
	const list = (n: string[]) =>
		n.length > 2 ? `${n.slice(0, 2).join(", ")} and ${n.length - 2} more` : n.join(" and ");
	if (names("ATTENDED").length)
		return { text: `${list(names("ATTENDED"))} came to the interview`, tone: "plain" };
	if (names("INVITED").length)
		return { text: `${list(names("INVITED"))} invited to interview`, tone: "plain" };
	if (names("SHORTLISTED").length)
		return { text: `Shortlist ready: ${list(names("SHORTLISTED"))}`, tone: "plain" };
	if (names("IN_CALLS").length) return { text: `${list(names("IN_CALLS"))} in the checks`, tone: "plain" };
	if (names("ACCEPTED").length)
		return { text: `${list(names("ACCEPTED"))} lined up for a screening call`, tone: "plain" };
	if (names("CONFIRMING").length)
		return { text: `Waiting for ${list(names("CONFIRMING"))} to say yes`, tone: "plain" };
	// Nobody in progress: the agent's own line can lag behind a decision ("Shortlist ready" after a pass).
	if (rows && (rows.some((c) => !isActive(c)) || /shortlist|interview/i.test(status?.now.text ?? "")))
		return { text: "Looking for more candidates", tone: "plain" };
	if (status) return { text: plain(status.now.text), tone: "plain" };
	return { text: "Getting ready", tone: "plain" };
}

export function People({ roleId, criteria }: { roleId: string; criteria: Criteria }) {
	const list = useCandidates(roleId);
	const { open } = useCandidatesPanel();
	const [showAll, setShowAll] = useState(false);
	if (!list.data) return null;
	const active = activeCandidates(list.data);
	const out = list.data.filter((c) => !isActive(c));
	const withLanguage = !!requiredLanguage(criteria);
	const visible = showAll ? active : active.slice(0, 3);
	return (
		<section aria-label="Candidates" className="space-y-1 pb-2">
			<div className="flex items-baseline justify-between px-2">
				<h2 className="type-label text-muted-foreground">Candidates</h2>
				{out.length > 0 && (
					<button
						type="button"
						onClick={() => open()}
						className="type-label text-muted-foreground hover:text-foreground"
					>
						{out.length} passed
					</button>
				)}
			</div>
			{active.length === 0 ? (
				<p className="px-2 py-2 type-label text-muted-foreground">
					{out.length
						? "No one in progress right now. Recruiters are looking for more."
						: "No one yet. Recruiters are looking; each profile shows up here."}
				</p>
			) : (
				<ul className="space-y-0.5">
					{visible.map((c) => (
						<PersonRow key={c.candidateId} roleId={roleId} c={c} withLanguage={withLanguage} onOpen={open} />
					))}
				</ul>
			)}
			{active.length > 3 && (
				<button
					type="button"
					onClick={() => setShowAll((s) => !s)}
					className="px-2 type-label text-muted-foreground hover:text-foreground"
				>
					{showAll ? "Show fewer" : `and ${active.length - 3} more`}
				</button>
			)}
		</section>
	);
}

function PersonRow({
	roleId,
	c,
	withLanguage,
	onOpen,
}: {
	roleId: string;
	c: CandidateRow;
	withLanguage: boolean;
	onOpen: (id: string) => void;
}) {
	// The calls (screening, language, reference) only exist once someone is past confirming.
	const past = c.stage !== "REVIEWING" && c.stage !== "CONFIRMING";
	const detail = useCandidate(roleId, past ? c.candidateId : null);
	const steps = stepsFor(c, detail.data?.calls ?? [], withLanguage);
	return (
		<li className="cockpit-row">
			<button
				type="button"
				onClick={() => onOpen(c.candidateId)}
				className="flex w-full items-center gap-3 rounded-2xl px-2 py-2 text-left transition-[background-color,transform] duration-150 ease-out hover:bg-muted active:scale-[0.99]"
			>
				<Avatar name={c.name} src={c.avatarUrl} size="sm" />
				<span className="min-w-0 flex-1">
					<span className="flex items-baseline gap-2">
						<span className="truncate">{c.name}</span>
						{c.score !== null && (
							<span className="shrink-0 type-label tabular text-muted-foreground">fit {c.score}</span>
						)}
					</span>
					{/* Phone: where they are in one line. Wider: the whole track. */}
					<StepSummary steps={steps} />
					<StepTrack steps={steps} />
				</span>
			</button>
		</li>
	);
}

function StepSummary({ steps }: { steps: Step[] }) {
	const done = steps.filter((s) => s.state === "done").length;
	const now = steps.find((s) => s.state === "now");
	return (
		<span className="block truncate type-label text-muted-foreground sm:hidden">
			{done} of {steps.length} done
			{now && (
				<span className="text-primary">
					{" "}
					· {now.label}
					{now.note ? `: ${now.note}` : " …"}
				</span>
			)}
		</span>
	);
}

function StepTrack({ steps }: { steps: Step[] }) {
	return (
		<span className="hidden flex-wrap items-baseline gap-x-1.5 type-label sm:flex">
			{steps.map((s, i) => (
				<span key={s.label} className="inline-flex items-baseline gap-1.5">
					{i > 0 && <span className="text-muted-foreground/50">·</span>}
					<span
						className={cn(
							"transition-colors duration-300",
							s.state === "done" && "text-foreground",
							s.state === "now" && "text-primary",
							s.state === "failed" && "text-muted-foreground line-through",
							s.state === "next" && "text-muted-foreground/60",
						)}
					>
						{s.label}
						{s.state === "done" && (
							<>
								{" "}
								<span className="step-done">✓</span>
							</>
						)}
						{s.state === "now" && <span className="text-primary/70">{s.note ? ` ${s.note}` : " …"}</span>}
					</span>
				</span>
			))}
		</span>
	);
}

type Call = { kind: CallKind; status: "PENDING" | "ACCEPTED" | "REJECTED" };

function stepsFor(c: CandidateRow, calls: Call[], withLanguage: boolean): Step[] {
	const steps: Step[] = [];
	if (c.stage === "REVIEWING") return [{ label: "Your call on the profile", state: "now", note: "" }];
	steps.push({
		label: "Confirmed",
		state: c.stage === "CONFIRMING" ? "now" : "done",
		note: c.stage === "CONFIRMING" ? "waiting for their yes" : undefined,
	});
	const kinds: [CallKind, string][] = [
		["screening", "Screening"],
		...(withLanguage ? ([["language", "Language"]] as [CallKind, string][]) : []),
		["reference", "Reference"],
	];
	const late = ["SHORTLISTED", "INVITED", "ATTENDED"].includes(c.stage);
	let current = c.stage !== "CONFIRMING";
	for (const [kind, label] of kinds) {
		const mine = calls.filter((x) => x.kind === kind);
		const accepted = mine.some((x) => x.status === "ACCEPTED");
		const pending = mine.some((x) => x.status === "PENDING");
		if (accepted || late) {
			steps.push({ label, state: "done" });
			continue;
		}
		if (current) {
			steps.push({ label, state: "now", note: pending ? "checking the notes" : undefined });
			current = false;
		} else steps.push({ label, state: "next" });
	}
	const interview: Step =
		c.stage === "ATTENDED"
			? { label: "Interview", state: "done" }
			: c.stage === "INVITED"
				? { label: "Interview", state: "now", note: "invited" }
				: c.stage === "SHORTLISTED"
					? { label: "Interview", state: "now", note: "your decision" }
					: { label: "Interview", state: "next" };
	steps.push(interview);
	return steps;
}
