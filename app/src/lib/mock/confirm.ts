/**
 * Mock confirmation links. Kept in localStorage (not the per-tab mock store) so the demo can open the link in a
 * second tab, click Yes, and see the first tab react.
 */
import type { CandidateConfirmation } from "@scout/shared";
import type { CandidateConfirmInput, CandidateConfirmView } from "../gigs/confirm";
import { MockError } from "./gigs";

type Status = CandidateConfirmation["status"];
const KEY = "scout.mock-confirm.v1";
type Stored = Omit<CandidateConfirmView, "status"> & {
	token: string;
	status: Status;
	respondedAt: string | null;
	availability?: string;
	salaryExpectation?: string;
	timeZone?: string;
};

function all(): Record<string, Stored> {
	try {
		return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, Stored>;
	} catch {
		return {};
	}
}
function put(entry: Stored) {
	try {
		localStorage.setItem(KEY, JSON.stringify({ ...all(), [entry.token]: entry }));
	} catch {
		// Private mode: the link still works in this tab.
	}
}

export const confirmUrl = (token: string) => `${location.origin}/c/${token}`;

export function createConfirmation(card: Omit<CandidateConfirmView, "status">) {
	const token = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");
	put({ ...card, token, status: "PENDING", respondedAt: null });
	return token;
}

export const confirmationOf = (token: string): Stored | null => all()[token] ?? null;

export function answerConfirmation(token: string, status: Status) {
	const entry = confirmationOf(token);
	if (entry && entry.status === "PENDING") put({ ...entry, status, respondedAt: new Date().toISOString() });
}

/** The recruiter's view of the link on their deliverable. */
export function confirmationFor(token: string): CandidateConfirmation | null {
	const e = confirmationOf(token);
	return (
		e && { status: e.status, url: confirmUrl(token), expiresAt: e.expiresAt, respondedAt: e.respondedAt }
	);
}

const view = ({
	token: _t,
	respondedAt: _r,
	availability: _a,
	salaryExpectation: _s,
	timeZone: _z,
	...card
}: Stored) => card;

export const confirmProcedures = {
	"candidate.view": ({ input }: { input: Record<string, unknown> }) => {
		const entry = confirmationOf(String(input.token));
		if (!entry) throw new MockError(404, "NOT_FOUND", "This link isn't valid.");
		if (entry.status === "PENDING" && Date.parse(entry.expiresAt) <= Date.now())
			answerConfirmation(entry.token, "EXPIRED");
		return view(confirmationOf(entry.token) ?? entry);
	},
	"candidate.confirm": ({ input }: { input: Record<string, unknown> }) => {
		const req = input as CandidateConfirmInput;
		const entry = confirmationOf(String(req.token));
		if (!entry) throw new MockError(404, "NOT_FOUND", "This link isn't valid.");
		if (entry.status !== "PENDING") throw new MockError(409, "ALREADY_ANSWERED", "You already answered.");
		const status = req.interested ? "YES" : "NO";
		put({
			...entry,
			status,
			respondedAt: new Date().toISOString(),
			availability: req.availability,
			salaryExpectation: req.salaryExpectation,
			timeZone: req.timeZone,
		});
		return { status };
	},
};
