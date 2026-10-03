/**
 * Notetaker for screening / reference gigs: the claimant pastes the meeting link, a Recall bot joins and records,
 * we poll its status (no webhooks on localhost), then download the transcript, hash it (the deliverable's
 * evidence_hash) and pre-fill the script answers.
 *
 * RECALL_MOCK=1 simulates the bot with a fixture transcript, so the demo works without a live meeting.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type {
	RecordingPrefill,
	RecordingStatus,
	RecordingView,
	ScriptQuestion,
	TranscriptLine,
} from "@scout/shared";
import { eq, inArray, sql } from "drizzle-orm";
import { boolean, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { db, schema } from "../db/index.ts";
import { publish } from "../events.ts";
import { forbidden, HttpError, notFound } from "../http.ts";
import { createRecallClient, latestStatusCode, type RecallClient, RecallError } from "./client.ts";
import { extractAnswers, transcriptToText } from "./extract.ts";

export const recallEnv = {
	apiKey: process.env.RECALL_API_KEY || undefined,
	region: process.env.RECALL_REGION || "eu-central-1",
	mock: process.env.RECALL_MOCK === "1",
	pollMs: Number(process.env.RECALL_POLL_MS ?? 5000),
	/** Mock timeline step (ms between joining → in_call → recording → processing → done). */
	mockStepMs: Number(process.env.RECALL_MOCK_STEP_MS ?? 3000),
};

/** Own table, created idempotently (kept out of the main Drizzle schema so this module stays self-contained). */
export const recordings = pgTable("recall_recordings", {
	gigId: text("gig_id").primaryKey(),
	wallet: text().notNull(),
	botId: text("bot_id").notNull(),
	meetingUrl: text("meeting_url").notNull(),
	status: text().$type<RecordingStatus>().notNull(),
	failureReason: text("failure_reason"),
	transcript: text(),
	lines: jsonb().$type<TranscriptLine[]>(),
	transcriptHash: text("transcript_hash"),
	prefill: jsonb().$type<RecordingPrefill>(),
	mock: boolean().notNull().default(false),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});
type Row = typeof recordings.$inferSelect;

let ready: Promise<void> | null = null;
function ensureTable() {
	ready ??= db
		.execute(sql`CREATE TABLE IF NOT EXISTS recall_recordings (
			gig_id text PRIMARY KEY,
			wallet text NOT NULL,
			bot_id text NOT NULL,
			meeting_url text NOT NULL,
			status text NOT NULL,
			failure_reason text,
			transcript text,
			lines jsonb,
			transcript_hash text,
			prefill jsonb,
			mock boolean NOT NULL DEFAULT false,
			created_at timestamptz NOT NULL DEFAULT now(),
			updated_at timestamptz NOT NULL DEFAULT now()
		)`)
		.then(() => undefined);
	return ready;
}

let client: RecallClient = createRecallClient({ apiKey: recallEnv.apiKey, region: recallEnv.region });
/** Tests swap the HTTP client. */
export function setRecallClient(c: RecallClient) {
	client = c;
}

const STATUS_TEXT: Record<RecordingStatus, string> = {
	joining: "The notetaker is joining the call",
	waiting_room: "The notetaker is waiting to be let in",
	in_call: "The notetaker is in the call",
	recording: "Recording",
	processing: "Call ended, preparing the transcript",
	done: "Transcript ready",
	failed: "The notetaker couldn't record this call",
};

const ALLOWED_HOSTS = ["meet.google.com", "zoom.us", "teams.microsoft.com", "teams.live.com"];

const ACTIVE: RecordingStatus[] = ["joining", "waiting_room", "in_call", "recording", "processing"];

// ---- use cases --------------------------------------------------------------

