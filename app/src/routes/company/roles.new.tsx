import type { Criteria, DraftRoleResponse, Me } from "@scout/shared";
import { DEMO_REVIEW_WINDOW_SECONDS, toBaseUnits } from "@scout/shared";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Loader2, Minus, Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { RequireAccount } from "@/components/account";
import { Disclosure } from "@/components/bits";
import { ReviewerChoice, validReviewer } from "@/components/reviewer";
import { Curtain } from "@/components/role-draft/curtain";
import { followInto, useFollow } from "@/components/role-draft/follow";
import { bestSentence, JdBackdrop, splitSentences } from "@/components/role-draft/jd-reader";
import { JobPost, type JobPostData } from "@/components/role-draft/job-post";
import { PlanView } from "@/components/role-draft/plan";
import { type FieldKey, useReveal } from "@/components/role-draft/reveal";
import { type PartialDraft, useDraftStream } from "@/components/role-draft/stream";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "@/lib/errors";
import { formatMoney } from "@/lib/format";
import { BUDGET_STEP_USD, DEFAULT_BUDGET_USD, planGigs } from "@/lib/gigs/plan";
import { type ReviewerModeValue, reviewApi } from "@/lib/gigs/review";
import { DEMO_JOB_DESCRIPTION } from "@/lib/mock/store";
import { useTRPCClient } from "@/lib/trpc";
import { useTransact } from "@/lib/use-transact";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/company/roles/new")({
	component: () => <RequireAccount kind="company">{(me) => <NewRole me={me} />}</RequireAccount>,
});

/** Short window so the "no answer → paid automatically" path is visible in the live demo. */
const REVIEW_WINDOW = DEMO_REVIEW_WINDOW_SECONDS;

function useReducedMotion() {
	const [reduced, setReduced] = useState(
		() => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
	);
	useEffect(() => {
		const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
		const on = () => setReduced(mq.matches);
		mq.addEventListener("change", on);
		return () => mq.removeEventListener("change", on);
	}, []);
	return reduced;
}

/** The draft in progress survives a reload (this tab only): the pasted text, the agent's draft, the edits. */
const SAVED_KEY = "scout.new-role.v1";
type Saved = {
	jd: string;
	result?: DraftRoleResponse | null;
	title?: string | null;
	company?: string | null;
	edits?: Partial<Criteria>;
	budgetUsd?: number;
};
function loadSaved(): Saved | null {
	try {
		return JSON.parse(sessionStorage.getItem(SAVED_KEY) ?? "null") as Saved | null;
	} catch {
		return null;
	}
}
function save(patch: Partial<Saved>) {
	try {
		sessionStorage.setItem(SAVED_KEY, JSON.stringify({ ...(loadSaved() ?? { jd: "" }), ...patch }));
	} catch {}
}
export const clearSavedDraft = () => {
	try {
		sessionStorage.removeItem(SAVED_KEY);
	} catch {}
};

function NewRole({ me }: { me: Me }) {
	const saved = useMemo(loadSaved, []);
	const [jd, setJdState] = useState(saved?.jd ?? "");
	const setJd = (v: string) => {
		setJdState(v);
		save({ jd: v, result: null });
	};
	const stream = useDraftStream();
	const restored = useRef(false);
	useEffect(() => {
		if (restored.current || !saved?.result || !saved.jd) return;
		restored.current = true;
		stream.restore(saved.result);
	}, [saved, stream.restore]);
	useEffect(() => {
		if (stream.phase === "done" && stream.result) save({ result: stream.result });
		if (stream.phase === "idle" && restored.current)
			save({ result: null, title: null, company: null, edits: {} });
	}, [stream.phase, stream.result]);

	if (stream.phase === "idle") {
		return (
			<div className="rd-page mx-auto max-w-2xl space-y-8">
				<h1 className="type-display">Who are you hiring?</h1>
				<Textarea
					value={jd}
					onChange={(e) => setJd(e.target.value)}
					placeholder="Paste the job description"
					aria-label="Job description"
					className="min-h-72 rounded-3xl p-5"
				/>
				<div className="flex items-center gap-4">
					<Button
						size="lg"
						className="h-12 px-8"
						onClick={() => stream.start(jd)}
						disabled={jd.trim().length < 50}
					>
						Next
					</Button>
					{!jd && DEMO_JOB_DESCRIPTION && (
						<button
							type="button"
							onClick={() => setJd(DEMO_JOB_DESCRIPTION)}
							className="type-label text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
						>
							Use an example
						</button>
					)}
				</div>
			</div>
		);
	}

	return <Drafting jd={jd} me={me} stream={stream} saved={restored.current ? saved : null} />;
}

