import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { LlmProvider, RawRequest } from "./types.ts";

export function createOpenAiProvider(): LlmProvider {
	const client = new OpenAI();
	const model = process.env.OPENAI_MODEL ?? "gpt-6-astra";

	return {
		name: "openai",
		model,
		async completeRaw({ system, prompt, schema, schemaName, signal }: RawRequest) {
			const response = await client.responses.create(
				{
					model,
					instructions: system,
					input: prompt,
					text: { format: zodTextFormat(schema, schemaName) },
				},
				{ signal },
			);
			for (const item of response.output) {
				if (item.type !== "message") continue;
				for (const part of item.content) {
					if (part.type === "refusal") throw new Error(`OpenAI refused: ${part.refusal}`);
				}
			}
			return { text: response.output_text };
		},
	};
}
