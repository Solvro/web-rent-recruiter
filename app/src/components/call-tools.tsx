import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { useNow } from "@/components/bits";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "@/lib/errors";
import { firstName } from "@/lib/format";
import { callApi, callStateOf, zoneOf } from "@/lib/gigs/calls";
import type { GigView } from "@/lib/gigs/schemas";

const time = (zone: string, now: number) =>
	new Date(now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone: zone });
const zoneName = (zone: string) =>
	new Intl.DateTimeFormat("en", { timeZone: zone, timeZoneName: "short" })
		.formatToParts(new Date())
		.find((p) => p.type === "timeZoneName")?.value ?? zone;

/** Book the call in the candidate's time: both clocks side by side, so 4 pm doesn't become 3 pm by mistake. */
export function BookingTimes({ gig }: { gig: GigView }) {
	const now = useNow(30_000);
	const place = gig.candidate?.card?.location ?? gig.candidate?.summary.city ?? gig.city;
	const theirs = zoneOf(place);
	const mine = Intl.DateTimeFormat().resolvedOptions().timeZone;
	if (!theirs) return null;
	const who = gig.candidate?.name ? firstName(gig.candidate.name) : "The candidate";
	const same = time(theirs, now) === time(mine, now);
	return (
		<p className="type-label text-muted-foreground">
			{who} is in {place?.split(",")[0]} · {time(theirs, now)} {zoneName(theirs)} now
			{same ? " · same time as you" : ` · ${time(mine, now)} for you (${zoneName(mine)})`}. Send the invite in
			their time.
		</p>
	);
}

/** "Candidate didn't join": the first time the agent reschedules once; the second time it stops the screening. */
export function NoShow({ gig }: { gig: GigView }) {
	const qc = useQueryClient();
	const { noShows } = callStateOf(gig);
	const who = gig.candidate?.name ? firstName(gig.candidate.name) : "The candidate";
	const report = useMutation({
		mutationFn: () => callApi.noShow(gig.id),
		onSuccess: () => void qc.invalidateQueries({ queryKey: ["gigs"] }),
	});
	if (noShows >= 1)
		return (
			<div className="space-y-2 rounded-3xl bg-muted p-4">
				<p>{who} didn't join · rescheduling once</p>
				<p className="type-label text-muted-foreground">
					You have 24 more hours. If {who} misses it again, tell us here; the gig closes and nothing counts
					against you.
				</p>
				<Button size="sm" variant="outline" onClick={() => report.mutate()} disabled={report.isPending}>
					{report.isPending && <Loader2 className="animate-spin" />}
					{who} missed it again
				</Button>
			</div>
		);
	return (
		<button
			type="button"
			onClick={() => report.mutate()}
			disabled={report.isPending}
			className="type-label text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
		>
			{report.isPending ? "Saving…" : `${who} didn't join the call`}
		</button>
	);
}

/** Something is off about the candidate (wrong face, scripted answers, can't verify). */
export function ReportFake({
	label = "Report fake candidate",
	onReport,
}: {
	label?: string;
	onReport: (reason: string) => Promise<unknown>;
}) {
	const qc = useQueryClient();
	const [open, setOpen] = useState(false);
	const [reason, setReason] = useState("");
	const send = useMutation({
		mutationFn: () => onReport(reason.trim()),
		onSuccess: () => {
			setOpen(false);
			void qc.invalidateQueries();
		},
	});
	return (
		<>
			<button
				type="button"
				onClick={() => setOpen(true)}
				className="type-label text-muted-foreground underline-offset-4 hover:text-destructive hover:underline"
			>
				{label}
			</button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent className="gap-4 p-6">
					<DialogTitle>{label}</DialogTitle>
					<p className="text-muted-foreground">
						The agent stops work on this candidate and looks into it. Say what you noticed.
					</p>
					<Textarea
						value={reason}
						onChange={(e) => setReason(e.target.value)}
						placeholder="e.g. camera off the whole call, answers read from a script, profile photo doesn't match"
						aria-label="What you noticed"
						className="min-h-24 rounded-2xl p-3"
					/>
					{send.isError && <p className="type-label text-destructive">{errorMessage(send.error)}</p>}
					<DialogFooter>
						<Button
							variant="destructive"
							onClick={() => send.mutate()}
							disabled={reason.trim().length < 5 || send.isPending}
						>
							{send.isPending && <Loader2 className="animate-spin" />}
							Report
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