/** The text a field came from, to find its sentence in the job description. */
function fieldText(key: FieldKey, p: PartialDraft): string {
	const c = p.criteria;
	const [kind, i] = key.split(":");
	const list = { must: c?.mustHave, nice: c?.niceToHave, deal: c?.dealBreakers }[kind];
	if (list) return list[Number(i)]?.label ?? "";
	switch (key) {
		case "title":
			return p.title ?? "";
		case "summary":
			return p.summary ?? "";
		case "seniority":
			return `${c?.seniority ?? ""} ${p.title ?? ""}`;
		case "location":
			return `${(c?.location?.places ?? []).join(" ")} ${c?.location?.mode ?? ""} office remote hybrid`;
		case "salary":
			return `${c?.salaryRange?.min ?? ""} ${c?.salaryRange?.max ?? ""} ${c?.salaryRange?.currency ?? ""} salary`;
		case "languages":
			return (c?.languages ?? []).join(" ");
		default:
			return "";
	}
}

function Drafting({
	jd,
	me,
	stream,
	saved,
}: {
	jd: string;
	me: Me;
	stream: ReturnType<typeof useDraftStream>;
	/** Restored after a reload: show the finished post right away, with the earlier edits. */
	saved: Saved | null;
}) {
	const reduced = useReducedMotion() || !!saved;
	const done = stream.phase === "done";
	const result = stream.result;
	const reveal = useReveal(result ?? stream.partial, done, reduced);

	// One page throughout. The pasted text sits where the post will be; the agent turns it into the post line by
	// line, the leftover text folds away, the plan lands under it, and the Start controls (already laid out with the
	// plan) fade in. Nothing is swapped, so nothing moves when the agent finishes.
	const [stage, setStage] = useState<"post" | "plan" | "edit">(saved ? "edit" : "post");
	const instant = reveal.skipped || reduced;
	useEffect(() => {
		if (stage !== "post" || !reveal.complete || !result) return;
		// Let the leftover text finish folding before the plan arrives below it.
		const t = setTimeout(() => setStage("plan"), instant ? 0 : 700);
		return () => clearTimeout(t);
	}, [stage, reveal.complete, instant, result]);
	useEffect(() => {
		if (stage !== "plan") return;
		const t = setTimeout(() => setStage("edit"), instant ? 0 : 1100);
		return () => clearTimeout(t);
	}, [stage, instant]);

	// The company's edits on top of the agent's draft.
	const [title, setTitle] = useState<string | null>(saved?.title ?? null);
	const [company, setCompany] = useState<string | null>(saved?.company ?? null);
	const [edits, setEdits] = useState<Partial<Criteria>>(saved?.edits ?? {});
	useEffect(() => save({ title, company, edits }), [title, company, edits]);
	const partial: PartialDraft = result
		? { ...result, title: title ?? result.title, criteria: { ...result.criteria, ...edits } }
		: stream.partial;
	const criteria: Criteria | null = result ? { ...result.criteria, ...edits } : null;

	// The pasted text, read along with the agent: before anything resolves a cursor reads through it; then the
	// sentence behind the next field is highlighted, and it's marked used once that field appears.
	const sentences = useMemo(() => splitSentences(jd).flat(), [jd]);
	const [cursor, setCursor] = useState(0);
	const [used, setUsed] = useState<Set<number>>(() => new Set());
	const reading = reveal.lastKey === null && !reveal.nextKey && stream.phase === "reading";
	useEffect(() => {
		if (!reading) return;
		const t = setInterval(() => setCursor((c) => Math.min(c + 1, sentences.length - 1)), 420);
		return () => clearInterval(t);
	}, [reading, sentences.length]);
	const nextText = reveal.nextKey ? fieldText(reveal.nextKey, partial) : "";
	const lastText = reveal.lastKey ? fieldText(reveal.lastKey, partial) : "";
	const next = nextText ? bestSentence(sentences, nextText) : -1;
	useEffect(() => {
		if (!lastText) return;
		const i = bestSentence(sentences, lastText);
		if (i >= 0) setUsed((u) => (u.has(i) ? u : new Set(u).add(i)));
	}, [lastText, sentences]);
	const active = next >= 0 ? next : reading ? cursor : -1;

	// Keep the newest field (then the plan, then the Start button) in view, unless the person scrolled back up.
	const column = useRef<HTMLDivElement>(null);
	const postRef = useRef<HTMLDivElement>(null);
	const backdropRef = useRef<HTMLDivElement>(null);
	const follow = useFollow(stage !== "edit");
	useEffect(() => {
		if (!follow.following) return;
		const target = stage === "edit" ? "start" : stage === "plan" ? "plan" : reveal.lastKey;
		if (!target) return;
		followInto(
			column.current?.querySelector(`[data-field="${target}"]`),
			reduced,
			stage === "post" ? 160 : 40,
		);
	}, [stage, reveal.lastKey, follow.following, reduced]);

	// Budget and start.
	const client = useTRPCClient();
	const navigate = useNavigate();
	const { transact, pending } = useTransact();
	const [budgetUsd, setBudgetUsd] = useState(saved?.budgetUsd ?? DEFAULT_BUDGET_USD);
	useEffect(() => save({ budgetUsd }), [budgetUsd]);
	const [reviewer, setReviewer] = useState<{ mode: ReviewerModeValue; key: string }>({
		mode: "scout",
		key: "",
	});
	const budget = toBaseUnits(budgetUsd);
	// The agent re-splits the work for every budget the company tries.
	const plan = criteria ? planGigs(criteria, budgetUsd) : null;
	const tooLittle = !!plan && !plan.gigs.some((g) => g.kind === "SCREENING_CALL");
	const tooMuch = budget > BigInt(me.usdcBalance);
	const start = useMutation({
		mutationFn: async () => {
			if (!result || !criteria) return;
			const res = await client.roles.create.mutate({
				title: title?.trim() || result.title,
				company: (company ?? result.company ?? undefined)?.trim() || undefined,
				summary: result.summary,
				jobDescription: jd,
				criteria,
				taskType: "SOURCING",
				reviewWindowSeconds: REVIEW_WINDOW,
				deposit: budget.toString(),
			});
			// The role exists now (funded or not): the draft has done its job.
			clearSavedDraft();
			const ok = await transact(res.unsignedTx, {
				pending: "Starting your agent…",
				success: `Your agent is on it. ${formatMoney(budget)} set aside.`,
				receipt: true,
			});
			// Signing failed or was abandoned: the role exists unfunded. Its page explains it and offers to add the
			// budget again, so there is never a dead draft.
			if (!ok) {
				navigate({ to: "/company/roles/$roleId", params: { roleId: res.roleId } });
				return;
			}
			// Someone other than the Scout agent checks the work: record it on the role right away.
			if (reviewer.mode !== "scout") {
				const set = await reviewApi.setReviewer(res.roleId, reviewer.mode, reviewer.key.trim());
				await transact(set.unsignedTx, {
					pending: "Saving who checks the work…",
					success: reviewer.mode === "self" ? "You check the work yourself." : "Your agent checks the work.",
				});
			}
			navigate({ to: "/company/roles/$roleId", params: { roleId: res.roleId } });
		},
	});

	if (stream.phase === "error") {
		return (
			<div className="mx-auto max-w-2xl space-y-6">
				<p>Your agent couldn't read this one. {stream.error}</p>
				<Button variant="outline" onClick={stream.reset}>
					Back to the job description
				</Button>
			</div>
		);
	}

	const c = partial.criteria;
	const post: JobPostData = {
		title: partial.title,
		// The posting's own company first; the account's name only when the posting doesn't say.
		company: company ?? result?.company ?? me.companyName ?? me.displayName,
		seniority: c?.seniority,
		location: c?.location,
		salary: c?.salaryRange,
		summary: partial.summary,
		mustHave: c?.mustHave,
		niceToHave: c?.niceToHave,
		dealBreakers: c?.dealBreakers,
		languages: c?.languages,
	};
	const editing = stage === "edit";
	const status =
		stage === "post"
			? stream.status || "Reading the job description…"
			: stage === "plan"
				? "Pricing the work…"
				: null;

	return (
		<div ref={column} className="rd-page mx-auto max-w-2xl">
			{/*
			 * Two different controls in two different places: "Skip" (right) only while the post is being written,
			 * "← Job description" (left) only once it is done. A double-click on Skip lands on empty space, never on
			 * the control that throws the draft away.
			 */}
			<div className="flex h-6 items-center justify-between gap-4">
				{status ? (
					<p className="type-label text-muted-foreground shimmer" aria-live="polite">
						{status}
					</p>
				) : (
					<EditJd onEdit={stream.reset} />
				)}
				{stage === "post" && (
					<button
						type="button"
						onClick={reveal.skip}
						className="type-label text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
					>
						Skip
					</button>
				)}
			</div>

			{/*
			 * The post is built over the pasted text, which stays exactly where it sat in the textarea: same width and
			 * left edge as the textarea's text box (1px border + 20px padding), and the same top (form: 36.8px heading +
			 * 32px gap + 21px; here: 24px status row + 40px margin, so 25.8px). The post layer defines the height; the
			 * backdrop is absolutely positioned and only ever changes colour/opacity.
			 */}
			<div className="rd-cover relative mt-10">
				<JdBackdrop
					ref={backdropRef}
					text={jd}
					active={stage === "post" ? active : -1}
					used={used}
					quiet={reveal.lastKey !== null}
					hidden={reveal.complete}
					className="absolute inset-x-[21px] top-[25.8px]"
				/>
				<Curtain post={postRef} backdrop={backdropRef} />
				<div ref={postRef} className="relative">
					<JobPost
						data={post}
						reveal={{ isShown: reveal.isShown, isPending: () => false }}
						edit={
							editing
								? {
										onTitle: setTitle,
										onCompany: setCompany,
										onCriteria: (patch) => setEdits((e) => ({ ...e, ...patch })),
									}
								: undefined
						}
					/>
				</div>
			</div>
			{editing && criteria && (result?.dropped?.length ?? 0) > 0 && (
				<LeftOut
					items={(result?.dropped ?? []).filter((d) => !criteria.niceToHave.some((c) => c.label === d))}
					onAdd={(label) =>
						setEdits((e) => ({
							...e,
							niceToHave: [
								...(e.niceToHave ?? criteria.niceToHave),
								{
									id: `added-${label
										.toLowerCase()
										.replace(/[^a-z0-9]+/g, "-")
										.slice(0, 40)}`,
									label,
									weight: 2,
								},
							],
						}))
					}
				/>
			)}

			{stage !== "post" && plan && (
				<section data-field="plan" className="space-y-4 pt-12">
					<h2 className="type-label text-muted-foreground">Your agent's plan</h2>
					<PlanView plan={plan} animate={!reduced} />

					{/* Laid out with the plan, usable once the agent is done: appears in place. */}
					<div
						data-field="start"
						inert={!editing}
						className={cn("space-y-6 pt-2 transition-opacity duration-300 ease-out", !editing && "opacity-0")}
					>
						<div className="flex flex-wrap items-center gap-4">
							<div className="inline-flex items-center gap-1 rounded-full bg-secondary p-1">
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label="Less budget"
									onClick={() => setBudgetUsd((b) => Math.max(BUDGET_STEP_USD * 2, b - BUDGET_STEP_USD))}
								>
									<Minus />
								</Button>
								<span className="w-28 text-center tabular">{formatMoney(budget)} budget</span>
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label="More budget"
									onClick={() => setBudgetUsd((b) => b + BUDGET_STEP_USD)}
								>
									<Plus />
								</Button>
							</div>
							<span className="type-label text-muted-foreground">Unused budget comes back to you.</span>
						</div>

						<div className="space-y-4">
							<Button
								size="lg"
								className="h-12 w-full sm:w-auto sm:px-10"
								disabled={
									tooMuch ||
									tooLittle ||
									!validReviewer(reviewer.mode, reviewer.key) ||
									start.isPending ||
									pending
								}
								onClick={() => start.mutate()}
							>
								{(start.isPending || pending) && <Loader2 className="animate-spin" />}
								Start agent · {formatMoney(budget)}
							</Button>
							{tooMuch ? (
								<p className="type-label text-destructive">
									That's more than the {formatMoney(me.usdcBalance)} you have. Lower the budget.
								</p>
							) : (
								<p className="type-label text-muted-foreground">
									You have {formatMoney(me.usdcBalance)} available.
								</p>
							)}
							{tooLittle && (
								<p className="type-label text-muted-foreground">
									Add budget so your agent can book at least one screening call.
								</p>
							)}
							{start.isError && <p className="type-label text-destructive">{errorMessage(start.error)}</p>}
							<Disclosure label="Change who checks the work">
								<ReviewerChoice
									mode={reviewer.mode}
									agentKey={reviewer.key}
									onChange={(mode, key) => setReviewer({ mode, key })}
								/>
							</Disclosure>
						</div>
					</div>
				</section>
			)}

			{!editing && !follow.following && (
				<div className="pointer-events-none fixed inset-x-0 bottom-6 z-20 flex justify-center">
					<button
						type="button"
						onClick={follow.resume}
						className="rd-in pointer-events-auto h-9 rounded-full bg-foreground px-4 type-label text-background shadow-sm"
					>
						Follow along ↓
					</button>
				</div>
			)}
		</div>
	);
}

