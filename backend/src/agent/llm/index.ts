import type { z } from "zod";
import { createAnthropicProvider } from "./anthropic.ts";
import { createOpenAiProvider } from "./openai.ts";
import { createOpenRouterProvider } from "./openrouter.ts";
import type { CompleteOptions, LlmProvider, ProviderName } from "./types.ts";

export type { CompleteOptions, LlmProvider, ProviderName } from "./types.ts";

let cached: LlmProvider | null | undefined;

const PROVIDERS: ProviderName[] = ["openrouter", "anthropic", "openai", "offline"];

/** LLM_PROVIDER wins; otherwise the first key found (OpenRouter, Anthropic, OpenAI); otherwise offline. */
export function resolveProviderName(env: NodeJS.ProcessEnv = process.env): ProviderName {
	const explicit = env.LLM_PROVIDER?.toLowerCase() as ProviderName | undefined;
	if (explicit && PROVIDERS.includes(explicit)) return explicit;
	if (env.OPENROUTER_API_KEY) return "openrouter";
	if (env.ANTHROPIC_API_KEY) return "anthropic";
	if (env.OPENAI_API_KEY) return "openai";
	return "offline";
}

function getProvider(): LlmProvider | null {
	if (cached !== undefined) return cached;
	const name = resolveProviderName();
	cached =
		name === "openrouter"
			? createOpenRouterProvider()
			: name === "anthropic"
				? createAnthropicProvider()
				: name === "openai"
					? createOpenAiProvider()
					: null;
	return cached;
}

/** For display, e.g. "openrouter · anthropic/claude-sonnet-5.5" or "offline". */
export function providerLabel(): string {
	const provider = getProvider();
	return provider ? `${provider.name} · ${provider.model}` : "offline";
}

/**
 * Structured completion validated with zod. Invalid output is retried once with the
 * validation error appended. If the provider still fails (network, refusal, invalid JSON,
 * timeout) we log and fall back to the deterministic offline answer so the demo never dies.
 */
export async function complete<S extends z.ZodType>(options: CompleteOptions<S>): Promise<z.infer<S>> {
	const provider = getProvider();
	if (!provider) return options.schema.parse(options.offline());

	const signal = options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined;
	let prompt = options.prompt;
	let lastError: unknown;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const raw = await provider.completeRaw({
				system: options.system,
				prompt,
				schema: options.schema,
				schemaName: options.schemaName,
				signal,
				fast: options.fast,
			});
			if (options.meter && raw.costUsd) options.meter.costUsd += raw.costUsd;
			const parsed = options.schema.safeParse(JSON.parse(raw.text));
			if (parsed.success) return parsed.data;
			lastError = parsed.error;
			prompt = `${options.prompt}\n\nYour previous answer did not match the required schema:\n${parsed.error.message}\nReturn corrected JSON only.`;
		} catch (error) {
			lastError = error;
			if (!(error instanceof SyntaxError)) break;
			prompt = `${options.prompt}\n\nYour previous answer was not valid JSON. Return JSON only.`;
		}
	}
	const timedOut = signal?.aborted;
	if (!timedOut) {
		console.warn(
			`[agent] ${provider.name} failed for ${options.schemaName}, using offline fallback:`,
			lastError instanceof Error ? lastError.message : lastError,
		);
	}
	return options.schema.parse(options.offline());
}
