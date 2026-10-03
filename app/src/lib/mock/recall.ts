/**
 * Mock of the meeting notetaker (Stream E, packages/shared/src/recall.ts): a scripted timeline from "joining" to
 * "done", the canonical Karolina transcript, and answers pre-filled per script question.
 */
import type { RecordingStatus, RecordingView, ScriptQuestion } from "@scout/shared";
import transcriptFixture from "../../../../backend/src/recall/fixtures/karolina-screening.json";
import { MockError } from "./gigs";

type Line = { speaker: string; text: string; startSec: number };
type Session = {
	gigId: string;
	meetingUrl: string;
	startedAt: number;
	stoppedAt: number | null;
	script: ScriptQuestion[];
};

const KEY = "scout.mock-recall.v1";
const sessions = new Map<string, Session>(
	(() => {
		try {
			return JSON.parse(localStorage.getItem(KEY) ?? "[]") as [string, Session][];
		} catch {
			return [];
		}
	})(),
);
const save = () => {
	try {
		localStorage.setItem(KEY, JSON.stringify([...sessions]));
	} catch {}
};
const STEPS: [RecordingStatus, number, string][] = [
	["joining", 3, "The notetaker is joining the call"],
	["waiting_room", 6, "The notetaker is waiting to be let in"],
	["in_call", 8, "The notetaker is in the call"],
	["recording", 18, "Recording"],
	["processing", 22, "Call ended, preparing the transcript"],
];

const MEETING =
	/^https:\/\/(meet\.google\.com|([\w-]+\.)?zoom\.us|teams\.microsoft\.com|teams\.live\.com)\//i;

async function sha256(text: string) {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

const STOP = new Set(
	"about after also and are ask can could did does for from have how into its more not that the their them they this was what when which who why will with you your".split(
		" ",
	),
);
const words = (t: string) =>
	new Set(
		t
			.toLowerCase()
			.split(/[^a-z0-9+]+/)
			.filter((w) => w.length > 2 && !STOP.has(w))
			.map((w) => w.replace(/(ing|ed|s)$/, "")),
	);
const SYNONYMS: Record<string, string> = {
	salary: "compensation",
	move: "look",
	start: "notice",
	office: "warsaw",
};

/**
 * Offline stand-in for the backend's extraction: split the call into question/answer pairs and give each script
 * question the pair whose words overlap most. Questions with no matching pair stay "missing".
 */
function prefill(script: ScriptQuestion[], lines: Line[]) {
	const interviewer = lines[0]?.speaker;
	const pairs: { asked: string; said: string }[] = [];
	for (const l of lines) {
		if (l.speaker === interviewer) pairs.push({ asked: l.text, said: "" });
		else if (pairs.length) pairs[pairs.length - 1].said += ` ${l.text}`;
	}
	const used = new Set<number>();
	const answers = script.flatMap((q) => {
		const want = words(`${q.question} ${q.whatGoodLooksLike}`);
		for (const [k, v] of Object.entries(SYNONYMS)) if (want.has(k)) want.add(v);
		let best = -1;
		let bestScore = 0;
		pairs.forEach((p, i) => {
			if (used.has(i) || p.said.trim().split(/\s+/).length < 6) return;
			const have = words(`${p.asked} ${p.said}`);
			const score = [...want].filter((w) => have.has(w)).length;
			if (score > bestScore) [best, bestScore] = [i, score];
		});
		if (best < 0) return [];
		used.add(best);
		return [{ questionId: q.id, answer: pairs[best].said.trim() }];
	});
	const answered = new Set(answers.map((x) => x.questionId));
	return {
		answers,
		recommendation: "ADVANCE" as const,
		missing: script.filter((q) => !answered.has(q.id)).map((q) => q.id),
	};
}

async function view(s: Session): Promise<RecordingView> {
	const elapsed =
		((s.stoppedAt ?? Date.now()) - s.startedAt) / 1000 +
		(s.stoppedAt ? (Date.now() - s.stoppedAt) / 1000 + 18 : 0);
	const step = STEPS.find(([, until]) => elapsed < until);
	const base = {
		gigId: s.gigId,
		meetingUrl: s.meetingUrl,
		failureReason: null,
		updatedAt: new Date().toISOString(),
	};
	if (step)
		return {
			...base,
			status: step[0],
			statusText: step[2],
			transcript: null,
			lines: null,
			transcriptHash: null,
			prefill: null,
		};
	const lines = transcriptFixture as Line[];
	const transcript = lines.map((l) => `${l.speaker}: ${l.text}`).join("\n");
	return {
		...base,
		status: "done",
		statusText: "Transcript ready",
		transcript,
		lines,
		transcriptHash: await sha256(transcript),
		prefill: prefill(s.script, lines),
	};
}

/** Was this call recorded to the end? (Otherwise the answers are self-reported.) */
export const hasRecording = (gigId: string) => {
	const s = sessions.get(gigId);
	return !!s && (Date.now() - s.startedAt) / 1000 > 22;
};

/** The notetaker joined the meeting (the recruiter showed up), whether or not the candidate did. */
export const notetakerJoined = (gigId: string) => {
	const s = sessions.get(gigId);
	return !!s && (Date.now() - s.startedAt) / 1000 > 4;
};

/** The recorded call's transcript lines for a gig, when there is one. */
export const transcriptOf = (gigId: string) => (hasRecording(gigId) ? (transcriptFixture as Line[]) : null);

export function recallProcedures(scriptOf: (gigId: string) => ScriptQuestion[] | null) {
	return {
		"recall.invite": async ({ input }: { input: Record<string, unknown> }) => {
			const gigId = String(input.gigId);
			const meetingUrl = String(input.meetingUrl ?? "").trim();
			if (!MEETING.test(meetingUrl))
				throw new MockError(400, "UNSUPPORTED_MEETING", "Paste a Google Meet, Zoom or Teams link.");
			const existing = sessions.get(gigId);
			if (existing && (await view(existing)).status === "done")
				throw new MockError(409, "RECORDING_DONE", "This call is already recorded.");
			const s = { gigId, meetingUrl, startedAt: Date.now(), stoppedAt: null, script: scriptOf(gigId) ?? [] };
			sessions.set(gigId, s);
			save();
			return view(s);
		},
		"recall.status": async ({ input }: { input: Record<string, unknown> }) => {
			const s = sessions.get(String(input.gigId));
			return s ? view(s) : null;
		},
		"recall.stop": async ({ input }: { input: Record<string, unknown> }) => {
			const s = sessions.get(String(input.gigId));
			if (!s) throw new MockError(404, "NOT_FOUND", "No recording for this gig.");
			s.stoppedAt ??= Date.now();
			save();
			return view(s);
		},
	};
}
