import type { RoleStatusView } from "@scout/shared";
import { useState } from "react";
import { useNow } from "@/components/bits";
import { useWaitingAction } from "@/lib/gigs/actions";
import type { ThreadActivity } from "@/lib/gigs/schemas";
import { plain } from "@/lib/plain";
import { cn } from "@/lib/utils";

/** "12 s", "4 min", "2 h", "3 d" */
export function since(ms: number) {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s} s`;
	const m = Math.round(s / 60);
	if (m < 60) return `${m} min`;
	const h = Math.round(m / 60);
	return h < 48 ? `${h} h` : `${Math.round(h / 24)} d`;
}

/**
 * The agent is never silently busy: right after Hanna writes, or while it works, one shimmering line says what
 * it is doing and for how long.
 */
export function Thinking({ items, status }: { items: ThreadActivity[]; status: RoleStatusView | undefined }) {
	const now = useNow(1000);
	const last = items.at(-1);
	const awaitingReply = last?.kind === "COMPANY_MESSAGE";
	const busy = status?.now.busy;
	if (!awaitingReply && !busy) return null;
	const text = plain(awaitingReply ? "Thinking" : (status?.now.detail ?? status?.now.text ?? "Working"));
	const from = Date.parse(
		(awaitingReply ? last?.createdAt : (status?.now.startedAt ?? status?.now.since)) ??
			new Date().toISOString(),
	);
	return (
		<p className="px-2 py-1 type-label text-muted-foreground" aria-live="polite">
			<span className="shimmer">{text}…</span> <span className="tabular">{since(now - from)}</span>
		</p>
	);
}

/**
 * Everyone the agent is waiting for (not the company), each with how long it has been, whether that is slow,
 * and the one-click fixes the API offers for it.
 */
export function WaitingList({ roleId, status }: { roleId: string; status: RoleStatusView | undefined }) {
	const now = useNow(30_000);
	const run = useWaitingAction(roleId);
	const list = (status?.waitingOn ?? []).filter((w) => w.who !== "company");
	if (!list.length) return null;
	return (
		<ul className="space-y-1 px-2 pb-1">
			{list.map((w) => {
				const waited = now - Date.parse(w.since);
				const left = w.deadline ? Date.parse(w.deadline) - now : null;
				const due = w.expectedBy ? Date.parse(w.expectedBy) - now : null;
				return (
					<li key={w.what} className="type-label text-muted-foreground">
						<span className={cn(w.slow && "text-warning-foreground")}>
							Waiting for {lower(plain(w.what))}
						</span>
						{left !== null
							? ` · ${left > 0 ? `${since(left)} left` : "time is up"}`
							: waited > 60_000
								? ` · ${since(waited)} so far`
								: ""}
						{w.slow
							? " · slower than usual"
							: left === null && due !== null && due > 0
								? ` · usually within ${since(due)}`
								: ""}
						<span className="mt-0.5 flex flex-wrap gap-x-3 sm:mt-0 sm:inline">
							{(w.actions ?? []).map((action) => (
								<button
									key={`${action.id}-${action.criterionId ?? action.gigId ?? ""}`}
									type="button"
									disabled={run.isPending}
									onClick={() => run.mutate({ action })}
									className="text-foreground underline-offset-4 hover:underline disabled:opacity-50 sm:ml-2"
								>
									{run.isPending && run.variables?.action === action ? "…" : action.label}
								</button>
							))}
						</span>
					</li>
				);
			})}
		</ul>
	);
}

/** "Recruiters to …" → "recruiters to …"; names stay capitalised. */
const lower = (s: string) =>
	/^(Recruiters|A recruiter|The)\b/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s;

const ORIENTATION_KEY = (roleId: string) => `scout.orientation.${roleId}`;

/** Shown once on a fresh role: what happens next and how long it usually takes. */
export function WhatHappensNext({ roleId, started }: { roleId: string; started: boolean }) {
	const [open, setOpen] = useState(() => {
		try {
			return localStorage.getItem(ORIENTATION_KEY(roleId)) !== "seen";
		} catch {
			return true;
		}
	});
	if (!open || started) return null;
	const close = () => {
		setOpen(false);
		try {
			localStorage.setItem(ORIENTATION_KEY(roleId), "seen");
		} catch {}
	};
	return (
		<section className="my-4 space-y-3 rounded-3xl bg-card p-5 ring-1 ring-foreground/10 animate-in fade-in">
			<div className="flex items-baseline justify-between">
				<p>What happens next</p>
				<button
					type="button"
					onClick={close}
					className="type-label text-muted-foreground hover:text-foreground"
				>
					Got it
				</button>
			</div>
			<ol className="space-y-2 type-label text-muted-foreground">
				{[
					["Recruiters find profiles", "first ones usually within a day"],
					["Candidates confirm they're interested", "you pay only then, usually within hours"],
					["Recruiters run screening calls", "notes checked by your agent, 1–3 days"],
					["You get a shortlist to decide on", "usually 5–10 days from now"],
				].map(([what, when], i) => (
					<li key={what} className="flex gap-3">
						<span className="tabular">{i + 1}</span>
						<span>
							<span className="text-foreground">{what}</span> · {when}
						</span>
					</li>
				))}
			</ol>
		</section>
	);
}

/** One line under the header: what to expect next, from where the pipeline is. */
export function nextLine(p: RoleStatusView["pipeline"] | undefined): string | null {
	if (!p) return null;
	if (p.shortlisted > 0) return "Next: your decision on the shortlist";
	if (p.referenceDone > 0) return "Next: shortlist, usually within a day";
	if (p.screeningDone > 0) return "Next: reference check, usually 1–2 days";
	if (p.confirmed > 0) return "Next: screening calls, notes usually within 1–3 days";
	if (p.sourcingAccepted > 0) return "Next: candidates confirm interest, usually within hours";
	return "Next: first profiles usually within a day";
}
