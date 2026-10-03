/**
 * Meeting notetaker for screening / reference gigs (Recall.ai). The recruiter pastes the meeting link after taking
 * the gig; a bot joins, records and transcribes; the agent pre-fills the answers from the transcript.
 */
import { z } from "zod";
import { RecruiterRecommendation, ScriptAnswer } from "./gigs.ts";

/** joining → waiting_room → in_call → recording → processing (call ended, transcript being made) → done | failed. */
export const RecordingStatus = z.enum([
	"joining",
	"waiting_room",
	"in_call",
	"recording",
	"processing",
	"done",
	"failed",
]);
export type RecordingStatus = z.infer<typeof RecordingStatus>;

export const TranscriptLine = z.object({
	speaker: z.string(),
	text: z.string(),
	/** Seconds from the start of the recording. */
	startSec: z.number(),
});
export type TranscriptLine = z.infer<typeof TranscriptLine>;

/** Answers the agent extracted from the transcript. The recruiter reviews and edits them before delivering. */
export const RecordingPrefill = z.object({
	answers: z.array(ScriptAnswer),
	recommendation: RecruiterRecommendation,
	/** Script questions the call didn't cover. */
	missing: z.array(z.string()),
});
export type RecordingPrefill = z.infer<typeof RecordingPrefill>;

export const RecordingView = z.object({
	gigId: z.string(),
	status: RecordingStatus,
	meetingUrl: z.string(),
	/** Human sentence for the UI ("The notetaker is waiting to be let in"). */
	statusText: z.string(),
	failureReason: z.string().nullable(),
	/** Plain-text transcript ("Speaker: text" per line), once done. Goes into the deliverable as `transcript`. */
	transcript: z.string().nullable(),
	lines: z.array(TranscriptLine).nullable(),
	/** hex sha256 of `transcript`; the deliverable's on-chain evidence_hash. */
	transcriptHash: z.string().nullable(),
	prefill: RecordingPrefill.nullable(),
	updatedAt: z.string(),
});
export type RecordingView = z.infer<typeof RecordingView>;

export const RecallInviteRequest = z.object({ gigId: z.string(), meetingUrl: z.string().url() });
export const RecallStatusRequest = z.object({ gigId: z.string() });
