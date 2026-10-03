import type { SubmissionView } from "@scout/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useTRPCClient } from "./trpc";

const passed = (iso: string | null | undefined) => !!iso && new Date(iso).getTime() <= Date.now();

/** Pending past its review window: the recruiter is paid automatically. */
export const isTimedOut = (s: SubmissionView) => s.status === "PENDING" && passed(s.reviewDeadline);

/**
 * Anything the rules say must be paid once time runs out (unanswered candidates, held-back parts)
 * is triggered quietly by whoever has the page open, so nobody has to press a button.
 */
export function useAutoRelease(subs: SubmissionView[] | undefined) {
	const qc = useQueryClient();
	const client = useTRPCClient();
	const tried = useRef(new Set<string>());
	useEffect(() => {
		const run = () => {
			for (const s of subs ?? []) {
				const settle = isTimedOut(s);
				const release =
					s.status === "ACCEPTED" && s.payout?.laterStatus === "HELD" && passed(s.payout.laterReleasesAt);
				const key = `${s.id}:${settle ? "settle" : "release"}`;
				if ((!settle && !release) || tried.current.has(key)) continue;
				tried.current.add(key);
				(settle ? client.submissions.settle : client.submissions.release)
					.mutate({ id: s.id })
					.catch(() => setTimeout(() => tried.current.delete(key), 15_000))
					.finally(() => void qc.invalidateQueries());
			}
		};
		run();
		const t = setInterval(run, 3000);
		return () => clearInterval(t);
	}, [subs, qc, client]);
}
