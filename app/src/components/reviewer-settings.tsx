import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ReviewerChoice, validReviewer } from "@/components/reviewer";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/errors";
import { type ReviewerModeValue, reviewApi, useReviewer } from "@/lib/gigs/review";
import { useTransact } from "@/lib/use-transact";

/** Change who checks the work on a live role. */
export function ReviewerSettings({ roleId }: { roleId: string }) {
	const current = useReviewer(roleId);
	const qc = useQueryClient();
	const { transact, pending } = useTransact();
	const [mode, setMode] = useState<ReviewerModeValue>("scout");
	const [key, setKey] = useState("");
	useEffect(() => {
		if (!current.data) return;
		setMode(current.data.mode);
		setKey(current.data.agentPubkey ?? "");
	}, [current.data]);
	const changed =
		!!current.data &&
		(mode !== current.data.mode || (mode === "custom" && key.trim() !== current.data.agentPubkey));
	const save = useMutation({
		mutationFn: async () => {
			const { unsignedTx } = await reviewApi.setReviewer(roleId, mode, key.trim());
			await transact(unsignedTx, { pending: "Saving…", success: "Saved." });
			await qc.invalidateQueries({ queryKey: ["roles"] });
		},
		onError: (e) => toast.error(errorMessage(e)),
	});
	if (!current.data) return null;
	return (
		<div className="space-y-3">
			<ReviewerChoice
				mode={mode}
				agentKey={key}
				onChange={(m, k) => {
					setMode(m);
					setKey(k);
				}}
			/>
			{changed && (
				<Button
					onClick={() => save.mutate()}
					disabled={!validReviewer(mode, key) || save.isPending || pending}
				>
					{(save.isPending || pending) && <Loader2 className="animate-spin" />}
					Save
				</Button>
			)}
			<p className="type-label text-muted-foreground">
				Payout rules are enforced automatically, not by RentRecruiter. You can change who checks the work any time.
			</p>
		</div>
	);
}
