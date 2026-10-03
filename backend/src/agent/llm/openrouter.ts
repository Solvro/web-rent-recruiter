import { z } from "zod";
import type { LlmProvider, RawRequest } from "./types.ts";

const URL = "https://openrouter.ai/api/v1/chat/completions";

/** Keywords some upstream providers reject in strict mode. zod still enforces them after parsing. */
const UNSUPPORTED = new Set([
	"$schema",
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"pattern",
	"format",
]);

export function strictSchema(node: unknown): unknown {
	if (Array.isArray(node)) return node.map(strictSchema);
	if (!node || typeof node !== "object") return node;
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(node)) {
		if (!UNSUPPORTED.has(key)) out[key] = strictSchema(value);
	}
	if (out.type === "object" && out.properties) {
		out.additionalProperties = false;
		out.required = Object.keys(out.properties as object);
	}
	return out;
}

/** OpenAI-compatible chat completions with json_schema structured output. */
export function createOpenRouterProvider(): LlmProvider {
	const model = process.env.OPENROUTER_MODEL ?? "anthropic/claude-sonnet-5.5";
	// Used for latency-critical one-liners (the review summary): ~1.2 s vs ~2-4 s.
	const fastModel = process.env.OPENROUTER_FAST_MODEL ?? "anthropic/claude-haiku-4.5";

	return {
		name: "openrouter",
		model,
		async completeRaw({ system, prompt, schema, schemaName, signal, fast }: RawRequest) {
			const res = await fetch(URL, {
				method: "POST",
				headers: {
					authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
					"content-type": "application/json",
					"x-title": "Scout",
				},
				body: JSON.stringify({
					model: fast ? fastModel : model,
					messages: [
						{ role: "system", content: system },
						{ role: "user", content: prompt },
					],
					response_format: {
						type: "json_schema",
						json_schema: { name: schemaName, strict: true, schema: strictSchema(z.toJSONSchema(schema)) },
					},
					...(fast ? {} : { reasoning: { effort: "low" } }),
					usage: { include: true },
				}),
				signal,
			});
			const json = (await res.json().catch(() => ({}))) as {
				choices?: { message?: { content?: string; refusal?: string | null } }[];
				usage?: { cost?: number };
				error?: { message?: string };
			};
			if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${json.error?.message ?? "request failed"}`);
			const message = json.choices?.[0]?.message;
			if (message?.refusal) throw new Error(`OpenRouter refused: ${message.refusal}`);
			if (!message?.content) throw new Error("OpenRouter returned no content");
			return { text: message.content, costUsd: json.usage?.cost };
		},
	};
}