/** Back to the job description. Ignores clicks for a moment after it appears, so no stray click lands on it. */
function EditJd({ onEdit }: { onEdit: () => void }) {
	const [armed, setArmed] = useState(false);
	useEffect(() => {
		const t = setTimeout(() => setArmed(true), 700);
		return () => clearTimeout(t);
	}, []);
	return (
		<button
			type="button"
			onClick={() => armed && onEdit()}
			aria-disabled={!armed}
			className="type-label text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
		>
			← Job description
		</button>
	);
}

/** Requirements from the posting the agent didn't keep: said out loud, one click to add back. */
function LeftOut({ items, onAdd }: { items: string[]; onAdd: (label: string) => void }) {
	if (!items.length) return null;
	return (
		<div className="mt-6 space-y-2 rounded-3xl bg-muted p-4">
			<p className="type-label text-muted-foreground">
				Left out of the requirements (too vague for the agent to check):
			</p>
			<ul className="flex flex-wrap gap-2">
				{items.map((label) => (
					<li key={label}>
						<button
							type="button"
							onClick={() => onAdd(label)}
							className="rounded-full bg-card px-3 py-1 type-label ring-1 ring-border hover:text-primary"
						>
							+ {label}
						</button>
					</li>
				))}
			</ul>
		</div>
	);
}
