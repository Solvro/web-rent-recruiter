/**
 * Jev (TypeSafe System One) through OpenRouter's passthrough:
 * POST https://openrouter.ai/api/v1/systemone with an OpenRouter key.
 * Plain fetch, no SDK. Questions are Noul / Choice / Score as in https://docs.typesafe.ai/llms.txt.
 */

export const JEV_URL = "https://openrouter.ai/api/v1/systemone";
export const JEV_MODEL = "jev-latest";

export type JevQuestion =
	| { type: "noul"; instructions: string; criteria?: { true: string; false: string } }
	| { type: "choice"; instructions: string; criteria: Record<string, string | null> }
	| { type: "score"; instructions: string; criteria: string[] };

export type JevAnswer =
	| { type: "noul"; noul: number }
	| { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
	| { type: "score"; score: number; confidence: number; probabilities: number[] };

export interface JevResult {
	answers: Record<string, JevAnswer>;
	model: string;
	costUsd: number;
	inputTokens: number;
	latencyMs: number;
}

export const jevKey = () => process.env.JEV_API_KEY ?? process.env.OPENROUTER_API_KEY;

export async function askJev(
	state: unknown,
	questions: Record<string, JevQuestion>,
	{ timeoutMs = 8000 }: { timeoutMs?: number } = {},
): Promise<JevResult> {
	const key = jevKey();
	if (!key) throw new Error("JEV_API_KEY is not set");
	const started = Date.now();
	const res = await fetch(JEV_URL, {
		method: "POST",
		headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
		body: JSON.stringify({ model: JEV_MODEL, state, questions }),
		signal: AbortSignal.timeout(timeoutMs),
	});
	const json = (await res.json().catch(() => ({}))) as {
		answers?: Record<string, JevAnswer>;
		model?: string;
		usage?: { input_tokens?: number; cost?: number };
		error?: { message?: string };
	};
	if (!res.ok || !json.answers) {
		throw new Error(`Jev ${res.status}: ${json.error?.message ?? "no answers"}`);
	}
	return {
		answers: json.answers,
		model: json.model ?? JEV_MODEL,
		costUsd: typeof json.usage?.cost === "number" ? json.usage.cost : 0,
		inputTokens: json.usage?.input_tokens ?? 0,
		latencyMs: Date.now() - started,
	};
}

export const noulOf = (answer: JevAnswer | undefined) => (answer?.type === "noul" ? answer.noul : null);
