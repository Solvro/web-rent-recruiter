import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { LlmProvider, RawRequest } from "./types.ts";

export function createAnthropicProvider(): LlmProvider {
	const client = new Anthropic();
	const model = process.env.ANTHROPIC_MODEL ?? "claude-opus-5-5";

	return {
		name: "anthropic",
		model,
		async completeRaw({ system, prompt, schema, signal }: RawRequest) {
			const response = await client.beta.messages.create(
				{
					model,
					max_tokens: 16000,
					// Re-run on a fallback model if a safety classifier declines.
					betas: ["server-side-fallback-2026-07-01"],
					fallbacks: "default",
					system,
					messages: [{ role: "user", content: prompt }],
					output_config: { effort: "medium", format: betaZodOutputFormat(schema) },
				},
				{ signal },
			);
			if (response.stop_reason === "refusal") {
				throw new Error(`Anthropic refused: ${response.stop_details?.category ?? "unknown"}`);
			}
			const text = response.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("");
			return { text };
		},
	};
}
