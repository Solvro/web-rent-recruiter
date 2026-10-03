import { generateText, jsonSchema, Output } from "ai";
import { z } from "zod";
import { costFromMetadata, getModel } from "./models.ts";
import { strictSchema } from "./schema.ts";
import type { CompleteOptions } from "./types.ts";

export type { ModelTier, ProviderName } from "./models.ts";
export { getModel, modelId, OPENROUTER_DEFAULTS, providerLabel, resolveProviderName } from "./models.ts";
export type { CompleteOptions } from "./types.ts";

/**
 * Structured completion through the AI SDK (`generateText` + `Output.object`), validated with zod.
 * Invalid output is retried once with the validation error appended. If the provider still fails
 * (network, refusal, invalid JSON, timeout) we log and fall back to the deterministic offline
 * answer so the demo never dies.
 */
/** DEMO_FAST=1: no generative calls on the agent's critical path; templates + Jev only. */
export const demoFast = () => /^(1|true|yes)$/i.test(process.env.DEMO_FAST ?? "");

export async function complete<S extends z.ZodType>(options: CompleteOptions<S>): Promise<z.infer<S>> {
	const model = getModel(options.fast ? "fast" : "main");
	if (!model || (demoFast() && !options.essential)) return options.schema.parse(options.offline());

	const abortSignal = options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined;
	// Strict JSON schema (all props required, no extras, no numeric bounds); zod re-checks below.
	const schema = jsonSchema(strictSchema(z.toJSONSchema(options.schema)) as Parameters<typeof jsonSchema>[0]);
	let prompt = options.prompt;
	let lastError: unknown;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const result = await generateText({
				model,
				system: options.system,
				prompt,
				output: Output.object({ schema, name: options.schemaName }),
				abortSignal,
				maxRetries: 1,
			});
			if (options.meter) options.meter.costUsd += costFromMetadata(result.providerMetadata);
			const parsed = options.schema.safeParse(result.output);
			if (parsed.success) return parsed.data;
			lastError = parsed.error;
			prompt = `${options.prompt}\n\nYour previous answer did not match the required schema:\n${parsed.error.message}\nReturn corrected JSON only.`;
		} catch (error) {
			lastError = error;
			if (abortSignal?.aborted) break;
			prompt = `${options.prompt}\n\nYour previous answer was not valid JSON for the schema. Return JSON only.`;
		}
	}
	if (!abortSignal?.aborted) {
		console.warn(
			`[agent] LLM failed for ${options.schemaName}, using offline fallback:`,
			lastError instanceof Error ? lastError.message.slice(0, 300) : lastError,
		);
	}
	return options.schema.parse(options.offline());
}