export async function invite(
	wallet: string,
	input: { gigId: string; meetingUrl: string },
): Promise<RecordingView> {
	await ensureTable();
	const gig = await loadGig(input.gigId);
	if (gig.type !== "SCREENING_CALL" && gig.type !== "REFERENCE_CHECK")
		throw new HttpError(400, "NOT_A_CALL_GIG", "Only screening and reference gigs can be recorded.");
	if (gig.claimantWallet !== wallet) throw forbidden("Take this gig first to invite the notetaker.");
	const host = safeHost(input.meetingUrl);
	if (!host || !ALLOWED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`)))
		throw new HttpError(400, "UNSUPPORTED_MEETING", "Paste a Google Meet, Zoom or Teams link.");

	const existing = await getRow(gig.id);
	if (existing && ACTIVE.includes(existing.status)) return toView(existing);
	if (existing?.status === "done")
		throw new HttpError(409, "RECORDING_DONE", "This call is already recorded. Deliver the answers.");

	const mock = recallEnv.mock;
	if (!mock && !client.configured)
		throw new HttpError(503, "RECALL_NOT_CONFIGURED", "The notetaker isn't set up on this server.");
	const botId = mock ? `mock-${gig.id}` : (await client.createBot({ meetingUrl: input.meetingUrl })).id;
	const row: Row = {
		gigId: gig.id,
		wallet,
		botId,
		meetingUrl: input.meetingUrl,
		status: "joining",
		failureReason: null,
		transcript: null,
		lines: null,
		transcriptHash: null,
		prefill: null,
		mock,
		createdAt: new Date(),
		updatedAt: new Date(),
	};
	await db
		.insert(recordings)
		.values(row)
		.onConflictDoUpdate({ target: recordings.gigId, set: { ...row, createdAt: undefined } });
	notify(gig, row);
	track(row);
	return toView(row);
}

export async function status(viewer: string | null, gigId: string): Promise<RecordingView | null> {
	await ensureTable();
	const gig = await loadGig(gigId);
	await requireViewer(viewer, gig);
	const row = await getRow(gigId);
	return row ? toView(row) : null;
}

/** Makes the bot leave (the recruiter ended the call early); the transcript is produced as usual. */
export async function stop(wallet: string, gigId: string): Promise<RecordingView> {
	await ensureTable();
	const gig = await loadGig(gigId);
	if (gig.claimantWallet !== wallet)
		throw forbidden("Only the recruiter on this gig can stop the notetaker.");
	const row = await getRow(gigId);
	if (!row) throw notFound("No notetaker on this call.");
	if (!ACTIVE.includes(row.status) || row.status === "processing") return toView(row);
	if (row.mock) return toView(await update(row, { status: "processing" }));
	await client.leaveCall(row.botId).catch(() => undefined);
	return toView(await update(row, { status: "processing" }));
}

/** Resumes polling for calls that were in flight when the server restarted. */
export function startRecallPoller(log: { info(m: string): void; warn(m: string): void }) {
	void ensureTable()
		.then(() => db.select().from(recordings).where(inArray(recordings.status, ACTIVE)))
		.then((rows) => {
			for (const row of rows) track(row);
			if (rows.length) log.info(`[recall] resumed ${rows.length} recording(s)`);
		})
		.catch((e) => log.warn(`[recall] resume failed: ${(e as Error).message}`));
	return () => {
		for (const t of timers.values()) clearTimeout(t);
		timers.clear();
	};
}

// ---- polling ----------------------------------------------------------------

const timers = new Map<string, ReturnType<typeof setTimeout>>();

function track(row: Row) {
	if (timers.has(row.gigId)) return;
	const tick = async () => {
		timers.delete(row.gigId);
		const current = await getRow(row.gigId);
		if (!current || !ACTIVE.includes(current.status)) return;
		try {
			const next = current.mock ? await stepMock(current) : await stepLive(current);
			if (next && ACTIVE.includes(next.status)) schedule();
		} catch (e) {
			console.warn(`[recall] poll ${row.gigId}: ${(e as Error).message.slice(0, 200)}`);
			schedule();
		}
	};
	const schedule = () =>
		timers.set(row.gigId, setTimeout(tick, row.mock ? recallEnv.mockStepMs : recallEnv.pollMs));
	schedule();
}

const CODE_MAP: Record<string, RecordingStatus> = {
	joining_call: "joining",
	in_waiting_room: "waiting_room",
	in_call_not_recording: "in_call",
	recording_permission_allowed: "in_call",
	in_call_recording: "recording",
	call_ended: "processing",
	done: "processing", // becomes "done" once the transcript is downloaded
	fatal: "failed",
	recording_permission_denied: "failed",
};

async function stepLive(row: Row): Promise<Row> {
	const bot = await client.getBot(row.botId);
	const code = latestStatusCode(bot);
	const mapped: RecordingStatus = (code ? CODE_MAP[code] : undefined) ?? row.status;
	if (mapped === "failed") {
		const last = bot.status_changes.at(-1);
		return update(row, {
			status: "failed",
			failureReason: last?.sub_code ?? last?.message ?? code ?? "unknown",
		});
	}
	if (code === "done") {
		try {
			return await finish(row, await client.getTranscript(row.botId));
		} catch (e) {
			if (e instanceof RecallError && e.code === "NO_TRANSCRIPT")
				return update(row, { status: "processing" });
			throw e;
		}
	}
	return mapped !== row.status ? update(row, { status: mapped }) : row;
}

const MOCK_ORDER: RecordingStatus[] = ["joining", "in_call", "recording", "processing"];
async function stepMock(row: Row): Promise<Row> {
	const i = MOCK_ORDER.indexOf(row.status);
	const nextStatus = i >= 0 ? MOCK_ORDER[i + 1] : undefined;
	if (nextStatus) return update(row, { status: nextStatus });
	return finish(row, mockTranscript());
}

async function finish(row: Row, lines: TranscriptLine[]): Promise<Row> {
	if (!lines.length) return update(row, { status: "failed", failureReason: "The transcript was empty." });
	const transcript = transcriptToText(lines);
	const transcriptHash = createHash("sha256").update(transcript).digest("hex");
	const gig = await loadGig(row.gigId);
	const script = (gig.script ?? {}) as { questions?: ScriptQuestion[]; candidate?: { name?: string } };
	const prefill = script.questions?.length
		? await extractAnswers({ questions: script.questions, lines, candidateName: script.candidate?.name })
		: null;
	const done = await update(row, { status: "done", transcript, lines, transcriptHash, prefill });
	publish({ type: "gig.updated", roleId: gig.roleId, gigId: gig.id, message: "recording.ready" });
	return done;
}

let fixture: TranscriptLine[] | null = null;
/** The fixture's lines spread over a realistic ~24-minute screening (its text is a condensed call). */
const MOCK_CALL_SECONDS = 24 * 60;
export function mockTranscript(): TranscriptLine[] {
	fixture ??= JSON.parse(
		readFileSync(new URL("./fixtures/karolina-screening.json", import.meta.url), "utf8"),
	) as TranscriptLine[];
	const last = Math.max(1, ...fixture.map((l) => l.startSec ?? 0));
	return fixture.map((l) => ({
		...l,
		startSec: Math.round(((l.startSec ?? 0) / last) * (MOCK_CALL_SECONDS - 30)),
	}));
}

/**
 * The recording for a call deliverable (only the recruiter who recorded it): normalized lines and a fresh media
 * URL from Recall (null for mock recordings or when Recall has no media yet).
 */
export async function recordingFor(
	gigId: string,
	wallet: string,
): Promise<{ lines: TranscriptLine[]; mediaUrl: string | null } | null> {
	await ensureTable();
	const row = await getRow(gigId);
	if (!row || row.wallet !== wallet || row.status !== "done") return null;
	const mediaUrl = row.mock ? null : await client.getMediaUrl(row.botId).catch(() => null);
	return { lines: row.lines ?? [], mediaUrl };
}

/** Recording metadata for the agent's transcript-integrity checks (duration, who spoke). */
export async function recordingMeta(
	gigId: string,
): Promise<{ provider: string; durationSeconds: number; speakers: string[] } | null> {
	await ensureTable();
	const row = await getRow(gigId);
	if (!row || row.status !== "done" || !row.lines?.length) return null;
	const starts = row.lines.map((l) => l.startSec ?? 0);
	return {
		provider: row.mock ? "recall-mock" : "recall",
		// The last line's start plus a short tail: Recall lines carry start times only.
		durationSeconds: Math.max(...starts) - Math.min(...starts) + 30,
		speakers: [...new Set(row.lines.map((l) => l.speaker))],
	};
}

// ---- helpers ----------------------------------------------------------------

async function loadGig(id: string) {
	const [gig] = await db.select().from(schema.gigs).where(eq(schema.gigs.id, id));
	if (!gig) throw notFound("Gig not found.");
	return gig;
}

async function requireViewer(viewer: string | null, gig: typeof schema.gigs.$inferSelect) {
	if (viewer && gig.claimantWallet === viewer) return;
	if (viewer) {
		const [role] = await db
			.select({ companyWallet: schema.roles.companyWallet })
			.from(schema.roles)
			.where(eq(schema.roles.id, gig.roleId));
		if (role?.companyWallet === viewer) return;
	}
	throw forbidden("Only the recruiter on this gig and the company can see the recording.");
}

async function getRow(gigId: string): Promise<Row | null> {
	const [row] = await db.select().from(recordings).where(eq(recordings.gigId, gigId));
	return row ?? null;
}

async function update(row: Row, patch: Partial<Row>): Promise<Row> {
	const next = { ...row, ...patch, updatedAt: new Date() };
	await db
		.update(recordings)
		.set({ ...patch, updatedAt: next.updatedAt })
		.where(eq(recordings.gigId, row.gigId));
	if (patch.status && patch.status !== row.status && patch.status !== "done") {
		const gig = await loadGig(row.gigId).catch(() => null);
		if (gig) notify(gig, next);
	}
	return next;
}

function notify(gig: { id: string; roleId: string }, row: Row) {
	publish({ type: "gig.updated", roleId: gig.roleId, gigId: gig.id, message: `recording.${row.status}` });
}

function toView(row: Row): RecordingView {
	return {
		gigId: row.gigId,
		status: row.status,
		meetingUrl: row.meetingUrl,
		statusText: STATUS_TEXT[row.status],
		failureReason: row.failureReason,
		transcript: row.transcript,
		lines: row.lines,
		transcriptHash: row.transcriptHash,
		prefill: row.prefill,
		updatedAt: row.updatedAt.toISOString(),
	};
}

function safeHost(url: string): string | null {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return null;
	}
}

/**
 * Server-side evidence for a gig's deliverable: the stored transcript and its sha256, only once the recording is
 * done. Use this instead of client-sent transcript text.
 */
export async function recordingEvidence(
	gigId: string,
): Promise<{ transcript: string; transcriptHash: string; wallet: string } | null> {
	await ensureTable();
	const row = await getRow(gigId);
	if (!row || row.status !== "done" || !row.transcript || !row.transcriptHash) return null;
	return { transcript: row.transcript, transcriptHash: row.transcriptHash, wallet: row.wallet };
}
