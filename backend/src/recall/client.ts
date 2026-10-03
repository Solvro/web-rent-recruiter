/**
 * Minimal Recall.ai REST client (https://docs.recall.ai). We poll instead of using webhooks (localhost).
 * Transcripts use the meeting's own captions provider: no extra charge and no third-party keys.
 */
import type { TranscriptLine } from "@scout/shared";

export const RECALL_BOT_NAME = "Scout notetaker";

export class RecallError extends Error {
	constructor(
		message: string,
		readonly status: number | null,
		readonly code: "NOT_CONFIGURED" | "HTTP" | "NETWORK" | "NO_TRANSCRIPT",
	) {
		super(message);
		this.name = "RecallError";
	}
}

export interface RecallConfig {
	apiKey: string | undefined;
	region: string;
	fetch?: typeof fetch;
	/** Base delay for retry backoff (tests set it to 0). */
	retryDelayMs?: number;
}

export interface RecallStatusChange {
	code: string;
	sub_code?: string | null;
	message?: string | null;
	created_at: string;
}

export interface RecallBot {
	id: string;
	meeting_url: unknown;
	status_changes: RecallStatusChange[];
	recordings?: Array<{
		id: string;
		media_shortcuts?: {
			transcript?: {
				status?: { code: string };
				data?: { download_url?: string | null };
			} | null;
		};
	}>;
}

interface RawTranscriptEntry {
	participant?: { name?: string | null; id?: number | null };
	words?: Array<{ text: string; start_timestamp?: { relative?: number | null } | null }>;
}

export function createRecallClient(config: RecallConfig) {
	const doFetch = config.fetch ?? fetch;
	const base = `https://${config.region}.recall.ai/api/v1`;
	const retryDelayMs = config.retryDelayMs ?? 500;

	async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
		if (!config.apiKey) throw new RecallError("RECALL_API_KEY is not set", null, "NOT_CONFIGURED");
		let lastError: RecallError | null = null;
		for (let attempt = 0; attempt < 4; attempt++) {
			if (attempt > 0) await sleep(retryDelayMs * 2 ** (attempt - 1));
			let res: Response;
			try {
				res = await doFetch(`${base}${path}`, {
					method,
					headers: {
						Authorization: `Token ${config.apiKey}`,
						"Content-Type": "application/json",
						Accept: "application/json",
					},
					body: body === undefined ? undefined : JSON.stringify(body),
				});
			} catch (e) {
				lastError = new RecallError(`Recall request failed: ${(e as Error).message}`, null, "NETWORK");
				continue;
			}
			if (res.ok) return (res.status === 204 ? undefined : await res.json()) as T;
			const text = (await res.text().catch(() => "")).slice(0, 300);
			lastError = new RecallError(`Recall ${method} ${path} → ${res.status}: ${text}`, res.status, "HTTP");
			// Retry rate limits and server errors only; 4xx is our fault.
			if (res.status !== 429 && res.status < 500) throw lastError;
		}
		throw lastError ?? new RecallError("Recall request failed", null, "NETWORK");
	}

	return {
		configured: Boolean(config.apiKey),

		createBot(input: { meetingUrl: string; botName?: string; joinAt?: string }) {
			return request<RecallBot>("POST", "/bot/", {
				meeting_url: input.meetingUrl,
				bot_name: input.botName ?? RECALL_BOT_NAME,
				...(input.joinAt ? { join_at: input.joinAt } : {}),
				recording_config: {
					transcript: { provider: { meeting_captions: { language_code: "en" } } },
					video_mixed_layout: "audio_only",
				},
			});
		},

		getBot(id: string) {
			return request<RecallBot>("GET", `/bot/${id}/`);
		},

		leaveCall(id: string) {
			return request<unknown>("POST", `/bot/${id}/leave_call/`);
		},

		/** Downloads the bot's transcript and normalizes it to speaker turns. */
		async getTranscript(botId: string): Promise<TranscriptLine[]> {
			const bot = await this.getBot(botId);
			const shortcut = bot.recordings?.[0]?.media_shortcuts?.transcript;
			const url = shortcut?.data?.download_url;
			if (!url) throw new RecallError("Transcript not available yet", null, "NO_TRANSCRIPT");
			const res = await doFetch(url);
			if (!res.ok) throw new RecallError(`Transcript download → ${res.status}`, res.status, "HTTP");
			return normalizeTranscript((await res.json()) as RawTranscriptEntry[]);
		},
	};
}
export type RecallClient = ReturnType<typeof createRecallClient>;

/** Recall's JSON (one entry per speaker turn, word-level) → readable lines, merging consecutive turns. */
export function normalizeTranscript(raw: RawTranscriptEntry[]): TranscriptLine[] {
	const lines: TranscriptLine[] = [];
	for (const entry of raw) {
		const text = (entry.words ?? [])
			.map((w) => w.text)
			.join(" ")
			.replace(/\s+([,.?!])/g, "$1")
			.trim();
		if (!text) continue;
		const speaker = entry.participant?.name?.trim() || `Speaker ${entry.participant?.id ?? "?"}`;
		const startSec = entry.words?.[0]?.start_timestamp?.relative ?? 0;
		const prev = lines.at(-1);
		if (prev && prev.speaker === speaker) prev.text = `${prev.text} ${text}`;
		else lines.push({ speaker, text, startSec });
	}
	return lines.sort((a, b) => a.startSec - b.startSec);
}

/** Latest bot status code, without the "bot." prefix webhooks use. */
export function latestStatusCode(bot: RecallBot): string | null {
	const last = bot.status_changes.at(-1);
	return last ? last.code.replace(/^bot\./, "") : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
