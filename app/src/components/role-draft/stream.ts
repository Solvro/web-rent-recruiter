/**
 * The agent reading a job description, as a stream of partial drafts.
 *
 * Live: the `draft.stream` subscription (model output field by field). If it isn't available (mock mode, or a
 * backend without it) the hook falls back to `roles.draft` and replays the finished draft at a reading pace, so
 * the page behaves the same either way.
 */
import { type Criteria, type DraftRoleResponse, DraftStreamEvent } from "@scout/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { API_MOCK } from "@/lib/env";
import { errorMessage } from "@/lib/errors";
import { typedClient, untypedClient } from "@/lib/trpc";

export type PartialDraft = {
	title?: string;
	summary?: string;
	criteria?: Partial<Omit<Criteria, "location" | "salaryRange">> & {
		location?: Partial<Criteria["location"]>;
		salaryRange?: Partial<NonNullable<Criteria["salaryRange"]>> | null;
	};
};

export type DraftStreamState = {
	phase: "idle" | "reading" | "done" | "error";
	status: string;
	partial: PartialDraft;
	result: DraftRoleResponse | null;
	error: string | null;
};

const IDLE: DraftStreamState = { phase: "idle", status: "", partial: {}, result: null, error: null };

/** How long to wait for the live stream's first event before falling back. */
const FIRST_EVENT_MS = 2500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The finished draft as the same sequence of partials the server would stream. */
function replaySteps(d: DraftRoleResponse): { status: string; partial: PartialDraft }[] {
	const c = d.criteria;
	const steps: { status: string; partial: PartialDraft }[] = [];
	const push = (status: string, criteria?: PartialDraft["criteria"], summary = true) =>
		steps.push({ status, partial: { title: d.title, ...(summary ? { summary: d.summary } : {}), criteria } });
	push("Reading the role…", undefined, false);
	push("Reading the role…");
	for (let i = 1; i <= c.mustHave.length; i++)
		push("Reading requirements…", { mustHave: c.mustHave.slice(0, i) });
	for (let i = 1; i <= c.niceToHave.length; i++)
		push("Noting nice-to-haves…", { mustHave: c.mustHave, niceToHave: c.niceToHave.slice(0, i) });
	const base = { mustHave: c.mustHave, niceToHave: c.niceToHave, seniority: c.seniority };
	push("Checking location…", { ...base, location: c.location });
	push("Checking the salary range…", { ...base, location: c.location, salaryRange: c.salaryRange });
	push("Checking languages…", {
		...base,
		location: c.location,
		salaryRange: c.salaryRange,
		languages: c.languages,
	});
	for (let i = 1; i <= c.dealBreakers.length; i++)
		push("Looking for deal-breakers…", { ...c, dealBreakers: c.dealBreakers.slice(0, i) });
	return steps;
}

export function useDraftStream() {
	const [state, setState] = useState<DraftStreamState>(IDLE);
	const run = useRef(0);
	const unsubscribe = useRef<(() => void) | null>(null);

	const stop = useCallback(() => {
		run.current++;
		unsubscribe.current?.();
		unsubscribe.current = null;
	}, []);
	useEffect(() => stop, [stop]);

	const fallback = useCallback(async (id: number, jobDescription: string) => {
		try {
			const draft = await typedClient.roles.draft.mutate({ jobDescription });
			for (const step of replaySteps(draft)) {
				if (run.current !== id) return;
				setState((s) => ({ ...s, status: step.status, partial: step.partial }));
				await sleep(140);
			}
			if (run.current !== id) return;
			setState((s) => ({ ...s, phase: "done", status: "Pricing the work…", result: draft }));
		} catch (error) {
			if (run.current === id) setState((s) => ({ ...s, phase: "error", error: errorMessage(error) }));
		}
	}, []);

	const start = useCallback(
		(jobDescription: string) => {
			stop();
			const id = run.current;
			setState({ ...IDLE, phase: "reading", status: "Reading the job description…" });

			let alive = false;
			let fellBack = false;
			const goFallback = () => {
				if (fellBack || run.current !== id) return;
				fellBack = true;
				unsubscribe.current?.();
				unsubscribe.current = null;
				void fallback(id, jobDescription);
			};
			// Mock data has no stream to wait for.
			if (API_MOCK) {
				goFallback();
				return;
			}
			const timer = setTimeout(() => !alive && goFallback(), FIRST_EVENT_MS);

			try {
				const sub = untypedClient.subscription(
					"draft.stream",
					{ jobDescription },
					{
						onData: (raw: unknown) => {
							if (run.current !== id || fellBack) return;
							alive = true;
							const event = DraftStreamEvent.safeParse(raw);
							if (!event.success) return;
							const e = event.data;
							if (e.type === "status") setState((s) => ({ ...s, status: e.text }));
							else if (e.type === "partial") setState((s) => ({ ...s, partial: e.draft as PartialDraft }));
							else {
								setState((s) => ({
									...s,
									phase: "done",
									result: e.response,
									partial: e.response,
								}));
								clearTimeout(timer);
								unsubscribe.current?.();
								unsubscribe.current = null;
							}
						},
						onError: () => {
							clearTimeout(timer);
							goFallback();
						},
					},
				);
				unsubscribe.current = () => sub.unsubscribe();
			} catch {
				clearTimeout(timer);
				goFallback();
			}
		},
		[fallback, stop],
	);

	const reset = useCallback(() => {
		stop();
		setState(IDLE);
	}, [stop]);

	/** A draft saved before a reload: back to the finished post, no new run. */
	const restore = useCallback((draft: DraftRoleResponse) => {
		setState({ ...IDLE, phase: "done", status: "", partial: draft, result: draft });
	}, []);

	return { ...state, start, reset, restore };
}
