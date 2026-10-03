import { TRPCClientError } from "@trpc/client";
import { z } from "zod";

type ErrorData = { appCode?: string; httpStatus?: number; details?: Record<string, unknown> };

/** The backend's errorFormatter puts appCode/details on every error (see backend/src/trpc/init.ts). */
export function errorData(e: unknown): ErrorData | null {
	return e instanceof TRPCClientError ? ((e.data ?? null) as ErrorData | null) : null;
}

export const appCodeOf = (e: unknown) => errorData(e)?.appCode ?? null;

const FRIENDLY: Record<string, string> = {
	REQUIREMENTS_NOT_MET: "This gig needs more experience than your account has yet.",
	REVIEW_WINDOW_EXPIRED: "Time to respond has passed, so this candidate is paid automatically.",
	ROLE_NOT_FUNDED: "This role isn't open yet.",
	INSUFFICIENT_FUNDS: "Not enough balance for this amount.",
	PENDING_SUBMISSIONS: "Decide on the candidates in review first.",
	NOT_PENDING: "This candidate was already decided.",
	UNAUTHORIZED: "Please log in again.",
	ROLE_FULL: "This role is full.",
	ROLE_NOT_OPEN: "This role is closed.",
	ALREADY_DECIDED: "This candidate was already decided.",
	OUTCOME_ALREADY_SET: "This was already confirmed.",
	HOLDBACK_WINDOW_EXPIRED: "It's too late to report a problem for this candidate.",
	HOLDBACK_WINDOW_OPEN: "The rest is paid automatically a little later.",
	NOTHING_HELD_BACK: "Everything for this candidate is already paid.",
	SCREENING_CALL: "Add your call notes.",
	DUPLICATE_CANDIDATE: "Another recruiter already submitted this person.",
	TOO_MANY_REQUESTS: "We're a little busy. Please try again in a moment.",
};
const TECHNICAL =
	/solana|blockchain|on-?chain|crypto|wallet|usdc|token|vault|program|transaction|signature|explorer|devnet|\bSOL\b|\bsign|keypair|anchor|lamport|codec|rpc|trpc|uuid|zod/i;
const GENERIC = "Something went wrong. Please try again.";

/** Business-language message for any failure; technical details only go to the console. */
export function errorMessage(e: unknown) {
	const data = errorData(e);
	if (data?.appCode && FRIENDLY[data.appCode]) return FRIENDLY[data.appCode];
	// Validation failures (ours or the server's) must never surface raw JSON.
	if (e instanceof z.ZodError || data?.appCode === "VALIDATION") return GENERIC;
	const message = e instanceof Error ? e.message : "";
	if (!message || /^\s*[[{]/.test(message) || TECHNICAL.test(message) || (data?.httpStatus ?? 0) >= 500)
		return GENERIC;
	return message;
}

export const isDuplicate = (e: unknown) => appCodeOf(e) === "DUPLICATE_CANDIDATE";

/** The thing asked for doesn't exist (or the link is malformed): show "not found", not an error page. */
export function isNotFound(e: unknown) {
	const data = errorData(e);
	return (
		data?.httpStatus === 404 ||
		data?.httpStatus === 400 ||
		/NOT_FOUND$/.test(data?.appCode ?? "") ||
		data?.appCode === "VALIDATION" ||
		data?.appCode === "BAD_REQUEST"
	);
}
