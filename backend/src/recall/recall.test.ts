import type { ScriptQuestion } from "@scout/shared";
import { describe, expect, it } from "vitest";
import { createRecallClient, latestStatusCode, normalizeTranscript, RecallError } from "./client.ts";
import { offlineExtract, transcriptToText } from "./extract.ts";
import { mockTranscript } from "./service.ts";

function fakeFetch(responses: Array<{ status: number; body?: unknown }>) {
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	const fn = (async (url: string, init?: RequestInit) => {
		calls.push({ url, init });
		const r = responses.shift() ?? { status: 500 };
		return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
	}) as unknown as typeof fetch;
	return { fn, calls };
}

describe("recall client", () => {
	it("creates a bot in the EU region with meeting captions and the token header", async () => {
		const { fn, calls } = fakeFetch([
			{ status: 201, body: { id: "bot-1", meeting_url: {}, status_changes: [] } },
		]);
		const client = createRecallClient({
			apiKey: "secret",
			region: "eu-central-1",
			fetch: fn,
			retryDelayMs: 0,
		});
		const bot = await client.createBot({ meetingUrl: "https://meet.google.com/abc-defg-hij" });
		expect(bot.id).toBe("bot-1");
		expect(calls[0]?.url).toBe("https://eu-central-1.recall.ai/api/v1/bot/");
		const headers = (calls[0]?.init?.headers ?? {}) as Record<string, string>;
		expect(headers.Authorization).toBe("Token secret");
		const body = JSON.parse(String(calls[0]?.init?.body));
		expect(body.bot_name).toBe("Scout notetaker");
		expect(body.recording_config.transcript.provider).toEqual({ meeting_captions: { language_code: "en" } });
	});

	it("retries 429/5xx but not 4xx", async () => {
		const retry = fakeFetch([
			{ status: 429 },
			{ status: 502 },
			{ status: 200, body: { id: "b", status_changes: [] } },
		]);
		const c1 = createRecallClient({ apiKey: "k", region: "eu-central-1", fetch: retry.fn, retryDelayMs: 0 });
		await expect(c1.getBot("b")).resolves.toMatchObject({ id: "b" });
		expect(retry.calls).toHaveLength(3);

		const bad = fakeFetch([{ status: 400, body: { meeting_url: ["invalid"] } }]);
		const c2 = createRecallClient({ apiKey: "k", region: "eu-central-1", fetch: bad.fn, retryDelayMs: 0 });
		await expect(c2.getBot("b")).rejects.toBeInstanceOf(RecallError);
		expect(bad.calls).toHaveLength(1);
	});

	it("refuses to call without a key and never puts the key in errors", async () => {
		const none = createRecallClient({ apiKey: undefined, region: "eu-central-1" });
		await expect(none.getBot("x")).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
		const bad = fakeFetch([{ status: 401, body: { detail: "Invalid token." } }]);
		const c = createRecallClient({ apiKey: "super-secret-key", region: "eu-central-1", fetch: bad.fn });
		const err = await c.getBot("x").catch((e: Error) => e);
		expect(String(err)).not.toContain("super-secret-key");
	});

	it("downloads and normalizes the transcript", async () => {
		const { fn } = fakeFetch([
			{
				status: 200,
				body: {
					id: "b",
					status_changes: [{ code: "done", created_at: "" }],
					recordings: [
						{ id: "r", media_shortcuts: { transcript: { data: { download_url: "https://dl/t.json" } } } },
					],
				},
			},
			{
				status: 200,
				body: [
					{ participant: { id: 1, name: "Ola" }, words: [{ text: "Hi", start_timestamp: { relative: 1 } }] },
					{
						participant: { id: 1, name: "Ola" },
						words: [{ text: "there", start_timestamp: { relative: 2 } }],
					},
					{
						participant: { id: 2, name: null },
						words: [{ text: "Hello", start_timestamp: { relative: 3 } }, { text: "." }],
					},
				],
			},
		]);
		const client = createRecallClient({ apiKey: "k", region: "eu-central-1", fetch: fn, retryDelayMs: 0 });
		expect(await client.getTranscript("b")).toEqual([
			{ speaker: "Ola", text: "Hi there", startSec: 1 },
			{ speaker: "Speaker 2", text: "Hello.", startSec: 3 },
		]);
	});

	it("reads the latest status without the webhook prefix", () => {
		expect(
			latestStatusCode({
				id: "b",
				meeting_url: null,
				status_changes: [
					{ code: "joining_call", created_at: "" },
					{ code: "bot.in_call_recording", created_at: "" },
				],
			}),
		).toBe("in_call_recording");
		expect(normalizeTranscript([])).toEqual([]);
	});
});

