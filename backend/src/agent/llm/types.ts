import type { z } from "zod";

export type ProviderName = "openrouter" | "anthropic" | "openai" | "offline";

export interface RawRequest {
	system: string;
	prompt: string;
	schema: z.ZodType;
	schemaName: string;
	signal?: AbortSignal;
	/** Latency-critical: providers that can, use a faster model without extended reasoning. */
	fast?: boolean;
}

export interface RawResponse {
	text: string;
	/** USD, when the provider reports it (OpenRouter does). */
	costUsd?: number;
}

/** A model provider returns the raw JSON text; validation and retries live in complete(). */
export interface LlmProvider {
	name: ProviderName;
	model: string;
	completeRaw(request: RawRequest): Promise<RawResponse>;
}

export interface CompleteOptions<S extends z.ZodType> {
	system: string;
	prompt: string;
	schema: S;
	schemaName: string;
	/** Deterministic answer used by the offline provider and as a last-resort fallback. */
	offline: () => z.infer<S>;
	/** Aborts the provider call; the offline answer is returned instead. */
	timeoutMs?: number;
	/** Prefer a fast model (OpenRouter: OPENROUTER_FAST_MODEL). */
	fast?: boolean;
	/** Incremented with the reported cost of every provider call this completion makes. */
	meter?: { costUsd: number };
}
