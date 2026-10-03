/** Meeting notetaker for screening / reference gigs. Mounted in appRouter as `recall`. */
import { RecallInviteRequest, RecallStatusRequest, RecordingView } from "@scout/shared";
import { invite, status, stop } from "../../recall/service.ts";
import { publicProcedure, router, walletProcedure } from "../init.ts";

export const recallRouter = router({
	/** Claimant only: send the notetaker to the meeting link. Idempotent while a recording is in progress. */
	invite: walletProcedure
		.input(RecallInviteRequest)
		.output(RecordingView)
		.mutation(({ ctx, input }) => invite(ctx.wallet, input)),
	/** Claimant or the role's company. null until the notetaker was invited. */
	status: publicProcedure
		.input(RecallStatusRequest)
		.output(RecordingView.nullable())
		.query(({ ctx, input }) => status(ctx.wallet, input.gigId)),
	/** Claimant: make the notetaker leave now (the transcript is produced as usual). */
	stop: walletProcedure
		.input(RecallStatusRequest)
		.output(RecordingView)
		.mutation(({ ctx, input }) => stop(ctx.wallet, input.gigId)),
});