describe("transcript → script answers (offline)", () => {
	// Script questions for the canonical demo role (backend/src/agent/fixtures/screening-karolina-good.json).
	const ids = [
		"q-rust-production",
		"q-solana-programs",
		"q-defi-protocols",
		"q-program-security",
		"q-fluent-english",
		"q-only-remote",
		"q-motivation",
		"q-logistics",
	];
	// The script's wording differs from what the recruiter actually said; shared words are enough to match.
	const TEXT: Record<string, string> = {
		"q-rust-production": "How many years of production Rust have you written, and where?",
		"q-solana-programs": "Which Solana programs have you shipped to mainnet?",
		"q-defi-protocols": "What DeFi protocol work did you design yourself?",
		"q-program-security": "How do you approach program security: fuzzing, tests, audits?",
		"q-fluent-english": "How comfortable are you working in English every day?",
		"q-only-remote": "Are you open to two days a week in the Warsaw office, or only fully remote?",
		"q-motivation": "Why are you looking to move now?",
		"q-logistics": "What's your notice period and compensation expectation, and are you in other processes?",
	};
	const questions: ScriptQuestion[] = ids.map((id) => ({
		id,
		question: TEXT[id] ?? id,
		whatGoodLooksLike: "",
	}));

	it("pairs each script question with the answer to the recruiter's matching question", () => {
		const lines = mockTranscript();
		const out = offlineExtract({ questions, lines });
		expect(out.answers.map((a) => a.questionId)).toEqual(ids);
		expect(out.answers[0]?.answer).toContain("Six years of production Rust");
		expect(out.answers[1]?.answer).toContain("upgrade of the lending pools");
		expect(out.answers[3]?.answer).toContain("Trident fuzz suite");
		expect(out.answers[5]?.answer).toContain("Mokotów");
		expect(out.answers[7]?.answer).toContain("thirty-six thousand PLN");
		expect(out.missing).toEqual([]);
		expect(out.recommendation).toBe("ADVANCE");
		expect(transcriptToText(lines).split("\n")[0]).toMatch(/^Ola Wiśniewska: Hi Karolina/);
	});

	it("marks uncovered questions as missing", () => {
		const out = offlineExtract({ questions, lines: mockTranscript().slice(0, 11) });
		expect(out.answers.map((a) => a.questionId)).toEqual(ids.slice(0, out.answers.length));
		expect(out.answers.length).toBeLessThanOrEqual(5);
		expect(out.missing).toHaveLength(8 - out.answers.length);
		expect(out.recommendation).toBe("MAYBE");
	});
});

describe("transcript → script answers: no shifted answers", () => {
	it("leaves a question empty rather than giving it a neighbour's answer", () => {
		const lines = [
			{ speaker: "Ola", text: "Hi! Quick intro first: how are you today, all good?", startSec: 0 },
			{ speaker: "Karolina", text: "All good, thanks, happy to talk about the role today.", startSec: 5 },
			{ speaker: "Ola", text: "How many years of production Rust have you written?", startSec: 10 },
			{
				speaker: "Karolina",
				text: "Six years of production Rust, the last three on lending programs.",
				startSec: 15,
			},
		];
		const out = offlineExtract({
			questions: [
				{ id: "lang", question: "Is your English fluent enough for daily work?", whatGoodLooksLike: "" },
				{ id: "rust", question: "Years of production Rust?", whatGoodLooksLike: "" },
			],
			lines,
		});
		expect(out.answers).toEqual([{ questionId: "rust", answer: expect.stringContaining("Six years") }]);
		expect(out.missing).toEqual(["lang"]);
	});
});
