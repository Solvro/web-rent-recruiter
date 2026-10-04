/**
 * AI SDK model selection. One place decides which provider and model every agent call uses.
 *
 * Defaults are CHEAP models for development and tests; the live demo opts into Sonnet with
 * OPENROUTER_MODEL=anthropic/claude-sonnet-5.5.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";

export type ProviderName = "openrouter" | "anthropic" | "openai" | "offline";
export type ModelTier = "main" | "fast";

const PROVIDERS: ProviderName[] = ["openrouter", "anthropic", "openai", "offline"];

/** Cheapest capable OpenRouter models with tool calling + structured outputs (checked 2026-10-03). */
export const OPENROUTER_DEFAULTS = {
	main: "openai/gpt-6-luna", // $0.10 / $0.50 per M tokens
	fast: "google/gemini-2.5-flash-lite", // $0.10 / $0.40 per M tokens
	demo: "anthropic/claude-sonnet-5.5", // opt-in for the live demo
} as const;

/** LLM_PROVIDER wins; otherwise the first key found (OpenRouter, Anthropic, OpenAI); otherwise offline. */
export function resolveProviderName(env: NodeJS.ProcessEnv = process.env): ProviderName {
	const explicit = env.LLM_PROVIDER?.toLowerCase() as ProviderName | undefined;
	if (explicit && PROVIDERS.includes(explicit)) return explicit;
	if (env.OPENROUTER_API_KEY) return "openrouter";
	if (env.ANTHROPIC_API_KEY) return "anthropic";
	if (env.OPENAI_API_KEY) return "openai";
	return "offline";
}

export function modelId(tier: ModelTier, env: NodeJS.ProcessEnv = process.env): string | null {
	switch (resolveProviderName(env)) {
		case "openrouter":
			return tier === "fast"
				? (env.OPENROUTER_FAST_MODEL ?? OPENROUTER_DEFAULTS.fast)
				: (env.OPENROUTER_MODEL ?? OPENROUTER_DEFAULTS.main);
		case "anthropic":
			return tier === "fast"
				? (env.ANTHROPIC_FAST_MODEL ?? "claude-haiku-4-5")
				: (env.ANTHROPIC_MODEL ?? "claude-opus-5-5");
		case "openai":
			return tier === "fast" ? (env.OPENAI_FAST_MODEL ?? "gpt-6-luna") : (env.OPENAI_MODEL ?? "gpt-6-astra");
		default:
			return null;
	}
}

const cache = new Map<string, LanguageModel>();

/** The AI SDK model for a tier, or null when offline. */
export function getModel(tier: ModelTier = "main"): LanguageModel | null {
	const provider = resolveProviderName();
	const id = modelId(tier);
	if (!id) return null;
	const key = `${provider}:${id}`;
	const hit = cache.get(key);
	if (hit) return hit;
	let model: LanguageModel;
	if (provider === "openrouter") {
		const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY, appName: "RentRecruiter" });
		model = openrouter.chat(id, { usage: { include: true } });
	} else if (provider === "anthropic") {
		model = createAnthropic()(id);
	} else {
		model = createOpenAI()(id);
	}
	cache.set(key, model);
	return model;
}

/** For display, e.g. "openrouter · openai/gpt-6-luna" or "offline". */
export function providerLabel(): string {
	const id = modelId("main");
	return id ? `${resolveProviderName()} · ${id}` : "offline";
}

/** USD cost OpenRouter reports in provider metadata; 0 for providers that don't. */
export function costFromMetadata(metadata: unknown): number {
	const usage = (metadata as { openrouter?: { usage?: { cost?: number } } } | undefined)?.openrouter?.usage;
	return typeof usage?.cost === "number" ? usage.cost : 0;
}
